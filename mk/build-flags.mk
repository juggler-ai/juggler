# ─────────────────────────────────────────────────────────────────────────────
# build-flags.mk — single source of truth for how any juggler binary compiles.
#
# Included by this repo's own Makefile (`include mk/build-flags.mk`). It is also
# included, unmodified, by the private release/packaging build that layers extra
# server features on top of this module — so the two builds can never drift on
# ldflags, cgo flags, or the macOS deployment target. This fragment ships in the
# public repo and the public build uses it standalone; it knows nothing about
# any outer module.
#
# The including Makefile MUST define, before the include:
#   UNAME_S    := $(shell uname -s)
#   VERSION    — release version string (e.g. read from the VERSION file)
#   COMMIT     — short git SHA
#   BUILD_DATE — RFC3339 UTC timestamp
# These are sourced differently per repo (a nested submodule reads its own
# VERSION file / git dir), so they stay local; only their *use* is shared here.
#
# It defines the host facts both builds branch on — GOARCH_HOST, BIN_EXT, RACE —
# so anything that reads one of them at parse time (an ifeq, or a := variable)
# must come after the include.
# ─────────────────────────────────────────────────────────────────────────────

# Host CPU arch, translated to Go's GOARCH names — the default for native Linux
# builds, so a plain build targets the running machine instead of silently
# cross-compiling (these are cgo GTK/WebKitGTK builds, so a mismatched GOARCH
# needs a cross-gcc toolchain most machines don't have).
UNAME_M := $(shell uname -m)
ifeq ($(UNAME_M),x86_64)
GOARCH_HOST := amd64
else ifneq (,$(filter $(UNAME_M),aarch64 arm64))
GOARCH_HOST := arm64
else
GOARCH_HOST := $(UNAME_M)
endif

# Executable suffix for native (non-cross-compiled) builds on this host. Native
# Windows reports Windows_NT via $(OS) regardless of shell (uname -s instead
# returns MSYS_NT-.../MINGW64_NT-... under Git Bash, inconsistent to match on).
# This matters beyond cosmetics: `go build -o path` never auto-appends .exe when
# given an explicit filename, and a Windows binary without it can't be found or
# launched by what looks for it — the desktop app's serverBinPath()
# (cmd/juggler-app/server_conn.go) looks for a sibling literally named
# juggler.exe, and Go's exec (which the browser suite spawns the test server
# through) only accepts a PATHEXT extension. The cross-compile targets
# (build-windows) hardcode .exe, so this only affects native builds on Windows.
ifeq ($(OS),Windows_NT)
BIN_EXT := .exe
else
BIN_EXT :=
endif

# The race detector needs cgo (a C compiler). CI and most Unix dev boxes have
# one, so -race is on by default there. A Windows dev box usually has no C
# toolchain, so cgo can't build and `go test -race` fails outright with
# "requires cgo" — it defaults off there so the suite still runs (minus race).
# Override either way: `make test RACE=-race` or `make test RACE=`.
ifeq ($(OS),Windows_NT)
RACE ?=
else
RACE ?= -race
endif

GOCMD ?= go
# Default builds are test-capable: cmd/juggler/testing/ and worker test-support
# are gated by `//go:build !production`, so omitting the tag keeps them in the
# binary. GOBUILD_RELEASE adds -tags production to exclude them from shipped
# binaries.
GOBUILD = $(GOCMD) build
GOBUILD_RELEASE = $(GOCMD) build -tags production

# Pin the macOS deployment target so clang compiles Wails v3's Objective-C .m
# files and the Go linker agree on a min OS version. Without this clang defaults
# to the host SDK (macOS 26 on recent Macs) while the Go linker defaults to
# 11.0, producing "object file was built for newer macOS" warnings on every
# build. 14.0 = Sonoma, our minimum supported macOS.
MACOSX_DEPLOYMENT_TARGET ?= 14.0
export MACOSX_DEPLOYMENT_TARGET
# MACOSX_DEPLOYMENT_TARGET alone doesn't silence the warning for the cgo
# runtime-support objects (runtime/cgo's _x_cgo_thread_start &c.): they're
# clang-compiled but cached, and the deployment-target env is NOT part of Go's
# build-cache key, so a stale 26.0 object gets reused. Putting the min-version
# on CGO_CFLAGS bakes it into the compile command line, which IS hashed into the
# cache key, so those objects rebuild at 14.0 too. CGO_LDFLAGS covers the *link*
# step for `go test` commands that don't carry explicit -ldflags: Go passes its
# hardcoded 11.0 platform version to clang, but CGO_LDFLAGS is appended after it,
# so -mmacosx-version-min=14.0 wins. Darwin-only: these flags are clang errors on
# Linux/Windows toolchains (Windows builds are CGO_ENABLED=0).
ifeq ($(UNAME_S),Darwin)
export CGO_CFLAGS=-mmacosx-version-min=$(MACOSX_DEPLOYMENT_TARGET)
export CGO_LDFLAGS=-mmacosx-version-min=$(MACOSX_DEPLOYMENT_TARGET)
endif

# Version stamps. LDFLAGS_BASE is platform-neutral (reused by the Windows/Linux
# cross-builds); LDFLAGS adds the macOS host-specific linker args.
#
# OFFICIAL marks a build that will be published as a release. Everything else —
# a build from a clone, a CI smoke build, a packaged test server — reports its
# version with a -dev suffix, so a binary somebody built from this source is
# never counted as one they downloaded. Only the stamp gets the suffix: VERSION
# itself names the DMG and feeds the Windows installer, both of which want it
# numeric. Accepts 1/true/yes so a CI job can forward a boolean output directly,
# where a bare $(if ...) would read the string "false" as set.
OFFICIAL ?=
VERSION_STAMP := $(strip $(if $(filter 1 true yes,$(OFFICIAL)),$(VERSION),\
  $(if $(filter dev,$(VERSION)),dev,$(VERSION)-dev)))

# The stamp for a server built to be driven by the test suites. A suite run
# spawns servers that behave like any other install, so the only thing telling
# the two apart afterwards is what they call themselves: -test where a build
# from source says -dev. Both are unpublished and neither is counted as an
# install, but keeping them distinct means a day's figures can say whether the
# traffic was somebody working or a test run.
TEST_VERSION_STAMP := $(strip $(if $(filter dev,$(VERSION)),dev,$(VERSION)-test))

# ldflags-stamp STAMP — the version-stamp flags for a build reporting STAMP.
# Both stamps go through it so the release and test builds cannot drift on
# anything but the version they report.
ldflags-stamp = -X juggler/cmd/juggler/core.stampedVersion=$(1) \
  -X juggler/cmd/juggler/core.Commit=$(COMMIT) \
  -X juggler/cmd/juggler/core.BuildDate=$(BUILD_DATE)

LDFLAGS_BASE := $(call ldflags-stamp,$(VERSION_STAMP))
TEST_LDFLAGS_BASE := $(call ldflags-stamp,$(TEST_VERSION_STAMP))
# Match the macOS deployment target between Go's external linker and the Wails
# v3 cgo .o files. -no_warn_duplicate_libraries: clang's runtime + Wails's
# frameworks both pull in -lobjc; macOS 26's ld warns instead of dedup'ing.
ifeq ($(UNAME_S),Darwin)
HOST_LDFLAGS := '-extldflags=-mmacosx-version-min=$(MACOSX_DEPLOYMENT_TARGET) -Wl,-no_warn_duplicate_libraries'
endif
LDFLAGS := $(LDFLAGS_BASE) $(HOST_LDFLAGS)
TEST_LDFLAGS := $(TEST_LDFLAGS_BASE) $(HOST_LDFLAGS)
