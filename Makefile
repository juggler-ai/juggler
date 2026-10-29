.PHONY: build test test-build test-go test-full benchmark dev clean fmt lint lint-files lint-go lint-deadcode lint-js lint-js-deadcode lint-types lint-css lint-i18n fix fix-files fix-fmt fix-go fix-js fix-css node-deps help models-sync mac-app install-mac app-icon-embed wails-runtime-embed wails-runtime-build test-wails-patches win-icon release-build-mac mac-dmg mac-dmg-pack win-installer win-installer-pack linux-binaries linux-tarball linux-tarball-pack mac-codesign linux-compat-server

# Binary name
BINARY_NAME=juggler
BUILD_DIR=bin

# Platform detection (used to optionally bundle a macOS .app)
UNAME_S := $(shell uname -s)
# GOARCH_HOST (host CPU arch), BIN_EXT (native executable suffix) and RACE come
# from mk/build-flags.mk, included below.
# Extra linker args for the desktop app on a native Windows build. The app is a
# GUI binary and must link -H windowsgui, or Windows gives it a console window
# that sits open behind the app for its whole run (and its logging assumes no
# console — see cmd/juggler-app/util.go). The cross-compile target
# (build-windows) passes the same flag; this is the native-build half. The
# server binary deliberately does NOT get it: see the console-subsystem note
# below.
ifeq ($(OS),Windows_NT)
APP_LDFLAGS := -H windowsgui
else
APP_LDFLAGS :=
endif
MAC_APP_DIR=$(BUILD_DIR)/Juggler.app
# The clickable bundle executable is the desktop app (juggler-app); the headless
# server binary (juggler) sits alongside it in MacOS/ so the app's serverBinPath
# finds it as a sibling.
MAC_APP_BIN=$(MAC_APP_DIR)/Contents/MacOS/$(BINARY_NAME)
MAC_APP_APP_BIN=$(MAC_APP_DIR)/Contents/MacOS/juggler-app
MAC_APP_RES=$(MAC_APP_DIR)/Contents/Resources
MAC_APP_PLIST=$(MAC_APP_DIR)/Contents/Info.plist
# Where each macOS binary is built before being moved into the bundle (see
# go-build for why). Outside the bundle, so a half-finished build never leaves a
# stray Mach-O for mac-codesign to seal in or for the DMG to ship.
MAC_STAGE=$(BUILD_DIR)/.stage
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
# Unset (default) → ad-hoc signing, with no cert dependency for other devs/CI. Set it to a self-signed keychain cert's name to opt in:
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
# runs the whole suite quietly. Honoured by `make test`, `make
# test-go`, and `make test-full`. Double-quoted so a regex containing |, /, or a
# space survives the single-quoted `bash -c` wrappers in the test recipes below.
RUN ?=
GOTEST_RUN=$(if $(RUN),-run "$(RUN)" -v)
# With RUN set every package is still compiled and run, so the ~40 that hold no
# matching test narrate themselves under -v — a "no tests to run" warning, a
# bare PASS and an `ok <pkg> [no tests to run]` each. That is the great majority
# of the output of a one-test run, and it buries the test you asked about.
# Silence exactly those lines (plus the `[no test files]` roll-call) and nothing
# else, so a narrowed run prints the narrowed run. Only applied when RUN is set:
# an unnarrowed run's per-package `ok` lines are its progress feed.
#
# It sits BEFORE the tee, so the log and the terminal hold the same text and
# there is never a reason to go and read the log instead. The braces' `|| true`
# stops a fully-filtered stream (grep exits 1 when it selects nothing) from
# reading as a failure under pipefail; `go test`'s own status is the verdict.
#
# Silencing those lines also silences a RUN that matched nothing anywhere, so
# `test` (and `test-go` run on its own) end with scripts/run-matched over the
# layers' logs, which fails a narrowed run in which no test passed or failed.
QUIET_UNMATCHED=$(if $(RUN),| { grep --line-buffered -vE "^(testing: warning: no tests to run|PASS)$$|\[no tests to run\]$$|\[no test files\]$$" || true; })
GOGET=$(GOCMD) get
GOFMT=$(GOCMD) fmt
GOVET=$(GOCMD) vet

# Version info (can override with: make build VERSION=1.0.0).
# The version lives in the VERSION file at the repo root, bumped by
# scripts/push-release; CI passes it explicitly via VERSION=.
VERSION ?= $(shell cat VERSION 2>/dev/null || echo "dev")
COMMIT ?= $(shell git rev-parse --short HEAD 2>/dev/null || echo "unknown")
BUILD_DATE ?= $(shell date -u +%Y-%m-%dT%H:%M:%SZ)

# Shared build flags: GOARCH_HOST/BIN_EXT/RACE, GOBUILD/GOBUILD_RELEASE, the
# macOS deployment-target + CGO exports, and the version-stamp
# LDFLAGS_BASE/LDFLAGS. Included here — after
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
	@# Build into $(MAC_STAGE) and move into the bundle, rather than writing the
	@# slot directly. A server RUNNING from this tree re-execs its own path to
	@# recover from a main-thread wedge (relaunchInPlace), so that path must
	@# never be empty: building in place leaves it missing for the whole compile,
	@# and a wedge in that window turns an in-place restart into a dead process.
	@# rename() is atomic and leaves the old inode intact for anything still
	@# running from it. Moving in also replaces a leftover universal (fat) Mach-O
	@# from an older `make release-build-mac`, which `go build -o` refuses to
	@# overwrite ("already exists and is not an object file").
	@mkdir -p $(MAC_STAGE)
	@rm -f $(MAC_STAGE)/$(BINARY_NAME) $(MAC_STAGE)/juggler-app
	@$(GOBUILD) -ldflags "$(LDFLAGS)" -o $(MAC_STAGE)/$(BINARY_NAME) ./cmd/juggler
	@$(GOBUILD) $(APP_GOFLAGS) -ldflags "$(LDFLAGS)" -o $(MAC_STAGE)/juggler-app ./cmd/juggler-app
	@mv -f $(MAC_STAGE)/$(BINARY_NAME) $(MAC_APP_BIN)
	@mv -f $(MAC_STAGE)/juggler-app $(MAC_APP_APP_BIN)
	@$(MAKE) --no-print-directory mac-app-meta
	@$(MAKE) --no-print-directory mac-codesign
	@ln -sfn Juggler.app/Contents/MacOS/$(BINARY_NAME) $(BUILD_DIR)/$(BINARY_NAME)
	@ln -sfn Juggler.app/Contents/MacOS/juggler-app $(BUILD_DIR)/juggler-app
else
	@$(GOBUILD) -ldflags "$(LDFLAGS)" -o $(BUILD_DIR)/$(BINARY_NAME)$(BIN_EXT) ./cmd/juggler
	@$(GOBUILD) $(APP_GOFLAGS) -ldflags "$(LDFLAGS) $(APP_LDFLAGS)" -o $(BUILD_DIR)/juggler-app$(BIN_EXT) ./cmd/juggler-app
endif
	@$(GOBUILD) -ldflags "$(LDFLAGS)" -o $(BUILD_DIR)/juggler-test$(BIN_EXT) ./cmd/juggler-test
	@echo "✓ built juggler, juggler-app, juggler-test ($(VERSION_STAMP))"

# Where the server the suites drive is built. Beside the app, never in it:
# bin/juggler is the slot the desktop app occupies (on macOS a symlink into
# Juggler.app), so building a test server there would leave a `make build` owing
# after every test run. The suites find this one through JUGGLER_TEST_SERVER
# (helpers.ServerBinary, tests/helpers/subprocess.go).
TEST_SERVER_BIN := $(BUILD_DIR)/juggler-testsrv$(BIN_EXT)

## test-build: Build the test-capable server the suites spawn, stamped -test.
## No production tag: the browser suite needs the //go:build !production handlers.
##
## The stamp is what keeps a test run from being counted as an install. A spawned
## server behaves like one in every other respect — it polls the update endpoint
## on the same schedule, from whatever config dir the test handed it — so the
## version is all the endpoint has to tell them apart, and several spawn sites
## here start the server without --test. Stamped -dev, one run of this suite
## reports a handful of brand new installs, and a CI matrix does it per runner.
test-build: app-icon-embed wails-runtime-embed
	@mkdir -p $(BUILD_DIR)
	@$(GOBUILD) -ldflags "$(TEST_LDFLAGS)" -o $(TEST_SERVER_BIN) ./cmd/juggler
	@$(GOBUILD) -ldflags "$(TEST_LDFLAGS)" -o $(BUILD_DIR)/juggler-test$(BIN_EXT) ./cmd/juggler-test
	@echo "✓ built juggler-testsrv, juggler-test ($(TEST_VERSION_STAMP))"

## release-build: Build juggler with -tags production. Excludes test handlers
## (cmd/juggler/testing/, worker_test_support.go) so they can't be reached in
## shipped binaries. juggler-test is intentionally not built here.
release-build: app-icon-embed wails-runtime-embed
	@echo "Building $(BINARY_NAME) $(VERSION_STAMP) [release]..."
	@mkdir -p $(BUILD_DIR)
ifeq ($(UNAME_S),Darwin)
	@mkdir -p $(MAC_APP_DIR)/Contents/MacOS $(MAC_APP_RES)
	@# See go-build for why each binary is built into $(MAC_STAGE) and moved in.
	@mkdir -p $(MAC_STAGE)
	@rm -f $(MAC_STAGE)/$(BINARY_NAME) $(MAC_STAGE)/juggler-app
	$(GOBUILD_RELEASE) -ldflags "$(LDFLAGS)" -o $(MAC_STAGE)/$(BINARY_NAME) ./cmd/juggler
	@echo "Building juggler-app $(VERSION_STAMP) [release]..."
	$(GOBUILD_RELEASE) $(APP_GOFLAGS) -ldflags "$(LDFLAGS)" -o $(MAC_STAGE)/juggler-app ./cmd/juggler-app
	@mv -f $(MAC_STAGE)/$(BINARY_NAME) $(MAC_APP_BIN)
	@mv -f $(MAC_STAGE)/juggler-app $(MAC_APP_APP_BIN)
	@$(MAKE) --no-print-directory mac-app-meta
	@$(MAKE) --no-print-directory mac-codesign
	@ln -sfn Juggler.app/Contents/MacOS/$(BINARY_NAME) $(BUILD_DIR)/$(BINARY_NAME)
	@ln -sfn Juggler.app/Contents/MacOS/juggler-app $(BUILD_DIR)/juggler-app
else
	$(GOBUILD_RELEASE) -ldflags "$(LDFLAGS)" -o $(BUILD_DIR)/$(BINARY_NAME)$(BIN_EXT) ./cmd/juggler
	@echo "Building juggler-app $(VERSION_STAMP) [release]..."
	$(GOBUILD_RELEASE) $(APP_GOFLAGS) -ldflags "$(LDFLAGS) $(APP_LDFLAGS)" -o $(BUILD_DIR)/juggler-app$(BIN_EXT) ./cmd/juggler-app
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
	echo "Building juggler-app.exe (windowsgui) $(VERSION_STAMP)..." && \
	CGO_ENABLED=0 GOOS=windows GOARCH=amd64 $(GOBUILD_RELEASE) $(APP_GOFLAGS) -ldflags "$(LDFLAGS_BASE) -H windowsgui" -o $(WIN_BUILD_DIR)/juggler-app.exe ./cmd/juggler-app
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

# APP_GOFLAGS (optional): extra `go build` flags for the desktop app
# (./cmd/juggler-app) only, on every target that compiles it — for instance
# -overlay=<json> to compile extra files into the package without writing them
# into this tree. Unset = the stock app, exactly as written.
APP_GOFLAGS ?=

## release-build-mac: Build the Juggler.app for distribution.
## Both the server (juggler) and app (juggler-app) are built based on the
## system arch. macOS only. Use `make mac-dmg` to wrap the
## result in a drag-to-Applications DMG. Set SERVER_BIN to inject a prebuilt
## server into the slot instead of building ./cmd/juggler.
release-build-mac: app-icon-embed wails-runtime-embed
ifneq ($(UNAME_S),Darwin)
	@echo "release-build-mac is only supported on macOS."; exit 1
endif
	@echo "Building Juggler.app $(VERSION_STAMP) [release, $(GOARCH_HOST)]..."
	@mkdir -p $(MAC_APP_DIR)/Contents/MacOS $(MAC_APP_RES)
	@# See go-build for why each binary is built into $(MAC_STAGE) and moved in.
	@mkdir -p $(MAC_STAGE)
	@rm -f $(MAC_STAGE)/$(BINARY_NAME) $(MAC_STAGE)/juggler-app
	@if [ -n "$(SERVER_BIN)" ]; then \
		echo "  → juggler (from $(SERVER_BIN))"; \
		cp "$(SERVER_BIN)" "$(MAC_STAGE)/$(BINARY_NAME)"; \
	else \
		echo "  → juggler ($(GOARCH_HOST))"; \
		CGO_ENABLED=1 GOOS=darwin GOARCH=$(GOARCH_HOST) $(GOBUILD_RELEASE) -ldflags "$(LDFLAGS)" -o $(MAC_STAGE)/$(BINARY_NAME) ./cmd/juggler || exit 1; \
	fi
	@echo "  → juggler-app ($(GOARCH_HOST))"
	@CGO_ENABLED=1 GOOS=darwin GOARCH=$(GOARCH_HOST) $(GOBUILD_RELEASE) $(APP_GOFLAGS) -ldflags "$(LDFLAGS)" -o $(MAC_STAGE)/juggler-app ./cmd/juggler-app || exit 1
	@mv -f $(MAC_STAGE)/$(BINARY_NAME) $(MAC_APP_BIN)
	@mv -f $(MAC_STAGE)/juggler-app $(MAC_APP_APP_BIN)
	@$(MAKE) --no-print-directory mac-app-meta
	@$(MAKE) --no-print-directory mac-codesign
	@ln -sfn Juggler.app/Contents/MacOS/$(BINARY_NAME) $(BUILD_DIR)/$(BINARY_NAME)
	@ln -sfn Juggler.app/Contents/MacOS/juggler-app $(BUILD_DIR)/juggler-app
	@echo "→ $(MAC_APP_DIR) ($(GOARCH_HOST): $$(lipo -archs $(MAC_APP_APP_BIN)))"

## mac-dmg: Build a distributable .dmg containing the Juggler.app with
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
## The installer's languages and messages are generated from the UI catalogues
## into $(WIN_BUILD_DIR)/languages.iss, which juggler.iss includes.
win-installer-pack:
	@command -v iscc >/dev/null 2>&1 || { echo "iscc (Inno Setup) not found"; exit 1; }
	@[ -f "$(WIN_BUILD_DIR)/$(BINARY_NAME).exe" ] || { echo "no $(WIN_BUILD_DIR)/$(BINARY_NAME).exe to package — build the Windows binaries first"; exit 1; }
	@node scripts/i18n-bundle inno $(WIN_BUILD_DIR)/languages.iss
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
	@CGO_ENABLED=1 GOOS=linux GOARCH=$(GOARCH) $(GOBUILD_RELEASE) $(APP_GOFLAGS) -ldflags "$(LDFLAGS_BASE)" -o $(BUILD_DIR)/juggler-app ./cmd/juggler-app

## linux-compat-server: Build a linux/amd64 server binary inside Ubuntu 22.04,
## for running it on a distribution older than the one a release is built on.
## Output: bin/juggler-linux-amd64-jammy.
## Needs Docker, and runs on any host — the build is containerised, so an arm64
## machine cross-builds it under emulation rather than needing a toolchain.
## $(SERVER_BIN) is deliberately NOT honoured here: this target exists to pin
## the glibc floor, which a binary built elsewhere would not have.
linux-compat-server: app-icon-embed wails-runtime-embed
	@mkdir -p $(BUILD_DIR)
	@echo "  → juggler-linux-amd64-jammy (docker, ubuntu:22.04)"
	@DOCKER_BUILDKIT=1 docker build \
		--platform linux/amd64 \
		--target export \
		--output type=local,dest=$(BUILD_DIR) \
		--build-arg LDFLAGS="$(LDFLAGS_BASE)" \
		-f packaging/docker/Dockerfile.build-jammy .

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
## The source is the bundle the fork commits, built from the runtime's
## TypeScript by `make wails-runtime-build`. It carries CRLF endings on Windows;
## we strip CRs so the committed LF copy is byte-identical on every OS
## (otherwise the build rewrites it and it shows as perpetually modified).
##
## It refuses to build on a bundle it can show is stale, rather than embedding
## it: a fork whose runtime source changed without a rebuild ships a runtime.js
## that silently disagrees with the Go half of the same fork. Two checks, both
## against the fork's own git (skipped when it isn't a git checkout):
##   - runtime source modified in the working tree while the bundle is not;
##   - a commit to the runtime source (tests excluded) newer than the last
##     commit to the bundle. A depth-1 clone holds one commit, so it never
##     trips this; a full clone after a rebase is where it matters.
## A missing bundle means the fork isn't checked out, and is an error too.
WAILS_V3=3rdparty/wails/v3
WAILS_RUNTIME_SRC=$(WAILS_V3)/internal/assetserver/bundledassets/runtime.js
WAILS_RUNTIME_EMBED=cmd/juggler/server/wails_runtime.js
WAILS_RUNTIME_INPUTS=internal/runtime/desktop/@wailsio/runtime/src internal/runtime/desktop/compiled \
	':(exclude)*.test.*' ':(exclude)*.spec.*'
wails-runtime-embed:
	@if [ ! -f "$(WAILS_RUNTIME_SRC)" ]; then \
		echo "✗ $(WAILS_RUNTIME_SRC) is missing — the Wails fork isn't checked out. Run: git submodule update --init --recursive" >&2; \
		exit 1; \
	fi
	@if git -C "$(WAILS_V3)" rev-parse --git-dir >/dev/null 2>&1; then \
		cd "$(WAILS_V3)"; \
		if [ -n "$$(git status --porcelain -- $(WAILS_RUNTIME_INPUTS))" ] && \
		   [ -z "$$(git status --porcelain -- internal/assetserver/bundledassets/runtime.js)" ]; then \
			echo "✗ the Wails runtime source has uncommitted changes but its bundle doesn't — run: make wails-runtime-build" >&2; \
			git status --short -- $(WAILS_RUNTIME_INPUTS) >&2; \
			exit 1; \
		fi; \
		bundle=$$(git rev-list -1 HEAD -- internal/assetserver/bundledassets/runtime.js); \
		src=$$(git rev-list -1 HEAD -- $(WAILS_RUNTIME_INPUTS)); \
		if [ -n "$$bundle" ] && [ -n "$$src" ] && [ "$$bundle" != "$$src" ] && \
		   git merge-base --is-ancestor "$$bundle" "$$src"; then \
			echo "✗ the Wails runtime bundle predates its source: $$(git log -1 --format='%h %s' "$$src") changed the runtime after the bundle was last built ($$(git log -1 --format=%h "$$bundle")). Run: make wails-runtime-build, and commit the result in the fork" >&2; \
			exit 1; \
		fi; \
	fi
	@tr -d '\r' < "$(WAILS_RUNTIME_SRC)" > "$(WAILS_RUNTIME_EMBED).tmp"; \
	if ! cmp -s "$(WAILS_RUNTIME_EMBED).tmp" "$(WAILS_RUNTIME_EMBED)" 2>/dev/null; then \
		mv "$(WAILS_RUNTIME_EMBED).tmp" "$(WAILS_RUNTIME_EMBED)"; \
		echo "Synced $(WAILS_RUNTIME_EMBED) ← $(WAILS_RUNTIME_SRC)"; \
	else rm -f "$(WAILS_RUNTIME_EMBED).tmp"; fi

## wails-runtime-build: Rebuild the Wails fork's bundled runtime (runtime.js and
## runtime.debug.js) from its TypeScript source, with the exact esbuild commands
## of the fork's `task runtime:build:assets` (internal/runtime/Taskfile.yaml) —
## the output upstream CI requires every PR's committed bundle to match. Needs
## Node; `npm ci` installs the runtime's lockfile-pinned esbuild. Commit the
## result in the fork; wails-runtime-embed then copies it into the server.
WAILS_ESBUILD=desktop/@wailsio/runtime/node_modules/.bin/esbuild
WAILS_ESBUILD_ARGS=desktop/@wailsio/runtime/src/index.ts --inject:desktop/compiled/main.js --format=esm \
	--target=safari11 --bundle --ignore-annotations --tree-shaking=true
wails-runtime-build:
	@cd "$(WAILS_V3)/internal/runtime/desktop/@wailsio/runtime" && npm ci --no-audit --no-fund --ignore-scripts
	@cd "$(WAILS_V3)/internal/runtime" && \
		$(WAILS_ESBUILD) $(WAILS_ESBUILD_ARGS) --sourcemap=inline --outfile=../assetserver/bundledassets/runtime.debug.js --define:DEBUG=true && \
		$(WAILS_ESBUILD) $(WAILS_ESBUILD_ARGS) --minify --outfile=../assetserver/bundledassets/runtime.js --define:DEBUG=false --drop:console
	@git -C "$(WAILS_V3)" status --short -- internal/assetserver/bundledassets

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
## Its translatable text (NSMicrophoneUsageDescription), CFBundleLocalizations
## and the .lproj localizations are added by scripts/i18n-bundle, from
## packaging/messages.json and the UI catalogues in web/i18n.
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
		'  <!-- Accept a folder dropped on the Dock icon, or sent over by Finder. -->' \
		'  <!-- Alternate rank: Finder stays the default handler for a folder. -->' \
		'  <key>CFBundleDocumentTypes</key>' \
		'  <array><dict>' \
		'    <key>CFBundleTypeName</key><string>Folder</string>' \
		'    <key>CFBundleTypeRole</key><string>Editor</string>' \
		'    <key>LSHandlerRank</key><string>Alternate</string>' \
		'    <key>LSItemContentTypes</key><array><string>public.folder</string></array>' \
		'  </dict></array>' \
		'</dict></plist>' \
		> $(MAC_APP_PLIST)
	@# NSMicrophoneUsageDescription is there because TCC attributes a tool
	@# subprocess's request to its responsible app.
	@node scripts/i18n-bundle mac $(MAC_APP_DIR)/Contents
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
## runtime is meaningless without one), so an identity-less dev build gets a
## plain ad-hoc signature. Run after mac-app-meta so Info.plist is sealed in.
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
## Runs the Go package unit tests (GO_TEST_PACKAGES, incl. the claudecode
## provider and worker) first, then the integration/browser suite — as distinct lines so
## a failure names which layer broke.
##
## Runs without `-v`, so the terminal stays quiet: a single `ok ... <time>`
## line per package on success, and only the failing tests' output on failure.
## Each layer announces itself, the first failing layer stops the run (so a
## failure is the last thing on screen) and is named in a ✗ line under it. Run
## it plain and read what it prints: the same text is teed to
## $(BUILD_DIR)/test*.log purely for afterwards, and there is nothing in there
## that was not on your terminal — no need to tee/tail/grep yourself.
##
## To iterate on ONE test, pass RUN='<regex>' (a `go test -run` pattern matched
## against test-function names); it also flips on -v so you see that test's
## output, and silences the packages holding no matching test (QUIET_UNMATCHED)
## so what is left is the test you asked for. This is the sanctioned way to run
## a single integration/browser test — never invoke `node`, the browser harness,
## or `go test` by hand.
##   make test RUN='TestDiffView'            # one test, whichever layer it's in
##   make test RUN='TestDiffView/collapsed'  # one subtest
##   make test-go RUN='TestWorker'           # restrict to the fast unit layer
test: test-go test-wails-patches
	@mkdir -p $(BUILD_DIR)
	@echo "── integration + browser suite ──"
	@bash -c 'set -o pipefail; \
		export JUGGLER_TEST_SERVER="$(abspath $(TEST_SERVER_BIN))"; \
		$(GOTEST) -count=1 $(RACE) -timeout 15m $(GOTEST_RUN) ./tests/integration/... 2>&1 $(QUIET_UNMATCHED) | tee $(BUILD_DIR)/test.log; \
		rc=$${PIPESTATUS[0]}; \
		if [ $$rc -ne 0 ]; then echo "✗ the integration + browser suite failed — its output is above"; exit $$rc; fi; \
		$(if $(RUN),scripts/run-matched "$(RUN)" $(BUILD_DIR)/test-go.log $(BUILD_DIR)/test-wails-run.log $(BUILD_DIR)/test.log || exit 1;) \
		echo "✓ all tests passed"'

## test-go: Run Go package unit tests (claudecode provider, worker, etc.).
## Scope is GO_TEST_PACKAGES: every package of the module (GO_PACKAGES) except
## the integration and browser suites under ./tests/..., which `test` runs as
## its own layer (~75s under -race; claudecode ~55s). That includes the
## tool-delivery permutation harness.
test-go: go-build test-build
	@mkdir -p $(BUILD_DIR)
	@echo "── Go package tests ──"
	@bash -c 'set -o pipefail; \
		$(GOTEST) -count=1 $(RACE) -timeout 5m $(GOTEST_RUN) $(GO_TEST_PACKAGES) 2>&1 $(QUIET_UNMATCHED) | tee $(BUILD_DIR)/test-go.log; \
		rc=$${PIPESTATUS[0]}; \
		if [ $$rc -ne 0 ]; then echo "✗ the Go package tests failed — their output is above"; exit $$rc; fi; \
		$(if $(and $(RUN),$(filter test-go,$(MAKECMDGOALS))),scripts/run-matched "$(RUN)" $(BUILD_DIR)/test-go.log || exit 1;) \
		echo "✓ Go package tests passed"'

## models-sync: Refresh the compiled-in models.dev snapshot
## (cmd/juggler/providers/modelsdev/snapshot.json) — the one step here that
## touches the network — then compare the hand-kept built-in model tables
## against the full catalogue (TestModelsDevDrift). The generator prints what
## the refresh changed; review the diff and commit it. A drift failure names a
## built-in limit that disagrees with models.dev: fix the table, or record why
## ours is right in the test's allowlist. Run it before every release.
MODELS_DEV_RAW=$(BUILD_DIR)/models-dev-api.json
models-sync:
	@mkdir -p $(BUILD_DIR)
	@echo "── models.dev snapshot ──"
	@cd cmd/juggler/providers/modelsdev && go run ./gen -o snapshot.json -raw $(abspath $(MODELS_DEV_RAW))
	@echo "── built-in tables against models.dev ──"
	@JUGGLER_MODELSDEV_API=$(abspath $(MODELS_DEV_RAW)) $(GOTEST) -count=1 -run '^TestModelsDevDrift$$' -v ./cmd/juggler/providers/audit

## test-wails-patches: Run the Wails fork's own tests for the packages its
## local patches touch (docs/wails-fork.md is the ledger; keep this list in
## step with it). They live in the fork's module, outside every ./... above, so
## nothing else runs them. Built with the toolchain that builds juggler
## (GOTOOLCHAIN=local) rather than the newer one the fork's go.mod may suggest.
## The Windows-only packages compile and run on Windows; elsewhere they are
## cross-vetted for windows/amd64, so a patch that breaks the Windows build is
## caught on every OS. ~20s; ~45s under -race.
WAILS_PATCH_PKGS=./pkg/application
WAILS_PATCH_PKGS_WINDOWS=./pkg/w32 ./internal/webview2/pkg/edge
ifeq ($(OS),Windows_NT)
WAILS_PATCH_PKGS+=$(WAILS_PATCH_PKGS_WINDOWS)
endif
test-wails-patches:
	@mkdir -p $(BUILD_DIR)
	@echo "── Wails fork patch tests ──"
	@# The verdict is go test's own exit status. With RUN set the output is also
	@# kept in test-wails-run.log, one of the logs `test` hands to run-matched.
	@bash -c 'set -o pipefail; cd $(WAILS_V3) && \
		GOTOOLCHAIN=local $(GOTEST) -count=1 $(RACE) -timeout 5m $(GOTEST_RUN) $(WAILS_PATCH_PKGS) 2>&1 $(QUIET_UNMATCHED) $(if $(RUN),| tee $(abspath $(BUILD_DIR))/test-wails-run.log)' \
		|| { echo "✗ the Wails fork patch tests failed — their output is above"; exit 1; }
ifneq ($(OS),Windows_NT)
	@cd $(WAILS_V3) && GOTOOLCHAIN=local GOOS=windows GOARCH=amd64 $(GOCMD) vet -unsafeptr=false $(WAILS_PATCH_PKGS) $(WAILS_PATCH_PKGS_WINDOWS) \
		|| { echo "✗ the Wails fork's patched packages don't compile for windows/amd64"; exit 1; }
endif
	@echo "✓ Wails fork patch tests passed"

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
GOLANGCI_LINT_VERSION=v2.14.0

# What each linter covers, said once. The whole-tree targets below build their
# arguments from these, and scripts/lint-files reads the same values from the
# environment (exported here) to decide which of the files it is handed each
# linter sees, so a per-file run and `make lint` agree on every path.
#   GO_PACKAGES  go vet / golangci-lint: every package of this module. ./...
#                would also sweep in the Go an npm package ships under
#                tooling/node_modules/ (e.g. flatted/), so the module's own
#                package dirs are named instead, and lint-go fails if `go list
#                ./...` finds a package outside them that is not under
#                GO_FOREIGN. 3rdparty/wails and tests/benchmarks/fixtures are
#                modules of their own, so no pattern here reaches them.
#   GO_TEST_PACKAGES  the Go package unit tests (test-go, and every CI step
#                that runs them, which read it with `make -s
#                print-GO_TEST_PACKAGES`): GO_PACKAGES without ./tests/...,
#                whose integration and browser suites need a built test server
#                and run as their own layer (`test`, ./tests/integration/...).
#                tests/helpers holds no tests of its own.
#   GO_FOREIGN   top-level dirs whose Go is not this project's: neither vetted
#                nor gofmt-checked.
#   CSS_DIRS     stylelint.
# gofmt checks every .go file outside GO_FOREIGN, testdata and fixtures
# included: formatting needs no package to compile, so there is nothing to
# exempt them from.
GO_PACKAGES := . ./cmd/... ./internal/... ./jlog/... ./tests/... ./web/...
GO_TEST_PACKAGES := $(filter-out ./tests/...,$(GO_PACKAGES))
GO_FOREIGN := 3rdparty tooling
CSS_DIRS := web/css web/machine web/extensions web/sdk
export GOLANGCI_LINT_VERSION GO_PACKAGES GO_FOREIGN CSS_DIRS
GOFMT_FIND = find . -name '*.go' $(foreach d,$(GO_FOREIGN),-not -path './$(d)/*') -print0
CSS_GLOBS = $(foreach d,$(CSS_DIRS),'$(d)/**/*.css')

## print-VAR: Print a variable's value. scripts/lint-files uses it to read the
## lint scopes above when it is run directly rather than through make.
print-%:
	@: $(info $($*))

## lint: Run all linters (Go + JavaScript type checking + JavaScript linting + CSS)
## This and `lint-files` are the ONLY sanctioned ways to lint. Never invoke
## golangci-lint / go vet / gofmt / eslint / stylelint by hand — the configs,
## flags, ignore patterns and pinned tool versions live here, and a hand-rolled
## invocation silently diverges from what CI enforces.
lint: lint-fmt lint-go lint-deadcode lint-types lint-js lint-js-deadcode lint-css lint-docs lint-i18n
	@echo "✓ lint passed"

## lint-files: Lint ONLY the named files, using the same linters/configs as
## `make lint`, routed by extension (.go/.js/.css). Use this to lint a subset
## instead of reaching for the underlying tools directly.
##   make lint-files FILES="cmd/juggler/worker/foo.go web/js/bar.js"
## Go files pull in the embed prerequisites so package typechecks don't fail on
## a stale generated embed (same reason lint-go depends on them).
## FILES reaches the script through the environment (make exports a variable
## set on its command line), never as arguments: a long list would overflow
## Windows' command-line limit and arrive cut off mid-path. The lint scopes
## (GO_PACKAGES, GO_FOREIGN, CSS_DIRS) and GOLANGCI_LINT_VERSION travel the same
## way, exported above.
lint-files: app-icon-embed wails-runtime-embed
	@scripts/lint-files

## lint-fmt: Enforce gofmt on every .go file outside GO_FOREIGN.
## The paths reach gofmt through xargs because the whole tree's worth of them
## exceeds the command-line limit under Git-for-Windows bash: expanded inline
## they fail with "Argument list too long", which leaves the output empty and
## passes the check without having formatted-checked anything.
lint-fmt:
	@out=$$($(GOFMT_FIND) | xargs -0 gofmt -l); \
	if [ -n "$$out" ]; then \
		echo "gofmt: the following files are not formatted:"; \
		echo "$$out"; \
		exit 1; \
	fi

## lint-go: Run go vet and golangci-lint (installed at the pinned version if
## needed) over GO_PACKAGES, after checking that GO_PACKAGES still names every
## package of the module: a package dir added beside the listed ones fails here
## rather than going unlinted.
# app-icon-embed/wails-runtime-embed regenerate the go:embed source files from
# their assets/ sources. They must run before any Go compilation — including
# lint — or a deleted/stale embed file fails the typecheck (the generated copies
# are therefore disposable, not hand-maintained).
lint-go: app-icon-embed wails-runtime-embed
	@mod=$$($(GOCMD) list -m) && listed=$$($(GOCMD) list -e $(GO_PACKAGES) | tr '\n' ' ') \
		&& all=$$($(GOCMD) list -e ./...) || exit 1; \
	stray=$$(printf '%s\n' "$$all" | awk -v mod="$$mod" -v listed="$$listed" -v foreign="$(GO_FOREIGN)" ' \
		BEGIN { n = split(listed, l, " "); for (i = 1; i <= n; i++) ok[l[i]] = 1; m = split(foreign, f, " ") } \
		$$0 in ok { next } \
		{ for (i = 1; i <= m; i++) if (index($$0, mod "/" f[i] "/") == 1) next; print }'); \
	if [ -n "$$stray" ]; then \
		echo "lint-go: GO_PACKAGES in the Makefile does not cover these packages — add their dir:"; \
		printf '  %s\n' $$stray; \
		exit 1; \
	fi
	@$(GOVET) $(GO_PACKAGES)
	@scripts/ensure-golangci-lint
	@$(subst \,/,$(shell go env GOPATH))/bin/golangci-lint run --timeout=5m $(GO_PACKAGES)

## lint-deadcode: Find Go functions that no program reaches. Three passes of
## deadcode run concurrently, each answering a different question, and any
## function any of them reports fails the target. Nothing is filtered out of
## their output except DEADCODE_SEAMS below.
##
##   test     deadcode -test over GO_PACKAGES, tests included: code nothing
##            at all calls, not even a test — in test helpers and _test.go
##            files as much as anywhere. Remedy: delete it.
##   mains    every main package in GO_PACKAGES as a root, no
##            tests: code in a package some program links that only tests
##            reach. Remedy: delete it, or move it into a _test.go file (or a
##            *test helper package, as internal/userpaths/userpathstest is)
##            beside the tests that use it.
##   release  -tags production, rooted at DEADCODE_RELEASE_MAINS, the mains
##            release-build ships: code compiled into a release binary that
##            only a test-capable build (juggler-test, the //go:build
##            !production test handlers) reaches. Remedy: put it behind
##            //go:build !production, with a production stub if a call site
##            needs one. Lines the mains pass already reported are not
##            repeated here.
##
## tests/ is analysed by the test pass alone: it holds no program, only test
## helpers and the integration suites, so without -test everything in it is
## unreachable by definition. Its benchmark fixtures are data, not code; their
## go.mod keeps them out of this module.
##
## The analysis is valid for one GOOS, the host's. It cannot be run for the
## others from here: the server and the desktop app both link the Wails fork,
## which needs cgo and the target's C toolchain on darwin and linux. CI runs
## `make lint` natively on linux, windows and macos, so every platform's files
## are analysed there.
##
## DEADCODE_SEAMS: exported registration seams of the server whose only callers
## are mains in another module, which embeds this one and registers into them
## before app.Run. deadcode sees only this module's mains, so in the mains and
## release passes they are provably wrong, and they alone are dropped from those
## passes' output, by file and name. An entry the release pass no longer reports
## fails the target, so the list cannot outlive the code it names.
##   - server.RegisterTunnelMode: adds a WAN tunnel mode (a build that
##     registers none has no WAN feature).
##   - webui.RegisterCatalogFS: adds a UI-message catalogue for Go code outside
##     this module; updateCatalogSources is reached only through it.
##
## The package patterns are GO_PACKAGES, scoped to our own dirs — ./... would
## sweep into tooling/node_modules/, which on a fresh `npm install` ships Go
## files (e.g. flatted/golang/pkg/flatted/) that are unrelated to this
## module and tank the analysis with bogus "unreachable" hits. It would also
## pull in 3rdparty/, the vendored wails fork, whose own suite is not ours to
## run: hundreds of platform-specific and live-network tests.
DEADCODE_VERSION=v0.51.0
DEADCODE_RELEASE_MAINS := ./cmd/juggler ./cmd/juggler-app
DEADCODE_SEAMS := \
	cmd/juggler/server/tunnel_registry.go:RegisterTunnelMode \
	cmd/juggler/webui/webui.go:RegisterCatalogFS \
	cmd/juggler/webui/webui.go:updateCatalogSources
lint-deadcode: app-icon-embed wails-runtime-embed
	@dc="$(subst \,/,$(shell go env GOPATH))/bin/deadcode$(BIN_EXT)"; \
	if ! $(GOCMD) version -m "$$dc" 2>/dev/null | grep -q "golang.org/x/tools[[:space:]]*$(DEADCODE_VERSION)[[:space:]]"; then \
		echo "Installing deadcode $(DEADCODE_VERSION)..."; \
		$(GOCMD) install golang.org/x/tools/cmd/deadcode@$(DEADCODE_VERSION) || exit 1; \
	fi
	@dc="$(subst \,/,$(shell go env GOPATH))/bin/deadcode$(BIN_EXT)"; \
	tmp=$$(mktemp -d); trap 'rm -rf "$$tmp"' EXIT; \
	mains=$$($(GOCMD) list -f '{{if eq .Name "main"}}{{.ImportPath}}{{end}}' $(GO_PACKAGES)) || exit 1; \
	"$$dc" -test $(GO_PACKAGES) >"$$tmp/test" 2>"$$tmp/test.err" & test_pid=$$!; \
	"$$dc" $$mains >"$$tmp/mains" 2>"$$tmp/mains.err" & mains_pid=$$!; \
	"$$dc" -tags production $(DEADCODE_RELEASE_MAINS) >"$$tmp/release" 2>"$$tmp/release.err" & release_pid=$$!; \
	fail=0; \
	for pass in test:$$test_pid mains:$$mains_pid release:$$release_pid; do \
		if ! wait "$${pass#*:}"; then \
			echo "deadcode: the $${pass%%:*} pass could not analyse the program:"; \
			tr '\134' '/' <"$$tmp/$${pass%%:*}.err"; \
			fail=1; \
		fi; \
	done; \
	[ $$fail -eq 0 ] || exit 1; \
	for pass in test mains release; do \
		tr '\134' '/' <"$$tmp/$$pass" | awk -v seams="$(DEADCODE_SEAMS)" -v pass=$$pass ' \
			BEGIN { n = split(seams, s, " "); for (i = 1; i <= n; i++) seam[s[i]] = 1 } \
			{ key = $$0; sub(/:[0-9]+:[0-9]+: unreachable func: /, ":", key) } \
			pass != "test" && (key in seam) { print key >"/dev/stderr"; next } \
			{ print }' 2>"$$tmp/$$pass.seams" | sort >"$$tmp/$$pass.out"; \
	done; \
	for seam in $(DEADCODE_SEAMS); do \
		if ! grep -qxF "$$seam" "$$tmp/release.seams"; then \
			echo "deadcode: DEADCODE_SEAMS names $$seam, which the release pass does not report — remove the entry"; \
			fail=1; \
		fi; \
	done; \
	comm -23 "$$tmp/mains.out" "$$tmp/test.out" >"$$tmp/mains.new"; \
	sort -u "$$tmp/test.out" "$$tmp/mains.out" | comm -13 - "$$tmp/release.out" >"$$tmp/release.new"; \
	if [ -s "$$tmp/test.out" ]; then \
		echo "deadcode (test pass): nothing calls these, not even a test — delete them:"; \
		sed 's/^/  /' "$$tmp/test.out"; fail=1; \
	fi; \
	if [ -s "$$tmp/mains.new" ]; then \
		echo "deadcode (mains pass): only tests reach these — delete them, or move them beside the tests that use them:"; \
		sed 's/^/  /' "$$tmp/mains.new"; fail=1; \
	fi; \
	if [ -s "$$tmp/release.new" ]; then \
		echo "deadcode (release pass): only test-capable builds reach these, yet release builds compile them — put them behind //go:build !production:"; \
		sed 's/^/  /' "$$tmp/release.new"; fail=1; \
	fi; \
	exit $$fail

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
## worse than a clear error. An install is kept only while it matches the
## lockfile it was made from (a copy kept beside it), so a pull that moves a
## pinned version reinstalls rather than linting with the old one.
NODE_DEPS_STAMP := tooling/node_modules/.installed-package-lock.json
node-deps:
	@if [ ! -x $(NPM_BIN)/eslint ] || [ ! -x $(NPM_BIN)/stylelint ] || [ ! -x $(NPM_BIN)/tsc ] \
		|| ! cmp -s tooling/package-lock.json $(NODE_DEPS_STAMP); then \
		if ! command -v npm > /dev/null 2>&1; then \
			echo "npm not found on PATH — cannot lint JS/CSS. Install Node.js and retry." >&2; \
			exit 2; \
		fi; \
		echo "Installing JS/CSS linters (cd tooling && npm ci)..."; \
		(cd tooling && npm ci --no-audit --no-fund --ignore-scripts) || exit 2; \
		cp tooling/package-lock.json $(NODE_DEPS_STAMP); \
	fi

## lint-types: Run TypeScript type checking on JavaScript files
lint-types: node-deps
	@NODE_NO_WARNINGS=1 $(NPM_BIN)/tsc --project tooling/jsconfig.json --noEmit

## lint-js: Run JavaScript linter (all warnings are errors), after the cases
## for the repo's own ESLint rules — a rule that misfires would make the lint
## that follows it meaningless. ESLint is handed the whole tree, so which files
## are linted, and under which rules, is said once, by tooling/eslint.config.js
## (its `files` and global `ignores`); lint-files hands it the same config and
## so reaches the same verdict for any file.
lint-js: node-deps
	@NODE_NO_WARNINGS=1 node tooling/eslint-rules/no-raw-ui-string.test.js
	@NODE_NO_WARNINGS=1 node tooling/eslint-rules/test-hooks-in-tests-only.test.js
	@NODE_NO_WARNINGS=1 node tooling/eslint-rules/sdk-boundary.test.js
	@NODE_NO_WARNINGS=1 node tooling/eslint-rules/escape-html-interpolation.test.js
	@NODE_NO_WARNINGS=1 node tooling/eslint-rules/no-private-test-wait.test.js
	@NODE_NO_WARNINGS=1 $(NPM_BIN)/eslint --config tooling/eslint.config.js --max-warnings 0 .

## lint-js-deadcode: lint-deadcode for the JavaScript (tooling/js-deadcode.js),
## after its fixture cases (tooling/js-deadcode.test.js). Roots: the HTML
## documents (module scripts, inline modules, import maps), the extension
## manifests' `provides` globs, Go string literals naming a file of the tree,
## and the .d.ts files, one declaration at a time. Liveness follows top-level
## bindings, as deadcode follows functions. Two passes: production roots and
## modules only, then with the tests' (web/js-tests/**, any _tests/) added. It
## reports dead files, exports and bindings (nothing reaches them, not even a
## test) and test-only ones (only tests do), except `__name` test hooks, which
## the test-hooks-in-tests-only rule keeps for tests alone. The one carve-out:
## everything under web/sdk/** is public API, live by path. A specifier that is
## not a literal and cannot be evaluated must be listed, with what it loads, in
## the script's DYNAMIC_IMPORTS; an unlisted site or a stale entry fails. Over
## every module — production, tests, and the Node code under tooling/ and
## tests/ — it also checks that each imported name (static, `export … from`,
## destructured `import()`, JSDoc `import('…').Name` and `@import`) is exported
## by its target, through re-exports and `export *`. There is no allowlist: a finding is fixed where it is. `node tooling/js-deadcode.js
## --summary` prints each kind's count and first findings.
lint-js-deadcode: node-deps
	@NODE_NO_WARNINGS=1 node tooling/js-deadcode.test.js
	@NODE_NO_WARNINGS=1 node tooling/js-deadcode.js

## lint-css: Run the CSS linters — stylelint (rem units, no px, no literal
## colour outside web/css/tokens/), after the cases for the repo's own
## stylelint rule, then lint-css-arch, which checks the architecture contract in
## web/css/README.md: sheet ownership, dead selectors, token parity, and that
## both HTML documents link the same sheets. The last is whole-tree by nature,
## so it always runs in full rather than over a file list.
lint-css: node-deps
	@NODE_NO_WARNINGS=1 node tooling/stylelint-rules/no-literal-colour-function.test.js
	@NODE_NO_WARNINGS=1 $(NPM_BIN)/stylelint --config tooling/.stylelintrc.json $(CSS_GLOBS)
	@node scripts/lint-css-arch

## lint-i18n: Check that web/i18n/en.json and the en-XA pseudo-locale match the
## t() calls in the source. Whole-tree by nature, so it always runs in full.
lint-i18n: node-deps
	@node scripts/i18n check

## lint-docs: Check that the JavaScript examples in the Markdown docs can be
## copy/pasted and run — specifically, that a block never uses a name the same
## document shows the source of without importing it. Whole-tree by nature (the
## symbol table is per document), so it always runs in full.
lint-docs: node-deps
	@node scripts/lint-docs-code

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

## fix-fmt: gofmt -w across the tree (same file set lint-fmt checks, reaching
## gofmt through xargs for the same reason).
fix-fmt:
	@$(GOFMT_FIND) | xargs -0 gofmt -w

## fix-go: Apply golangci-lint's auto-fixes (only the linters that support --fix;
## many findings have none and still need a hand edit). Same package scope as
## lint-go; embeds regenerated first so the fixers typecheck against the real build.
fix-go: app-icon-embed wails-runtime-embed
	@scripts/ensure-golangci-lint
	@$(subst \,/,$(shell go env GOPATH))/bin/golangci-lint run --fix --timeout=5m $(GO_PACKAGES)

## fix-js: eslint --fix over the same tree and config as lint-js.
fix-js: node-deps
	@NODE_NO_WARNINGS=1 $(NPM_BIN)/eslint --config tooling/eslint.config.js --fix .

## fix-css: stylelint --fix (same globs and config as lint-css).
fix-css: node-deps
	@NODE_NO_WARNINGS=1 $(NPM_BIN)/stylelint --config tooling/.stylelintrc.json --fix $(CSS_GLOBS)

## fix-files: Auto-fix ONLY the named files, routed by extension to the same
## fixers as `make fix` (the write-mode counterpart to lint-files). Whole-program
## checks with no per-file fix (deadcode, type errors) are not run here.
##   make fix-files FILES="cmd/juggler/worker/foo.go web/css/bar.css"
fix-files: app-icon-embed wails-runtime-embed
	@FIX=1 scripts/lint-files

## install: Install binary globally
install: build
	@echo "Installing $(BINARY_NAME)..."
	@cp $(BUILD_DIR)/$(BINARY_NAME) $(GOPATH)/bin/

## tidy: Tidy go modules
tidy:
	@echo "Tidying go modules..."
	@$(GOCMD) mod tidy

## help: Show this help message, listing every documented target.
## Each entry comes from that target's `## name: …` doc comment, with the
## continuation lines joined on and only the first sentence shown — the rest is
## Makefile-internal detail, readable where it is written. Two rules keep prose
## out of the listing: a `## …` line whose first word isn't `name:` is treated
## as continuation (so a description may contain colons and run as long as it
## likes), and an entry only prints if a rule of that name actually exists.
help:
	@echo "Usage: make [target]"
	@echo ""
	@echo "Targets:"
	@awk '\
	function emit(n, d,   line, indent, cut, i, p, tail, sentence) { \
	  sentence = d; p = 0; \
	  while ((i = index(substr(d, p + 1), ". ")) > 0) { \
	    p += i; tail = substr(d, 1, p); \
	    if (tail ~ /(e\.g|i\.e|etc|vs)\.$$/) continue; \
	    sentence = tail; break; \
	  } \
	  indent = sprintf("%20s", ""); \
	  line = sprintf("  %-16s %s", n, sentence); \
	  while (length(line) > 92) { \
	    cut = 92; \
	    while (cut > 20 && substr(line, cut, 1) != " ") cut--; \
	    if (cut <= 20) break; \
	    print substr(line, 1, cut - 1); \
	    line = indent substr(line, cut + 1); \
	  } \
	  print line; \
	} \
	/^##[ \t]*[A-Za-z0-9_.-]+:/ { \
	  sub(/^##[ \t]*/, ""); \
	  i = index($$0, ":"); \
	  cur = ++count; \
	  name[cur] = substr($$0, 1, i - 1); \
	  desc[cur] = substr($$0, i + 1); \
	  sub(/^[ \t]+/, "", desc[cur]); \
	  next; \
	} \
	/^##/ { \
	  if (count == 0) next; \
	  sub(/^##[ \t]*/, ""); \
	  desc[count] = desc[count] " " $$0; \
	  next; \
	} \
	/^[A-Za-z0-9_.-]+[ \t]*:/ { \
	  rule = $$0; sub(/[ \t]*:.*/, "", rule); isrule[rule] = 1; \
	} \
	END { \
	  for (i = 1; i <= count; i++) if (isrule[name[i]]) emit(name[i], desc[i]); \
	} \
	' $(MAKEFILE_LIST)

.DEFAULT_GOAL := help
