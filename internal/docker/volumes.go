package docker

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strings"
)

// ListVolumes lists all Docker volumes enriched with container references and disk usage from /system/df.
func (c *Client) ListVolumes(ctx context.Context) ([]VolumeSummary, error) {
	var rawVols struct {
		Volumes []struct {
			Name       string            `json:"Name"`
			Driver     string            `json:"Driver"`
			Mountpoint string            `json:"Mountpoint"`
			CreatedAt  string            `json:"CreatedAt"`
			Labels     map[string]string `json:"Labels"`
			Scope      string            `json:"Scope"`
			UsageData  *struct {
				Size     int64 `json:"Size"`
				RefCount int64 `json:"RefCount"`
			} `json:"UsageData"`
		} `json:"Volumes"`
	}
	if err := c.getJSON(ctx, "/volumes", &rawVols); err != nil {
		return nil, err
	}

	// Also fetch /system/df volume sizes if available
	volSizes := make(map[string]int64)
	var rawDF struct {
		Volumes []struct {
			Name      string `json:"Name"`
			UsageData *struct {
				Size     int64 `json:"Size"`
				RefCount int64 `json:"RefCount"`
			} `json:"UsageData"`
		} `json:"Volumes"`
	}
	if err := c.getJSON(ctx, "/system/df", &rawDF); err == nil {
		for _, v := range rawDF.Volumes {
			if v.UsageData != nil {
				volSizes[v.Name] = v.UsageData.Size
			}
		}
	}

	ctrs, _ := c.ListContainers(ctx, false)
	usedByMap := make(map[string][]string)
	mountPathsMap := make(map[string][]string)
	recordMounts := func(ctr ContainerSummary) {
		for _, m := range ctr.Mounts {
			if m.Type == "volume" && m.Name != "" {
				usedByMap[m.Name] = append(usedByMap[m.Name], ctr.Name)
				if m.Destination != "" {
					mountPathsMap[m.Name] = append(mountPathsMap[m.Name], ctr.Name+":"+m.Destination)
				}
			}
		}
	}
	for _, g := range ctrs.ComposeGroups {
		for _, ctr := range g.Containers {
			recordMounts(ctr)
		}
	}
	for _, ctr := range ctrs.Standalone {
		recordMounts(ctr)
	}

	out := make([]VolumeSummary, 0, len(rawVols.Volumes))
	for _, rv := range rawVols.Volumes {
		usedBy := usedByMap[rv.Name]
		mountPaths := mountPathsMap[rv.Name]
		size := int64(-1)
		if s, ok := volSizes[rv.Name]; ok {
			size = s
		} else if rv.UsageData != nil {
			size = rv.UsageData.Size
		}

		_, hasAnonLabel := rv.Labels["com.docker.volume.anonymous"]
		anon := hasAnonLabel || isHexHash64(rv.Name)
		shortName := rv.Name
		if anon && len(shortName) > 12 {
			shortName = shortName[:12]
		}
		composeProject := rv.Labels["com.docker.compose.project"]

		out = append(out, VolumeSummary{
			Name:             rv.Name,
			ShortName:        shortName,
			Anonymous:        anon,
			ComposeProject:   composeProject,
			Driver:           rv.Driver,
			Mountpoint:       rv.Mountpoint,
			CreatedAt:        rv.CreatedAt,
			Labels:           rv.Labels,
			Scope:            rv.Scope,
			SizeBytes:        size,
			RefCount:         int64(len(usedBy)),
			InUse:            len(usedBy) > 0,
			UsedByContainers: usedBy,
			MountPaths:       mountPaths,
		})
	}

	c.enrichVolumesWithContents(ctx, out)

	sort.Slice(out, func(i, j int) bool {
		if out[i].InUse != out[j].InUse {
			return out[i].InUse
		}
		return out[i].Name < out[j].Name
	})

	return out, nil
}

// CountVolumes returns the total number of Docker volumes without fetching disk usage or probing contents.
func (c *Client) CountVolumes(ctx context.Context) (int, error) {
	var rawVols struct {
		Volumes []struct {
			Name string `json:"Name"`
		} `json:"Volumes"`
	}
	if err := c.getJSON(ctx, "/volumes", &rawVols); err != nil {
		return 0, err
	}
	return len(rawVols.Volumes), nil
}

// CreateVolume creates a named Docker volume.
func (c *Client) CreateVolume(ctx context.Context, name string) error {
	trimmed := strings.TrimSpace(name)
	payload, _ := json.Marshal(map[string]string{"Name": trimmed})
	resp, err := c.doRequest(ctx, http.MethodPost, "/volumes/create", bytes.NewReader(payload), map[string]string{
		"Content-Type": "application/json",
	})
	if err != nil {
		return err
	}
	resp.Body.Close()
	c.invalidateVolumeCache(trimmed)
	return nil
}

// RemoveVolume deletes a Docker volume by name.
func (c *Client) RemoveVolume(ctx context.Context, name string, force bool) error {
	q := url.Values{}
	if force {
		q.Set("force", "true")
	}
	resp, err := c.doRequest(ctx, http.MethodDelete, fmt.Sprintf("/volumes/%s?%s", url.PathEscape(name), q.Encode()), nil, nil)
	if err != nil {
		return err
	}
	resp.Body.Close()
	c.invalidateVolumeCache(name)
	return nil
}
