//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"testing"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/worker"
)

type importAnswer struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Existing bool   `json:"existing"`
	Room     int    `json:"room"`
}

func importBody(digest string) string {
	return `{"title":"Fix the build","created":"2026-11-01T09:00:00Z",
		"source":{"kind":"claude-code","id":"sess-1","digest":"` + digest + `"},
		"items":[{"type":"user","content":"the build is broken"},
		         {"type":"tool-action","toolUseId":"t1","toolName":"Bash","toolInput":{"command":"make"},"result":"ok"},
		         {"type":"assistant","content":"Fixed."}]}`
}

func postImport(t *testing.T, api *SessionAPI, body string) (int, importAnswer, string) {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/conversations/import", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	api.HandleImportConversation(rr, req)
	var ans importAnswer
	_ = json.Unmarshal(rr.Body.Bytes(), &ans)
	return rr.Code, ans, rr.Body.String()
}

func newImportFixture(t *testing.T, existing int) (*SessionAPI, *core.SessionManager) {
	t.Helper()
	mgr, err := core.NewSessionManagerForPath(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(mgr.Shutdown)
	for i := range existing {
		if _, _, err := mgr.CreateConversation("Conv " + strconv.Itoa(i)); err != nil {
			t.Fatalf("seed %d: %v", i, err)
		}
	}
	return &SessionAPI{managerProvider: func() *core.SessionManager { return mgr }}, mgr
}

// TestHandleImportConversation_CreatesFilledAtTheEnd: the answer names a
// conversation whose document is already the import when the id is handed out,
// and it goes behind the tabs the user already has.
func TestHandleImportConversation_CreatesFilledAtTheEnd(t *testing.T) {
	api, mgr := newImportFixture(t, 2)

	code, ans, body := postImport(t, api, importBody("d1"))
	if code != http.StatusCreated || ans.ID == "" {
		t.Fatalf("status %d, body %s", code, body)
	}
	if ans.Name != "Fix the build" || ans.Room != core.MaxConversations-3 {
		t.Errorf("answer = %+v, want the title and room for %d more", ans, core.MaxConversations-3)
	}
	order := mgr.GetSession().ConversationOrder
	if order[len(order)-1] != ans.ID {
		t.Errorf("order = %v, want the import last", order)
	}
	dir, _ := mgr.ConvDir(ans.ID)
	state, err := os.ReadFile(core.ConvDocPath(dir))
	if err != nil || len(state) == 0 {
		t.Fatalf("doc.yjs empty or unreadable (%v) when the id was answered", err)
	}
	doc := worker.NewConversationDocument(ans.ID, "")
	defer doc.Destroy()
	if err := doc.LoadFromState(state); err != nil {
		t.Fatalf("load: %v", err)
	}
	if items := doc.GetItems(); len(items) != 4 || items[0].ItemID != "SYSTEM_1" || items[2].ToolName != "Bash" {
		t.Errorf("items = %+v, want SYSTEM_1 then the three imported", items)
	}
}

// TestHandleImportConversation_RecognisesARepeat: the same transcript offered
// again — while open, and after the user binned it — answers with the first
// conversation instead of making another; the same session grown since (a new
// digest) is a new import.
func TestHandleImportConversation_RecognisesARepeat(t *testing.T) {
	api, mgr := newImportFixture(t, 0)

	_, first, _ := postImport(t, api, importBody("d1"))
	code, again, body := postImport(t, api, importBody("d1"))
	if code != http.StatusOK || !again.Existing || again.ID != first.ID {
		t.Fatalf("repeat: status %d, body %s — want 200 naming %s", code, body, first.ID)
	}

	if err := mgr.BinConversation(first.ID); err != nil {
		t.Fatalf("bin: %v", err)
	}
	if code, binned, body := postImport(t, api, importBody("d1")); code != http.StatusOK || binned.ID != first.ID {
		t.Fatalf("repeat after binning: status %d, body %s — a binned import is still imported", code, body)
	}

	code, grown, body := postImport(t, api, importBody("d2"))
	if code != http.StatusCreated || grown.ID == first.ID {
		t.Fatalf("grown session: status %d, body %s — want a new conversation", code, body)
	}
	if n := len(mgr.GetSession().ConversationOrder); n != 1 {
		t.Errorf("%d conversations open, want only the grown import", n)
	}
}

// TestHandleImportConversation_RefusesBadInputAndTheCap: a transcript that
// cannot be a conversation is the caller's error and creates nothing; a full
// session refuses as any create does.
func TestHandleImportConversation_RefusesBadInputAndTheCap(t *testing.T) {
	api, mgr := newImportFixture(t, 0)
	bad := `{"title":"x","source":{"kind":"k","id":"i","digest":"d"},"items":[{"type":"assistant","content":"no user"}]}`
	if code, _, body := postImport(t, api, bad); code != http.StatusBadRequest {
		t.Fatalf("status %d, body %s, want 400", code, body)
	}
	if n := len(mgr.GetSession().ConversationOrder); n != 0 {
		t.Fatalf("a refused import left %d conversations", n)
	}

	full, _ := newImportFixture(t, core.MaxConversations)
	if code, _, body := postImport(t, full, importBody("d1")); code != http.StatusConflict {
		t.Fatalf("at the cap: status %d, body %s, want 409", code, body)
	}
}
