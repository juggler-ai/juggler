//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"juggler/cmd/juggler/core"
)

// decodeCheck runs HandleCheckProject for path and returns the decoded body.
func decodeCheck(t *testing.T, api *ProjectAPI, path string) map[string]any {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/project/check?path="+path, nil)
	rec := httptest.NewRecorder()
	api.HandleCheckProject(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var body map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	return body
}

// The project this instance already has open must never be reported as locked:
// the lock is held by *this* server, so the picker has to be able to re-select
// it. Regression test for the mobile/browser "Already open at http://…/" bug
// that made switching from a phone impossible.
func TestHandleCheckProject_CurrentProjectNotLocked(t *testing.T) {
	dir := t.TempDir()

	lockChecked := false
	api := &ProjectAPI{
		pathProvider: func() string { return dir },
		checkLockedFn: func(string) (bool, *core.InstanceInfo, error) {
			lockChecked = true
			return true, nil, nil // would report "locked" if consulted
		},
	}

	body := decodeCheck(t, api, dir)

	if valid, _ := body["valid"].(bool); !valid {
		t.Errorf("valid = %v, want true for the current project", body["valid"])
	}
	if current, _ := body["current"].(bool); !current {
		t.Errorf("current = %v, want true for the current project", body["current"])
	}
	if _, hasLocked := body["locked"]; hasLocked {
		t.Errorf("current project must not be reported as locked: %v", body)
	}
	if lockChecked {
		t.Error("lock probe must be skipped for the current project")
	}
}

// A different project genuinely held by another instance must still be flagged.
func TestHandleCheckProject_OtherLocked(t *testing.T) {
	current := t.TempDir()
	other := t.TempDir()

	api := &ProjectAPI{
		pathProvider: func() string { return current },
		checkLockedFn: func(string) (bool, *core.InstanceInfo, error) {
			return true, nil, nil // held, no live instance info
		},
	}

	body := decodeCheck(t, api, other)

	if valid, _ := body["valid"].(bool); valid {
		t.Errorf("valid = %v, want false for a locked project", body["valid"])
	}
	if locked, _ := body["locked"].(bool); !locked {
		t.Errorf("locked = %v, want true for a locked project", body["locked"])
	}
}

// A free directory (not current, not locked) validates normally.
func TestHandleCheckProject_FreeDir(t *testing.T) {
	current := t.TempDir()
	free := t.TempDir()

	api := &ProjectAPI{
		pathProvider: func() string { return current },
		checkLockedFn: func(string) (bool, *core.InstanceInfo, error) {
			return false, nil, nil
		},
	}

	body := decodeCheck(t, api, free)

	if valid, _ := body["valid"].(bool); !valid {
		t.Errorf("valid = %v, want true for a free directory", body["valid"])
	}
	if _, hasCurrent := body["current"]; hasCurrent {
		t.Errorf("free directory must not be marked current: %v", body)
	}
}
