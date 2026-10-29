//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !production

package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gorilla/mux"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/server/handlers"
	jugglertest "juggler/cmd/juggler/testing"
)

// ownershipGuardServer is the real session route table with the test routes
// registered over it, as a test-mode server has them, on a bare router.
func ownershipGuardServer(t *testing.T) (*Server, *jugglertest.TestService) {
	t.Helper()
	mgr, err := core.NewSessionManagerForPath(t.TempDir())
	if err != nil {
		t.Fatalf("NewSessionManagerForPath: %v", err)
	}
	t.Cleanup(mgr.Shutdown)
	s := &Server{router: mux.NewRouter()}
	s.setupSessionRoutes(handlers.NewSessionAPI(func() *core.SessionManager { return mgr }, nil, nil, nil, nil))
	svc := jugglertest.NewTestService(t.TempDir(), nil)
	s.RegisterTestRoutes(svc)
	return s, svc
}

func ownersOf(t *testing.T, svc *jugglertest.TestService) map[string]jugglertest.OwnerInfo {
	t.Helper()
	rec := httptest.NewRecorder()
	svc.HandleConversationOwners(rec, httptest.NewRequest(http.MethodGet, "/api/test/conversation-owners", nil))
	var body struct {
		Owners map[string]jugglertest.OwnerInfo `json:"owners"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("owners: %v (%s)", err, rec.Body.String())
	}
	return body.Owners
}

// commitWatcher is a ResponseWriter that runs onCommit when the status line
// is committed, i.e. at the moment a client could first see the response.
type commitWatcher struct {
	*httptest.ResponseRecorder
	onCommit  func(status int)
	committed bool
}

func (c *commitWatcher) WriteHeader(status int) {
	if !c.committed {
		c.committed = true
		c.onCommit(status)
	}
	c.ResponseRecorder.WriteHeader(status)
}

func (c *commitWatcher) Write(b []byte) (int, error) {
	if !c.committed {
		c.WriteHeader(http.StatusOK)
	}
	return c.ResponseRecorder.Write(b)
}

// TestConvOwnershipGuard pins the multi-lane pool's conversation-ownership
// guard through the real session routes: a lane-tagged create records its
// lane before the 201 reaches the client (a test may delete the moment it has
// the id), a delete or bin from any other lane is refused with 403 before any
// teardown, and the owning lane's delete releases ownership so the suite-end
// leak dump stays empty. A request with no lane, which is all production
// sends, is neither recorded nor refused.
func TestConvOwnershipGuard(t *testing.T) {
	s, svc := ownershipGuardServer(t)

	serve := func(w http.ResponseWriter, method, target, body string) {
		req := httptest.NewRequest(method, target, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		s.router.ServeHTTP(w, req)
	}
	create := func(query string) string {
		t.Helper()
		var ownersAtCommit map[string]jugglertest.OwnerInfo
		w := &commitWatcher{ResponseRecorder: httptest.NewRecorder(), onCommit: func(int) {
			ownersAtCommit = ownersOf(t, svc)
		}}
		serve(w, http.MethodPost, "/api/conversations"+query, `{"name":"guarded"}`)
		if w.Code != http.StatusCreated {
			t.Fatalf("create%s = %d %s, want 201", query, w.Code, w.Body.String())
		}
		var body struct {
			ID string `json:"id"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil || body.ID == "" {
			t.Fatalf("create%s body %q: %v", query, w.Body.String(), err)
		}
		if lane := strings.Contains(query, "lane="); lane {
			if _, ok := ownersAtCommit[body.ID]; !ok {
				t.Errorf("create%s: owner of %s not recorded when the 201 was committed (owners then: %v)",
					query, body.ID, ownersAtCommit)
			}
		}
		return body.ID
	}
	status := func(method, target string) int {
		rec := httptest.NewRecorder()
		serve(rec, method, target, "")
		return rec.Code
	}

	id := create("?lane=a&reason=TestOwner")
	if got := ownersOf(t, svc)[id]; got.Lane != "a" || got.Reason != "TestOwner" {
		t.Fatalf("owner of %s = %+v, want lane a, reason TestOwner", id, got)
	}

	if got := status(http.MethodDelete, "/api/session/conversations/"+id+"?lane=b&permanent=true"); got != http.StatusForbidden {
		t.Errorf("cross-lane delete = %d, want 403", got)
	}
	if got := status(http.MethodPost, "/api/session/conversations/"+id+"/bin?lane=b"); got != http.StatusForbidden {
		t.Errorf("cross-lane bin = %d, want 403", got)
	}
	if got := status(http.MethodGet, "/api/session/conversations/"+id); got != http.StatusOK {
		t.Fatalf("conversation after refused delete/bin = %d, want 200 (it must not have been torn down)", got)
	}
	if _, ok := ownersOf(t, svc)[id]; !ok {
		t.Fatalf("a refused delete released ownership of %s", id)
	}

	if got := status(http.MethodDelete, "/api/session/conversations/"+id+"?lane=a&permanent=true"); got != http.StatusNoContent {
		t.Fatalf("owner-lane delete = %d, want 204", got)
	}
	if owners := ownersOf(t, svc); len(owners) != 0 {
		t.Errorf("owners after the owner's delete = %v, want none", owners)
	}

	untagged := create("")
	if owners := ownersOf(t, svc); len(owners) != 0 {
		t.Errorf("an untagged create was recorded: %v", owners)
	}
	if got := status(http.MethodDelete, "/api/session/conversations/"+untagged+"?lane=b&permanent=true"); got != http.StatusNoContent {
		t.Errorf("delete of an unowned conversation = %d, want 204", got)
	}
}
