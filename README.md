# Container Land

If you run Docker natively on Linux, you already get the best part of the deal: containers run directly on your kernel with zero virtual machine tax. What you usually lose is the nice visual dashboard from Docker Desktop when you just want to tail interleaved logs across a six-service Compose stack, pop a shell into a container, or figure out why `/var/lib/docker` quietly ate 40 GB of your SSD.

Most alternatives either want you to run a bloated VM anyway (the horror!) or ask you to spin up a management container with a database just to look at your other containers.

I built **Container Land** to fix that. It is a single, self-contained Go binary with an embedded web UI that talks directly to your local Docker socket (`/var/run/docker.sock` or rootless) and runs quietly as a user `systemd` service on `http://127.0.0.1:8485`.

![Containers and Compose Stack Interleaved Logs](docs/screenshots/01-compose-stack-logs.png)

## What it does (and why)

### 1. Compose stacks and interleaved logs in one split view

When you are working on a local project, you rarely care about a single container in isolation. You care about the stack. Container Land groups your containers automatically by their `com.docker.compose.project` label alongside any standalone containers.

Clicking any Compose stack opens the slide-over inspector on the right and streams live, colour-coded, interleaved logs from every service in that stack at once. You can filter down to a single service pill (`api`, `postgres`, `redis`), search in real time, toggle timestamps, or copy the lot to your clipboard in one click. Starting, stopping, or restarting a stack gives you immediate progress feedback so you are never left guessing whether Docker heard you.

### 2. Instant in-browser `exec` terminal (`xterm.js`)

Sometimes you just need to poke around inside a running container without opening another terminal tab and typing `docker exec -it <some-long-container-name> /bin/sh`.

Click **Exec** on any running container (or switch to the **Terminal (Exec)** tab in the right drawer) to get a full interactive WebSocket TTY session powered by `xterm.js`. It automatically falls back from `bash` to `sh` on minimal Alpine images and resizes cleanly with the drawer.

![Interactive Container Terminal](docs/screenshots/02-container-exec-terminal.png)

### 3. Image management with multi-select and live pull streaming

The **Images** view shows every local image, whether it is currently in use (and by which containers), its age, and its size.

- **Pull with live layer progress**: Click **Pull Image...**, type a tag like `redis:7-alpine` or `postgres:18`, and hit `Enter` to watch the layer-by-layer download stream live.
- **Bulk cleanup**: Tick the checkboxes next to old build artefacts and delete them in a single batch, or hit **Prune Unused Images** to clear dangling layers in one go.

![Images Management and Bulk Selection](docs/screenshots/03-images-management.png)

### 4. Volume inspection that actually tells you what anonymous volumes are

Anyone who has used Docker for more than a week has stared at a list of unattached volumes named `3b35fe43dddc364cd84189cfb27c32626d299e776ba71f309eb3df683716be9e` and wondered: *"Is that my local Postgres database from Tuesday, or 2 GB of dead `node_modules`?"*

Container Land solves this by performing a fast, read-only inspection of volume directories and matching their top-level file signatures. Even when an anonymous volume is completely unattached, the **Volumes** table tells you what is inside (`PostgreSQL 18 data (18/)`, `RabbitMQ data (mnesia)`, `Node.js packages (node_modules)`, `Docker-in-Docker (/var/lib/docker)`, or `Empty volume`). Clicking any volume opens the **Volume Inspector** drawer so you can see the exact top-level files and directories before you decide to delete it.

![Volumes Content Detection and Inspector](docs/screenshots/04-volumes-inspector.png)

### 5. Docker vs Host resource telemetry and safe pruning

System monitors like `htop` or `btop` already show you what your Linux box is doing overall. What you actually want to know in a container manager is how much of your machine **Docker** is eating, which specific containers are responsible, and what you can get back if you stop or prune them.

![Resources and Prune Centre](docs/screenshots/05-resources-and-prune.png)

The **Resources & Prune** page (and the persistent top telemetry bar) uses dual-colour stacked bars to separate **Docker's consumption** from the **rest of your host system**:

- **CPU & RAM (Docker vs Host)**: See the exact CPU percentage and live RAM consumed by running containers versus other host processes, plus a clear callout showing how much **RAM you will immediately reclaim** if you stop your running containers.
- **Consumption by Running Compose Stack & Container**: A live leaderboard ranking your active Compose stacks and containers by memory footprint, complete with one-click **Stop (Free X MB)** buttons when a runaway service needs to be put to bed.
- **Safe Disk Prune Builder**: Breaks down `/system/df` across Images, Build Cache, Stopped Containers, and Local Volumes. Named and anonymous volumes are **excluded by default** (protected behind a separate warning checkbox and confirmation modal) so a routine disk cleanup never nukes your local database state.

## Setup & Installation Guide

### Prerequisites

- **Linux** with a running Docker Engine (standard rootful `/var/run/docker.sock` or Rootless Docker).
- **Go 1.23+** and **Node.js 20+** (only needed if you are building from source).

### 1. Clone and build the single binary

Building the project compiles the React + TypeScript frontend into static assets, embeds them into the Go server via `go:embed`, and outputs a single portable binary at `./bin/container-land`:

```bash
git clone https://github.com/jgunnink/container-land.git
cd container-land
make build
```

### 2. Run it directly (ad-hoc mode)

If you just want to spin it up in your terminal right now:

```bash
./bin/container-land --open
```

This starts the server on [http://127.0.0.1:8485](http://127.0.0.1:8485) and opens your default browser.

### 3. Install as a background user `systemd` service (Recommended)

If you want Container Land to always be there at `http://127.0.0.1:8485` whenever you log in (without needing `sudo` or a root daemon):

```bash
make install-service
```

Under the hood, this:
1. Builds `./bin/container-land` and installs it to `~/.local/bin/container-land`.
2. Installs the portable user unit file to `~/.config/systemd/user/container-land.service`.
3. Runs `systemctl --user daemon-reload && systemctl --user enable --now container-land.service`.

Useful commands for managing the background service:

```bash
# Check service status
systemctl --user status container-land.service

# Tail live daemon logs
journalctl --user -u container-land.service -f

# Restart after pulling updates
make install-service && systemctl --user restart container-land.service

# Stop and remove the user systemd service
make uninstall-service
```

## Configuration (CLI Flags & Environment Variables)

Container Land works out of the box with zero configuration, auto-discovering your Docker socket in the following order:
1. `--socket` CLI flag
2. `DOCKER_HOST` environment variable
3. `$XDG_RUNTIME_DIR/docker.sock` (Rootless Docker on Linux)
4. `/var/run/docker.sock` (Standard Linux Docker Engine)

| CLI Flag | Environment Variable | Default | Description |
|---|---|---|---|
| `--addr` | `CONTAINER_LAND_ADDR` | `127.0.0.1:8485` | HTTP listen address and port |
| `--socket` | `DOCKER_HOST` | Auto-discovered | Docker socket path (`unix:///var/run/docker.sock` or `tcp://...`) |
| `--open` | None | `false` | Automatically open the web UI in your default browser on startup |
| `--version` | None | None | Print the binary version and exit |

## Development & Testing

 The repository is split cleanly between the zero-dependency Go backend and the React 19 + TypeScript + Tailwind CSS frontend:

| Path | Purpose |
|---|---|
| `cmd/container-land/` | CLI entry point and graceful shutdown |
| `internal/docker/` | Unix/TCP Docker Engine client, 8-byte stream demultiplexer, Compose grouper, volume content inspector, and TTY `exec` hijacker |
| `internal/host/` | Linux `/proc` (`stat`, `meminfo`, `loadavg`, `uptime`, `hwmon`) and `statfs` reader |
| `internal/server/` | HTTP API, SSE streams (daemon events, container logs, Compose logs, live stats), WebSocket `exec` bridge, and embedded SPA |
| `web/` | React 19 + TypeScript + Tailwind CSS + `xterm.js` frontend |
| `systemd/` | Portable user `systemd` service unit (`%h/.local/bin/container-land`) |

To run the full test suite (Go `-race` unit/integration tests, Vitest frontend tests, TypeScript typecheck, and Vite production build):

```bash
make test
```

## Security Notes

Container Land communicates directly with your local Docker Engine socket, which means anyone who can reach its HTTP port has the same privileges as your local `docker` CLI user. For that reason, Container Land binds strictly to loopback (`127.0.0.1:8485`) by default. Do not bind `--addr 0.0.0.0:8485` on an untrusted network unless you place it behind an authenticated reverse proxy or Tailscale ACL.

## Licence

Released under the [MIT Licence](./LICENSE). If you run into a bug or have an idea that would make daily Docker life on Linux better, issues and pull requests are very welcome.
