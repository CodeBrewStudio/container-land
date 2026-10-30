package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"

	"github.com/container-land/container-land/internal/docker"
	"github.com/container-land/container-land/internal/host"
	"github.com/container-land/container-land/internal/server"
)

var version = "0.1.0"

const systemdUserUnit = `[Unit]
Description=Container Land - Local Docker Engine Web UI
After=network.target

[Service]
Type=simple
ExecStart=%h/.local/bin/container-land --addr 127.0.0.1:8485
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
`

func main() {
	defaultAddr := strings.TrimSpace(os.Getenv("CONTAINER_LAND_ADDR"))
	if defaultAddr == "" {
		defaultAddr = "127.0.0.1:8485"
	}

	var (
		addrFlag      = flag.String("addr", defaultAddr, "HTTP listen address (env CONTAINER_LAND_ADDR)")
		socketFlag    = flag.String("socket", "", "Docker Engine socket path or URI (env DOCKER_HOST)")
		openFlag      = flag.Bool("open", false, "Open the web UI in the default browser on startup")
		installFlag   = flag.Bool("install-service", false, "Install and enable background user service (systemd on Linux, LaunchAgent on macOS)")
		uninstallFlag = flag.Bool("uninstall-service", false, "Stop and remove background user service")
		versionFlag   = flag.Bool("version", false, "Print version and exit")
	)
	flag.Parse()

	if *versionFlag {
		fmt.Printf("container-land %s (%s/%s)\n", strings.TrimPrefix(version, "v"), runtime.GOOS, runtime.GOARCH)
		return
	}

	if *installFlag {
		if err := installUserService(); err != nil {
			log.Fatalf("Failed to install user service: %v", err)
		}
		return
	}

	if *uninstallFlag {
		if err := uninstallUserService(); err != nil {
			log.Fatalf("Failed to uninstall user service: %v", err)
		}
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
	log.Printf("Container Land %s listening on %s (docker=%s)", version, url, dockerClient.SocketURI())

	if *openFlag {
		go func() {
			time.Sleep(300 * time.Millisecond)
			openBrowser(url)
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

func openBrowser(url string) {
	cmd := "xdg-open"
	if runtime.GOOS == "darwin" {
		cmd = "open"
	}
	_ = exec.Command(cmd, url).Start()
}

func ensureInstalledBinary(home string) (string, error) {
	binDir := filepath.Join(home, ".local", "bin")
	if err := os.MkdirAll(binDir, 0755); err != nil {
		return "", err
	}
	targetBin := filepath.Join(binDir, "container-land")
	exePath, err := os.Executable()
	if err != nil {
		return targetBin, nil
	}
	realExe, err := filepath.EvalSymlinks(exePath)
	if err != nil {
		realExe = exePath
	}
	realTarget, err := filepath.EvalSymlinks(targetBin)
	if err == nil && realExe == realTarget {
		return targetBin, nil
	}

	src, err := os.Open(realExe)
	if err != nil {
		return "", err
	}
	defer src.Close()

	tmpTarget := targetBin + ".tmp"
	dst, err := os.OpenFile(tmpTarget, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0755)
	if err != nil {
		return "", err
	}
	if _, err := io.Copy(dst, src); err != nil {
		dst.Close()
		_ = os.Remove(tmpTarget)
		return "", err
	}
	dst.Close()
	if err := os.Rename(tmpTarget, targetBin); err != nil {
		_ = os.Remove(tmpTarget)
		return "", err
	}
	return targetBin, nil
}

func installUserService() error {
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	targetBin, err := ensureInstalledBinary(home)
	if err != nil {
		return err
	}

	if runtime.GOOS == "darwin" {
		agentsDir := filepath.Join(home, "Library", "LaunchAgents")
		if err := os.MkdirAll(agentsDir, 0755); err != nil {
			return err
		}
		plistPath := filepath.Join(agentsDir, "io.container-land.daemon.plist")
		plist := fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>io.container-land.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>%s</string>
    <string>--addr</string>
    <string>127.0.0.1:8485</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
`, targetBin)
		if err := os.WriteFile(plistPath, []byte(plist), 0644); err != nil {
			return err
		}
		_ = exec.Command("launchctl", "unload", plistPath).Run()
		if out, err := exec.Command("launchctl", "load", "-w", plistPath).CombinedOutput(); err != nil {
			return fmt.Errorf("launchctl load failed: %w (%s)", err, strings.TrimSpace(string(out)))
		}
		fmt.Printf("Installed binary to %s and started macOS LaunchAgent on http://127.0.0.1:8485\n", targetBin)
		return nil
	}

	unitDir := filepath.Join(home, ".config", "systemd", "user")
	if err := os.MkdirAll(unitDir, 0755); err != nil {
		return err
	}
	unitPath := filepath.Join(unitDir, "container-land.service")
	if err := os.WriteFile(unitPath, []byte(systemdUserUnit), 0644); err != nil {
		return err
	}
	if out, err := exec.Command("systemctl", "--user", "daemon-reload").CombinedOutput(); err != nil {
		return fmt.Errorf("systemctl --user daemon-reload: %w (%s)", err, strings.TrimSpace(string(out)))
	}
	if out, err := exec.Command("systemctl", "--user", "enable", "--now", "container-land.service").CombinedOutput(); err != nil {
		return fmt.Errorf("systemctl --user enable --now: %w (%s)", err, strings.TrimSpace(string(out)))
	}
	_ = exec.Command("systemctl", "--user", "restart", "container-land.service").Run()
	fmt.Printf("Installed binary to %s and enabled user systemd service on http://127.0.0.1:8485\n", targetBin)
	return nil
}

func uninstallUserService() error {
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	if runtime.GOOS == "darwin" {
		plistPath := filepath.Join(home, "Library", "LaunchAgents", "io.container-land.daemon.plist")
		_ = exec.Command("launchctl", "unload", "-w", plistPath).Run()
		_ = os.Remove(plistPath)
		fmt.Println("Stopped and removed macOS LaunchAgent io.container-land.daemon")
		return nil
	}
	_ = exec.Command("systemctl", "--user", "disable", "--now", "container-land.service").Run()
	unitPath := filepath.Join(home, ".config", "systemd", "user", "container-land.service")
	_ = os.Remove(unitPath)
	_ = exec.Command("systemctl", "--user", "daemon-reload").Run()
	fmt.Println("Stopped and removed user systemd service container-land.service")
	return nil
}
