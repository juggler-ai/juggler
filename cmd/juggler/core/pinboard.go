//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"time"
)

// Pin is one configured instance of a pinboard item type — one tab on the board.
//
// Config is opaque to the server: it is whatever the item type's client-side
// provider persists, stored and returned verbatim. That is deliberate, and it is
// what lets a pin outlive its provider — a disabled or uninstalled extension's
// pins keep their configuration until the user removes them, so re-enabling the
// extension restores a working board rather than an empty one.
type Pin struct {
	ID      string          `json:"id"`                // Client-generated, stable for the pin's life
	Type    string          `json:"type"`              // Item-type id, e.g. "file"
	Config  json.RawMessage `json:"config,omitempty"`  // Provider-owned, opaque here
	AddedAt string          `json:"addedAt,omitempty"` // RFC3339, set by the server when the pin is added
}

// MainBoardID names the board the docked panel shows. It is the one board that
// is not a window: every viewer of the project shares it, which is what makes
// the panel in the main window mean the same thing wherever it is opened.
const MainBoardID = "main"

// Board is one pinboard composition — the tabs of a single panel.
//
// A project has the main board and one per detached window. They are separate
// compositions rather than views of one, because a board detached into a window
// is a thing the user arranged for a purpose: two windows watching two different
// conversations want two different sets of tabs, and a shared list would have
// each rearranging the other.
//
// Conversation is empty for the main board, which follows whichever conversation
// its window is showing, and set for a detached one, which is a view of the one
// conversation it was opened for. It is also what tells the two apart: a board
// with a conversation is a window that can be reopened, and a board without one
// is the panel that is always there.
// Seeded records that the board has been furnished with its starting tabs, which
// is not the same as its having any. A board arrives empty and is filled once,
// by whichever viewer claims the seed; from then on its composition is the user's,
// and a board they have emptied stays empty. Without the flag those two states
// are the same state, and every load would put the starting tabs back.
type Board struct {
	ID           string `json:"id"`                     // Client-generated, stable for the board's life
	Conversation string `json:"conversation,omitempty"` // The conversation a detached board views; empty for the main board
	Seeded       bool   `json:"seeded,omitempty"`       // Its starting tabs have been placed (see ClaimBoardSeed)
	Pins         []Pin  `json:"pins,omitempty"`         // Its tabs, in order
}

// IsDetached reports whether this board belongs to a window of its own.
func (b Board) IsDetached() bool {
	return b.Conversation != ""
}

// Clone returns a copy whose pin slice the caller may mutate freely.
func (b Board) Clone() Board {
	c := b
	c.Pins = append([]Pin{}, b.Pins...)
	return c
}

// Limits on the board. These are not a security boundary — everything here is
// the user's own state — but an unbounded list persisted into session.json and
// broadcast to every viewer on each edit deserves a ceiling.
//
// MaxBoards counts the main board along with the detached ones. Sixteen windows
// of pins is already past the point of being a workspace, and a board is only
// ever created by a deliberate detach.
const (
	MaxPins           = 64
	MaxPinConfigBytes = 16 * 1024
	MaxPinTypeLen     = 128
	MaxPinboardOps    = 64
	MaxBoards         = 16
)

// pinIDRe constrains pin ids to what can be used unescaped as a DOM id, a map
// key, and a log token. Clients generate them (which is what makes a retried
// "add" idempotent rather than a duplicate), so the shape is checked here.
//
// Board ids are held to the same alphabet, for the same reasons and one more:
// a board id travels in a window's URL and comes back as a query parameter, so
// anything needing escaping to survive that round trip has no business being an
// id in the first place.
var pinIDRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

// BoardLiveness is what is connected to the session at the moment a detached
// board is claimed (SessionManager.ClaimDetachedBoards): the viewer ids of its
// windows, and the boards whose own windows are among them.
type BoardLiveness struct {
	Viewers map[string]bool
	Boards  map[string]bool
}

// ValidBoardID reports whether id is a well-formed board id. Exported because
// the id arrives from a query string, and the route that reads it should be able
// to refuse a bad one rather than create a board named after it.
func ValidBoardID(id string) bool {
	return pinIDRe.MatchString(id)
}

// PinboardOp is one semantic edit to the board.
//
// The board carries no revision and rejects no write for staleness. Two viewers
// editing at once is not a conflict to arbitrate: each op names the pin it acts
// on, so the actor goroutine applies them in arrival order against whatever the
// board is at that moment and both edits survive. This is the same choice
// ReorderConversations makes — merge, don't reject — and it is why a client never
// needs to rebase.
//
// Ops are idempotent by design: adding a pin whose id is already present, or
// removing/moving/updating one that is absent, is a no-op rather than an error.
// A retry after a dropped response therefore cannot duplicate or resurrect a pin.
type PinboardOp struct {
	Op     string          `json:"op"`               // "add" | "remove" | "move" | "update"
	ID     string          `json:"id"`               // The pin acted on (required by every op)
	Type   string          `json:"type,omitempty"`   // add: the item-type id
	Config json.RawMessage `json:"config,omitempty"` // add, update: provider config
	Index  *int            `json:"index,omitempty"`  // add, move: target position; add appends when absent
}

// Valid op names, kept as a set so an unknown op is a clear error rather than a
// silently ignored edit.
const (
	pinOpAdd    = "add"
	pinOpRemove = "remove"
	pinOpMove   = "move"
	pinOpUpdate = "update"
)

// applyPinboardOps returns the board that results from applying ops to pins, or
// an error naming the first structurally invalid op. It is a pure function of its
// arguments — the caller decides when to persist — so the operation semantics can
// be tested without a session, a manager, or a disk.
//
// An error rejects the whole batch: a batch is one user action, and half-applying
// it would leave the board in a state nobody asked for.
func applyPinboardOps(pins []Pin, ops []PinboardOp) ([]Pin, error) {
	if len(ops) == 0 {
		return pins, nil
	}
	if len(ops) > MaxPinboardOps {
		return nil, fmt.Errorf("too many operations: %d (max %d)", len(ops), MaxPinboardOps)
	}

	next := append([]Pin(nil), pins...)
	for i, op := range ops {
		var err error
		next, err = applyPinboardOp(next, op)
		if err != nil {
			return nil, fmt.Errorf("operation %d (%s): %w", i+1, op.Op, err)
		}
	}
	if len(next) > MaxPins {
		return nil, fmt.Errorf("too many pins: %d (max %d)", len(next), MaxPins)
	}
	return next, nil
}

// applyPinboardOp applies one op to a board it may modify in place.
func applyPinboardOp(pins []Pin, op PinboardOp) ([]Pin, error) {
	if !pinIDRe.MatchString(op.ID) {
		return nil, fmt.Errorf("invalid pin id %q", op.ID)
	}
	at := indexOfPin(pins, op.ID)

	switch op.Op {
	case pinOpAdd:
		if err := validatePinType(op.Type); err != nil {
			return nil, err
		}
		if err := validatePinConfig(op.Config); err != nil {
			return nil, err
		}
		if at >= 0 {
			// Already present — a retried add, not a second pin.
			return pins, nil
		}
		pin := Pin{
			ID:      op.ID,
			Type:    strings.TrimSpace(op.Type),
			Config:  op.Config,
			AddedAt: time.Now().UTC().Format(time.RFC3339),
		}
		return insertPin(pins, pin, clampPinIndex(op.Index, len(pins))), nil

	case pinOpRemove:
		if at < 0 {
			return pins, nil
		}
		return append(pins[:at], pins[at+1:]...), nil

	case pinOpMove:
		if at < 0 {
			return pins, nil
		}
		if op.Index == nil {
			return nil, fmt.Errorf("move requires an index")
		}
		pin := pins[at]
		pins = append(pins[:at], pins[at+1:]...)
		return insertPin(pins, pin, clampPinIndex(op.Index, len(pins))), nil

	case pinOpUpdate:
		if err := validatePinConfig(op.Config); err != nil {
			return nil, err
		}
		if at < 0 {
			return pins, nil
		}
		pins[at].Config = op.Config
		return pins, nil

	default:
		return nil, fmt.Errorf("unknown operation %q", op.Op)
	}
}

// indexOfPin returns the position of the pin with this id, or -1.
func indexOfPin(pins []Pin, id string) int {
	for i, p := range pins {
		if p.ID == id {
			return i
		}
	}
	return -1
}

// insertPin places pin at index, which the caller has already clamped.
func insertPin(pins []Pin, pin Pin, index int) []Pin {
	pins = append(pins, Pin{})
	copy(pins[index+1:], pins[index:])
	pins[index] = pin
	return pins
}

// clampPinIndex resolves a requested index to a legal insertion point. A nil or
// out-of-range index appends rather than failing: an index is a preference about
// where a tab lands, and no user action is worth refusing over it.
func clampPinIndex(index *int, length int) int {
	if index == nil || *index > length {
		return length
	}
	if *index < 0 {
		return 0
	}
	return *index
}

// validatePinType checks the item-type id an add names.
func validatePinType(pinType string) error {
	trimmed := strings.TrimSpace(pinType)
	if trimmed == "" {
		return fmt.Errorf("add requires a type")
	}
	if len(trimmed) > MaxPinTypeLen {
		return fmt.Errorf("type is too long: %d bytes (max %d)", len(trimmed), MaxPinTypeLen)
	}
	return nil
}

// validatePinConfig bounds a provider config without interpreting it. The
// contents are the provider's business; the size is the board's.
func validatePinConfig(config json.RawMessage) error {
	if len(config) > MaxPinConfigBytes {
		return fmt.Errorf("config is too large: %d bytes (max %d)", len(config), MaxPinConfigBytes)
	}
	if len(config) > 0 && !json.Valid(config) {
		return fmt.Errorf("config is not valid JSON")
	}
	return nil
}
