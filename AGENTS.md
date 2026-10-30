# Container Land (`AGENTS.md`)

Container Land is a portable, single-binary Linux daemon and embedded web UI for managing a local Docker Engine with Docker Desktop feature parity.

## Layout

| Path | Purpose |
|---|---|
| `cmd/container-land/` | CLI entry point (`--addr`, `--socket`, `--open`, `--version`) |
| `internal/docker/` | Zero-dependency Docker Engine HTTP/Unix socket client, 8-byte stream demultiplexer, Compose stack grouper, and TTY `exec` hijacker |
| `internal/host/` | Linux `/proc` and `statfs` host resource telemetry reader |
| `internal/server/` | HTTP API, SSE streams (daemon events, container logs, interleaved Compose stack logs, live stats), WebSocket `exec` bridge, and embedded SPA (`internal/server/dist`) |
| `web/` | React 19 + TypeScript + Tailwind CSS + `xterm.js` frontend |
| `systemd/` | Portable user systemd service (`%h/.local/bin/container-land`) |

## Commands

```bash
# Build web UI and compile single Go binary into ./bin/container-land
make build

# Run all Go (-race) and frontend (Vitest + TypeScript + Vite build) checks
make test

# Run locally on http://127.0.0.1:8485
./bin/container-land

# Install binary to ~/.local/bin and enable user systemd service
make install-service
```

## Browser Support Policy

**Browser Support:** Target modern evergreen desktop browsers (Chrome, Firefox, Edge, Safari). Baseline Newly Available features (`<dialog>`, `light-dark()`, `color-scheme`, `:has()`) may be used natively with lightweight progressive enhancement fallbacks.

## Open-Source & Privacy Rules

- Never commit machine-specific hostnames, local usernames, `/home/<user>` paths, or private container/project names in code, tests, or documentation.
- Keep default HTTP binding restricted to loopback (`127.0.0.1:8485`) unless explicitly overridden via `--addr` or `CONTAINER_LAND_ADDR`.
