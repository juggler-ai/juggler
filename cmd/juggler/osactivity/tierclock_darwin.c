// A clock of how much the background scheduling tier is being run.
//
// One thread, held at QOS_CLASS_BACKGROUND — scheduler priority 4, the tier
// WebKit runs a hidden page's web process at — sleeps a period at a time and
// adds up the time it was run in. A wake on time counts the whole stretch since
// the last one. A wake later than lateAfter means the tier was not run for the
// excess, so that stretch counts one period and the rest is discarded. Even an
// idle Mac coalesces this tier's timers by about 100ms, which lateAfter allows
// for; a saturated one leaves it unrun for seconds at a time.
//
// It is a plain pthread rather than a goroutine on a locked thread. Go hands a
// locked goroutine's processor to its thread when the goroutine is woken, so a
// thread the kernel then declines to run would hold that processor hostage for
// as long as the machine is saturated. This thread never calls into Go.

#include <pthread.h>
#include <pthread/qos.h>
#include <stdatomic.h>
#include <stdint.h>
#include <time.h>

#define TIER_PERIOD_NS (250LL * 1000 * 1000)
#define TIER_LATE_AFTER_NS (2 * TIER_PERIOD_NS + 250LL * 1000 * 1000)

static _Atomic int64_t g_tier_served_ns = 0;

// CLOCK_MONOTONIC keeps counting while the system sleeps, so a sleep reads as
// one late wake, not as time the tier was run.
static int64_t tier_now_ns(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (int64_t)ts.tv_sec * 1000000000LL + ts.tv_nsec;
}

static void *tier_clock_main(void *arg) {
    (void)arg;
    pthread_setname_np("juggler background-tier clock");
    const struct timespec period = {0, TIER_PERIOD_NS};
    int64_t last = tier_now_ns();
    for (;;) {
        nanosleep(&period, NULL);
        int64_t now = tier_now_ns();
        int64_t stretch = now - last;
        last = now;
        if (stretch > TIER_LATE_AFTER_NS) {
            stretch = TIER_PERIOD_NS;
        }
        atomic_fetch_add(&g_tier_served_ns, stretch);
    }
    return NULL;
}

static int g_tier_started = 0;

static void tier_clock_start_once(void) {
    pthread_attr_t attr;
    if (pthread_attr_init(&attr) != 0) {
        return;
    }
    pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED);
    if (pthread_attr_set_qos_class_np(&attr, QOS_CLASS_BACKGROUND, 0) == 0) {
        pthread_t thread;
        g_tier_started = pthread_create(&thread, &attr, tier_clock_main, NULL) == 0;
    }
    pthread_attr_destroy(&attr);
}

// juggler_tier_clock_start starts the clock's thread, once per process, and
// reports whether it is running at the background tier.
int juggler_tier_clock_start(void) {
    static pthread_once_t once = PTHREAD_ONCE_INIT;
    pthread_once(&once, tier_clock_start_once);
    return g_tier_started;
}

// juggler_tier_clock_served is the tier's served time so far, in nanoseconds.
int64_t juggler_tier_clock_served(void) {
    return atomic_load(&g_tier_served_ns);
}
