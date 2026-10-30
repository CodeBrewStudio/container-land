package docker

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"net"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
)

func buildDockerFrame(stream byte, line string) []byte {
	payload := []byte(line)
	header := make([]byte, 8)
	header[0] = stream
	binary.BigEndian.PutUint32(header[4:8], uint32(len(payload)))
	return append(header, payload...)
}

func TestDemuxDockerStream(t *testing.T) {
	var buf bytes.Buffer
	buf.Write(buildDockerFrame(1, "2026-10-30T08:00:01.123456789Z Listening on :3000\n"))
	buf.Write(buildDockerFrame(2, "2026-10-30T08:00:02.000000000Z Deprecated config key\n"))

	var entries []LogEntry
	meta := LogEntry{ContainerName: "acme-api-1", Service: "api"}
	err := DemuxDockerStream(context.Background(), &buf, false, meta, func(e LogEntry) error {
		entries = append(entries, e)
		return nil
	})
	if err != nil {
		t.Fatalf("DemuxDockerStream failed: %v", err)
	}
	if len(entries) != 2 {
		t.Fatalf("expected 2 entries, got %d", len(entries))
	}
	if entries[0].Stream != "stdout" || entries[0].Message != "Listening on :3000" || entries[0].Service != "api" {
		t.Fatalf("unexpected first entry: %+v", entries[0])
	}
	if entries[1].Stream != "stderr" || entries[1].Message != "Deprecated config key" {
		t.Fatalf("unexpected second entry: %+v", entries[1])
	}
}

func TestResolveEndpoint(t *testing.T) {
	netType, addr, uri := ResolveEndpoint("unix:///tmp/custom-docker.sock")
	if netType != "unix" || addr != "/tmp/custom-docker.sock" || uri != "unix:///tmp/custom-docker.sock" {
		t.Fatalf("unexpected explicit endpoint resolution: %s %s %s", netType, addr, uri)
	}

	netType, addr, uri = ResolveEndpoint("tcp://127.0.0.1:2375")
	if netType != "tcp" || addr != "127.0.0.1:2375" || uri != "tcp://127.0.0.1:2375" {
		t.Fatalf("unexpected tcp endpoint resolution: %s %s %s", netType, addr, uri)
	}
}

func TestClientOverUnixSocket(t *testing.T) {
	sockPath := filepath.Join(t.TempDir(), "docker.sock")
	ln, err := net.Listen("unix", sockPath)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()

	mux := http.NewServeMux()
	mux.HandleFunc("/info", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"Name":              "test-linux-box",
			"ServerVersion":     "29.9.2",
			"OperatingSystem":   "Linux",
			"Architecture":      "x86_64",
			"DockerRootDir":     "/var/lib/docker",
			"Driver":            "overlay2",
			"Containers":        3,
			"ContainersRunning": 2,
			"ContainersStopped": 1,
			"Images":            10,
		})
	})
	mux.HandleFunc("/version", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"Version":    "29.9.2",
			"ApiVersion": "1.56",
		})
	})
	mux.HandleFunc("/containers/json", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode([]map[string]any{
			{
				"Id":      "aaaa1111222233334444",
				"Names":   []string{"/acme-platform-api-1"},
				"Image":   "acme/api:dev",
				"ImageID": "sha256:img1",
				"State":   "running",
				"Status":  "Up 2 hours",
				"Ports": []map[string]any{
					{"IP": "0.0.0.0", "PrivatePort": 3000, "PublicPort": 3000, "Type": "tcp"},
					{"IP": "::", "PrivatePort": 3000, "PublicPort": 3000, "Type": "tcp"},
				},
				"Labels": map[string]string{
					"com.docker.compose.project":              "acme-platform",
					"com.docker.compose.service":              "api",
					"com.docker.compose.project.working_dir":  "/srv/acme",
					"com.docker.compose.project.config_files": "/srv/acme/compose.yaml",
				},
			},
			{
				"Id":      "bbbb1111222233334444",
				"Names":   []string{"/acme-platform-db-1"},
				"Image":   "postgres:18",
				"ImageID": "sha256:img2",
				"State":   "running",
				"Status":  "Up 2 hours",
				"Labels": map[string]string{
					"com.docker.compose.project": "acme-platform",
					"com.docker.compose.service": "db",
				},
			},
			{
				"Id":      "cccc1111222233334444",
				"Names":   []string{"/standalone-redis"},
				"Image":   "redis:7-alpine",
				"ImageID": "sha256:img3",
				"State":   "exited",
				"Status":  "Exited (0) 1 hour ago",
				"Labels":  map[string]string{},
			},
		})
	})
	mux.HandleFunc("/containers/", func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/stats"):
			_ = json.NewEncoder(w).Encode(map[string]any{
				"cpu_stats": map[string]any{
					"cpu_usage":        map[string]any{"total_usage": 200000000},
					"system_cpu_usage": 1000000000,
					"online_cpus":      4,
				},
				"precpu_stats": map[string]any{
					"cpu_usage":        map[string]any{"total_usage": 100000000},
					"system_cpu_usage": 0,
				},
				"memory_stats": map[string]any{
					"usage": 524288000,
					"limit": 1048576000,
					"stats": map[string]uint64{"inactive_file": 262144000},
				},
			})
		case strings.HasSuffix(r.URL.Path, "/json"):
			_ = json.NewEncoder(w).Encode(map[string]any{
				"Id":   "aaaa1111222233334444",
				"Name": "/acme-platform-api-1",
				"Config": map[string]any{
					"Image":  "acme/api:dev",
					"Tty":    false,
					"Labels": map[string]string{"com.docker.compose.service": "api"},
				},
				"State": map[string]any{"Status": "running", "Running": true},
			})
		case strings.HasSuffix(r.URL.Path, "/logs"):
			_, _ = w.Write(buildDockerFrame(1, "2026-10-30T08:00:05Z ready\n"))
		default:
			w.WriteHeader(http.StatusNoContent)
		}
	})
	mux.HandleFunc("/system/df", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"LayersSize": 1000,
			"Images": []map[string]any{
				{"Size": 600, "SharedSize": 100, "Containers": 1},
				{"Size": 500, "SharedSize": 100, "Containers": 0},
			},
			"Containers": []map[string]any{
				{"State": "running", "SizeRw": 50},
				{"State": "exited", "SizeRw": 25},
			},
			"Volumes": []map[string]any{
				{"UsageData": map[string]any{"Size": 2000, "RefCount": 0}},
			},
			"BuildCache": []map[string]any{
				{"Size": 300, "Shared": false, "InUse": false},
			},
		})
	})

	srv := &http.Server{Handler: mux}
	go func() { _ = srv.Serve(ln) }()
	defer srv.Close()

	client := NewClient(sockPath)
	ctx := context.Background()

	info, err := client.GetEngineInfo(ctx)
	if err != nil {
		t.Fatalf("GetEngineInfo failed: %v", err)
	}
	if info.Hostname != "test-linux-box" || info.APIVersion != "1.56" {
		t.Fatalf("unexpected EngineInfo: %+v", info)
	}

	ctrs, err := client.ListContainers(ctx, true)
	if err != nil {
		t.Fatalf("ListContainers failed: %v", err)
	}
	if len(ctrs.ComposeGroups) != 1 || ctrs.ComposeGroups[0].Name != "acme-platform" {
		t.Fatalf("expected 1 compose group acme-platform, got %+v", ctrs.ComposeGroups)
	}
	if ctrs.ComposeGroups[0].RunningCount != 2 || ctrs.ComposeGroups[0].TotalCount != 2 {
		t.Fatalf("unexpected compose counts: %+v", ctrs.ComposeGroups[0])
	}
	if len(ctrs.ComposeGroups[0].ExposedPorts) != 1 {
		t.Fatalf("expected deduplicated port binding, got %+v", ctrs.ComposeGroups[0].ExposedPorts)
	}
	if len(ctrs.Standalone) != 1 || ctrs.Standalone[0].Name != "standalone-redis" {
		t.Fatalf("unexpected standalone containers: %+v", ctrs.Standalone)
	}

	// Verify multiplexed Compose stack log streaming
	var composeLogs []LogEntry
	if err := client.StreamComposeLogs(ctx, "acme-platform", 50, func(e LogEntry) error {
		composeLogs = append(composeLogs, e)
		return nil
	}); err != nil {
		t.Fatalf("StreamComposeLogs failed: %v", err)
	}
	if len(composeLogs) != 2 {
		t.Fatalf("expected 2 compose log lines (1 per service), got %d", len(composeLogs))
	}

	// Verify disk usage calculation (SafeReclaimable excludes volumes)
	df, err := client.GetDiskUsage(ctx)
	if err != nil {
		t.Fatalf("GetDiskUsage failed: %v", err)
	}
	// ImagesReclaimable = 500-100 = 400; ContainersReclaimable = 25; BuildCacheReclaimable = 300 => SafeReclaimable = 725
	if df.SafeReclaimable != 725 {
		t.Fatalf("expected SafeReclaimable 725, got %d", df.SafeReclaimable)
	}
	if df.TotalReclaimable != 2725 {
		t.Fatalf("expected TotalReclaimable 2725, got %d", df.TotalReclaimable)
	}
}

func TestClassifyVolumeContents(t *testing.T) {
	if !isHexHash64(strings.Repeat("a1b2c3d4", 8)) {
		t.Fatal("expected 64-char hex string to be detected as anonymous hash")
	}
	if isHexHash64("my-named-postgres-volume") {
		t.Fatal("expected named volume not to be detected as anonymous hash")
	}

	cases := []struct {
		entries []string
		size    int64
		want    string
	}{
		{nil, 0, "Empty volume"},
		{[]string{"buildkit", "containers", "image", "overlay2", "volumes"}, 1024, "Docker-in-Docker (/var/lib/docker)"},
		{[]string{"PG_VERSION", "base", "global", "pg_wal", "postgresql.conf"}, 1024, "PostgreSQL database"},
		{[]string{"18"}, 1024, "PostgreSQL 18 data (18/)"},
		{[]string{"mnesia", ".erlang.cookie"}, 1024, "RabbitMQ data (mnesia)"},
		{[]string{".bin", "react", "typescript", "vite"}, 1024, "Node.js packages (node_modules)"},
		{[]string{"dump.rdb"}, 1024, "Redis persistence data"},
	}
	for _, tc := range cases {
		got := inferVolumeContentHint(tc.entries, tc.size)
		if got != tc.want {
			t.Fatalf("inferVolumeContentHint(%v, %d) = %q, want %q", tc.entries, tc.size, got, tc.want)
		}
	}
}
