package docker

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// Client communicates with a local Docker Engine over Unix domain socket or TCP.
type Client struct {
	network    string // "unix" or "tcp"
	addr       string // socket path or host:port
	displayURI string
	httpClient *http.Client

	volMu    sync.Mutex
	volCache map[string][]string
}

// ResolveEndpoint determines the Docker socket/endpoint in portable priority order:
// 1. explicit CLI flag (--socket)
// 2. DOCKER_HOST environment variable
// 3. $XDG_RUNTIME_DIR/docker.sock (Rootless Docker on Linux)
// 4. /var/run/docker.sock (Standard Linux default)
func ResolveEndpoint(explicit string) (network, addr, displayURI string) {
	raw := strings.TrimSpace(explicit)
	if raw == "" {
		raw = strings.TrimSpace(os.Getenv("DOCKER_HOST"))
	}
	if raw != "" {
		if strings.HasPrefix(raw, "unix://") {
			p := strings.TrimPrefix(raw, "unix://")
			return "unix", p, "unix://" + p
		}
		if strings.HasPrefix(raw, "tcp://") {
			h := strings.TrimPrefix(raw, "tcp://")
			return "tcp", h, "tcp://" + h
		}
		if strings.HasPrefix(raw, "http://") {
			h := strings.TrimPrefix(raw, "http://")
			return "tcp", h, "tcp://" + h
		}
		return "unix", raw, "unix://" + raw
	}

	if xdg := os.Getenv("XDG_RUNTIME_DIR"); xdg != "" {
		rootlessSock := filepath.Join(xdg, "docker.sock")
		if fi, err := os.Stat(rootlessSock); err == nil && !fi.IsDir() {
			if _, dialErr := os.Stat("/var/run/docker.sock"); dialErr != nil {
				return "unix", rootlessSock, "unix://" + rootlessSock
			}
		}
	}

	if fi, err := os.Stat("/var/run/docker.sock"); err == nil && !fi.IsDir() {
		return "unix", "/var/run/docker.sock", "unix:///var/run/docker.sock"
	}

	// Check common user-scoped sockets on macOS and Linux (Docker Desktop, OrbStack, Colima, Rancher Desktop)
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		candidates := []string{
			filepath.Join(home, ".docker", "run", "docker.sock"),
			filepath.Join(home, ".orbstack", "run", "docker.sock"),
			filepath.Join(home, ".colima", "default", "docker.sock"),
			filepath.Join(home, ".rd", "docker.sock"),
		}
		for _, cand := range candidates {
			if fi, sErr := os.Stat(cand); sErr == nil && !fi.IsDir() {
				return "unix", cand, "unix://" + cand
			}
		}
	}

	defaultSock := "/var/run/docker.sock"
	return "unix", defaultSock, "unix://" + defaultSock
}

// NewClient creates a new Docker Engine client.
func NewClient(explicitEndpoint string) *Client {
	netType, addr, display := ResolveEndpoint(explicitEndpoint)
	tr := &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, netType, addr)
		},
		DisableCompression: true,
	}
	return &Client{
		network:    netType,
		addr:       addr,
		displayURI: display,
		httpClient: &http.Client{
			Transport: tr,
		},
	}
}

// SocketURI returns the human-readable endpoint URI (e.g. unix:///var/run/docker.sock).
func (c *Client) SocketURI() string {
	return c.displayURI
}

func (c *Client) doRequest(ctx context.Context, method, path string, body io.Reader, headers map[string]string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, method, "http://localhost"+path, body)
	if err != nil {
		return nil, err
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode >= 400 {
		defer resp.Body.Close()
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 8192))
		var apiErr struct {
			Message string `json:"message"`
		}
		if json.Unmarshal(msg, &apiErr) == nil && apiErr.Message != "" {
			return nil, fmt.Errorf("docker API %s %s (%d): %s", method, path, resp.StatusCode, apiErr.Message)
		}
		return nil, fmt.Errorf("docker API %s %s (%d): %s", method, path, resp.StatusCode, strings.TrimSpace(string(msg)))
	}
	return resp, nil
}

func (c *Client) getJSON(ctx context.Context, path string, out any) error {
	resp, err := c.doRequest(ctx, http.MethodGet, path, nil, nil)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	return json.NewDecoder(resp.Body).Decode(out)
}

// GetEngineInfo fetches daemon info and version metadata.
func (c *Client) GetEngineInfo(ctx context.Context) (EngineInfo, error) {
	var rawInfo struct {
		Name              string `json:"Name"`
		ServerVersion     string `json:"ServerVersion"`
		OperatingSystem   string `json:"OperatingSystem"`
		Architecture      string `json:"Architecture"`
		KernelVersion     string `json:"KernelVersion"`
		DockerRootDir     string `json:"DockerRootDir"`
		Driver            string `json:"Driver"`
		Containers        int    `json:"Containers"`
		ContainersRunning int    `json:"ContainersRunning"`
		ContainersPaused  int    `json:"ContainersPaused"`
		ContainersStopped int    `json:"ContainersStopped"`
		Images            int    `json:"Images"`
		MemTotal          int64  `json:"MemTotal"`
		NCPU              int    `json:"NCPU"`
	}
	if err := c.getJSON(ctx, "/info", &rawInfo); err != nil {
		return EngineInfo{SocketPath: c.displayURI}, err
	}

	var rawVer struct {
		Version    string `json:"Version"`
		APIVersion string `json:"ApiVersion"`
	}
	_ = c.getJSON(ctx, "/version", &rawVer)

	serverVer := rawInfo.ServerVersion
	if serverVer == "" {
		serverVer = rawVer.Version
	}

	return EngineInfo{
		Hostname:          rawInfo.Name,
		ServerVersion:     serverVer,
		APIVersion:        rawVer.APIVersion,
		OperatingSystem:   rawInfo.OperatingSystem,
		Architecture:      rawInfo.Architecture,
		KernelVersion:     rawInfo.KernelVersion,
		DockerRootDir:     rawInfo.DockerRootDir,
		StorageDriver:     rawInfo.Driver,
		SocketPath:        c.displayURI,
		Containers:        rawInfo.Containers,
		ContainersRunning: rawInfo.ContainersRunning,
		ContainersPaused:  rawInfo.ContainersPaused,
		ContainersStopped: rawInfo.ContainersStopped,
		Images:            rawInfo.Images,
		MemTotal:          rawInfo.MemTotal,
		NCPU:              rawInfo.NCPU,
	}, nil
}

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

func (c *Client) populateRunningStats(ctx context.Context, containers []ContainerSummary) {
	statsCtx, cancel := context.WithTimeout(ctx, 2500*time.Millisecond)
	defer cancel()

	var wg sync.WaitGroup
	for i := range containers {
		if containers[i].State != "running" {
			continue
		}
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
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
	Read     time.Time `json:"read"`
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
			Ports    map[string][]struct {
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

// ListImages lists all Docker images enriched with active container usage references.
func (c *Client) ListImages(ctx context.Context) ([]ImageSummary, error) {
	var rawImages []struct {
		ID          string   `json:"Id"`
		RepoTags    []string `json:"RepoTags"`
		RepoDigests []string `json:"RepoDigests"`
		Created     int64    `json:"Created"`
		Size        int64    `json:"Size"`
		SharedSize  int64    `json:"SharedSize"`
		Containers  int64    `json:"Containers"`
	}
	if err := c.getJSON(ctx, "/images/json?all=0", &rawImages); err != nil {
		return nil, err
	}

	ctrs, _ := c.ListContainers(ctx, false)
	usedByMap := make(map[string][]string)
	addRef := func(imgID, name string) {
		usedByMap[imgID] = append(usedByMap[imgID], name)
	}
	for _, g := range ctrs.ComposeGroups {
		for _, ctr := range g.Containers {
			addRef(ctr.ImageID, ctr.Name)
		}
	}
	for _, ctr := range ctrs.Standalone {
		addRef(ctr.ImageID, ctr.Name)
	}

	out := make([]ImageSummary, 0, len(rawImages))
	for _, ri := range rawImages {
		shortID := strings.TrimPrefix(ri.ID, "sha256:")
		if len(shortID) > 12 {
			shortID = shortID[:12]
		}
		repo := "<none>"
		tag := "<none>"
		if len(ri.RepoTags) > 0 && ri.RepoTags[0] != "<none>:<none>" {
			parts := strings.Split(ri.RepoTags[0], ":")
			if len(parts) > 1 {
				tag = parts[len(parts)-1]
				repo = strings.Join(parts[:len(parts)-1], ":")
			} else {
				repo = ri.RepoTags[0]
				tag = "latest"
			}
		} else if len(ri.RepoDigests) > 0 {
			parts := strings.Split(ri.RepoDigests[0], "@")
			if len(parts) > 0 && parts[0] != "<none>" {
				repo = parts[0]
			}
		}

		usedBy := usedByMap[ri.ID]
		inUse := len(usedBy) > 0 || ri.Containers > 0

		out = append(out, ImageSummary{
			ID:               ri.ID,
			ShortID:          shortID,
			RepoTags:         ri.RepoTags,
			Repository:       repo,
			Tag:              tag,
			Created:          ri.Created,
			SizeBytes:        ri.Size,
			SharedSizeBytes:  ri.SharedSize,
			Containers:       int64(len(usedBy)),
			InUse:            inUse,
			UsedByContainers: usedBy,
		})
	}

	sort.Slice(out, func(i, j int) bool {
		if out[i].InUse != out[j].InUse {
			return out[i].InUse
		}
		return out[i].Created > out[j].Created
	})

	return out, nil
}

// PullImage pulls an image from a registry and streams JSON progress updates.
func (c *Client) PullImage(ctx context.Context, fromImage string, onProgress func(map[string]any) error) error {
	q := url.Values{}
	q.Set("fromImage", strings.TrimSpace(fromImage))
	resp, err := c.doRequest(ctx, http.MethodPost, "/images/create?"+q.Encode(), nil, nil)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	dec := json.NewDecoder(resp.Body)
	for {
		var msg map[string]any
		if err := dec.Decode(&msg); err != nil {
			if err == io.EOF {
				return nil
			}
			return err
		}
		if err := onProgress(msg); err != nil {
			return err
		}
	}
}

// RemoveImage removes an image by ID or reference.
func (c *Client) RemoveImage(ctx context.Context, id string, force bool) error {
	q := url.Values{}
	if force {
		q.Set("force", "true")
	}
	resp, err := c.doRequest(ctx, http.MethodDelete, fmt.Sprintf("/images/%s?%s", url.PathEscape(id), q.Encode()), nil, nil)
	if err != nil {
		return err
	}
	resp.Body.Close()
	return nil
}

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

// CreateVolume creates a named Docker volume.
func (c *Client) CreateVolume(ctx context.Context, name string) error {
	payload, _ := json.Marshal(map[string]string{"Name": strings.TrimSpace(name)})
	resp, err := c.doRequest(ctx, http.MethodPost, "/volumes/create", bytes.NewReader(payload), map[string]string{
		"Content-Type": "application/json",
	})
	if err != nil {
		return err
	}
	resp.Body.Close()
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
	return nil
}

// ListNetworks lists all Docker networks and their attached containers.
func (c *Client) ListNetworks(ctx context.Context) ([]NetworkSummary, error) {
	var rawNets []struct {
		ID         string `json:"Id"`
		Name       string `json:"Name"`
		Driver     string `json:"Driver"`
		Scope      string `json:"Scope"`
		Internal   bool   `json:"Internal"`
		Attachable bool   `json:"Attachable"`
		Created    string `json:"Created"`
		IPAM       struct {
			Config []struct {
				Subnet  string `json:"Subnet"`
				Gateway string `json:"Gateway"`
			} `json:"Config"`
		} `json:"IPAM"`
		Containers map[string]struct {
			Name        string `json:"Name"`
			IPv4Address string `json:"IPv4Address"`
			MacAddress  string `json:"MacAddress"`
		} `json:"Containers"`
	}
	if err := c.getJSON(ctx, "/networks", &rawNets); err != nil {
		return nil, err
	}

	// Cross-reference container networks from /containers/json since some Docker versions omit Containers map in /networks list
	ctrs, _ := c.ListContainers(ctx, false)
	byNet := make(map[string][]NetworkContainerEndpoint)
	recordNet := func(ctr ContainerSummary) {
		for _, n := range ctr.Networks {
			byNet[n] = append(byNet[n], NetworkContainerEndpoint{
				ContainerID:   ctr.ShortID,
				ContainerName: ctr.Name,
			})
		}
	}
	for _, g := range ctrs.ComposeGroups {
		for _, ctr := range g.Containers {
			recordNet(ctr)
		}
	}
	for _, ctr := range ctrs.Standalone {
		recordNet(ctr)
	}

	out := make([]NetworkSummary, 0, len(rawNets))
	for _, rn := range rawNets {
		shortID := rn.ID
		if len(shortID) > 12 {
			shortID = shortID[:12]
		}
		var subnet, gateway string
		if len(rn.IPAM.Config) > 0 {
			subnet = rn.IPAM.Config[0].Subnet
			gateway = rn.IPAM.Config[0].Gateway
		}
		endpoints := make([]NetworkContainerEndpoint, 0)
		for cid, ep := range rn.Containers {
			shortC := cid
			if len(shortC) > 12 {
				shortC = shortC[:12]
			}
			endpoints = append(endpoints, NetworkContainerEndpoint{
				ContainerID:   shortC,
				ContainerName: ep.Name,
				IPv4Address:   ep.IPv4Address,
				MacAddress:    ep.MacAddress,
			})
		}
		if len(endpoints) == 0 {
			endpoints = byNet[rn.Name]
		}
		builtIn := rn.Name == "bridge" || rn.Name == "host" || rn.Name == "none"

		out = append(out, NetworkSummary{
			ID:         rn.ID,
			ShortID:    shortID,
			Name:       rn.Name,
			Driver:     rn.Driver,
			Scope:      rn.Scope,
			Internal:   rn.Internal,
			Attachable: rn.Attachable,
			Subnet:     subnet,
			Gateway:    gateway,
			Created:    rn.Created,
			BuiltIn:    builtIn,
			InUse:      len(endpoints) > 0 || builtIn,
			Containers: endpoints,
		})
	}

	sort.Slice(out, func(i, j int) bool {
		return out[i].Name < out[j].Name
	})

	return out, nil
}

// RemoveNetwork removes a custom Docker network by ID.
func (c *Client) RemoveNetwork(ctx context.Context, id string) error {
	resp, err := c.doRequest(ctx, http.MethodDelete, fmt.Sprintf("/networks/%s", url.PathEscape(id)), nil, nil)
	if err != nil {
		return err
	}
	resp.Body.Close()
	return nil
}

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

func round2(v float64) float64 {
	return float64(int64(v*100+0.5)) / 100.0
}

// Ensure bufio is referenced for stream readers in exec.go.
var _ = bufio.NewReader
