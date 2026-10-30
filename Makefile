SHELL := /bin/bash
GO ?= $(shell command -v go 2>/dev/null || echo $(HOME)/.local/go/bin/go)
PREFIX ?= $(HOME)/.local
BINDIR ?= $(PREFIX)/bin
SYSTEMD_USER_DIR ?= $(HOME)/.config/systemd/user
BINARY := bin/container-land

.PHONY: all build-web build test dev install install-service uninstall-service clean

all: build

build-web:
	cd web && npm install --no-audit --no-fund && npm run build
	rm -rf internal/server/dist
	cp -r web/dist internal/server/dist

build: build-web
	mkdir -p bin
	$(GO) build -trimpath -ldflags="-s -w" -o $(BINARY) ./cmd/container-land

test: build-web
	$(GO) test -v -race ./...
	cd web && npm test -- --run

install: build
	mkdir -p $(BINDIR)
	install -m 0755 $(BINARY) $(BINDIR)/container-land

install-service: install
	mkdir -p $(SYSTEMD_USER_DIR)
	install -m 0644 systemd/container-land.service $(SYSTEMD_USER_DIR)/container-land.service
	systemctl --user daemon-reload
	systemctl --user enable --now container-land.service

uninstall-service:
	-systemctl --user disable --now container-land.service
	rm -f $(SYSTEMD_USER_DIR)/container-land.service
	-systemctl --user daemon-reload

clean:
	rm -rf bin internal/server/dist web/dist
