package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/container-land/container-land/internal/docker"
	"github.com/container-land/container-land/internal/host"
	"github.com/container-land/container-land/internal/server"
)

const version = "1.0.0"

func main() {
	defaultAddr := strings.TrimSpace(os.Getenv("CONTAINER_LAND_ADDR"))
	if defaultAddr == "" {
		defaultAddr = "127.0.0.1:8485"
	}

	var (
		addrFlag    = flag.String("addr", defaultAddr, "HTTP listen address (env CONTAINER_LAND_ADDR)")
		socketFlag  = flag.String("socket", "", "Docker Engine socket path or URI (env DOCKER_HOST)")
		openFlag    = flag.Bool("open", false, "Open the web UI in the default browser on startup")
		versionFlag = flag.Bool("version", false, "Print version and exit")
	)
	flag.Parse()

	if *versionFlag {
		fmt.Printf("container-land v%s\n", version)
		return
	}

	dockerClient := docker.NewClient(*socketFlag)
	hostCollector := host.NewCollector()
	srvHandler := server.New(dockerClient, hostCollector)

	httpServer := &http.Server{
		Addr:              *addrFlag,
		Handler:           srvHandler,
		ReadHeaderTimeout: 10 * time.Second,
	}

	url := "http://" + *addrFlag
	log.Printf("Container Land v%s listening on %s (docker=%s)", version, url, dockerClient.SocketURI())

	if *openFlag {
		go func() {
			time.Sleep(300 * time.Millisecond)
			_ = exec.Command("xdg-open", url).Start()
		}()
	}

	errCh := make(chan error, 1)
	go func() {
		if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
		close(errCh)
	}()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)

	select {
	case err := <-errCh:
		if err != nil {
			log.Fatalf("server failed: %v", err)
		}
	case sig := <-sigCh:
		log.Printf("Received %s, shutting down...", sig)
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = httpServer.Shutdown(ctx)
	}
}
