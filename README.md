# Container Land

A fast, lightweight, single-binary interface for managing a local Docker Engine on Linux.

Container Land gives you the everyday features of Docker Desktop on Linux without running a heavy virtual machine: live container and Docker Compose stack management, interleaved multi-container Compose log streams, an interactive in-browser `exec` terminal (`xterm.js`), image pulling and layer inspection, volume and network management, live Linux `/proc` host resource telemetry, and a safe Docker disk prune centre.

## Features

- **Containers & Docker Compose Stacks**: Automatically groups containers by `com.docker.compose.project` alongside standalone containers. Start, stop, restart, or remove individual containers or entire Compose stacks in one click.
- **Dual-Mode Right Slide-Over Inspector**:
  - **Compose Stack Mode**: Click any Compose group row to stream live, interleaved, colour-coded logs across every container in the stack with instant service filter pills and aggregated stack CPU/RAM metrics.
  - **Container Mode**: Click any container row for live SSE logs (`stdout`/`stderr` demuxed, search, timestamps, download), an interactive WebSocket TTY shell (`bash`/`sh`), live 1-second CPU/Memory/Network/Block I/O charts, structured Environment & Mounts inspection, and raw Inspect JSON.
- **Images, Volumes & Networks**: Browse, search, inspect, pull images with live progress, see which containers reference each image/volume/network, and clean up unused resources.
- **Host Telemetry & Safe Prune Centre**: Live Linux `/proc` CPU, per-core load, memory, swap, and filesystem telemetry alongside Docker's `/system/df` breakdown. Safe-by-default System Prune reclaims stopped containers, unused images, and build cache while protecting named volumes unless explicitly opted in.
- **Portable & Rootless-Ready**: Auto-discovers standard (`/var/run/docker.sock`), rootless (`$XDG_RUNTIME_DIR/docker.sock`), and custom (`DOCKER_HOST` / `--socket`) endpoints. Ships as a single self-contained Go binary with embedded web assets.

## Quick Start

### Prerequisites

- Linux with Docker Engine (rootful or rootless)
- Go 1.23+ and Node.js 20+ (only required when building from source)

### Build & Run

```bash
make build
./bin/container-land
```

Then open [http://127.0.0.1:8485](http://127.0.0.1:8485) in your browser (or run `./bin/container-land --open`).

### Install as a User Systemd Service

```bash
make install-service
```

This installs the binary to `~/.local/bin/container-land` and enables the `container-land.service` user unit on `http://127.0.0.1:8485`.

To remove the service:

```bash
make uninstall-service
```

## CLI Flags & Environment Variables

| Flag | Environment Variable | Default | Description |
|---|---|---|---|
| `--addr` | `CONTAINER_LAND_ADDR` | `127.0.0.1:8485` | HTTP listen address |
| `--socket` | `DOCKER_HOST` | Auto-discovered | Docker daemon socket path (`unix:///...`, `/var/run/docker.sock`, or `$XDG_RUNTIME_DIR/docker.sock`) |
| `--open` | — | `false` | Open the UI in the default browser on startup |
| `--version` | — | — | Print version and exit |

## Security

Container Land talks directly to the local Docker daemon socket and therefore has the same privileges as your local `docker` CLI. By default, it binds strictly to loopback (`127.0.0.1:8485`). Do not expose it on an untrusted network interface without placing it behind an authenticated reverse proxy.

## License

[MIT](./LICENSE)
