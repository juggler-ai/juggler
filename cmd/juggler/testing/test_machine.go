//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !production

package testing

import (
	"net/http"

	"juggler/cmd/juggler/server/handlers"
	"juggler/internal/machineload"
)

// TestMachine is how busy the machine was when a test failed.
type TestMachine struct {
	// Available is false where the OS keeps no run-queue average, so a reader
	// can tell "idle" from "unmeasured" — three zeroes look identical.
	Available bool    `json:"available"`
	One       float64 `json:"one"`
	Five      float64 `json:"five"`
	Fifteen   float64 `json:"fifteen"`
	CPUs      int     `json:"cpus"`
	PerCPU    float64 `json:"perCpu"`
	// Line is the rendered one-liner, so the browser and the Go harness quote
	// the identical wording and a log can be grepped for either.
	Line string `json:"line"`
}

// HandleMachine reports the machine's load average. GET /api/test/machine.
//
// The browser is where almost every failure block is assembled, and a page
// cannot read a load average: there is no such web API, and the lanes are
// deliberately sandboxed away from anything that would amount to one. So the
// number comes from the process that can read it, over the loopback the lane is
// already talking to.
//
// It is a reading, not a judgement about this test — the load average covers the
// last minute and a browser test's whole budget is 25 seconds, so a saturated
// figure says the run is not evidence and a quiet one says the failure deserves
// attention. That is the entire purpose: to stop a timeout being filed as a
// flake on no evidence either way.
func (api *TestRunAPI) HandleMachine(w http.ResponseWriter, r *http.Request) {
	out := TestMachine{Line: machineload.Line()}
	if reading, ok := machineload.Read(); ok {
		out.Available = true
		out.One, out.Five, out.Fifteen = reading.One, reading.Five, reading.Fifteen
		out.CPUs = reading.CPUs
		out.PerCPU = reading.PerCPU()
	}
	handlers.WriteJSON(w, r, 0, out)
}
