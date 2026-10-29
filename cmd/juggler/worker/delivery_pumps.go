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
// (TestWorkerSeamsOwnTheirState). Run goroutine only, which every method
// asserts (actor_guard.go): the pump goroutines talk back through w.Send.
type deliveryPumps struct {
	// pumpActor is the worker's actor guard; nil for a set built bare.
	pumpActor    *actorGuard
	pumpsByEntry map[string]*taskDeliveryPump
}

func newDeliveryPumps(actor *actorGuard) deliveryPumps {
	return deliveryPumps{pumpActor: actor, pumpsByEntry: make(map[string]*taskDeliveryPump)}
}

// own asserts the caller is the actor.
func (d *deliveryPumps) own() { d.pumpActor.assertActor("the delivery pump table") }

// running reports whether a pump is serving entryID.
func (d *deliveryPumps) running(entryID string) bool {
	d.own()
	_, ok := d.pumpsByEntry[entryID]
	return ok
}

// any reports whether an internal producer can still enqueue task output.
func (d *deliveryPumps) any() bool {
	d.own()
	return len(d.pumpsByEntry) != 0
}

// add records p as the pump serving its entry.
func (d *deliveryPumps) add(p *taskDeliveryPump) { d.own(); d.pumpsByEntry[p.entryID] = p }

// forget drops a pump that has already stopped by itself.
func (d *deliveryPumps) forget(entryID string) { d.own(); delete(d.pumpsByEntry, entryID) }

// stop stops the pump serving entryID, kills its task and drops it. A no-op
// when none is running.
func (d *deliveryPumps) stop(entryID string) {
	d.own()
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
