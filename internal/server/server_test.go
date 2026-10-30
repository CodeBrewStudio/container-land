package server

import (
	"bytes"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/container-land/container-land/internal/docker"
	"github.com/container-land/container-land/internal/host"
)

func newMockDockerSocket(t *testing.T) string {
	t.Helper()
	sockPath := filepath.Join(t.TempDir(), "docker.sock")
	ln, err := net.Listen("unix", sockPath)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })

	mux := http.NewServeMux()
	mux.HandleFunc("/info", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"Name":              "portable-host",
			"ServerVersion":     "29.9.2",
			"OperatingSystem":   "Linux",
			"Architecture":      "x86_64",
			"DockerRootDir":     "/var/lib/docker",
			"Driver":            "overlay2",
			"Containers":        2,
			"ContainersRunning": 2,
			"Images":            5,
		})
	})
	mux.HandleFunc("/version", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"Version": "29.9.2", "ApiVersion": "1.56"})
	})
	mux.HandleFunc("/containers/json", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode([]map[string]any{
			{
				"Id":      "c1111111111111111111",
				"Names":   []string{"/acme-api-1"},
				"Image":   "acme/api:latest",
				"ImageID": "sha256:1111",
				"State":   "running",
				"Status":  "Up 1 hour",
				"Labels": map[string]string{
					"com.docker.compose.project": "acme",
					"com.docker.compose.service": "api",
				},
			},
		})
	})
	mux.HandleFunc("/containers/", func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/stats") {
			_ = json.NewEncoder(w).Encode(map[string]any{})
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("/containers/prune", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ContainersDeleted": []string{"old-c1"},
			"SpaceReclaimed":    1024,
		})
	})
	mux.HandleFunc("/images/prune", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ImagesDeleted":  []map[string]string{{"Deleted": "sha256:deadbeef"}},
			"SpaceReclaimed": 4096,
		})
	})
	mux.HandleFunc("/build/prune", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"CachesDeleted":  []string{"bc1"},
			"SpaceReclaimed": 2048,
		})
	})
	mux.HandleFunc("/volumes", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"Volumes": []any{}})
	})
	mux.HandleFunc("/networks", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode([]any{})
	})
	mux.HandleFunc("/system/df", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"LayersSize": 5000,
			"Images":     []map[string]any{{"Size": 5000, "SharedSize": 0, "Containers": 1}},
		})
	})

	srv := &http.Server{Handler: mux}
	go func() { _ = srv.Serve(ln) }()
	t.Cleanup(func() { _ = srv.Close() })
	return sockPath
}

func TestServerEndpoints(t *testing.T) {
	sock := newMockDockerSocket(t)
	dc := docker.NewClient(sock)
	hc := host.NewCollector()
	srv := New(dc, hc)

	ts := httptest.NewServer(srv)
	defer ts.Close()

	// 1. Overview
	resp, err := http.Get(ts.URL + "/api/overview")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 for /api/overview, got %d", resp.StatusCode)
	}
	var ov OverviewResponse
	if err := json.NewDecoder(resp.Body).Decode(&ov); err != nil {
		t.Fatal(err)
	}
	if ov.Engine.Hostname != "portable-host" || ov.ComposeStackCount != 1 {
		t.Fatalf("unexpected overview: %+v", ov)
	}

	// 2. Compose action
	cResp, err := http.Post(ts.URL+"/api/compose/acme/restart", "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer cResp.Body.Close()
	if cResp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 for compose restart, got %d", cResp.StatusCode)
	}

	// 3. Safe System Prune
	pruneBody, _ := json.Marshal(docker.PruneRequest{
		Containers: true,
		Images:     true,
		BuildCache: true,
		Volumes:    false,
	})
	pResp, err := http.Post(ts.URL+"/api/system/prune", "application/json", bytes.NewReader(pruneBody))
	if err != nil {
		t.Fatal(err)
	}
	defer pResp.Body.Close()
	var pr docker.PruneResponse
	if err := json.NewDecoder(pResp.Body).Decode(&pr); err != nil {
		t.Fatal(err)
	}
	if pr.TotalReclaimedBytes != 1024+4096+2048 {
		t.Fatalf("unexpected TotalReclaimedBytes: %d", pr.TotalReclaimedBytes)
	}

	// 4. Embedded SPA fallback
	spaResp, err := http.Get(ts.URL + "/")
	if err != nil {
		t.Fatal(err)
	}
	defer spaResp.Body.Close()
	if spaResp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 for SPA root, got %d", spaResp.StatusCode)
	}
}
