package docker

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"
)

type rawDockerContainer struct {
	ID      string            `json:"Id"`
	Names   []string          `json:"Names"`
	Image   string            `json:"Image"`
	ImageID string            `json:"ImageID"`
	Command string            `json:"Command"`
	Created int64             `json:"Created"`
	State   string            `json:"State"`
	Status  string            `json:"Status"`
	Ports   []PortBinding     `json:"Ports"`
	Labels  map[string]string `json:"Labels"`
	Mounts  []struct {
		Type        string `json:"Type"`
		Name        string `json:"Name"`
		Source      string `json:"Source"`
		Destination string `json:"Destination"`
		Mode        string `json:"Mode"`
		RW          bool   `json:"RW"`
	} `json:"Mounts"`
	NetworkSettings struct {
		Networks map[string]any `json:"Networks"`
	} `json:"NetworkSettings"`
}

// ListContainers returns all containers (running and stopped), optionally enriched with live CPU/RAM stats,
// grouped into Compose stacks and standalone containers.
func (c *Client) ListContainers(ctx context.Context, withStats bool) (ContainersResponse, error) {
	var rawList []rawDockerContainer
	if err := c.getJSON(ctx, "/containers/json?all=1", &rawList); err != nil {
		return ContainersResponse{}, err
	}

	summaries := make([]ContainerSummary, 0, len(rawList))
	for _, rc := range rawList {
		name := rc.ID
		if len(rc.Names) > 0 {
			name = strings.TrimPrefix(rc.Names[0], "/")
		}
		if strings.HasPrefix(name, "container-land-vol-probe") || rc.Labels["io.container-land.internal"] == "volume-probe" {
			continue
		}
		shortID := rc.ID
		if len(shortID) > 12 {
			shortID = shortID[:12]
		}
		mounts := make([]MountPoint, 0, len(rc.Mounts))
		for _, m := range rc.Mounts {
			mounts = append(mounts, MountPoint{
				Type:        m.Type,
				Name:        m.Name,
				Source:      m.Source,
				Destination: m.Destination,
				Mode:        m.Mode,
				RW:          m.RW,
			})
		}
		var netNames []string
		for k := range rc.NetworkSettings.Networks {
			netNames = append(netNames, k)
		}
		sort.Strings(netNames)

		// Deduplicate and sort port bindings
		ports := dedupePorts(rc.Ports)

		summaries = append(summaries, ContainerSummary{
			ID:                 rc.ID,
			ShortID:            shortID,
			Name:               name,
			Image:              rc.Image,
			ImageID:            rc.ImageID,
			Command:            rc.Command,
			Created:            rc.Created,
			State:              rc.State,
			Status:             rc.Status,
			Ports:              ports,
			Labels:             rc.Labels,
			ComposeProject:     rc.Labels["com.docker.compose.project"],
			ComposeService:     rc.Labels["com.docker.compose.service"],
			ComposeWorkDir:     rc.Labels["com.docker.compose.project.working_dir"],
			ComposeConfigFiles: rc.Labels["com.docker.compose.project.config_files"],
			Mounts:             mounts,
			Networks:           netNames,
		})
	}

	if withStats {
		c.populateRunningStats(ctx, summaries)
	}

	return groupContainers(summaries), nil
}

func dedupePorts(in []PortBinding) []PortBinding {
	seen := make(map[string]bool, len(in))
	out := make([]PortBinding, 0, len(in))
	for _, p := range in {
		// Normalize IPv6 :: duplicate of 0.0.0.0 when PublicPort & PrivatePort match
		key := fmt.Sprintf("%d:%d/%s", p.PublicPort, p.PrivatePort, p.Type)
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, p)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].PublicPort != out[j].PublicPort {
			return out[i].PublicPort < out[j].PublicPort
		}
		return out[i].PrivatePort < out[j].PrivatePort
	})
	return out
}

func groupContainers(all []ContainerSummary) ContainersResponse {
	sort.Slice(all, func(i, j int) bool {
		return all[i].Name < all[j].Name
	})

	groupsMap := make(map[string]*ComposeGroup)
	var standalone []ContainerSummary
	runningTotal := 0

	for _, ctr := range all {
		if ctr.State == "running" {
			runningTotal++
		}
		if ctr.ComposeProject == "" {
			standalone = append(standalone, ctr)
			continue
		}
		g, exists := groupsMap[ctr.ComposeProject]
		if !exists {
			g = &ComposeGroup{
				Name:        ctr.ComposeProject,
				WorkingDir:  ctr.ComposeWorkDir,
				ConfigFiles: ctr.ComposeConfigFiles,
			}
			groupsMap[ctr.ComposeProject] = g
		}
		if g.WorkingDir == "" && ctr.ComposeWorkDir != "" {
			g.WorkingDir = ctr.ComposeWorkDir
		}
		if g.ConfigFiles == "" && ctr.ComposeConfigFiles != "" {
			g.ConfigFiles = ctr.ComposeConfigFiles
		}
		g.TotalCount++
		if ctr.State == "running" {
			g.RunningCount++
		}
		g.CPUPercent = round2(g.CPUPercent + ctr.CPUPercent)
		g.MemUsageBytes += ctr.MemUsageBytes
		for _, p := range ctr.Ports {
			if p.PublicPort > 0 {
				g.ExposedPorts = append(g.ExposedPorts, p)
			}
		}
		g.Containers = append(g.Containers, ctr)
	}

	groups := make([]ComposeGroup, 0, len(groupsMap))
	for _, g := range groupsMap {
		g.ExposedPorts = dedupePorts(g.ExposedPorts)
		switch {
		case g.RunningCount == g.TotalCount && g.TotalCount > 0:
			g.Status = "running"
		case g.RunningCount > 0:
			g.Status = "partial"
		default:
			g.Status = "stopped"
		}
		groups = append(groups, *g)
	}
	sort.Slice(groups, func(i, j int) bool {
		return groups[i].Name < groups[j].Name
	})

	return ContainersResponse{
		ComposeGroups: groups,
		Standalone:    standalone,
		TotalCount:    len(all),
		RunningCount:  runningTotal,
		StoppedCount:  len(all) - runningTotal,
	}
}

const maxConcurrentStatsRequests = 8

func (c *Client) populateRunningStats(ctx context.Context, containers []ContainerSummary) {
	statsCtx, cancel := context.WithTimeout(ctx, 2500*time.Millisecond)
	defer cancel()

	sem := make(chan struct{}, maxConcurrentStatsRequests)
	var wg sync.WaitGroup
	for i := range containers {
		if containers[i].State != "running" {
			continue
		}
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			select {
			case sem <- struct{}{}:
				defer func() { <-sem }()
			case <-statsCtx.Done():
				return
			}
			st, err := c.GetContainerStatsSnapshot(statsCtx, containers[idx].ID)
			if err != nil {
				return
			}
			containers[idx].CPUPercent = st.CPUPercent
			containers[idx].MemUsageBytes = st.MemUsageBytes
			containers[idx].MemLimitBytes = st.MemLimitBytes
			containers[idx].MemPercent = st.MemPercent
			containers[idx].NetRxBytes = st.NetRxBytes
			containers[idx].NetTxBytes = st.NetTxBytes
			containers[idx].BlockReadBytes = st.BlockReadBytes
			containers[idx].BlockWriteBytes = st.BlockWriteBytes
			containers[idx].PIDs = st.PIDs
		}(i)
	}
	wg.Wait()
}

type rawDockerStats struct {
	Read      time.Time `json:"read"`
	PidsStats struct {
		Current uint64 `json:"current"`
	} `json:"pids_stats"`
	CPUStats struct {
		CPUUsage struct {
			TotalUsage  uint64   `json:"total_usage"`
			PerCPUUsage []uint64 `json:"percpu_usage"`
		} `json:"cpu_usage"`
		SystemCPUUsage uint64 `json:"system_cpu_usage"`
		OnlineCPUs     uint64 `json:"online_cpus"`
	} `json:"cpu_stats"`
	PreCPUStats struct {
		CPUUsage struct {
			TotalUsage uint64 `json:"total_usage"`
		} `json:"cpu_usage"`
		SystemCPUUsage uint64 `json:"system_cpu_usage"`
	} `json:"precpu_stats"`
	MemoryStats struct {
		Usage uint64            `json:"usage"`
		Limit uint64            `json:"limit"`
		Stats map[string]uint64 `json:"stats"`
	} `json:"memory_stats"`
	Networks map[string]struct {
		RxBytes uint64 `json:"rx_bytes"`
		TxBytes uint64 `json:"tx_bytes"`
	} `json:"networks"`
	BlkioStats struct {
		IoServiceBytesRecursive []struct {
			Op    string `json:"op"`
			Value uint64 `json:"value"`
		} `json:"io_service_bytes_recursive"`
	} `json:"blkio_stats"`
}

func parseDockerStats(id, name string, raw rawDockerStats) ContainerStats {
	cpuDelta := float64(0)
	if raw.CPUStats.CPUUsage.TotalUsage > raw.PreCPUStats.CPUUsage.TotalUsage {
		cpuDelta = float64(raw.CPUStats.CPUUsage.TotalUsage - raw.PreCPUStats.CPUUsage.TotalUsage)
	}
	sysDelta := float64(0)
	if raw.CPUStats.SystemCPUUsage > raw.PreCPUStats.SystemCPUUsage {
		sysDelta = float64(raw.CPUStats.SystemCPUUsage - raw.PreCPUStats.SystemCPUUsage)
	}
	onlineCPUs := raw.CPUStats.OnlineCPUs
	if onlineCPUs == 0 {
		onlineCPUs = uint64(len(raw.CPUStats.CPUUsage.PerCPUUsage))
	}
	if onlineCPUs == 0 {
		onlineCPUs = 1
	}
	cpuPct := 0.0
	if sysDelta > 0 && cpuDelta > 0 {
		cpuPct = round2((cpuDelta / sysDelta) * float64(onlineCPUs) * 100.0)
	}

	// Exclude inactive_file / cache matching `docker stats` CLI calculation
	memUsage := raw.MemoryStats.Usage
	if inactiveFile, ok := raw.MemoryStats.Stats["inactive_file"]; ok && memUsage > inactiveFile {
		memUsage -= inactiveFile
	} else if cache, ok := raw.MemoryStats.Stats["cache"]; ok && memUsage > cache {
		memUsage -= cache
	}
	memLimit := raw.MemoryStats.Limit
	memPct := 0.0
	if memLimit > 0 {
		memPct = round2((float64(memUsage) / float64(memLimit)) * 100.0)
	}

	var rx, tx uint64
	for _, netStat := range raw.Networks {
		rx += netStat.RxBytes
		tx += netStat.TxBytes
	}

	var blkRead, blkWrite uint64
	for _, entry := range raw.BlkioStats.IoServiceBytesRecursive {
		switch strings.ToLower(entry.Op) {
		case "read":
			blkRead += entry.Value
		case "write":
			blkWrite += entry.Value
		}
	}

	ts := raw.Read
	if ts.IsZero() {
		ts = time.Now().UTC()
	}

	return ContainerStats{
		ContainerID:     id,
		Name:            name,
		Timestamp:       ts,
		CPUPercent:      cpuPct,
		MemUsageBytes:   memUsage,
		MemLimitBytes:   memLimit,
		MemPercent:      memPct,
		NetRxBytes:      rx,
		NetTxBytes:      tx,
		BlockReadBytes:  blkRead,
		BlockWriteBytes: blkWrite,
		PIDs:            raw.PidsStats.Current,
	}
}

// GetContainerStatsSnapshot fetches a single non-streaming stats sample for a container.
func (c *Client) GetContainerStatsSnapshot(ctx context.Context, id string) (ContainerStats, error) {
	var raw rawDockerStats
	if err := c.getJSON(ctx, fmt.Sprintf("/containers/%s/stats?stream=false", url.PathEscape(id)), &raw); err != nil {
		return ContainerStats{}, err
	}
	return parseDockerStats(id, "", raw), nil
}

// StreamContainerStats streams live 1-second stats for a container until ctx is cancelled.
func (c *Client) StreamContainerStats(ctx context.Context, id string, onStats func(ContainerStats) error) error {
	resp, err := c.doRequest(ctx, http.MethodGet, fmt.Sprintf("/containers/%s/stats?stream=true", url.PathEscape(id)), nil, nil)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	dec := json.NewDecoder(resp.Body)
	for {
		var raw rawDockerStats
		if err := dec.Decode(&raw); err != nil {
			if err == io.EOF || ctx.Err() != nil {
				return nil
			}
			return err
		}
		if err := onStats(parseDockerStats(id, "", raw)); err != nil {
			return err
		}
	}
}

// ContainerAction performs start, stop, or restart on a single container.
func (c *Client) ContainerAction(ctx context.Context, id, action string) error {
	switch action {
	case "start", "stop", "restart":
	default:
		return fmt.Errorf("unsupported container action %q", action)
	}
	resp, err := c.doRequest(ctx, http.MethodPost, fmt.Sprintf("/containers/%s/%s", url.PathEscape(id), action), nil, nil)
	if err != nil {
		return err
	}
	resp.Body.Close()
	return nil
}

// RemoveContainer deletes a container (optionally forcing removal of running containers and anonymous volumes).
func (c *Client) RemoveContainer(ctx context.Context, id string, force, removeVolumes bool) error {
	q := url.Values{}
	if force {
		q.Set("force", "true")
	}
	if removeVolumes {
		q.Set("v", "true")
	}
	resp, err := c.doRequest(ctx, http.MethodDelete, fmt.Sprintf("/containers/%s?%s", url.PathEscape(id), q.Encode()), nil, nil)
	if err != nil {
		return err
	}
	resp.Body.Close()
	return nil
}

// ComposeAction executes a bulk lifecycle action (start, stop, restart, remove) across all containers in a Compose stack.
func (c *Client) ComposeAction(ctx context.Context, project, action string) (int, error) {
	list, err := c.ListContainers(ctx, false)
	if err != nil {
		return 0, err
	}
	var targets []ContainerSummary
	for _, g := range list.ComposeGroups {
		if g.Name == project {
			targets = g.Containers
			break
		}
	}
	if len(targets) == 0 {
		return 0, fmt.Errorf("compose project %q not found", project)
	}

	var (
		wg       sync.WaitGroup
		mu       sync.Mutex
		firstErr error
		count    int
	)
	for _, ctr := range targets {
		wg.Add(1)
		go func(id string) {
			defer wg.Done()
			var err error
			if action == "remove" {
				err = c.RemoveContainer(ctx, id, true, false)
			} else {
				err = c.ContainerAction(ctx, id, action)
			}
			mu.Lock()
			defer mu.Unlock()
			if err != nil && firstErr == nil {
				firstErr = err
			} else if err == nil {
				count++
			}
		}(ctr.ID)
	}
	wg.Wait()
	return count, firstErr
}

// InspectContainer returns structured and raw JSON inspection details for a container.
func (c *Client) InspectContainer(ctx context.Context, id string) (ContainerInspectDetail, error) {
	resp, err := c.doRequest(ctx, http.MethodGet, fmt.Sprintf("/containers/%s/json", url.PathEscape(id)), nil, nil)
	if err != nil {
		return ContainerInspectDetail{}, err
	}
	defer resp.Body.Close()

	bodyBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		return ContainerInspectDetail{}, err
	}

	var rawMap map[string]any
	if err := json.Unmarshal(bodyBytes, &rawMap); err != nil {
		return ContainerInspectDetail{}, err
	}

	var parsed struct {
		ID           string `json:"Id"`
		Name         string `json:"Name"`
		Platform     string `json:"Platform"`
		RestartCount int    `json:"RestartCount"`
		State        struct {
			Status     string `json:"Status"`
			Running    bool   `json:"Running"`
			StartedAt  string `json:"StartedAt"`
			FinishedAt string `json:"FinishedAt"`
		} `json:"State"`
		Config struct {
			Image      string            `json:"Image"`
			Cmd        []string          `json:"Cmd"`
			Entrypoint []string          `json:"Entrypoint"`
			WorkingDir string            `json:"WorkingDir"`
			User       string            `json:"User"`
			Tty        bool              `json:"Tty"`
			Env        []string          `json:"Env"`
			Labels     map[string]string `json:"Labels"`
		} `json:"Config"`
		HostConfig struct {
			RestartPolicy struct {
				Name string `json:"Name"`
			} `json:"RestartPolicy"`
		} `json:"HostConfig"`
		Mounts []struct {
			Type        string `json:"Type"`
			Name        string `json:"Name"`
			Source      string `json:"Source"`
			Destination string `json:"Destination"`
			Mode        string `json:"Mode"`
			RW          bool   `json:"RW"`
		} `json:"Mounts"`
		NetworkSettings struct {
			Ports map[string][]struct {
				HostIP   string `json:"HostIp"`
				HostPort string `json:"HostPort"`
			} `json:"Ports"`
			Networks map[string]struct {
				IPAddress string `json:"IPAddress"`
			} `json:"Networks"`
		} `json:"NetworkSettings"`
	}
	if err := json.Unmarshal(bodyBytes, &parsed); err != nil {
		return ContainerInspectDetail{}, err
	}

	mounts := make([]MountPoint, 0, len(parsed.Mounts))
	for _, m := range parsed.Mounts {
		mounts = append(mounts, MountPoint{
			Type:        m.Type,
			Name:        m.Name,
			Source:      m.Source,
			Destination: m.Destination,
			Mode:        m.Mode,
			RW:          m.RW,
		})
	}

	nets := make(map[string]string, len(parsed.NetworkSettings.Networks))
	for k, v := range parsed.NetworkSettings.Networks {
		nets[k] = v.IPAddress
	}

	var ports []PortBinding
	for portProto, bindings := range parsed.NetworkSettings.Ports {
		parts := strings.Split(portProto, "/")
		var priv uint16
		fmt.Sscanf(parts[0], "%d", &priv)
		proto := "tcp"
		if len(parts) > 1 {
			proto = parts[1]
		}
		if len(bindings) == 0 {
			ports = append(ports, PortBinding{PrivatePort: priv, Type: proto})
			continue
		}
		for _, b := range bindings {
			var pub uint16
			fmt.Sscanf(b.HostPort, "%d", &pub)
			ports = append(ports, PortBinding{
				IP:          b.HostIP,
				PrivatePort: priv,
				PublicPort:  pub,
				Type:        proto,
			})
		}
	}

	return ContainerInspectDetail{
		ID:            parsed.ID,
		Name:          strings.TrimPrefix(parsed.Name, "/"),
		Image:         parsed.Config.Image,
		State:         parsed.State.Status,
		Status:        parsed.State.Status,
		StartedAt:     parsed.State.StartedAt,
		FinishedAt:    parsed.State.FinishedAt,
		RestartCount:  parsed.RestartCount,
		RestartPolicy: parsed.HostConfig.RestartPolicy.Name,
		Platform:      parsed.Platform,
		Command:       parsed.Config.Cmd,
		Entrypoint:    parsed.Config.Entrypoint,
		WorkingDir:    parsed.Config.WorkingDir,
		User:          parsed.Config.User,
		TTY:           parsed.Config.Tty,
		Env:           parsed.Config.Env,
		Labels:        parsed.Config.Labels,
		Mounts:        mounts,
		Ports:         dedupePorts(ports),
		Networks:      nets,
		Raw:           rawMap,
	}, nil
}

// StreamContainerLogs streams historical and live logs for a single container.
func (c *Client) StreamContainerLogs(ctx context.Context, id string, tail int, follow bool, meta LogEntry, onEntry func(LogEntry) error) error {
	if tail <= 0 {
		tail = 300
	}
	isTTY := false
	if detail, err := c.InspectContainer(ctx, id); err == nil {
		isTTY = detail.TTY
		if meta.ContainerName == "" {
			meta.ContainerName = detail.Name
		}
		if meta.Service == "" {
			meta.Service = detail.Labels["com.docker.compose.service"]
		}
	}
	meta.ContainerID = id

	q := url.Values{}
	q.Set("stdout", "true")
	q.Set("stderr", "true")
	q.Set("timestamps", "true")
	q.Set("tail", fmt.Sprintf("%d", tail))
	if follow {
		q.Set("follow", "true")
	}

	resp, err := c.doRequest(ctx, http.MethodGet, fmt.Sprintf("/containers/%s/logs?%s", url.PathEscape(id), q.Encode()), nil, nil)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	return DemuxDockerStream(ctx, resp.Body, isTTY, meta, onEntry)
}

// StreamComposeLogs multiplexes live log streams across all containers in a Compose stack.
func (c *Client) StreamComposeLogs(ctx context.Context, project string, tail int, onEntry func(LogEntry) error) error {
	list, err := c.ListContainers(ctx, false)
	if err != nil {
		return err
	}
	var targets []ContainerSummary
	for _, g := range list.ComposeGroups {
		if g.Name == project {
			targets = g.Containers
			break
		}
	}
	if len(targets) == 0 {
		return fmt.Errorf("compose project %q not found", project)
	}

	if tail <= 0 {
		tail = 100
	}

	ch := make(chan LogEntry, 256)
	var wg sync.WaitGroup
	streamCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	for _, ctr := range targets {
		wg.Add(1)
		go func(target ContainerSummary) {
			defer wg.Done()
			svc := target.ComposeService
			if svc == "" {
				svc = target.Name
			}
			meta := LogEntry{
				ContainerID:   target.ID,
				ContainerName: target.Name,
				Service:       svc,
			}
			_ = c.StreamContainerLogs(streamCtx, target.ID, tail, true, meta, func(entry LogEntry) error {
				select {
				case ch <- entry:
					return nil
				case <-streamCtx.Done():
					return streamCtx.Err()
				}
			})
		}(ctr)
	}

	go func() {
		wg.Wait()
		close(ch)
	}()

	for {
		select {
		case <-ctx.Done():
			return nil
		case entry, ok := <-ch:
			if !ok {
				return nil
			}
			if err := onEntry(entry); err != nil {
				return err
			}
		}
	}
}
