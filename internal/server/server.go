package server

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/container-land/container-land/internal/docker"
	"github.com/container-land/container-land/internal/host"
)

// OverviewResponse combines Docker Engine metadata, host resource telemetry, and disk usage.
type OverviewResponse struct {
	Engine            docker.EngineInfo       `json:"engine"`
	Host              host.Snapshot           `json:"host"`
	DiskUsage         docker.DiskUsageSummary `json:"diskUsage"`
	ComposeStackCount int                     `json:"composeStackCount"`
	VolumeCount       int                     `json:"volumeCount"`
	NetworkCount      int                     `json:"networkCount"`
}

// Server exposes the Container Land REST API, SSE streams, WebSocket exec bridge, and embedded web UI.
type Server struct {
	docker *docker.Client
	host   *host.Collector
	mux    *http.ServeMux

	dfMu       sync.Mutex
	cachedDF   docker.DiskUsageSummary
	cachedDFAt time.Time
}

// New creates a new Server instance.
func New(dockerClient *docker.Client, hostCollector *host.Collector) *Server {
	s := &Server{
		docker: dockerClient,
		host:   hostCollector,
		mux:    http.NewServeMux(),
	}
	s.registerRoutes()
	return s
}

// ServeHTTP implements http.Handler.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.mux.ServeHTTP(w, r)
}

func (s *Server) registerRoutes() {
	s.mux.HandleFunc("/api/overview", s.handleOverview)
	s.mux.HandleFunc("/api/events", s.handleEventsSSE)
	s.mux.HandleFunc("/api/containers", s.handleContainers)
	s.mux.HandleFunc("/api/containers/", s.handleContainerSubroutes)
	s.mux.HandleFunc("/api/compose/", s.handleComposeSubroutes)
	s.mux.HandleFunc("/api/images", s.handleImages)
	s.mux.HandleFunc("/api/images/pull", s.handleImagePullSSE)
	s.mux.HandleFunc("/api/images/", s.handleImageDelete)
	s.mux.HandleFunc("/api/volumes", s.handleVolumes)
	s.mux.HandleFunc("/api/volumes/", s.handleVolumeDelete)
	s.mux.HandleFunc("/api/networks", s.handleNetworks)
	s.mux.HandleFunc("/api/networks/", s.handleNetworkDelete)
	s.mux.HandleFunc("/api/system/df", s.handleSystemDF)
	s.mux.HandleFunc("/api/system/prune", s.handleSystemPrune)

	// Embedded SPA static asset handler with fallback to index.html
	sub, err := distFS()
	if err == nil {
		fileServer := http.FileServer(http.FS(sub))
		s.mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
			if strings.HasPrefix(r.URL.Path, "/api/") {
				writeError(w, http.StatusNotFound, "API endpoint not found")
				return
			}
			path := strings.TrimPrefix(r.URL.Path, "/")
			if path == "" {
				path = "index.html"
			}
			if f, openErr := sub.Open(path); openErr == nil {
				_ = f.Close()
				fileServer.ServeHTTP(w, r)
				return
			}
			// SPA fallback
			r.URL.Path = "/"
			fileServer.ServeHTTP(w, r)
		})
	}
}

func (s *Server) getDiskUsageCached(ctx context.Context, forceRefresh bool) (docker.DiskUsageSummary, error) {
	s.dfMu.Lock()
	if !forceRefresh && time.Since(s.cachedDFAt) < 15*time.Second && s.cachedDF.TotalSize > 0 {
		df := s.cachedDF
		s.dfMu.Unlock()
		return df, nil
	}
	s.dfMu.Unlock()

	df, err := s.docker.GetDiskUsage(ctx)
	if err != nil {
		return df, err
	}
	s.dfMu.Lock()
	s.cachedDF = df
	s.cachedDFAt = time.Now()
	s.dfMu.Unlock()
	return df, nil
}

func (s *Server) buildOverview(ctx context.Context, forceDF bool) (OverviewResponse, error) {
	info, err := s.docker.GetEngineInfo(ctx)
	if err != nil {
		return OverviewResponse{}, err
	}
	hostSnap := s.host.Collect(info.DockerRootDir)
	// Fallback to Docker Engine /info metrics on non-Linux hosts (e.g. macOS) where /proc is unavailable
	if hostSnap.MemTotalBytes == 0 && info.MemTotal > 0 {
		hostSnap.MemTotalBytes = uint64(info.MemTotal)
	}
	if hostSnap.CPUCores == 0 && info.NCPU > 0 {
		hostSnap.CPUCores = info.NCPU
	}
	if hostSnap.KernelVersion == "" && info.KernelVersion != "" {
		hostSnap.KernelVersion = info.KernelVersion
	}
	if hostSnap.CPUModel == "" && info.OperatingSystem != "" {
		hostSnap.CPUModel = info.OperatingSystem + " (" + info.Architecture + ")"
	}
	df, _ := s.getDiskUsageCached(ctx, forceDF)

	ctrs, _ := s.docker.ListContainers(ctx, false)
	nets, _ := s.docker.ListNetworks(ctx)

	volCount := df.VolumesTotal
	if volCount == 0 {
		if vols, vErr := s.docker.ListVolumes(ctx); vErr == nil {
			volCount = len(vols)
		}
	}

	return OverviewResponse{
		Engine:            info,
		Host:              hostSnap,
		DiskUsage:         df,
		ComposeStackCount: len(ctrs.ComposeGroups),
		VolumeCount:       volCount,
		NetworkCount:      len(nets),
	}, nil
}

func (s *Server) handleOverview(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	force := r.URL.Query().Get("refresh") == "true"
	ov, err := s.buildOverview(r.Context(), force)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, ov)
}

func (s *Server) handleEventsSSE(w http.ResponseWriter, r *http.Request) {
	flusher, ok := prepareSSE(w)
	if !ok {
		return
	}
	ctx := r.Context()

	// Send initial overview immediately
	if ov, err := s.buildOverview(ctx, false); err == nil {
		_ = writeSSEEvent(w, flusher, "overview", ov)
	}

	var writeMu sync.Mutex
	safeSend := func(event string, payload any) error {
		writeMu.Lock()
		defer writeMu.Unlock()
		return writeSSEEvent(w, flusher, event, payload)
	}

	// Stream live Docker daemon events in background goroutine
	go func() {
		_ = s.docker.StreamEvents(ctx, func(ev docker.DaemonEvent) error {
			return safeSend("docker", ev)
		})
	}()

	ticker := time.NewTicker(2500 * time.Millisecond)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			ov, err := s.buildOverview(ctx, false)
			if err != nil {
				continue
			}
			if err := safeSend("overview", ov); err != nil {
				return
			}
		}
	}
}

func (s *Server) handleContainers(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	withStats := r.URL.Query().Get("stats") != "false"
	res, err := s.docker.ListContainers(r.Context(), withStats)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func (s *Server) handleContainerSubroutes(w http.ResponseWriter, r *http.Request) {
	trimmed := strings.TrimPrefix(r.URL.Path, "/api/containers/")
	parts := strings.Split(trimmed, "/")
	if len(parts) == 0 || parts[0] == "" {
		writeError(w, http.StatusBadRequest, "missing container id")
		return
	}
	id := parts[0]

	if len(parts) == 1 {
		if r.Method == http.MethodDelete {
			force := r.URL.Query().Get("force") != "false"
			volumes := r.URL.Query().Get("volumes") == "true"
			if err := s.docker.RemoveContainer(r.Context(), id, force, volumes); err != nil {
				writeError(w, http.StatusBadGateway, err.Error())
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{"deleted": id})
			return
		}
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	sub := parts[1]
	switch sub {
	case "start", "stop", "restart":
		if r.Method != http.MethodPost {
			writeError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		if err := s.docker.ContainerAction(r.Context(), id, sub); err != nil {
			writeError(w, http.StatusBadGateway, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"id": id, "action": sub, "ok": true})

	case "inspect":
		if r.Method != http.MethodGet {
			writeError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		detail, err := s.docker.InspectContainer(r.Context(), id)
		if err != nil {
			writeError(w, http.StatusBadGateway, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, detail)

	case "logs":
		s.handleContainerLogsSSE(w, r, id)

	case "stats":
		s.handleContainerStatsSSE(w, r, id)

	case "exec":
		s.handleContainerExecWS(w, r, id)

	default:
		writeError(w, http.StatusNotFound, "unknown container route")
	}
}

func (s *Server) handleContainerLogsSSE(w http.ResponseWriter, r *http.Request, id string) {
	flusher, ok := prepareSSE(w)
	if !ok {
		return
	}
	tail := 300
	if rawTail := r.URL.Query().Get("tail"); rawTail != "" {
		if parsed, err := strconv.Atoi(rawTail); err == nil && parsed > 0 {
			tail = parsed
		}
	}
	follow := r.URL.Query().Get("follow") != "false"

	err := s.docker.StreamContainerLogs(r.Context(), id, tail, follow, docker.LogEntry{}, func(entry docker.LogEntry) error {
		return writeSSEEvent(w, flusher, "log", entry)
	})
	if err != nil && r.Context().Err() == nil {
		_ = writeSSEEvent(w, flusher, "error", map[string]string{"error": err.Error()})
	}
}

func (s *Server) handleContainerStatsSSE(w http.ResponseWriter, r *http.Request, id string) {
	flusher, ok := prepareSSE(w)
	if !ok {
		return
	}
	_ = s.docker.StreamContainerStats(r.Context(), id, func(st docker.ContainerStats) error {
		return writeSSEEvent(w, flusher, "stats", st)
	})
}

func (s *Server) handleContainerExecWS(w http.ResponseWriter, r *http.Request, id string) {
	ws, err := UpgradeWebSocket(w, r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	defer ws.Close()

	cols, _ := strconv.Atoi(r.URL.Query().Get("cols"))
	rows, _ := strconv.Atoi(r.URL.Query().Get("rows"))
	if cols <= 0 {
		cols = 100
	}
	if rows <= 0 {
		rows = 28
	}
	shell := r.URL.Query().Get("shell")

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	session, err := s.docker.CreateAndStartExec(ctx, id, shell, cols, rows)
	if err != nil {
		_ = ws.WriteText("\r\n\x1b[31m[Container Land] Failed to start exec session: " + err.Error() + "\x1b[0m\r\n")
		return
	}
	defer session.Close()

	// Pipe container PTY output -> Browser WebSocket
	done := make(chan struct{})
	go func() {
		defer close(done)
		buf := make([]byte, 8192)
		for {
			n, rErr := session.Reader.Read(buf)
			if n > 0 {
				if wErr := ws.WriteText(string(buf[:n])); wErr != nil {
					return
				}
			}
			if rErr != nil {
				return
			}
		}
	}()

	// Pipe Browser WebSocket -> container PTY stdin (or handle JSON resize events)
	go func() {
		defer session.Close()
		for {
			_, payload, rErr := ws.ReadMessage()
			if rErr != nil {
				return
			}
			if len(payload) > 0 && payload[0] == '{' {
				var ctrl struct {
					Type string `json:"type"`
					Data string `json:"data"`
					Cols int    `json:"cols"`
					Rows int    `json:"rows"`
				}
				if json.Unmarshal(payload, &ctrl) == nil && ctrl.Type != "" {
					switch ctrl.Type {
					case "resize":
						_ = s.docker.ResizeExec(ctx, session.ExecID, ctrl.Cols, ctrl.Rows)
						continue
					case "input":
						_, _ = session.Conn.Write([]byte(ctrl.Data))
						continue
					}
				}
			}
			_, _ = session.Conn.Write(payload)
		}
	}()

	<-done
}

func (s *Server) handleComposeSubroutes(w http.ResponseWriter, r *http.Request) {
	trimmed := strings.TrimPrefix(r.URL.Path, "/api/compose/")
	parts := strings.Split(trimmed, "/")
	if len(parts) < 2 || parts[0] == "" {
		writeError(w, http.StatusBadRequest, "invalid compose route")
		return
	}
	project := parts[0]
	action := parts[1]

	switch action {
	case "start", "stop", "restart", "remove":
		if r.Method != http.MethodPost {
			writeError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		count, err := s.docker.ComposeAction(r.Context(), project, action)
		if err != nil {
			writeError(w, http.StatusBadGateway, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"project":  project,
			"action":   action,
			"affected": count,
		})

	case "logs":
		flusher, ok := prepareSSE(w)
		if !ok {
			return
		}
		tail := 100
		if rawTail := r.URL.Query().Get("tail"); rawTail != "" {
			if parsed, err := strconv.Atoi(rawTail); err == nil && parsed > 0 {
				tail = parsed
			}
		}
		err := s.docker.StreamComposeLogs(r.Context(), project, tail, func(entry docker.LogEntry) error {
			return writeSSEEvent(w, flusher, "log", entry)
		})
		if err != nil && r.Context().Err() == nil {
			_ = writeSSEEvent(w, flusher, "error", map[string]string{"error": err.Error()})
		}

	default:
		writeError(w, http.StatusNotFound, "unknown compose action")
	}
}

func (s *Server) handleImages(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	imgs, err := s.docker.ListImages(r.Context())
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, imgs)
}

func (s *Server) handleImagePullSSE(w http.ResponseWriter, r *http.Request) {
	imageRef := strings.TrimSpace(r.URL.Query().Get("image"))
	if imageRef == "" {
		writeError(w, http.StatusBadRequest, "missing image query parameter")
		return
	}
	flusher, ok := prepareSSE(w)
	if !ok {
		return
	}
	err := s.docker.PullImage(r.Context(), imageRef, func(msg map[string]any) error {
		return writeSSEEvent(w, flusher, "progress", msg)
	})
	if err != nil {
		_ = writeSSEEvent(w, flusher, "error", map[string]string{"error": err.Error()})
		return
	}
	_ = writeSSEEvent(w, flusher, "done", map[string]string{"image": imageRef})
}

func (s *Server) handleImageDelete(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodDelete {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	id := strings.TrimPrefix(r.URL.Path, "/api/images/")
	force := r.URL.Query().Get("force") == "true"
	if err := s.docker.RemoveImage(r.Context(), id, force); err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"deleted": id})
}

func (s *Server) handleVolumes(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		vols, err := s.docker.ListVolumes(r.Context())
		if err != nil {
			writeError(w, http.StatusBadGateway, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, vols)
	case http.MethodPost:
		var body struct {
			Name string `json:"name"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&body); err != nil || strings.TrimSpace(body.Name) == "" {
			writeError(w, http.StatusBadRequest, "volume name is required")
			return
		}
		if err := s.docker.CreateVolume(r.Context(), body.Name); err != nil {
			writeError(w, http.StatusBadGateway, err.Error())
			return
		}
		writeJSON(w, http.StatusCreated, map[string]any{"created": body.Name})
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Server) handleVolumeDelete(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodDelete {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	name := strings.TrimPrefix(r.URL.Path, "/api/volumes/")
	force := r.URL.Query().Get("force") == "true"
	if err := s.docker.RemoveVolume(r.Context(), name, force); err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"deleted": name})
}

func (s *Server) handleNetworks(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	nets, err := s.docker.ListNetworks(r.Context())
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, nets)
}

func (s *Server) handleNetworkDelete(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodDelete {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	id := strings.TrimPrefix(r.URL.Path, "/api/networks/")
	if err := s.docker.RemoveNetwork(r.Context(), id); err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"deleted": id})
}

func (s *Server) handleSystemDF(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	df, err := s.getDiskUsageCached(r.Context(), true)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, df)
}

func (s *Server) handleSystemPrune(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var req docker.PruneRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON payload")
		return
	}
	res, err := s.docker.Prune(r.Context(), req)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	// Invalidate disk usage cache after pruning
	_, _ = s.getDiskUsageCached(r.Context(), true)
	writeJSON(w, http.StatusOK, res)
}

func prepareSSE(w http.ResponseWriter) (http.Flusher, bool) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, "streaming unsupported")
		return nil, false
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()
	return flusher, true
}

func writeSSEEvent(w http.ResponseWriter, flusher http.Flusher, event string, payload any) error {
	b, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	if _, err := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, string(b)); err != nil {
		return err
	}
	flusher.Flush()
	return nil
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}
