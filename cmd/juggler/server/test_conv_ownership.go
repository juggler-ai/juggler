//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !production

package server

import (
	"encoding/json"
	"net/http"

	"github.com/gorilla/mux"

	"juggler/cmd/juggler/server/handlers"
	"juggler/internal/jlog"
)

// convOwnershipLedger is the testing package's ConvOwnership ledger as the
// guard uses it.
type convOwnershipLedger interface {
	RecordConvOwner(convID, lane, reason string)
	CheckConvDelete(convID, lane string) error
	ReleaseConvOwner(convID string)
}

// convOwnershipMiddleware guards conversations in the multi-lane test pool,
// where every lane shares one session. A create tagged ?lane= records that
// lane (and ?reason=, the creating test's name, for the suite-end leak dump)
// as the owner; a delete or bin from any other lane is refused with 403
// before the handler tears anything down, because tearing down another lane's
// worker kills a live test mid-turn; the owner's successful delete releases
// it. Bin keeps the owner: a binned conversation still needs deleting.
//
// The record and the release happen before the response is committed, so a
// client never sees a 201 whose owner is not yet recorded (a test may delete
// the moment it has the id) or a 204 whose owner is not yet released.
//
// Production never installs it, and production sends no lane.
func convOwnershipMiddleware(ledger convOwnershipLedger) mux.MiddlewareFunc {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			route := mux.CurrentRoute(r)
			if route == nil {
				next.ServeHTTP(w, r)
				return
			}
			lane := r.URL.Query().Get("lane")
			switch route.GetName() {
			case routeConversationCreate, routeConversationImport:
				reason := r.URL.Query().Get("reason")
				serveHeld(next, w, r, func(status int, body []byte) {
					if status != http.StatusCreated {
						return
					}
					var created struct {
						ID string `json:"id"`
					}
					if json.Unmarshal(body, &created) == nil && created.ID != "" {
						ledger.RecordConvOwner(created.ID, lane, reason)
					}
				})
			case routeConversationDelete, routeConversationBin:
				convID := mux.Vars(r)["convId"]
				if err := ledger.CheckConvDelete(convID, lane); err != nil {
					jlog.Error("[conv-ownership] REJECTED %s %s: %v", r.Method, r.URL.Path, err)
					handlers.WriteErr(w, r, http.StatusForbidden, err)
					return
				}
				if route.GetName() == routeConversationBin {
					next.ServeHTTP(w, r)
					return
				}
				serveHeld(next, w, r, func(status int, _ []byte) {
					if status == http.StatusNoContent {
						ledger.ReleaseConvOwner(convID)
					}
				})
			default:
				next.ServeHTTP(w, r)
			}
		})
	}
}

// serveHeld runs next with the response's commit held back until onCommit has
// seen the status and the first body write: the status line is not passed on
// until the body starts, or until next returns without one.
func serveHeld(next http.Handler, w http.ResponseWriter, r *http.Request, onCommit func(status int, body []byte)) {
	hw := &heldResponse{ResponseWriter: w, onCommit: onCommit}
	next.ServeHTTP(hw, r)
	hw.commit(nil)
}

type heldResponse struct {
	http.ResponseWriter
	onCommit  func(status int, body []byte)
	status    int
	committed bool
}

func (h *heldResponse) WriteHeader(status int) {
	if h.status == 0 {
		h.status = status
	}
}

func (h *heldResponse) Write(b []byte) (int, error) {
	h.commit(b)
	return h.ResponseWriter.Write(b)
}

func (h *heldResponse) commit(body []byte) {
	if h.committed {
		return
	}
	h.committed = true
	status := h.status
	if status == 0 {
		status = http.StatusOK
	}
	h.onCommit(status, body)
	if h.status != 0 {
		h.ResponseWriter.WriteHeader(h.status)
	}
}
