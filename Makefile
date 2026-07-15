.PHONY: build test test-go test-full benchmark dev clean fmt lint lint-files lint-go lint-deadcode lint-js lint-types lint-css fix fix-files fix-fmt fix-go fix-js fix-css node-deps help mac-app install-mac app-icon-embed wails-runtime-embed win-icon release-build-mac mac-dmg mac-dmg-pack win-installer win-installer-pack linux-binaries linux-tarball linux-tarball-pack mac-codesign

# Binary name
BINARY_NAME=juggler
BUILD_DIR=bin

# Platform detection (used to optionally bundle a macOS .app)
UNAME_S := $(shell uname -s)
# Host CPU arch, translated to Go's GOARCH names — the default for native Linux
# builds below, so `make linux-binaries` targets the running machine instead of
# silently cross-compiling (these are cgo GTK/WebKitGTK builds, so a mismatched
# GOARCH needs a cross-gcc toolchain most machines don't have).
UNAME_M := $(shell uname -m)
ifeq ($(UNAME_M),x86_64)
GOARCH_HOST := amd64
else ifneq (,$(filter $(UNAME_M),aarch64 arm64))
GOARCH_HOST := arm64
else
GOARCH_HOST := $(UNAME_M)
endif
# Executable suffix for native (non-cross-compiled) builds on this host. Native
# Windows reports Windows_NT via $OS regardless of shell (uname -s instead
# returns MSYS_NT-.../MINGW64_NT-... under Git Bash, inconsistent to match
# on). This matters beyond cosmetics: `go build -o path` never auto-appends
# .exe when given an explicit filename, but the desktop app's serverBinPath()
# (cmd/juggler-app/server_spawn.go) looks for a sibling literally named
# juggler.exe on Windows — without this suffix here, go-build silently
# produces a server binary the app can never find, and it falls back to
# whatever juggler.exe happens to be on PATH instead (e.g. a stale installed
# build) with no error.
ifeq ($(OS),Windows_NT)
BIN_EXT := .exe
else
BIN_EXT :=
endif
MAC_APP_DIR=$(BUILD_DIR)/Juggler.app
# The clickable bundle executable is the desktop app (juggler-app); the headless
# server binary (juggler) sits alongside it in MacOS/ so the app's serverBinPath
# finds it as a sibling.
MAC_APP_BIN=$(MAC_APP_DIR)/Contents/MacOS/$(BINARY_NAME)
MAC_APP_APP_BIN=$(MAC_APP_DIR)/Contents/MacOS/juggler-app
MAC_APP_RES=$(MAC_APP_DIR)/Contents/Resources
MAC_APP_PLIST=$(MAC_APP_DIR)/Contents/Info.plist
MAC_ICON_SRC=assets/icons/juggler.icon
MAC_BUNDLE_ID=studio.juggler.juggler
# Entitlements sealed into the bundle when signing with a real Developer ID
# identity under the hardened runtime (see mac-codesign). Unused by ad-hoc dev
# signing. Kept minimal on purpose — see the file's own comment.
MAC_ENTITLEMENTS=assets/macos/juggler.entitlements
# Optional stable code-signing identity for local macOS builds. Go ad-hoc-signs
# arm64 binaries, so every rebuild gets a fresh cdhash — and macOS TCC keys
# permission grants (Downloads/Documents/etc., which WebKit's WebContent process
# requests at startup) on that cdhash, re-prompting on the first launch of each
# new build. Signing with a *stable* identity instead keys the grant on the
# signing identity, so it persists across rebuilds and the prompt stops nagging.
# Unset (default) → ad-hoc signing, unchanged behaviour and no cert dependency
# for other devs/CI. Set it to a self-signed keychain cert's name to opt in:
#   make build CODESIGN_IDENTITY="Juggler Dev"
# (create the cert once via Keychain Access → Certificate Assistant → Create a
# Certificate → "Code Signing", self-signed; grant the Downloads prompt once.)
#
# For a distributable build, set it to a real Developer ID Application identity
#   make mac-dmg CODESIGN_IDENTITY="Developer ID Application: You (TEAMID)"
# and mac-codesign additionally enables the hardened runtime + a secure
# timestamp + $(MAC_ENTITLEMENTS), producing a bundle the release pipeline can
# notarize and staple. The identity's key must be in an unlocked keychain on the
# signing host.
CODESIGN_IDENTITY ?=

# Source-of-truth raster icon used for Linux runtime window icon and as the
# input for the Windows resource (.syso) compilation step.
APP_ICON_PNG=assets/icons/juggler-icon.png
APP_ICON_EMBED=cmd/juggler/app/icon.png
# Go's linker matches a .syso to a build by its _GOARCH suffix, so each Windows
# target architecture needs its own resource file. We ship amd64 and arm64
# (plus legacy 386); a missing arch silently links with no icon.
WIN_SYSO_ARCHES=arm64,amd64,386

# Go parameters
GOCMD=go
# GOBUILD / GOBUILD_RELEASE, the macOS deployment-target + CGO exports, and the
# version-stamp LDFLAGS all live in mk/build-flags.mk, included below (after the
# VERSION vars it references) so the release/packaging build shares them verbatim.
GOCLEAN=$(GOCMD) clean
GOTEST=$(GOCMD) test
# RUN='<regex>' narrows the suite to matching test functions (a `go test -run`
# pattern) and turns on -v so that one test's own output is visible; empty RUN
# runs the whole suite quietly, as before. Honoured by `make test`, `make
# test-go`, and `make test-full`. Double-quoted so a regex containing |, /, or a
# space survives the single-quoted `bash -c` wrappers in the test recipes below.
RUN ?=
GOTEST_RUN=$(if $(RUN),-run "$(RUN)" -v)
# The race detector needs cgo (a C compiler). CI and most Unix dev boxes have
# one, so default -race on. A Windows dev box usually has no C toolchain, so cgo
# can't build and `go test -race` fails outright with "requires cgo" — override
# with `make test RACE=` there to run the suite (minus race). Empty = no race.
RACE ?= -race
GOGET=$(GOCMD) get
GOFMT=$(GOCMD) fmt
GOVET=$(GOCMD) vet

# Version info (can override with: make build VERSION=1.0.0).
# The version lives in the VERSION file at the repo root, bumped by
# scripts/push-release; CI passes it explicitly via VERSION=.
VERSION ?= $(shell cat VERSION 2>/dev/null || echo "dev")
COMMIT ?= $(shell git rev-parse --short HEAD 2>/dev/null || echo "unknown")
BUILD_DATE ?= $(shell date -u +%Y-%m-%dT%H:%M:%SZ)

# Shared build flags: GOBUILD/GOBUILD_RELEASE, the macOS deployment-target + CGO
# exports, and the version-stamp LDFLAGS_BASE/LDFLAGS. Included here — after
# VERSION/COMMIT/BUILD_DATE, which it references — so this build and the private
# release/packaging build compile every binary identically. See mk/build-flags.mk.
include mk/build-flags.mk
# Windows stays a console-subsystem binary on purpose: a shell launch then runs
# juggler in the foreground (visible output, Ctrl+C, interactive keys) because
# the shell waits on console apps. An icon launch detaches the console Windows
# allocates at startup (see launchedFromTerminal) so no terminal window lingers.
# A GUI-subsystem build would instead detach into a hidden background process
# when run from a shell — the opposite of what we want.

all: test build

## go-build: Build only the Go code, without linting
# Quiet on success: the go build commands are @-prefixed so make doesn't echo
# their long ldflags command lines, and the per-binary progress echoes are
# dropped. `go build` prints nothing on success and its errors on failure, so a
# broken build is still fully diagnosed; a good build collapses to one ✓ line.
go-build: app-icon-embed wails-runtime-embed
	@mkdir -p $(BUILD_DIR)
ifeq ($(UNAME_S),Darwin)
	@mkdir -p $(MAC_APP_DIR)/Contents/MacOS $(MAC_APP_RES)
	@# Clear any prior binary first: a leftover universal (fat) Mach-O from an
	@# older `make release-build-mac` isn't a plain object file, so `go build -o`
	@# refuses to overwrite it ("already exists and is not an object file").
	@rm -f $(MAC_APP_BIN) $(MAC_APP_APP_BIN)
	@$(GOBUILD) -ldflags "$(LDFLAGS)" -o $(MAC_APP_BIN) ./cmd/juggler
	@$(GOBUILD) -ldflags "$(LDFLAGS)" -o $(MAC_APP_APP_BIN) ./cmd/juggler-app
	@$(MAKE) --no-print-directory mac-app-meta
	@$(MAKE) --no-print-directory mac-codesign
	@ln -sfn Juggler.app/Contents/MacOS/$(BINARY_NAME) $(BUILD_DIR)/$(BINARY_NAME)
	@ln -sfn Juggler.app/Contents/MacOS/juggler-app $(BUILD_DIR)/juggler-app
else
	@$(GOBUILD) -ldflags "$(LDFLAGS)" -o $(BUILD_DIR)/$(BINARY_NAME)$(BIN_EXT) ./cmd/juggler
	@$(GOBUILD) -ldflags "$(LDFLAGS)" -o $(BUILD_DIR)/juggler-app$(BIN_EXT) ./cmd/juggler-app
endif
	@$(GOBUILD) -ldflags "$(LDFLAGS)" -o $(BUILD_DIR)/juggler-test$(BIN_EXT) ./cmd/juggler-test
	@echo "✓ built juggler, juggler-app, juggler-test ($(VERSION))"

## release-build: Build juggler with -tags production. Excludes test handlers
## (cmd/juggler/testing/, worker_test_support.go) so they can't be reached in
## shipped binaries. juggler-test is intentionally not built here.
release-build: app-icon-embed wails-runtime-embed
	@echo "Building $(BINARY_NAME) $(VERSION) [release]..."
	@mkdir -p $(BUILD_DIR)
ifeq ($(UNAME_S),Darwin)
	@mkdir -p $(MAC_APP_DIR)/Contents/MacOS $(MAC_APP_RES)
	@# See go-build: clear a possible leftover universal (fat) binary so
	@# `go build -o` doesn't refuse to overwrite it.
	@rm -f $(MAC_APP_BIN) $(MAC_APP_APP_BIN)
	$(GOBUILD_RELEASE) -ldflags "$(LDFLAGS)" -o $(MAC_APP_BIN) ./cmd/juggler
	@echo "Building juggler-app $(VERSION) [release]..."
	$(GOBUILD_RELEASE) -ldflags "$(LDFLAGS)" -o $(MAC_APP_APP_BIN) ./cmd/juggler-app
	@$(MAKE) --no-print-directory mac-app-meta
	@$(MAKE) --no-print-directory mac-codesign
	@ln -sfn Juggler.app/Contents/MacOS/$(BINARY_NAME) $(BUILD_DIR)/$(BINARY_NAME)
	@ln -sfn Juggler.app/Contents/MacOS/juggler-app $(BUILD_DIR)/juggler-app
else
	$(GOBUILD_RELEASE) -ldflags "$(LDFLAGS)" -o $(BUILD_DIR)/$(BINARY_NAME)$(BIN_EXT) ./cmd/juggler
	@echo "Building juggler-app $(VERSION) [release]..."
	$(GOBUILD_RELEASE) -ldflags "$(LDFLAGS)" -o $(BUILD_DIR)/juggler-app$(BIN_EXT) ./cmd/juggler-app
endif

## build-windows: Cross-compile the Windows .exe binaries from any host. Wails
## v3's Windows backend is pure-Go (purego), so CGO is off and no cross C
## toolchain is needed. The server stays a console-subsystem binary (terminal
## CLI: visible output, Ctrl+C, interactive keys); the desktop app is built
## -H windowsgui so an Explorer/icon launch shows no stray console window.
## (Linux can't be cross-compiled here — its Wails backend is cgo GTK/WebKitGTK
## and needs the target headers+libs; build it natively on Linux.)
WIN_BUILD_DIR := $(BUILD_DIR)/windows
# The Windows icon .syso files must sit in each main package dir (cmd/juggler/
# and cmd/juggler-app/) for the Go linker to embed them (it only reads .syso
# from the package dir at link time — bin/ is not an option). To keep them out
# of the source tree during normal dev, they are generated here and removed
# again in the same shell (trap on EXIT, so a failed link still cleans up);
# only build-windows needs them.
build-windows: app-icon-embed wails-runtime-embed
	@echo "Cross-building Windows binaries (amd64)..."
	@mkdir -p $(WIN_BUILD_DIR)
	@$(MAKE) --no-print-directory win-icon
	@trap 'rm -f cmd/juggler/rsrc_*.syso cmd/juggler-app/rsrc_*.syso' EXIT; \
	if [ -n "$(SERVER_BIN)" ]; then \
		echo "Using prebuilt server $(SERVER_BIN)"; \
		cp "$(SERVER_BIN)" "$(WIN_BUILD_DIR)/$(BINARY_NAME).exe"; \
	else \
		CGO_ENABLED=0 GOOS=windows GOARCH=amd64 $(GOBUILD) -ldflags "$(LDFLAGS_BASE)" -o $(WIN_BUILD_DIR)/$(BINARY_NAME).exe ./cmd/juggler; \
	fi && \
	echo "Building juggler-app.exe (windowsgui) $(VERSION)..." && \
	CGO_ENABLED=0 GOOS=windows GOARCH=amd64 $(GOBUILD) -ldflags "$(LDFLAGS_BASE) -H windowsgui" -o $(WIN_BUILD_DIR)/juggler-app.exe ./cmd/juggler-app
	@echo "→ $(WIN_BUILD_DIR)/$(BINARY_NAME).exe (console), $(WIN_BUILD_DIR)/juggler-app.exe (GUI)"

# ── Distribution: one indivisible unit per platform ─────────────────────────
# Both binaries always travel together (the .app bundles them; the installer
# writes them to one dir), so the desktop app's sibling serverBinPath() always
# resolves a server of its exact build. See docs/distribution.md.

# SERVER_BIN (optional): path to a prebuilt server binary to drop into the slot
# instead of building ./cmd/juggler. Unset = build the free server, exactly as
# before. A build layering extra server features sets this to its own prebuilt
# server so the desktop app, bundle assembly, and packaging below stay this
# repo's single implementation. The server package itself is never referenced
# from outside this module — only the finished binary is injected.
SERVER_BIN ?=

## release-build-mac: Build the arm64 (Apple Silicon) Juggler.app for
## distribution. Both the server (juggler) and app (juggler-app) are built for
## arm64; the bundle stays one unit. macOS only. Use `make mac-dmg` to wrap the
## result in a drag-to-Applications DMG. Set SERVER_BIN to inject a prebuilt
## server into the slot instead of building ./cmd/juggler.
release-build-mac: app-icon-embed wails-runtime-embed
ifneq ($(UNAME_S),Darwin)
	@echo "release-build-mac is only supported on macOS."; exit 1
endif
	@echo "Building Juggler.app $(VERSION) [release, arm64]..."
	@mkdir -p $(MAC_APP_DIR)/Contents/MacOS $(MAC_APP_RES)
	@# Clear a possible leftover universal (fat) binary from an older release so
	@# `go build -o` doesn't refuse to overwrite it (see go-build).
	@rm -f $(MAC_APP_BIN) $(MAC_APP_APP_BIN)
	@if [ -n "$(SERVER_BIN)" ]; then \
		echo "  → juggler (from $(SERVER_BIN))"; \
		cp "$(SERVER_BIN)" "$(MAC_APP_BIN)"; \
	else \
		echo "  → juggler (arm64)"; \
		CGO_ENABLED=1 GOOS=darwin GOARCH=arm64 $(GOBUILD_RELEASE) -ldflags "$(LDFLAGS)" -o $(MAC_APP_BIN) ./cmd/juggler || exit 1; \
	fi
	@echo "  → juggler-app (arm64)"
	@CGO_ENABLED=1 GOOS=darwin GOARCH=arm64 $(GOBUILD_RELEASE) -ldflags "$(LDFLAGS)" -o $(MAC_APP_APP_BIN) ./cmd/juggler-app || exit 1
	@$(MAKE) --no-print-directory mac-app-meta
	@$(MAKE) --no-print-directory mac-codesign
	@ln -sfn Juggler.app/Contents/MacOS/$(BINARY_NAME) $(BUILD_DIR)/$(BINARY_NAME)
	@ln -sfn Juggler.app/Contents/MacOS/juggler-app $(BUILD_DIR)/juggler-app
	@echo "→ $(MAC_APP_DIR) (arm64: $$(lipo -archs $(MAC_APP_APP_BIN)))"

## mac-dmg: Build a distributable .dmg containing the arm64 Juggler.app with
## the standard drag-to-Applications layout. Requires create-dmg
## (brew install create-dmg). Output: bin/Juggler-$(VERSION).dmg.
DMG_NAME=$(BUILD_DIR)/Juggler-$(VERSION).dmg
mac-dmg: release-build-mac mac-dmg-pack

## mac-dmg-pack: Wrap the already-assembled $(MAC_APP_DIR) into the DMG, WITHOUT
## rebuilding it. mac-dmg = release-build-mac + this; kept separate so a caller
## that has already assembled the .app by other means (e.g. a bundle carrying a
## different server binary) can package it without a redundant release-build-mac.
mac-dmg-pack:
	@command -v create-dmg >/dev/null 2>&1 || { echo "create-dmg not found — run: brew install create-dmg"; exit 1; }
	@[ -d "$(MAC_APP_DIR)" ] || { echo "no $(MAC_APP_DIR) to package — build the app first"; exit 1; }
	@rm -f "$(DMG_NAME)"
	@stage=$$(mktemp -d); \
	cp -R "$(MAC_APP_DIR)" "$$stage/Juggler.app"; \
	create-dmg \
		--volname "Juggler" \
		--window-pos 200 120 \
		--window-size 600 360 \
		--icon-size 100 \
		--icon "Juggler.app" 150 180 \
		--hide-extension "Juggler.app" \
		--app-drop-link 450 180 \
		"$(DMG_NAME)" "$$stage" \
		|| { code=$$?; [ -f "$(DMG_NAME)" ] || { rm -rf "$$stage"; echo "create-dmg failed ($$code)"; exit $$code; }; }; \
		rm -rf "$$stage"
	@echo "→ $(DMG_NAME)"
	@# Signing/notarization happen around this target, not inside it: with
	@# CODESIGN_IDENTITY set, release-build-mac already sealed the .app with a
	@# Developer ID identity + hardened runtime (see mac-codesign), and the
	@# release pipeline runs `xcrun notarytool submit --wait` + `xcrun stapler
	@# staple` on the finished DMG. Built without an identity the DMG is only
	@# ad-hoc-signed, so a browser download is Gatekeeper-blocked as
	@# "unidentified developer" (recoverable via right-click → Open).

## win-installer: Build the Windows installer (Inno Setup) wrapping both .exe
## binaries into one install dir. Requires the Inno Setup compiler (iscc) and a
## prior `make build-windows`. Run on Windows (or wine). Output:
## bin/windows/Juggler-$(VERSION)-setup.exe.
win-installer: build-windows win-installer-pack

## win-installer-pack: Run Inno Setup over the already-built binaries in
## $(WIN_BUILD_DIR), WITHOUT rebuilding them. win-installer = build-windows +
## this; kept separate so a caller that has placed its own juggler.exe /
## juggler-app.exe there can package them without a redundant build-windows.
win-installer-pack:
	@command -v iscc >/dev/null 2>&1 || { echo "iscc (Inno Setup) not found"; exit 1; }
	@[ -f "$(WIN_BUILD_DIR)/$(BINARY_NAME).exe" ] || { echo "no $(WIN_BUILD_DIR)/$(BINARY_NAME).exe to package — build the Windows binaries first"; exit 1; }
	@MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' iscc /DMyAppVersion=$(VERSION) packaging/windows/juggler.iss
	@echo "→ $(WIN_BUILD_DIR)/Juggler-$(VERSION)-setup.exe"

# ── Linux release bundle ────────────────────────────────────────────────────
# Linux ships the server + desktop app together as one tarball per arch — the
# same "both binaries travel together" invariant the DMG/installer uphold.
GOARCH ?= $(GOARCH_HOST)

## linux-binaries: Build the server (or the prebuilt $(SERVER_BIN)) + the desktop
## app into bin/ for $(GOARCH). Native Linux only (the desktop app is cgo
## GTK/WebKitGTK). This is the loose-binary layout; `make linux-tarball` packs it.
linux-binaries: app-icon-embed wails-runtime-embed
	@mkdir -p $(BUILD_DIR)
	@if [ -n "$(SERVER_BIN)" ]; then \
		echo "  → juggler (from $(SERVER_BIN))"; \
		cp "$(SERVER_BIN)" "$(BUILD_DIR)/$(BINARY_NAME)"; \
	else \
		echo "  → juggler ($(GOARCH))"; \
		CGO_ENABLED=1 GOOS=linux GOARCH=$(GOARCH) $(GOBUILD_RELEASE) -ldflags "$(LDFLAGS_BASE)" -o $(BUILD_DIR)/$(BINARY_NAME) ./cmd/juggler; \
	fi
	@echo "  → juggler-app ($(GOARCH))"
	@CGO_ENABLED=1 GOOS=linux GOARCH=$(GOARCH) $(GOBUILD_RELEASE) -ldflags "$(LDFLAGS_BASE)" -o $(BUILD_DIR)/juggler-app ./cmd/juggler-app

## linux-tarball: linux-binaries + package them (README + checksums) into one
## tarball. Output: bin/juggler-linux-$(GOARCH).tar.gz.
linux-tarball: linux-binaries linux-tarball-pack

## linux-tarball-pack: Tar the already-built bin/juggler + bin/juggler-app
## (no rebuild), mirroring mac-dmg-pack / win-installer-pack.
linux-tarball-pack:
	@[ -f "$(BUILD_DIR)/$(BINARY_NAME)" ] || { echo "no $(BUILD_DIR)/$(BINARY_NAME) to package — build the Linux binaries first"; exit 1; }
	@stage=$$(mktemp -d); \
	cp $(BUILD_DIR)/$(BINARY_NAME) $(BUILD_DIR)/juggler-app "$$stage/"; \
	printf '%s\n' \
		"Juggler for Linux ($(GOARCH))" \
		"" \
		"Contents:" \
		"  juggler      headless server — run this, then open the printed URL," \
		"               or launch juggler-app which spawns it as a sibling" \
		"  juggler-app  GTK desktop app (needs a display: X11 or Wayland)" \
		"" \
		"Keep both binaries in the SAME directory — juggler-app finds juggler" \
		"next to itself." \
		"" \
		"Runtime dependencies (Ubuntu 24.04+ / equivalent):" \
		"  sudo apt-get install -y libgtk-4-1 libwebkitgtk-6.0-4" \
		> "$$stage/README.txt"; \
	( cd "$$stage" && sha256sum juggler juggler-app > checksums.txt && \
		tar czf "$(abspath $(BUILD_DIR))/juggler-linux-$(GOARCH).tar.gz" \
			juggler juggler-app checksums.txt README.txt ); \
	rm -rf "$$stage"
	@echo "→ $(BUILD_DIR)/juggler-linux-$(GOARCH).tar.gz"

## app-icon-embed: Sync $(APP_ICON_PNG) into the Go package so go:embed can
## pick it up (go:embed rejects symlinks). Both files are checked in; this
## keeps them in sync on every build, so changes to $(APP_ICON_PNG) flow
## through automatically.
app-icon-embed:
	@if [ -f "$(APP_ICON_PNG)" ] && ! cmp -s "$(APP_ICON_PNG)" "$(APP_ICON_EMBED)" 2>/dev/null; then \
		cp "$(APP_ICON_PNG)" "$(APP_ICON_EMBED)"; \
		echo "Synced $(APP_ICON_EMBED) ← $(APP_ICON_PNG)"; \
	fi

## wails-runtime-embed: Sync the Wails v3 runtime.js bundle into the server
## package so go:embed can pick it up (it can't follow symlinks or `..`).
## Served at /wails/runtime.js for every client — see wails_runtime.go.
WAILS_RUNTIME_SRC=3rdparty/wails/v3/internal/assetserver/bundledassets/runtime.js
WAILS_RUNTIME_EMBED=cmd/juggler/server/wails_runtime.js
wails-runtime-embed:
	@if [ -f "$(WAILS_RUNTIME_SRC)" ] && ! cmp -s "$(WAILS_RUNTIME_SRC)" "$(WAILS_RUNTIME_EMBED)" 2>/dev/null; then \
		cp "$(WAILS_RUNTIME_SRC)" "$(WAILS_RUNTIME_EMBED)"; \
		echo "Synced $(WAILS_RUNTIME_EMBED) ← $(WAILS_RUNTIME_SRC)"; \
	fi

## win-icon: Compile $(APP_ICON_PNG) into a Windows .syso resource for BOTH the
## server (cmd/juggler) and the desktop app (cmd/juggler-app) so each .exe shows
## the Juggler icon in Explorer / the taskbar — the linker only embeds a .syso
## found in the package it builds, so each main package needs its own. Uses
## github.com/tc-hib/go-winres (auto-installed). Skipped silently if the tool
## can't be installed (e.g. no network); the binaries still build, just without
## an icon resource.
##
## --manifest gui embeds an application manifest declaring the Common-Controls
## v6 side-by-side assembly (and PerMonitor-v2 DPI awareness, which the app also
## sets at runtime, so that part is a no-op). The v6 dependency is what lets the
## desktop app show themed TaskDialog message boxes instead of the classic
## Win32 MessageBox; without it the dialog code falls back to the legacy look.
#
# On the Windows runner `go env GOPATH` returns a backslash path
# (C:\Users\...\go); the msys `sh` that Make spawns eats the backslashes,
# mangling the tool path to C:Users...go/bin/go-winres. Normalise to forward
# slashes (valid on Windows too) so the invocation actually resolves.
GO_WINRES := $(subst \,/,$(shell go env GOPATH))/bin/go-winres
win-icon:
	@if [ ! -f "$(APP_ICON_PNG)" ]; then exit 0; fi
	@if [ ! -x "$(GO_WINRES)" ]; then \
		echo "Installing go-winres..."; \
		go install github.com/tc-hib/go-winres@latest >/dev/null 2>&1 || { \
			echo "warning: could not install go-winres; skipping Windows icon"; exit 0; }; \
	fi
	@for pkg in juggler juggler-app; do \
		"$(GO_WINRES)" simply \
			--arch $(WIN_SYSO_ARCHES) \
			--icon "$(APP_ICON_PNG)" \
			--manifest gui \
			--product-name Juggler \
			--file-description Juggler \
			--out cmd/$$pkg/rsrc >/dev/null || { \
				echo "warning: go-winres failed for cmd/$$pkg; skipping Windows icon"; exit 0; }; \
	done; \
	echo "Compiled Windows icon resources ($(WIN_SYSO_ARCHES)) → cmd/{juggler,juggler-app}/rsrc_windows_*.syso"

## mac-app-meta: Generate Info.plist and AppIcon.icns (macOS only).
## The .icon bundle ($(MAC_ICON_SRC)) is the source of truth, but Xcode's
## `actool` can't compile a standalone .icon to .icns outside an Xcode build
## graph. We rasterize the bundle's SVG asset with qlmanage and feed the
## standard sizes to iconutil. If anything in that pipeline fails we fall
## back to assets/icons/juggler-logo.png; if that's missing too we leave the bundle
## iconless rather than failing the build.
mac-app-meta:
ifeq ($(UNAME_S),Darwin)
	@printf '%s\n' \
		'<?xml version="1.0" encoding="UTF-8"?>' \
		'<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">' \
		'<plist version="1.0"><dict>' \
		'  <key>CFBundleDevelopmentRegion</key><string>en</string>' \
		'  <key>CFBundleExecutable</key><string>juggler-app</string>' \
		'  <key>CFBundleIconFile</key><string>AppIcon</string>' \
		'  <key>CFBundleIconName</key><string>juggler</string>' \
		'  <key>CFBundleIdentifier</key><string>$(MAC_BUNDLE_ID)</string>' \
		'  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>' \
		'  <key>CFBundleName</key><string>Juggler</string>' \
		'  <key>CFBundleDisplayName</key><string>Juggler</string>' \
		'  <key>CFBundlePackageType</key><string>APPL</string>' \
		'  <key>CFBundleShortVersionString</key><string>$(VERSION)</string>' \
		'  <key>CFBundleVersion</key><string>$(VERSION)</string>' \
		'  <key>LSMinimumSystemVersion</key><string>14.0</string>' \
		'  <key>NSHighResolutionCapable</key><true/>' \
		'</dict></plist>' \
		> $(MAC_APP_PLIST)
	@tmp=$$(mktemp -d); \
	base=$$(basename "$(MAC_ICON_SRC)" .icon); \
	if [ -d "$(MAC_ICON_SRC)" ] && xcrun actool "$(MAC_ICON_SRC)" \
		--compile $$tmp \
		--platform macosx \
		--minimum-deployment-target 26.0 \
		--target-device mac \
		--app-icon "$$base" \
		--include-all-app-icons \
		--output-partial-info-plist $$tmp/partial.plist \
		--warnings --errors --notices >/dev/null 2>&1 \
		&& [ -f "$$tmp/$$base.icns" ] && [ -f "$$tmp/Assets.car" ]; then \
		cp "$$tmp/$$base.icns" "$(MAC_APP_RES)/AppIcon.icns"; \
		cp "$$tmp/Assets.car"  "$(MAC_APP_RES)/Assets.car"; \
	else \
		echo "warning: actool failed to compile $(MAC_ICON_SRC); bundle has no icon"; \
	fi; \
	rm -rf $$tmp
endif

## mac-codesign: Seal the .app bundle (macOS only). Inner binaries first, then
## the bundle, so the seal covers everything (inside-out).
##
## ALWAYS signs — with $(CODESIGN_IDENTITY) when set, otherwise ad-hoc ("-").
## The ad-hoc fallback is not cosmetic: Go's linker only ad-hoc-signs each inner
## Mach-O individually and never writes the bundle's _CodeSignature, so an
## unsigned bundle's signature is INVALID ("code has no resources but signature
## indicates they must be present"). A quarantined copy of that (any browser
## download) fails Gatekeeper as "damaged and can't be opened" — a dead end with
## no Open option. Sealing the bundle ad-hoc makes the signature valid, which
## downgrades that to the recoverable "unidentified developer" prompt
## (right-click → Open / Settings → Open Anyway). Full removal of the warning
## still needs a Developer ID cert + notarization (see docs); this is the
## inside-out foundation that step builds on.
##
## With CODESIGN_IDENTITY set it additionally keys TCC grants on a stable cdhash
## (see CODESIGN_IDENTITY above) — stopping the per-rebuild permission prompts —
## AND enables the hardened runtime (--options runtime), a secure timestamp
## (--timestamp), and the $(MAC_ENTITLEMENTS) entitlements. Those three are the
## prerequisites for notarizing a Developer ID build: Apple rejects a submission
## that lacks the hardened runtime or a secure timestamp. The ad-hoc fallback
## deliberately omits them (a secure timestamp needs a real cert, and hardened
## runtime is meaningless without one), so an identity-less dev build signs
## exactly as before. Run after mac-app-meta so Info.plist is sealed in.
mac-codesign:
ifeq ($(UNAME_S),Darwin)
	@id="$(CODESIGN_IDENTITY)"; \
	if [ -n "$$id" ]; then \
		echo "Signing bundle with '$$id' (hardened runtime + entitlements + secure timestamp)..."; \
		opts="--options runtime --timestamp --entitlements $(MAC_ENTITLEMENTS)"; \
	else \
		id="-"; opts=""; \
		echo "Signing bundle ad-hoc (set CODESIGN_IDENTITY to use a real identity)..."; \
	fi; \
	codesign --force --sign "$$id" $$opts --identifier "$(MAC_BUNDLE_ID).server" "$(MAC_APP_BIN)" && \
	codesign --force --sign "$$id" $$opts --identifier "$(MAC_BUNDLE_ID)" "$(MAC_APP_APP_BIN)" && \
	codesign --force --sign "$$id" $$opts --identifier "$(MAC_BUNDLE_ID)" "$(MAC_APP_DIR)" || \
	{ echo "codesign failed (is '$$id' a valid keychain identity?)"; exit 1; }
endif

## build: Build all binaries (includes linting)
build: lint go-build

## test: Run all tests (Go package unit + integration + browser, no API keys
## needed). Skips lint for a fast inner loop. Use `make build` (or
## `make test-full`) before opening a PR to run lint + tests.
##
## Runs the Go package unit tests (`./cmd/...`, incl. the claudecode provider
## and worker) first, then the integration/browser suite — as distinct lines so
## a failure names which layer broke.
##
## Runs without `-v`, so the terminal stays quiet: a single `ok ... <time>`
## line on success, and only the failing tests' output on failure. The same
## output is teed to $(BUILD_DIR)/test*.log. No need to tee/tail/grep yourself.
##
## To iterate on ONE test, pass RUN='<regex>' (a `go test -run` pattern matched
## against test-function names); it also flips on -v so you see that test's
## output. This is the sanctioned way to run a single integration/browser test —
## never invoke `node`, the browser harness, or `go test` by hand.
##   make test RUN='TestDiffView'            # one test, whichever layer it's in
##   make test RUN='TestDiffView/collapsed'  # one subtest
##   make test-go RUN='TestWorker'           # restrict to the fast unit layer
test: test-go
	@mkdir -p $(BUILD_DIR)
	@bash -c 'set -o pipefail; \
		$(GOTEST) -count=1 $(RACE) -timeout 15m $(GOTEST_RUN) ./tests/integration/... 2>&1 | tee $(BUILD_DIR)/test.log; \
		exit $${PIPESTATUS[0]}'

## test-go: Run Go package unit tests (claudecode provider, worker, etc.).
## Scope is all of `./cmd/...` (~75s under -race; claudecode ~55s) — and
## includes the tool-delivery permutation harness, which `make test` otherwise
## only compiled (via lint) and never executed.
test-go: go-build
	@mkdir -p $(BUILD_DIR)
	@bash -c 'set -o pipefail; \
		$(GOTEST) -count=1 $(RACE) -timeout 5m $(GOTEST_RUN) ./cmd/... 2>&1 | tee $(BUILD_DIR)/test-go.log; \
		exit $${PIPESTATUS[0]}'

## test-full: Run lint + all tests (pre-PR target).
test-full: lint test

## benchmark: Run LLM benchmarks (requires API keys, e.g. ARGS="--task bugfix-001")
benchmark: build
	@echo "Running LLM benchmarks..."
	@$(BUILD_DIR)/juggler-test$(BIN_EXT) $(ARGS)

## dev: Run in development mode with hot reload
dev: build
	@echo "Running in development mode..."
	@$(BUILD_DIR)/$(BINARY_NAME)$(BIN_EXT) --assets-from-disk --verbose

## clean: Clean build artifacts
clean:
	@echo "Cleaning..."
	@$(GOCLEAN)
	@rm -rf $(BUILD_DIR) $(MAC_APP_DIR)
	@rm -f cmd/juggler/rsrc_*.syso cmd/juggler-app/rsrc_*.syso
# golangci-lint caches parsed typecheck data keyed by absolute file paths, so a
# repo move (or a stale build) leaves it pointing at paths that no longer exist
# — at which point it can no longer read the source to honor //nolint directives
# and starts emitting false positives it can't suppress. Clearing the cache
# forces a re-parse against the current paths. No-op if golangci-lint isn't
# installed.
	@if command -v golangci-lint &> /dev/null; then \
		golangci-lint cache clean &> /dev/null; \
	fi

## install-mac: Install Juggler.app to /Applications and symlink the CLI.
## Run after `make build`. Sudo may be required depending on permissions.
install-mac:
ifeq ($(UNAME_S),Darwin)
	@if [ ! -d "$(MAC_APP_DIR)" ]; then echo "Run 'make build' first."; exit 1; fi
	@echo "Installing Juggler.app to /Applications..."
	@rm -rf "/Applications/Juggler.app"
	@cp -R "$(MAC_APP_DIR)" "/Applications/Juggler.app"
	@mkdir -p /usr/local/bin
	@ln -sfn "/Applications/Juggler.app/Contents/MacOS/$(BINARY_NAME)" "/usr/local/bin/$(BINARY_NAME)"
	@echo "Installed. Run 'juggler' in a terminal or launch Juggler from Finder."
else
	@echo "install-mac is only supported on macOS."; exit 1
endif

## fmt: Format code
fmt:
	@echo "Formatting code..."
	@$(GOFMT) ./...

# Pin golangci-lint to the same version the CI workflow installs, so local
# and CI runs see the same rule set and the same false-positive surface.
GOLANGCI_LINT_VERSION=v2.12.2

## lint: Run all linters (Go + JavaScript type checking + JavaScript linting + CSS)
## This and `lint-files` are the ONLY sanctioned ways to lint. Never invoke
## golangci-lint / go vet / gofmt / eslint / stylelint by hand — the configs,
## flags, ignore patterns and pinned tool versions live here, and a hand-rolled
## invocation silently diverges from what CI enforces.
lint: lint-fmt lint-go lint-deadcode lint-types lint-js lint-css
	@echo "✓ lint passed"

## lint-files: Lint ONLY the named files, using the same linters/configs as
## `make lint`, routed by extension (.go/.js/.css). Use this to lint a subset
## instead of reaching for the underlying tools directly.
##   make lint-files FILES="cmd/juggler/worker/foo.go web/js/bar.js"
## Go files pull in the embed prerequisites so package typechecks don't fail on
## a stale generated embed (same reason lint-go depends on them).
lint-files: app-icon-embed wails-runtime-embed
	@GOLANGCI_LINT_VERSION="$(GOLANGCI_LINT_VERSION)" scripts/lint-files $(FILES)

## lint-fmt: Enforce gofmt across the tree.
## Excludes vendored submodules under 3rdparty/ and any Go files that an npm
## package vendored into tooling/node_modules/ ships (e.g. flatted/).
lint-fmt:
	@out=$$(gofmt -l $$(find . -name '*.go' -not -path './3rdparty/*' -not -path './tooling/*')); \
	if [ -n "$$out" ]; then \
		echo "gofmt: the following files are not formatted:"; \
		echo "$$out"; \
		exit 1; \
	fi

## lint-go: Run Go linter (installs pinned golangci-lint if needed).
## Package patterns are scoped explicitly so neither go vet nor golangci-lint
## descends into tooling/node_modules/ on a fresh `npm install`.
# app-icon-embed/wails-runtime-embed regenerate the go:embed source files from
# their assets/ sources. They must run before any Go compilation — including
# lint — or a deleted/stale embed file fails the typecheck (the generated copies
# are therefore disposable, not hand-maintained).
lint-go: app-icon-embed wails-runtime-embed
	@$(GOVET) ./cmd/... ./tests/... ./web/...
	@if ! command -v golangci-lint &> /dev/null; then \
		echo "Installing golangci-lint $(GOLANGCI_LINT_VERSION)..."; \
		go install github.com/golangci/golangci-lint/v2/cmd/golangci-lint@$(GOLANGCI_LINT_VERSION); \
	fi
	@$(subst \,/,$(shell go env GOPATH))/bin/golangci-lint run --timeout=5m ./cmd/... ./tests/... ./web/...

## lint-deadcode: Find unreachable Go functions in cmd/ (production code).
## Test helpers and benchmark fixtures are excluded; mock methods in _test.go
## are filtered because they satisfy interfaces via dynamic dispatch that
## deadcode's conservative analysis cannot prove reachable.
##
## Package patterns are scoped explicitly to our own dirs — using ./... would
## sweep into tooling/node_modules/, which on a fresh `npm install` ships Go
## files (e.g. flatted/golang/pkg/flatted/) that are unrelated to this
## module and tank the analysis with bogus "unreachable" hits.
lint-deadcode: app-icon-embed wails-runtime-embed
	@if [ ! -x "$(subst \,/,$(shell go env GOPATH))/bin/deadcode" ]; then \
		echo "Installing deadcode..."; \
		go install golang.org/x/tools/cmd/deadcode@latest; \
	fi
	@out=$$($(subst \,/,$(shell go env GOPATH))/bin/deadcode -test ./cmd/... ./tests/... ./web/... \
		| tr '\134' '/' \
		| grep -v '_test\.go:' \
		| grep -v '^tests/helpers/' \
		| grep -v '^tests/integration/helpers/' \
		| grep -v '^tests/benchmarks/fixtures/'); \
	if [ -n "$$out" ]; then \
		echo "$$out"; \
		echo "deadcode: unreachable functions found"; \
		exit 1; \
	fi

## JS/CSS tooling (configs + node_modules) lives under tooling/. Binaries are
## resolved directly from tooling/node_modules/.bin so the linters run from the
## repo root — keeping the web/** globs root-relative — while plugins and
## configs resolve next to themselves under tooling/. Run `cd tooling && npm
## install` to populate it.
NPM_BIN := tooling/node_modules/.bin

## node-deps: Ensure the JS/CSS/type linters (tooling/node_modules) are present,
## installing them on demand the SAME way lint-go bootstraps golangci-lint. This
## is the ONLY place the toolchain is installed — a single tooling/node_modules,
## never duplicated. Fails hard when npm is unavailable instead of skipping: a
## `make lint` that reports success without ever running eslint/stylelint/tsc is
## worse than a clear error.
node-deps:
	@if [ ! -x $(NPM_BIN)/eslint ] || [ ! -x $(NPM_BIN)/stylelint ] || [ ! -x $(NPM_BIN)/tsc ]; then \
		if ! command -v npm > /dev/null 2>&1; then \
			echo "npm not found on PATH — cannot lint JS/CSS. Install Node.js and retry." >&2; \
			exit 2; \
		fi; \
		echo "Installing JS/CSS linters (cd tooling && npm install)..."; \
		(cd tooling && npm install) || exit 2; \
	fi

## lint-types: Run TypeScript type checking on JavaScript files
lint-types: node-deps
	@NODE_NO_WARNINGS=1 $(NPM_BIN)/tsc --project tooling/jsconfig.json --noEmit

## lint-js: Run JavaScript linter (all warnings are errors)
lint-js: node-deps
	@NODE_NO_WARNINGS=1 $(NPM_BIN)/eslint --config tooling/eslint.config.js --max-warnings 0 --ignore-pattern 'web/js/vendor/**' 'web/js/**/*.js' 'web/sdk/**/*.js' 'web/extensions/**/*.js' 'web/js-tests/**/*.js'

## lint-css: Run CSS linter (enforces rem units, no px)
lint-css: node-deps
	@NODE_NO_WARNINGS=1 $(NPM_BIN)/stylelint --config tooling/.stylelintrc.json 'web/css/**/*.css'

## fix: Auto-fix everything the linters CAN fix in place — gofmt, golangci-lint
## --fix, eslint --fix, stylelint --fix — reusing the SAME globs, configs, and
## pinned tool versions as `make lint`, so a fix run and a lint run can never
## diverge. This is the counterpart to `lint`: run `make fix` to clear the
## mechanical failures, then `make lint` to see what genuinely needs a human. It
## does NOT touch type errors (lint-types) or dead code (lint-deadcode) — those
## have no safe auto-fix. Like lint, this and `fix-files` are the ONLY sanctioned
## ways to auto-fix; never run gofmt -w / eslint --fix / stylelint --fix by hand.
fix: fix-fmt fix-go fix-js fix-css
	@echo "✓ auto-fixes applied — now run 'make lint'"

## fix-fmt: gofmt -w across the tree (same file set lint-fmt checks).
fix-fmt:
	@gofmt -w $$(find . -name '*.go' -not -path './3rdparty/*' -not -path './tooling/*')

## fix-go: Apply golangci-lint's auto-fixes (only the linters that support --fix;
## many findings have none and still need a hand edit). Same package scope as
## lint-go; embeds regenerated first so the fixers typecheck against the real build.
fix-go: app-icon-embed wails-runtime-embed
	@if ! command -v golangci-lint &> /dev/null; then \
		echo "Installing golangci-lint $(GOLANGCI_LINT_VERSION)..."; \
		go install github.com/golangci/golangci-lint/v2/cmd/golangci-lint@$(GOLANGCI_LINT_VERSION); \
	fi
	@$(subst \,/,$(shell go env GOPATH))/bin/golangci-lint run --fix --timeout=5m ./cmd/... ./tests/... ./web/...

## fix-js: eslint --fix (same globs, config, and ignore patterns as lint-js).
fix-js: node-deps
	@NODE_NO_WARNINGS=1 $(NPM_BIN)/eslint --config tooling/eslint.config.js --fix --ignore-pattern 'web/js/vendor/**' 'web/js/**/*.js' 'web/sdk/**/*.js' 'web/extensions/**/*.js' 'web/js-tests/**/*.js'

## fix-css: stylelint --fix (same globs and config as lint-css).
fix-css: node-deps
	@NODE_NO_WARNINGS=1 $(NPM_BIN)/stylelint --config tooling/.stylelintrc.json --fix 'web/css/**/*.css'

## fix-files: Auto-fix ONLY the named files, routed by extension to the same
## fixers as `make fix` (the write-mode counterpart to lint-files). Whole-program
## checks with no per-file fix (deadcode, type errors) are not run here.
##   make fix-files FILES="cmd/juggler/worker/foo.go web/css/bar.css"
fix-files: app-icon-embed wails-runtime-embed
	@GOLANGCI_LINT_VERSION="$(GOLANGCI_LINT_VERSION)" FIX=1 scripts/lint-files $(FILES)

## install: Install binary globally
install: build
	@echo "Installing $(BINARY_NAME)..."
	@cp $(BUILD_DIR)/$(BINARY_NAME) $(GOPATH)/bin/

## tidy: Tidy go modules
tidy:
	@echo "Tidying go modules..."
	@$(GOCMD) mod tidy

## help: Show this help message
help:
	@echo "Usage: make [target]"
	@echo ""
	@echo "Targets:"
	@sed -n 's/^##//p' $(MAKEFILE_LIST) | column -t -s ':' | sed -e 's/^/ /'

.DEFAULT_GOAL := help
