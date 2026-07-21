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
	"path/filepath"
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

// gpuOverrideEnv lets the user override the Linux WebKitGTK webview's hardware
// acceleration autodetection. Recognised values (case-insensitive, surrounding
// whitespace ignored): "always" forces acceleration, "never" forces software
// rendering, and "auto" — the default when unset — autodetects. Any other value
// is treated as "auto".
const gpuOverrideEnv = "JUGGLER_WEBVIEW_GPU"

// LinuxWebviewGpuAcceleration decides whether the *visible* Linux WebKitGTK
// viewer window should use hardware-accelerated compositing (which the caller
// maps to application.WebviewGpuPolicyAlways) rather than software rendering
// (WebviewGpuPolicyNever). It returns the decision and a one-line note for the
// caller to log — the same idiom as PrepareLinuxWebKit.
//
// Why this is decided rather than a constant: forcing acceleration on a broken
// or absent GL stack (VM software GL, no DRI render node, headless) makes
// WebKitGTK's webview realisation fail and the window never appears — which is
// why the safe historical default was software. But software compositing
// re-rasterises every animated frame on the CPU, and Juggler's UI animates
// continuously while a conversation runs (the busy spinner), so on a machine
// that genuinely has a working GPU that pins a CPU core near saturation for the
// whole time work is in flight and stalls the UI. This enables acceleration
// whenever a usable DRI render node and a display are present. The single
// exception is a machine whose *only* render node is the crash-prone NVIDIA
// proprietary driver: there WebKitGTK's DMABUF path is unstable and nothing
// else can composite, so it stays on software. A machine that also has a
// non-NVIDIA render node (an Optimus/PRIME laptop, or a multi-GPU desktop with
// an Intel/AMD iGPU) composites fine through that node and is left accelerated.
// The JUGGLER_WEBVIEW_GPU env var overrides the decision either way.
//
// Off Linux the return is (false, ""): the LinuxWindow policy field is ignored
// on other platforms, and the engine window (off-screen, paints nothing) keeps
// its own hard-coded Never regardless.
func LinuxWebviewGpuAcceleration() (enabled bool, note string) {
	return linuxWebviewGpuAcceleration(
		runtime.GOOS,
		os.Getenv(gpuOverrideEnv),
		os.Getenv("DISPLAY"),
		os.Getenv("WAYLAND_DISPLAY"),
		renderNodeDrivers,
	)
}

// linuxWebviewGpuAcceleration is the testable core of LinuxWebviewGpuAcceleration:
// the OS, the override value, the two display env vars, and the render-node probe
// are all injected so every branch is reachable from any host. renderNodeDrivers
// returns the DRM driver name behind each /dev/dri/renderD* node ("" when a
// node's driver can't be identified).
func linuxWebviewGpuAcceleration(goos, override, display, wayland string, renderNodeDrivers func() []string) (bool, string) {
	if goos != "linux" {
		return false, ""
	}
	// JUGGLER_WEBVIEW_GPU overrides autodetection. Only the two documented
	// forcing values are recognised; "auto" (the third documented value), unset,
	// or anything else falls through to autodetection below.
	switch strings.ToLower(strings.TrimSpace(override)) {
	case "always":
		return true, "webview GPU acceleration forced ON via " + gpuOverrideEnv
	case "never":
		return false, "webview GPU acceleration forced OFF via " + gpuOverrideEnv + " — using software rendering"
	}
	// Autodetect. Every negative branch is also the crash-safe branch, so
	// software rendering is chosen whenever acceleration might fail to come up.
	if display == "" && wayland == "" {
		// Headless: Preflight already reports the missing display, so stay
		// software without an extra (redundant) log line.
		return false, ""
	}
	drivers := renderNodeDrivers()
	if len(drivers) == 0 {
		return false, "no DRI render node (/dev/dri/renderD*) detected — using software rendering for the webview"
	}
	// Enable as long as at least one render node is NOT the crash-prone NVIDIA
	// proprietary driver: WebKitGTK can composite through that node (the iGPU on
	// an Optimus/PRIME laptop, or an Intel/AMD GPU on a multi-GPU desktop). The
	// mere presence of the NVIDIA proprietary module says nothing about which GPU
	// drives the webview, so only the *sole-NVIDIA* case falls back to software.
	for _, d := range drivers {
		if !isNVIDIAProprietaryDriver(d) {
			return true, "GPU acceleration enabled for the webview (usable DRI render node present)"
		}
	}
	return false, "the only DRI render node is the NVIDIA proprietary driver — using software rendering for the webview (set " + gpuOverrideEnv + "=always to override)"
}

// renderNodeDrivers returns the DRM kernel driver bound to each /dev/dri/renderD*
// node — the render nodes WebKitGTK's accelerated compositor draws through. The
// driver name is read from sysfs (/sys/class/drm/<node>/device/driver, a symlink
// into the bus driver dir), e.g. "i915"/"xe" (Intel), "amdgpu"/"radeon" (AMD),
// "nvidia" (NVIDIA proprietary), "nouveau" (open NVIDIA). An entry is "" when the
// node exists but its driver can't be resolved (treated downstream as usable, not
// NVIDIA-proprietary). An empty slice means there is no render node at all
// (headless CI runners, pure-software-GL setups) — where forcing acceleration
// would fail to realise a window.
func renderNodeDrivers() []string {
	nodes, _ := filepath.Glob("/dev/dri/renderD*")
	drivers := make([]string, 0, len(nodes))
	for _, n := range nodes {
		link, err := os.Readlink("/sys/class/drm/" + filepath.Base(n) + "/device/driver")
		if err != nil {
			drivers = append(drivers, "")
			continue
		}
		drivers = append(drivers, filepath.Base(link))
	}
	return drivers
}

// isNVIDIAProprietaryDriver reports whether a DRM driver name is the proprietary
// NVIDIA driver ("nvidia") — the well-known crash/instability case for
// WebKitGTK's DMABUF and accelerated-compositing path. The open "nouveau" driver
// is NOT this case and composites fine, so it is deliberately excluded.
func isNVIDIAProprietaryDriver(driver string) bool {
	return driver == "nvidia"
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

// HostInfo reports the Linux host facts the engine-host diagnostics need: the
// detected package manager (or ""), whether xvfb-run is already on PATH, and
// the exact per-distro commands that install the Xvfb framebuffer and Node.js.
// Off Linux it is the zero value.
type HostInfo struct {
	PackageManager string // "apt-get", "dnf", "pacman", "zypper", or ""
	HasXvfb        bool   // xvfb-run is on PATH
	XvfbInstall    string // exact command to install Xvfb ("" if pm unknown)
	NodeInstall    string // exact command to install Node.js ("" if pm unknown)
}

// DetectHost probes this Linux host for its package manager and for xvfb-run,
// and derives the install commands. Only meaningful on Linux.
func DetectHost() HostInfo {
	h := detectLinuxHost(runtime.GOOS, exec.LookPath)
	return HostInfo{
		PackageManager: h.pm,
		HasXvfb:        h.hasXvfb,
		XvfbInstall:    xvfbInstallCommand(h.pm),
		NodeInstall:    nodeInstallCommand(h.pm),
	}
}

// UserNamespacesRestricted reports whether this host blocks the unprivileged
// user namespaces WebKitGTK's bwrap sandbox needs (see sandboxRestricted). It
// is exported for `juggler doctor`; always false off Linux.
func UserNamespacesRestricted() bool {
	if runtime.GOOS != "linux" {
		return false
	}
	return sandboxRestricted()
}

// nodeInstallCommand returns the exact command that installs Node.js for the
// detected package manager, or "" when no known package manager was found. The
// distro package can lag the engine's minimum (Node 22); the diagnostics that
// print this also state the version floor.
func nodeInstallCommand(pm string) string {
	switch pm {
	case "apt-get":
		return "sudo apt-get install -y nodejs"
	case "dnf":
		return "sudo dnf install -y nodejs"
	case "pacman":
		return "sudo pacman -S --needed nodejs"
	case "zypper":
		return "sudo zypper install -y nodejs"
	default:
		return ""
	}
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
