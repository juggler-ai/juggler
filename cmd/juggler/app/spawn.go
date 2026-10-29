//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package app

import (
	"fmt"
	"os"
	"os/exec"
	"runtime"

	"juggler/internal/binpath"
	"juggler/internal/jlog"
)

// launchDesktopApp opens the juggler-app desktop window pointed at serverURL.
// The server is windowless; the visible UI lives in this separate process.
// Used by the 'w' key and by a window-mode (icon/Finder) launch. devMode
// forwards --dev so a server in dev mode (--dev, or the implied dev mode of
// --assets-from-disk) gives its windows the web inspector and the full
// right-click menu.
func launchDesktopApp(serverURL string, devMode bool) error {
	appBin, err := appBinPath()
	if err != nil {
		return err
	}
	args := []string{"--url", serverURL}
	if devMode {
		args = append(args, "--dev")
	}
	jlog.Info("🪟 Opening desktop window → %s", serverURL)
	return launchDetached(appBin, args)
}

// appBinPath locates the juggler-app desktop binary:
//   - $JUGGLER_APP_BIN if set,
//   - a sibling "juggler-app" next to this executable (the installed layout),
//   - else "juggler-app" on PATH.
func appBinPath() (string, error) {
	if env := os.Getenv("JUGGLER_APP_BIN"); env != "" {
		return env, nil
	}
	name := "juggler-app"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	if exe, err := os.Executable(); err == nil {
		if cand, ok := binpath.Sibling(exe, name); ok {
			return cand, nil
		}
	}
	if p, err := exec.LookPath(name); err == nil {
		return p, nil
	}
	return "", fmt.Errorf("could not locate the juggler-app binary; set JUGGLER_APP_BIN")
}
