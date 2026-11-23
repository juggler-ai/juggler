//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package ops

import (
	"context"
	"fmt"
)

// Operations is the interface that all operation handlers must implement.
// ctx is the request context: handlers running unbounded work (filesystem
// walks, network fetches) should honor ctx.Err()/ctx.Done() so a cancelled
// HTTP request (the browser aborting the op fetch on Escape) stops the work
// instead of running it to completion.
type Operations interface {
	Execute(ctx context.Context, operation string, params map[string]any) (any, error)
}

// Factory is a function that creates an operation handler instance
type Factory func(scope PathScope) Operations

// Registration is one tool's entry: how its handler is built, and who may call
// it where. The zero flags are an ordinary tool, which the agent's tool calls
// and the user's client may both call, in a workspace.
//
// The flags are enforced by the dispatcher (handlers.OpsAPI), which serves the
// agent's tool calls and the user's client through different entries; a
// handler never has to ask who called it.
type Registration struct {
	Factory Factory

	// ClientOnly is a tool that acts for the user, through the user's client,
	// and that the agent's tool calls may never reach: what it does is what
	// the user asked for in the UI, with nothing approved or recorded as the
	// agent's.
	ClientOnly bool

	// AnyTree is a tool that may also run in trees no workspace names — those
	// the client's wider resolver reaches, such as another worktree of a
	// repository the user is looking at. Only a ClientOnly tool may have it,
	// and Register panics on one that is not, so that no slip in a dispatcher
	// can hand the agent a tree the user never registered.
	AnyTree bool
}

// registry maps tool IDs to their registrations
var registry = make(map[string]Registration)

// Register registers an ordinary tool's handler factory.
func Register(toolID string, factory Factory) {
	RegisterWith(toolID, Registration{Factory: factory})
}

// RegisterWith registers a tool with the flags its registration carries.
func RegisterWith(toolID string, reg Registration) {
	registry[toolID] = checked(toolID, reg)
}

// checked is reg, or a panic for one whose flags contradict each other.
func checked(toolID string, reg Registration) Registration {
	if reg.AnyTree && !reg.ClientOnly {
		panic(fmt.Sprintf("ops: %s may run in any tree, so it must be ClientOnly", toolID))
	}
	return reg
}

// Lookup returns a tool's registration.
func Lookup(toolID string) (Registration, error) {
	reg, ok := registry[toolID]
	if !ok {
		return Registration{}, fmt.Errorf("operation handler not found for tool: %s", toolID)
	}
	return reg, nil
}

// Table is one server's own registrations, over the process-wide ones: the
// tools whose handlers close over state that server owns (its job hub, its
// write queue), which a second server in the same process must not share. It
// is filled while the server is built and only read after, so it needs no
// lock.
type Table struct {
	own map[string]Registration
}

// NewTable is a table with nothing of its own yet.
func NewTable() *Table {
	return &Table{own: make(map[string]Registration)}
}

// Register adds one of the server's own tools; it shadows a process-wide tool
// of the same id.
func (t *Table) Register(toolID string, reg Registration) {
	t.own[toolID] = checked(toolID, reg)
}

// Lookup returns the server's own registration of a tool, or the process-wide
// one. A nil table has only the process-wide ones.
func (t *Table) Lookup(toolID string) (Registration, error) {
	if t != nil {
		if reg, ok := t.own[toolID]; ok {
			return reg, nil
		}
	}
	return Lookup(toolID)
}
