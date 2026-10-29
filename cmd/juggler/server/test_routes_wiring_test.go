//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !production

package server

import (
	"net/http"
	"testing"

	"github.com/gorilla/mux"

	jugglertest "juggler/cmd/juggler/testing"
)

// RegisterTestRoutes matches the test API against locally-declared structural
// interfaces, so a signature drift on either side silently unregisters the
// route/hook instead of failing the build. This test makes each structural
// match a compile-time/test-time fact. If one of these assertions fails, a
// RegisterTestRoutes feature has silently stopped wiring — fix the signature
// mismatch, don't delete the assertion.
func TestRegisterTestRoutesStructuralMatches(t *testing.T) {
	svc := jugglertest.NewTestService("/tmp", nil)
	var api any = svc

	if _, ok := api.(interface {
		HandleGetTask(w http.ResponseWriter, r *http.Request)
		HandleResetFixture(w http.ResponseWriter, r *http.Request)
		HandleDeleteFile(w http.ResponseWriter, r *http.Request)
		HandleMkdir(w http.ResponseWriter, r *http.Request)
		HandleDumpTape(w http.ResponseWriter, r *http.Request)
		HandleExtensionTests(w http.ResponseWriter, r *http.Request)
	}); !ok {
		t.Error("TestService no longer satisfies the task-API structural interface")
	}

	if _, ok := api.(interface {
		SetTapeDumper(fn func(string) any)
	}); !ok {
		t.Error("TestService no longer satisfies the tape-dumper structural interface")
	}

	if _, ok := api.(interface {
		RecordConvOwner(convID, lane, reason string)
		CheckConvDelete(convID, lane string) error
		ReleaseConvOwner(convID string)
		HandleConversationOwners(w http.ResponseWriter, r *http.Request)
	}); !ok {
		t.Error("TestService no longer satisfies the conversation-ownership structural interface — " +
			"the cross-lane delete guard and the leak-detection endpoint are silently unwired")
	}

	if _, ok := api.(interface {
		HandleRun(w http.ResponseWriter, r *http.Request)
		HandlePending(w http.ResponseWriter, r *http.Request)
		HandlePostResult(w http.ResponseWriter, r *http.Request)
		HandleGetResult(w http.ResponseWriter, r *http.Request)
		HandlePostNames(w http.ResponseWriter, r *http.Request)
		HandleGetNames(w http.ResponseWriter, r *http.Request)
		HandleJSTrace(w http.ResponseWriter, r *http.Request)
		HandleAudit(w http.ResponseWriter, r *http.Request)
		HandleMachine(w http.ResponseWriter, r *http.Request)
	}); !ok {
		t.Error("TestService no longer satisfies the run-API structural interface")
	}
}

// The structural interfaces a test API satisfies, named so a test can build
// one that satisfies only some of them.
type (
	wiringTaskAPI interface {
		HandleGetTask(w http.ResponseWriter, r *http.Request)
		HandleResetFixture(w http.ResponseWriter, r *http.Request)
		HandleDeleteFile(w http.ResponseWriter, r *http.Request)
		HandleMkdir(w http.ResponseWriter, r *http.Request)
		HandleDumpTape(w http.ResponseWriter, r *http.Request)
		HandleExtensionTests(w http.ResponseWriter, r *http.Request)
	}
	wiringTapeDumper interface {
		SetTapeDumper(fn func(string) any)
	}
	wiringOwnership interface {
		RecordConvOwner(convID, lane, reason string)
		CheckConvDelete(convID, lane string) error
		ReleaseConvOwner(convID string)
		HandleConversationOwners(w http.ResponseWriter, r *http.Request)
	}
)

// TestRegisterTestRoutesGrantsNothingOnAFailedMatch: a test API that fails a
// structural match panics RegisterTestRoutes, and a caller that recovers must
// be left with a server that behaves as production does. This one satisfies
// every match but the last, so any capability switched on before the matches
// are done is still on when it panics.
func TestRegisterTestRoutesGrantsNothingOnAFailedMatch(t *testing.T) {
	svc := jugglertest.NewTestService(t.TempDir(), nil)
	allButRun := struct {
		wiringTaskAPI
		wiringTapeDumper
		wiringOwnership
	}{svc, svc, svc}

	s := &Server{router: mux.NewRouter()}
	panicked := func() (p bool) {
		defer func() { p = recover() != nil }()
		s.RegisterTestRoutes(allButRun)
		return false
	}()
	if !panicked {
		t.Fatal("RegisterTestRoutes accepted a test API with no run-API — the fixture no longer fails the last match")
	}
	if s.test != (testCapabilities{}) {
		t.Fatalf("a failed RegisterTestRoutes left test capabilities on: %+v", s.test)
	}
}
