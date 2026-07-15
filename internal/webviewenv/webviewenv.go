//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Package webviewenv reports whether the host can bring up the Wails/WebKit
// webview that Juggler depends on, and builds the user-facing message shown
// when it can't.
//
// Juggler runs its agent engine inside a hidden webview even in headless server
// mode (the engine is the only thing that executes tools — see
// cmd/juggler/app/engine_lifecycle.go), so a host with no display server or no
// system webview runtime — a container, a CI runner, an SSH session with no
// desktop — cannot run the engine at all. Without help that failure is silent:
// the process sits for the connect timeout and then dies with a terse log line.
// This package turns it into an immediate, actionable, per-OS error, since what
// is missing (and how to supply it) differs on Linux, macOS, and Windows.
package webviewenv

import (
	"os"
	"os/exec"
	"runtime"
	"strings"
)

// Preflight returns a short description of a prerequisite that is *definitely*
// missing (so the webview can never initialise), or "" when nothing conclusive
// can be detected cheaply. It is deliberately conservative: it only reports a
// problem it is certain about, so a "" result does NOT mean the webview will
// work — the connect timeout remains the real catch-all. Its purpose is to fail
// fast on the common, unambiguous case (a headless Linux host with no display)
// instead of making the user wait out the timeout.
func Preflight() string {
	return preflight(runtime.GOOS, os.Getenv("DISPLAY"), os.Getenv("WAYLAND_DISPLAY"))
}

// preflight is the testable core of Preflight, taking the OS and the relevant
// environment explicitly so every branch is reachable from any host.
func preflight(goos, display, wayland string) string {
	// On Linux, WebKitGTK cannot initialise without an X11 or Wayland display.
	// With neither DISPLAY nor WAYLAND_DISPLAY set there is no display server to
	// connect to — a certain failure. (A set-but-broken display is not certain,
	// so it is left to the timeout.) macOS and Windows have no equivalently cheap
	// and reliable signal, so they fall through to the timeout + message path.
	if goos == "linux" && display == "" && wayland == "" {
		return "no display server detected (neither DISPLAY nor WAYLAND_DISPLAY is set)"
	}
	return ""
}

// disableSandboxEnv is WebKitGTK's escape hatch for turning off the bubblewrap
// process sandbox. WebKitGTK 6.0 (the GTK4 default stack) enables that sandbox
// by default, and Wails exposes no API to disable it, so this env var is our
// only lever.
const disableSandboxEnv = "WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS"

// sandboxProbes are the /proc/sys kernel toggles that, at the noted value, make
// unprivileged user-namespace creation impossible — precisely what WebKitGTK's
// bwrap sandbox needs. When any is tripped, bwrap fails with "setting up uid
// map: Permission denied", the WebProcess aborts, and the whole app dies with a
// cgo SIGTRAP before any watchdog can turn it into a clean message.
var sandboxProbes = []struct {
	path    string
	blocked func(string) bool
}{
	// Ubuntu 23.10+ restricts unprivileged userns via AppArmor by default;
	// "1" = restricted (a binary needs its own AppArmor profile to use them).
	{"/proc/sys/kernel/apparmor_restrict_unprivileged_userns", func(v string) bool { return v == "1" }},
	// Debian and some hardened kernels gate userns cloning; "0" = disabled.
	{"/proc/sys/kernel/unprivileged_userns_clone", func(v string) bool { return v == "0" }},
	// A hard cap of "0" means no user namespaces can be created at all.
	{"/proc/sys/user/max_user_namespaces", func(v string) bool { return v == "0" }},
}

// PrepareLinuxWebKit lets the WebKitGTK webview start on Linux hosts that block
// the unprivileged user namespaces its bwrap sandbox requires (notably Ubuntu
// 23.10+, which restricts them via AppArmor by default). On such a host bwrap
// fails with "setting up uid map: Permission denied", the WebProcess aborts,
// and the whole process dies with a cgo SIGTRAP before any of our watchdogs can
// turn it into a clean message. To pre-empt that we disable WebKit's process
// sandbox via its escape-hatch env var — but only when (a) we are on Linux,
// (b) the restriction is actually present, and (c) the user has not already set
// the var themselves. It returns a one-line note when it changed the
// environment (for the caller to log), or "" when it did nothing.
//
// Must be called before the first webview is created — at the top of main,
// before Wails/WebKit initialise — because WebKit reads this when it launches
// the WebProcess, which inherits this process's environment.
func PrepareLinuxWebKit() string {
	return prepareLinuxWebKit(runtime.GOOS, os.LookupEnv, os.Setenv, sandboxRestricted)
}

// prepareLinuxWebKit is the testable core of PrepareLinuxWebKit, taking the OS,
// env accessors, and the restriction probe explicitly so every branch is
// reachable from any host.
func prepareLinuxWebKit(goos string, lookupEnv func(string) (string, bool), setenv func(string, string) error, restricted func() bool) string {
	if goos != "linux" {
		return ""
	}
	// Respect an explicit user choice either way: if the var is already set
	// (even to "0"), the user or their launcher has decided — don't override.
	if _, ok := lookupEnv(disableSandboxEnv); ok {
		return ""
	}
	if !restricted() {
		return ""
	}
	if err := setenv(disableSandboxEnv, "1"); err != nil {
		return ""
	}
	return "unprivileged user namespaces are restricted on this host, which would " +
		"crash the WebKitGTK sandbox; set " + disableSandboxEnv + "=1 so the webview can start"
}

// sandboxRestricted reports whether this host blocks the unprivileged user
// namespaces WebKitGTK's bwrap sandbox needs, by reading the kernel toggles in
// sandboxProbes. A missing or unreadable toggle is treated as "not restricted".
func sandboxRestricted() bool {
	return sandboxRestrictedFrom(func(path string) (string, bool) {
		b, err := os.ReadFile(path)
		if err != nil {
			return "", false
		}
		return string(b), true
	})
}

// sandboxRestrictedFrom is the testable core of sandboxRestricted.
func sandboxRestrictedFrom(read func(string) (string, bool)) bool {
	for _, p := range sandboxProbes {
		if v, ok := read(p.path); ok && p.blocked(strings.TrimSpace(v)) {
			return true
		}
	}
	return false
}

// linuxHost carries the host facts that tailor the Linux remediation message:
// which package manager is installed (so the fix can be one exact command
// instead of generic advice) and whether xvfb-run is already available.
type linuxHost struct {
	pm      string // package-manager binary: "apt-get", "dnf", "pacman", "zypper", or ""
	hasXvfb bool   // xvfb-run is on PATH
}

// detectLinuxHost probes PATH for the package manager and for xvfb-run. Only
// meaningful on Linux; every other platform gets the zero value.
func detectLinuxHost(goos string, lookPath func(string) (string, error)) linuxHost {
	if goos != "linux" {
		return linuxHost{}
	}
	var h linuxHost
	if _, err := lookPath("xvfb-run"); err == nil {
		h.hasXvfb = true
	}
	for _, pm := range []string{"apt-get", "dnf", "pacman", "zypper"} {
		if _, err := lookPath(pm); err == nil {
			h.pm = pm
			break
		}
	}
	return h
}

// xvfbInstallCommand returns the exact command that installs the Xvfb virtual
// framebuffer for the detected package manager (the package name differs per
// distro family), or "" when no known package manager was found.
func xvfbInstallCommand(pm string) string {
	switch pm {
	case "apt-get":
		return "sudo apt-get install -y xvfb"
	case "dnf":
		return "sudo dnf install -y xorg-x11-server-Xvfb"
	case "pacman":
		return "sudo pacman -S --needed xorg-server-xvfb"
	case "zypper":
		return "sudo zypper install -y xvfb-run"
	default:
		return ""
	}
}

// UnavailableMessage builds the multi-line diagnostic printed when the webview
// cannot be brought up. reason is a short lead describing how the failure was
// detected (a Preflight finding, or "the … did not initialise within 30s"); the
// body is the per-OS list of things to check.
func UnavailableMessage(reason string) string {
	return message(runtime.GOOS, reason, detectLinuxHost(runtime.GOOS, exec.LookPath))
}

// message is the testable core of UnavailableMessage.
func message(goos, reason string, host linuxHost) string {
	var b strings.Builder
	b.WriteString("Juggler cannot start: ")
	b.WriteString(reason)
	b.WriteString(".\n\n")
	b.WriteString("Juggler runs its agent engine inside a webview, so it needs a graphical\n")
	b.WriteString("display and a system webview runtime even when running headless (no window).\n\n")
	b.WriteString("To fix this:\n")
	b.WriteString(remediation(goos, host))
	return b.String()
}

// remediation returns the per-OS bullet list of fixes.
func remediation(goos string, host linuxHost) string {
	switch goos {
	case "linux":
		// This process is running, so the GTK/WebKitGTK libraries it links are
		// demonstrably present — a missing runtime fails at the dynamic loader
		// before any of this code executes. What can be wrong here is the
		// display (most commonly: a headless host) or WebKit's own
		// subprocesses/sandbox, so that is what the bullets address.
		b := "  • Make a display available by setting DISPLAY or WAYLAND_DISPLAY.\n"
		switch {
		case host.hasXvfb:
			b += "" +
				"  • On a headless machine (container, CI runner, or SSH with no desktop),\n" +
				"    run under a virtual framebuffer: `xvfb-run -a juggler`.\n"
		case xvfbInstallCommand(host.pm) != "":
			b += "" +
				"  • On a headless machine (container, CI runner, or SSH with no desktop),\n" +
				"    run under a virtual framebuffer — install it with\n" +
				"    `" + xvfbInstallCommand(host.pm) + "`, then run `xvfb-run -a juggler`.\n"
		default:
			b += "" +
				"  • On a headless machine (container, CI runner, or SSH with no desktop),\n" +
				"    run under a virtual framebuffer — install your distro's Xvfb package\n" +
				"    (usually called `xvfb`), then run `xvfb-run -a juggler`.\n"
		}
		return b +
			"  • If a display exists but the webview still won't start, try setting\n" +
			"    WEBKIT_DISABLE_DMABUF_RENDERER=1 and WEBKIT_DISABLE_COMPOSITING_MODE=1.\n" +
			"  • On Ubuntu 23.10+ the sandbox WebKitGTK uses (bubblewrap) can be blocked\n" +
			"    by the kernel's unprivileged-user-namespace restriction — the tell-tale\n" +
			"    is `bwrap: setting up uid map: Permission denied`. Either re-allow it\n" +
			"    with `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`, or\n" +
			"    start Juggler with WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1 to run\n" +
			"    without the WebKit sandbox.\n"
	case "darwin":
		return "" +
			"  • Run Juggler from a logged-in graphical (Aqua) session. macOS cannot\n" +
			"    create a webview from an SSH session or a session-0 LaunchDaemon.\n" +
			"  • To start it under launchd, use a LaunchAgent in your GUI login session,\n" +
			"    not a LaunchDaemon.\n"
	case "windows":
		return "" +
			"  • Install the Microsoft Edge WebView2 Runtime (Evergreen):\n" +
			"    https://developer.microsoft.com/microsoft-edge/webview2/\n" +
			"  • Run Juggler in an interactive user session. Windows Server Core and\n" +
			"    session-0 services have no desktop and cannot host a webview.\n"
	default:
		return "  • Ensure a graphical display and a system webview runtime are available.\n"
	}
}
