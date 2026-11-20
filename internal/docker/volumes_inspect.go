package docker

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

const (
	probeContainerPrefix = "container-land-vol-probe"
	volCacheTTL          = 5 * time.Minute
	volProbeFailTTL      = 2 * time.Minute
)

func (c *Client) invalidateVolumeCache(name string) {
	c.volMu.Lock()
	defer c.volMu.Unlock()
	if c.volCache != nil {
		delete(c.volCache, name)
	}
}

func isHexHash64(s string) bool {
	if len(s) != 64 {
		return false
	}
	for i := 0; i < len(s); i++ {
		ch := s[i]
		if !((ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f') || (ch >= 'A' && ch <= 'F')) {
			return false
		}
	}
	return true
}

func inferVolumeContentHint(entries []string, sizeBytes int64) string {
	if len(entries) == 0 {
		if sizeBytes == 0 {
			return "Empty volume"
		}
		return "No top-level files"
	}

	has := func(target string) bool {
		for _, e := range entries {
			if strings.EqualFold(e, target) {
				return true
			}
		}
		return false
	}
	hasPrefix := func(prefix string) bool {
		for _, e := range entries {
			if strings.HasPrefix(strings.ToLower(e), strings.ToLower(prefix)) {
				return true
			}
		}
		return false
	}

	switch {
	case has(".yarn-integrity") || has("node_modules") || (has(".bin") && (hasPrefix("@") || has("typescript") || has("vite") || has("react"))):
		return "Node.js packages (node_modules)"
	case has(".erlang.cookie") || has("mnesia"):
		return "RabbitMQ data (mnesia)"
	case has("PG_VERSION") || has("pg_wal") || has("postgresql.conf"):
		return "PostgreSQL database"
	case len(entries) == 1 && (entries[0] == "18" || entries[0] == "17" || entries[0] == "16" || entries[0] == "15" || entries[0] == "14"):
		return fmt.Sprintf("PostgreSQL %s data (%s/)", entries[0], entries[0])
	case len(entries) == 1 && entries[0] == "data":
		return "PostgreSQL / Database data (data/)"
	case (len(entries) == 1 && entries[0] == "docker") || (has("buildkit") && has("overlay2")):
		return "Docker-in-Docker (/var/lib/docker)"
	case has("dump.rdb") || has("appendonly.aof") || has("appendonlydir"):
		return "Redis persistence data"
	case has("ibdata1") || has("mysql") || has("performance_schema"):
		return "MySQL / MariaDB data"
	case has("WiredTiger") || has("mongod.lock"):
		return "MongoDB data"
	case has("ruby") || has("specifications") || has("gems"):
		return "Ruby Bundler gems"
	default:
		preview := entries
		if len(preview) > 4 {
			preview = preview[:4]
		}
		return "Files: " + strings.Join(preview, ", ")
	}
}

func (c *Client) enrichVolumesWithContents(ctx context.Context, vols []VolumeSummary) {
	if len(vols) == 0 {
		return
	}

	now := time.Now()
	present := make(map[string]struct{}, len(vols))
	for _, v := range vols {
		present[v.Name] = struct{}{}
	}

	collectUncached := func() []int {
		c.volMu.Lock()
		defer c.volMu.Unlock()
		if c.volCache == nil {
			c.volCache = make(map[string]volCacheEntry)
		}
		// Evict keys for volumes that no longer exist to keep the cache bounded.
		for k := range c.volCache {
			if _, ok := present[k]; !ok {
				delete(c.volCache, k)
			}
		}

		var uncached []int
		for i := range vols {
			if entry, ok := c.volCache[vols[i].Name]; ok {
				ttl := volCacheTTL
				if entry.failed {
					ttl = volProbeFailTTL
				}
				if now.Sub(entry.cachedAt) < ttl {
					if !entry.failed {
						vols[i].TopEntries = entry.entries
						vols[i].ContentHint = inferVolumeContentHint(entry.entries, vols[i].SizeBytes)
					} else if vols[i].SizeBytes == 0 {
						vols[i].ContentHint = "Empty volume"
					}
					continue
				}
			}
			// Try direct host read first (works in rootless mode or when running with access to Mountpoint)
			if vols[i].Mountpoint != "" {
				if dirEntries, err := os.ReadDir(vols[i].Mountpoint); err == nil {
					var names []string
					for _, de := range dirEntries {
						names = append(names, de.Name())
						if len(names) >= 12 {
							break
						}
					}
					c.volCache[vols[i].Name] = volCacheEntry{entries: names, cachedAt: now}
					vols[i].TopEntries = names
					vols[i].ContentHint = inferVolumeContentHint(names, vols[i].SizeBytes)
					continue
				}
			}
			uncached = append(uncached, i)
		}
		return uncached
	}

	uncachedIndices := collectUncached()
	if len(uncachedIndices) == 0 {
		return
	}

	// Serialise container probing so concurrent /api/volumes requests don't spawn duplicate probe containers.
	c.volProbeMu.Lock()
	defer c.volProbeMu.Unlock()

	// Re-check cache after acquiring the probe lock in case another goroutine just populated it.
	now = time.Now()
	uncachedIndices = collectUncached()
	if len(uncachedIndices) == 0 {
		return
	}

	c.volMu.Lock()
	blocked := now.Before(c.probeBlockedUntil)
	c.volMu.Unlock()
	if blocked {
		for _, idx := range uncachedIndices {
			if vols[idx].SizeBytes == 0 {
				vols[idx].ContentHint = "Empty volume"
			}
		}
		return
	}

	probeResults, probeOK := c.runVolumeBatchProbe(ctx, vols, uncachedIndices)
	now = time.Now()

	c.volMu.Lock()
	defer c.volMu.Unlock()
	if !probeOK {
		c.probeBlockedUntil = now.Add(volProbeFailTTL)
	}
	for _, idx := range uncachedIndices {
		vName := vols[idx].Name
		if entries, ok := probeResults[idx]; ok {
			c.volCache[vName] = volCacheEntry{entries: entries, cachedAt: now}
			vols[idx].TopEntries = entries
			vols[idx].ContentHint = inferVolumeContentHint(entries, vols[idx].SizeBytes)
		} else if vols[idx].SizeBytes == 0 {
			c.volCache[vName] = volCacheEntry{entries: []string{}, cachedAt: now}
			vols[idx].ContentHint = "Empty volume"
		} else {
			c.volCache[vName] = volCacheEntry{cachedAt: now, failed: true}
		}
	}
}

func (c *Client) pickLocalHelperImage(ctx context.Context) string {
	var rawImages []struct {
		RepoTags []string `json:"RepoTags"`
		Size     int64    `json:"Size"`
	}
	if err := c.getJSON(ctx, "/images/json?all=0", &rawImages); err != nil || len(rawImages) == 0 {
		return ""
	}
	preferredPrefixes := []string{"alpine:", "busybox:", "redis:", "postgres:", "debian:", "ubuntu:", "node:"}
	for _, pref := range preferredPrefixes {
		for _, img := range rawImages {
			for _, tag := range img.RepoTags {
				if strings.HasPrefix(tag, pref) {
					return tag
				}
			}
		}
	}
	for _, img := range rawImages {
		for _, tag := range img.RepoTags {
			if tag != "" && tag != "<none>:<none>" {
				return tag
			}
		}
	}
	return ""
}

func (c *Client) runVolumeBatchProbe(ctx context.Context, vols []VolumeSummary, indices []int) (map[int][]string, bool) {
	out := make(map[int][]string, len(indices))
	helperImage := c.pickLocalHelperImage(ctx)
	if helperImage == "" {
		return out, false
	}

	probeCtx, cancel := context.WithTimeout(ctx, 4*time.Second)
	defer cancel()

	binds := make([]string, 0, len(indices))
	for _, idx := range indices {
		binds = append(binds, fmt.Sprintf("%s:/vols/%d:ro", vols[idx].Name, idx))
	}

	script := `for d in /vols/*; do [ -e "$d" ] || continue; echo "===VOL:$(basename "$d")==="; ls -A "$d" 2>/dev/null | head -n 12; done`
	createBody, _ := json.Marshal(map[string]any{
		"Image":           helperImage,
		"User":            "0:0",
		"Entrypoint":      []string{"/bin/sh", "-c"},
		"Cmd":             []string{script},
		"NetworkDisabled": true,
		"Labels": map[string]string{
			"io.container-land.internal": "volume-probe",
		},
		"HostConfig": map[string]any{
			"Binds": binds,
		},
	})

	q := url.Values{}
	q.Set("name", fmt.Sprintf("%s-%d", probeContainerPrefix, time.Now().UnixNano()))
	resp, err := c.doRequest(probeCtx, http.MethodPost, "/containers/create?"+q.Encode(), bytes.NewReader(createBody), map[string]string{
		"Content-Type": "application/json",
	})
	if err != nil {
		return out, false
	}
	var created struct {
		ID string `json:"Id"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&created)
	resp.Body.Close()
	if created.ID == "" {
		return out, false
	}
	defer func() {
		rmCtx, rmCancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer rmCancel()
		_ = c.RemoveContainer(rmCtx, created.ID, true, false)
	}()

	startResp, err := c.doRequest(probeCtx, http.MethodPost, fmt.Sprintf("/containers/%s/start", url.PathEscape(created.ID)), nil, nil)
	if err != nil {
		return out, false
	}
	startResp.Body.Close()

	waitResp, err := c.doRequest(probeCtx, http.MethodPost, fmt.Sprintf("/containers/%s/wait", url.PathEscape(created.ID)), nil, nil)
	if err == nil {
		_, _ = io.ReadAll(waitResp.Body)
		waitResp.Body.Close()
	}

	logResp, err := c.doRequest(probeCtx, http.MethodGet, fmt.Sprintf("/containers/%s/logs?stdout=true&stderr=false", url.PathEscape(created.ID)), nil, nil)
	if err != nil {
		return out, false
	}
	defer logResp.Body.Close()

	currentIdx := -1
	_ = DemuxDockerStream(probeCtx, logResp.Body, false, LogEntry{}, func(entry LogEntry) error {
		line := strings.TrimSpace(entry.Message)
		if strings.HasPrefix(line, "===VOL:") && strings.HasSuffix(line, "===") {
			numStr := strings.TrimSuffix(strings.TrimPrefix(line, "===VOL:"), "===")
			if parsed, pErr := strconv.Atoi(numStr); pErr == nil {
				currentIdx = parsed
				out[currentIdx] = []string{}
			}
			return nil
		}
		if currentIdx >= 0 && line != "" {
			out[currentIdx] = append(out[currentIdx], line)
		}
		return nil
	})

	return out, len(out) > 0
}
