package cloudsign

import (
	"net"
	"sync"
	"time"

	"golang.org/x/time/rate"
)

// ipLimiter rate-limits presign requests per client IP. Anyone who guesses a
// SessionID (a phrase-holder, or a lucky brute-forcer) still can't cheaply
// hammer the object store. Modeled on parley's relay ipLimiter (which is
// unexported, so replicated here).
type ipLimiter struct {
	mu    sync.Mutex
	m     map[string]*ipEntry
	limit rate.Limit
	burst int
	now   func() time.Time // injectable for tests
}

type ipEntry struct {
	lim  *rate.Limiter
	seen time.Time
}

// ipLimiterCap bounds the tracking map; when full we evict rather than grow.
const ipLimiterCap = 16384

// ipIdleTTL: an entry idle at least this long has a fully-refilled bucket, so
// evicting it is indistinguishable from a fresh one — lets us bound memory
// without ever forgiving an active offender.
const ipIdleTTL = 2 * time.Minute

func newIPLimiter(limit rate.Limit, burst int) *ipLimiter {
	return &ipLimiter{m: map[string]*ipEntry{}, limit: limit, burst: burst, now: time.Now}
}

func (l *ipLimiter) allow(remoteAddr string) bool {
	ip, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		ip = remoteAddr
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	if e, ok := l.m[ip]; ok {
		e.seen = now
		return e.lim.AllowN(now, 1)
	}
	if len(l.m) >= ipLimiterCap {
		l.evictLocked(now)
	}
	lim := rate.NewLimiter(l.limit, l.burst)
	l.m[ip] = &ipEntry{lim: lim, seen: now}
	return lim.AllowN(now, 1)
}

// evictLocked frees space in a full map: drop every entry idle past ipIdleTTL
// (buckets already refilled, so lossless), else drop the single
// least-recently-seen — never a blanket reset. Caller holds l.mu.
func (l *ipLimiter) evictLocked(now time.Time) {
	var oldestKey string
	var oldestSeen time.Time
	freed := false
	for k, e := range l.m {
		if now.Sub(e.seen) >= ipIdleTTL {
			delete(l.m, k)
			freed = true
			continue
		}
		if oldestKey == "" || e.seen.Before(oldestSeen) {
			oldestKey, oldestSeen = k, e.seen
		}
	}
	if !freed && oldestKey != "" {
		delete(l.m, oldestKey)
	}
}
