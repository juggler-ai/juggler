//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package machineload

import (
	"runtime"
	"strings"
	"testing"
)

// maxCredibleLoad bounds a per-platform reading. Its real job is catching a
// fixed-point average returned without its scale: on macOS the kernel's fscale
// is 2048, so a machine at a load of 0.5 reads as 1024 if the divide is ever
// dropped. No machine this suite runs on has 256 runnable threads, so anything
// past that is a decoding fault rather than a busy box.
const maxCredibleLoad = 256

func TestReadGivesACredibleLoadAverageWhereTheOSHasOne(t *testing.T) {
	r, ok := Read()
	hasLoadAverage := runtime.GOOS == "darwin" || runtime.GOOS == "linux"
	if ok != hasLoadAverage {
		t.Fatalf("Read() ok = %v on %s; want %v — either the platform gained a load average or the decode stopped working", ok, runtime.GOOS, hasLoadAverage)
	}
	if !ok {
		return
	}
	for _, c := range []struct {
		name string
		v    float64
	}{{"one", r.One}, {"five", r.Five}, {"fifteen", r.Fifteen}} {
		if c.v < 0 || c.v > maxCredibleLoad {
			t.Errorf("%s-minute average is %v, outside [0, %d] — the kernel's fixed-point scale is probably not being applied", c.name, c.v, maxCredibleLoad)
		}
	}
	if r.CPUs < 1 {
		t.Errorf("CPUs = %d; a reading with no cores to divide by cannot produce a per-CPU figure", r.CPUs)
	}
}

func TestPerCPUDividesByTheCoresAvailable(t *testing.T) {
	if got := (Reading{One: 8, CPUs: 4}).PerCPU(); got != 2 {
		t.Errorf("PerCPU() = %v; want 2 (a load of 8 over 4 cores)", got)
	}
	// A reading with no core count is the zero Reading, which only happens when
	// Read failed. Dividing by it would panic or produce +Inf, and a diagnostic
	// may not do either.
	if got := (Reading{One: 8}).PerCPU(); got != 0 {
		t.Errorf("PerCPU() = %v with no CPU count; want 0", got)
	}
}

func TestTheVerdictNamesWhatTheNumberMeans(t *testing.T) {
	cases := []struct {
		name  string
		r     Reading
		wants string
	}{
		{"idle", Reading{One: 1, CPUs: 8}, "quiet"},
		{"one runnable thread per core", Reading{One: 8, CPUs: 8}, "busy"},
		{"twice oversubscribed", Reading{One: 16, CPUs: 8}, "SATURATED"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := verdict(c.r); !strings.Contains(got, c.wants) {
				t.Errorf("verdict(%.2f over %d CPUs) = %q; want it to say %q", c.r.One, c.r.CPUs, got, c.wants)
			}
		})
	}
}

// A failure block is assembled while a test is already failing, so Line must
// always produce something a reader can act on — including on the platform with
// no load average, where saying so is the useful answer and a silent zero is the
// harmful one.
func TestLineAlwaysSaysSomething(t *testing.T) {
	line := Line()
	if !strings.HasPrefix(line, "MACHINE LOAD: ") {
		t.Fatalf("Line() = %q; want it to open with the label a failure block greps for", line)
	}
	// An unreadable load average must say so in words. A line that merely omits
	// the figures reads as an idle machine, which is how a void run gets quoted
	// as evidence.
	if _, ok := Read(); ok {
		if !strings.Contains(line, "per CPU") {
			t.Errorf("Line() = %q; a reading that exists must carry the per-CPU figure", line)
		}
	} else if !strings.Contains(line, "unavailable") {
		t.Errorf("Line() = %q; with no reading to give, the line must say it is unavailable", line)
	}
}
