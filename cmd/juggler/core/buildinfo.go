//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Package core contains build-time variables injected via ldflags.
// These are set during `make build` and default to development values.
package core

import (
	"strings"

	"juggler"
)

// devSuffix marks a version that was built from source rather than published.
// It is deliberately a semver prerelease suffix: everything that already reads
// a version — the update check, the analytics bucket, a human — parses it, and
// the two builds sort next to each other instead of into separate worlds.
const devSuffix = "-dev"

// bareDevVersion is what a build with no version at all reports, and what every
// unstamped build reported before the VERSION file was embedded. Builds out in
// the world still send it, so it stays a version this code recognises.
const bareDevVersion = "dev"

// testSuffix marks a server built to be driven by the test suites. A suite run
// spawns servers that are indistinguishable from an install in every other
// respect, so the version is what tells them apart afterwards. Like devSuffix it
// names a build that was never published.
const testSuffix = "-test"

// Build-time variables set via -ldflags "-X ..."
var (
	// stampedVersion is what the linker wrote in, and is empty in a build it did
	// not stamp — a plain `go build`, `go run`, a test binary. -X reaches only a
	// variable declared uninitialised or initialised to a constant, which is why
	// the version the app reads is resolved into Version rather than set here.
	stampedVersion string

	// Version is the version this build reports: "v0.6.1" for a release, or
	// "v0.6.1-dev" for a build of that source made anywhere else.
	Version = resolveVersion(stampedVersion, juggler.VersionFile)

	// Commit is the git commit hash (short form)
	Commit = "unknown"

	// BuildDate is the build timestamp in ISO 8601 format
	BuildDate = "unknown"
)

// resolveVersion decides what a build calls itself. An unstamped build is a
// build from source, and the version it was built from is worth more than the
// bare fact that it was unstamped — so it reports the embedded VERSION with the
// dev suffix, which is both finer-grained and still unmistakably not a release.
func resolveVersion(stamped, embedded string) string {
	if v := strings.TrimSpace(stamped); v != "" {
		return v
	}
	v := strings.TrimSpace(embedded)
	switch {
	case v == "":
		return bareDevVersion
	case strings.HasSuffix(v, devSuffix):
		return v
	default:
		return v + devSuffix
	}
}

// IsDevVersion reports whether v names a build somebody made from source:
// every such build of one source tree reports the same version.
func IsDevVersion(v string) bool {
	v = strings.TrimSpace(v)
	return v == bareDevVersion || strings.HasSuffix(v, devSuffix)
}

// IsTestVersion reports whether v names a server built to be driven by the test
// suites rather than run by anybody.
//
// This is the question the install figures ask, and it is deliberately narrower
// than "unpublished" (updatecheck.IsUnpublishedBuild): a build somebody made
// from source is a real install and is
// counted on purpose, because how many people build Juggler and run it is worth
// knowing. What must never be counted is a suite spawning servers, and since
// such a server behaves like an install in every other respect — it checks for
// updates on the same schedule — the suffix is the only thing that tells them
// apart.
func IsTestVersion(v string) bool {
	return strings.HasSuffix(strings.TrimSpace(v), testSuffix)
}
