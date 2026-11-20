package docker

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
)

// GetDiskUsage queries /system/df and calculates active, total, and reclaimable space across Images, Containers, Volumes, and Build Cache.
func (c *Client) GetDiskUsage(ctx context.Context) (DiskUsageSummary, error) {
	var raw struct {
		LayersSize int64 `json:"LayersSize"`
		Images     []struct {
			Size       int64 `json:"Size"`
			SharedSize int64 `json:"SharedSize"`
			Containers int64 `json:"Containers"`
		} `json:"Images"`
		Containers []struct {
			State  string `json:"State"`
			SizeRw int64  `json:"SizeRw"`
		} `json:"Containers"`
		Volumes []struct {
			UsageData *struct {
				Size     int64 `json:"Size"`
				RefCount int64 `json:"RefCount"`
			} `json:"UsageData"`
		} `json:"Volumes"`
		BuildCache []struct {
			Size   int64 `json:"Size"`
			Shared bool  `json:"Shared"`
			InUse  bool  `json:"InUse"`
		} `json:"BuildCache"`
	}
	if err := c.getJSON(ctx, "/system/df", &raw); err != nil {
		return DiskUsageSummary{}, err
	}

	var sum DiskUsageSummary
	sum.LayersSize = raw.LayersSize
	sum.ImagesTotal = len(raw.Images)

	var totalImageSize, reclaimableImages int64
	for _, img := range raw.Images {
		totalImageSize += img.Size
		if img.Containers > 0 {
			sum.ImagesActive++
		} else {
			unshared := img.Size - img.SharedSize
			if unshared > 0 {
				reclaimableImages += unshared
			}
		}
	}
	if sum.LayersSize > 0 {
		sum.ImagesSize = sum.LayersSize
	} else {
		sum.ImagesSize = totalImageSize
	}
	if reclaimableImages > sum.ImagesSize {
		reclaimableImages = sum.ImagesSize
	}
	sum.ImagesReclaimable = reclaimableImages

	sum.ContainersTotal = len(raw.Containers)
	for _, ctr := range raw.Containers {
		sum.ContainersSize += ctr.SizeRw
		if ctr.State == "running" || ctr.State == "paused" || ctr.State == "restarting" {
			sum.ContainersActive++
		} else {
			sum.ContainersReclaimable += ctr.SizeRw
		}
	}

	sum.VolumesTotal = len(raw.Volumes)
	for _, vol := range raw.Volumes {
		if vol.UsageData == nil {
			continue
		}
		if vol.UsageData.Size > 0 {
			sum.VolumesSize += vol.UsageData.Size
		}
		if vol.UsageData.RefCount > 0 {
			sum.VolumesActive++
		} else if vol.UsageData.Size > 0 {
			sum.VolumesReclaimable += vol.UsageData.Size
		}
	}

	sum.BuildCacheTotal = len(raw.BuildCache)
	for _, bc := range raw.BuildCache {
		if bc.InUse {
			sum.BuildCacheActive++
		}
		if !bc.Shared {
			sum.BuildCacheSize += bc.Size
			if !bc.InUse {
				sum.BuildCacheReclaimable += bc.Size
			}
		}
	}

	sum.TotalSize = sum.ImagesSize + sum.ContainersSize + sum.VolumesSize + sum.BuildCacheSize
	sum.SafeReclaimable = sum.ImagesReclaimable + sum.ContainersReclaimable + sum.BuildCacheReclaimable
	sum.TotalReclaimable = sum.SafeReclaimable + sum.VolumesReclaimable

	return sum, nil
}

// Prune executes targeted cleanup across stopped containers, unused images, build cache, and (if explicitly enabled) volumes.
func (c *Client) Prune(ctx context.Context, req PruneRequest) (PruneResponse, error) {
	var out PruneResponse

	if req.Containers {
		var res struct {
			ContainersDeleted []string `json:"ContainersDeleted"`
			SpaceReclaimed    uint64   `json:"SpaceReclaimed"`
		}
		resp, err := c.doRequest(ctx, http.MethodPost, "/containers/prune", nil, nil)
		if err != nil {
			return out, err
		}
		_ = json.NewDecoder(resp.Body).Decode(&res)
		resp.Body.Close()
		out.ContainersDeleted = res.ContainersDeleted
		out.ReclaimedContainersBytes = res.SpaceReclaimed
		out.TotalReclaimedBytes += res.SpaceReclaimed
	}

	if req.Images {
		danglingVal := "false"
		if req.DanglingOnly {
			danglingVal = "true"
		}
		filtersJSON, _ := json.Marshal(map[string][]string{
			"dangling": {danglingVal},
		})
		q := url.Values{}
		q.Set("filters", string(filtersJSON))

		var res struct {
			ImagesDeleted []struct {
				Untagged string `json:"Untagged"`
				Deleted  string `json:"Deleted"`
			} `json:"ImagesDeleted"`
			SpaceReclaimed uint64 `json:"SpaceReclaimed"`
		}
		resp, err := c.doRequest(ctx, http.MethodPost, "/images/prune?"+q.Encode(), nil, nil)
		if err != nil {
			return out, err
		}
		_ = json.NewDecoder(resp.Body).Decode(&res)
		resp.Body.Close()
		for _, item := range res.ImagesDeleted {
			if item.Untagged != "" {
				out.ImagesDeleted = append(out.ImagesDeleted, item.Untagged)
			} else if item.Deleted != "" {
				out.ImagesDeleted = append(out.ImagesDeleted, item.Deleted)
			}
		}
		out.ReclaimedImagesBytes = res.SpaceReclaimed
		out.TotalReclaimedBytes += res.SpaceReclaimed
	}

	if req.BuildCache {
		var res struct {
			CachesDeleted  []string `json:"CachesDeleted"`
			SpaceReclaimed uint64   `json:"SpaceReclaimed"`
		}
		resp, err := c.doRequest(ctx, http.MethodPost, "/build/prune", nil, nil)
		if err == nil {
			_ = json.NewDecoder(resp.Body).Decode(&res)
			resp.Body.Close()
			out.BuildCacheDeleted = res.CachesDeleted
			out.ReclaimedBuildCacheBytes = res.SpaceReclaimed
			out.TotalReclaimedBytes += res.SpaceReclaimed
		}
	}

	if req.Volumes {
		// Pass all=true filter so anonymous AND named unattached volumes can be pruned when explicitly requested
		filtersJSON, _ := json.Marshal(map[string][]string{
			"all": {"true"},
		})
		q := url.Values{}
		q.Set("filters", string(filtersJSON))

		var res struct {
			VolumesDeleted []string `json:"VolumesDeleted"`
			SpaceReclaimed uint64   `json:"SpaceReclaimed"`
		}
		resp, err := c.doRequest(ctx, http.MethodPost, "/volumes/prune?"+q.Encode(), nil, nil)
		if err != nil {
			return out, err
		}
		_ = json.NewDecoder(resp.Body).Decode(&res)
		resp.Body.Close()
		out.VolumesDeleted = res.VolumesDeleted
		out.ReclaimedVolumesBytes = res.SpaceReclaimed
		out.TotalReclaimedBytes += res.SpaceReclaimed
		for _, v := range res.VolumesDeleted {
			c.invalidateVolumeCache(v)
		}
	}

	return out, nil
}

// StreamEvents streams live Docker daemon events from /events.
func (c *Client) StreamEvents(ctx context.Context, onEvent func(DaemonEvent) error) error {
	resp, err := c.doRequest(ctx, http.MethodGet, "/events", nil, nil)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	dec := json.NewDecoder(resp.Body)
	for {
		var raw struct {
			Type   string `json:"Type"`
			Action string `json:"Action"`
			Time   int64  `json:"time"`
			Actor  struct {
				ID         string            `json:"ID"`
				Attributes map[string]string `json:"Attributes"`
			} `json:"Actor"`
		}
		if err := dec.Decode(&raw); err != nil {
			if err == io.EOF || ctx.Err() != nil {
				return nil
			}
			return err
		}
		if strings.HasPrefix(raw.Actor.Attributes["name"], "container-land-vol-probe") || raw.Actor.Attributes["io.container-land.internal"] == "volume-probe" {
			continue
		}
		// Skip high-frequency volume mount/unmount events (including those emitted by our
		// own volume probe container) so they don't trigger feedback loops of /api/volumes refreshes.
		if raw.Type == "volume" && (raw.Action == "mount" || raw.Action == "unmount") {
			continue
		}
		ev := DaemonEvent{
			Type:   raw.Type,
			Action: raw.Action,
			ID:     raw.Actor.ID,
			Name:   raw.Actor.Attributes["name"],
			Time:   raw.Time,
			Attrs:  raw.Actor.Attributes,
		}
		if err := onEvent(ev); err != nil {
			return err
		}
	}
}
