package docker

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type volCacheEntry struct {
	entries  []string
	cachedAt time.Time
	failed   bool
}

// Client communicates with a local Docker Engine over Unix domain socket or TCP.
type Client struct {
	network    string // "unix" or "tcp"
	addr       string // socket path or host:port
	displayURI string
	httpClient *http.Client

	volMu             sync.Mutex
	volProbeMu        sync.Mutex
	volCache          map[string]volCacheEntry
	probeBlockedUntil time.Time
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

func round2(v float64) float64 {
	return float64(int64(v*100+0.5)) / 100.0
}
