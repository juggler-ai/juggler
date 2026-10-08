//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import "juggler/cmd/juggler/ops"

// deliveryPumps is the set of running task-output delivery pumps, keyed by the
// pendingRequests entry each one serves. A pump polls a background task and
// injects its new output into a thread (see task_delivery.go, which owns what a
// pump does). This type only knows which are running and how to stop one.
// Every field is read and written only by the methods in this file
// (TestWorkerSeamsOwnTheirState). Run goroutine only: the pump goroutines talk
// back through w.Send.
type deliveryPumps struct {
	pumpsByEntry map[string]*taskDeliveryPump
}

func newDeliveryPumps() deliveryPumps {
	return deliveryPumps{pumpsByEntry: make(map[string]*taskDeliveryPump)}
}

// running reports whether a pump is serving entryID.
func (d *deliveryPumps) running(entryID string) bool {
	_, ok := d.pumpsByEntry[entryID]
	return ok
}

// add records p as the pump serving its entry.
func (d *deliveryPumps) add(p *taskDeliveryPump) { d.pumpsByEntry[p.entryID] = p }

// forget drops a pump that has already stopped by itself.
func (d *deliveryPumps) forget(entryID string) { delete(d.pumpsByEntry, entryID) }

// stop stops the pump serving entryID, kills its task and drops it. A no-op
// when none is running.
func (d *deliveryPumps) stop(entryID string) {
	if p, ok := d.pumpsByEntry[entryID]; ok {
		close(p.stop)
		ops.KillTask(p.taskID)
		delete(d.pumpsByEntry, entryID)
	}
}

// stopAll stops every pump and kills its task.
func (d *deliveryPumps) stopAll() {
	for id := range d.pumpsByEntry {
		d.stop(id)
	}
}
