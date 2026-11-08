package main

// The limits of POST /v1/proposals (docs/architecture.md § Security of the API): per client, 5 computations a minute
// and 100 a day; for the whole service, 4 computations at once, a request finding them busy waiting a few seconds
// for a place. Starting values, to set from a load test.

import (
	"net"
	"net/http"
	"net/netip"
	"strings"
	"sync"
	"time"
)

const (
	perMinute         = 5 // computations (POST /v1/proposals) per client
	perDay            = 100
	placesPerMinute   = 30 // single places (POST /v1/place): lighter, and a visitor may look at several in a row
	placesPerDay      = 300
	maxComputations   = 4               // at once, for the whole service
	computationWait   = 5 * time.Second // a request finding them busy waits this long for a place
	busyRetrySeconds  = 10              // then is told to come back after this
	maxClients        = 100_000         // clients remembered: beyond, new ones are refused as busy (bounded memory)
	clientsPurgeEvery = 10 * time.Minute
)

// clientKey is who a request is counted for: its IPv4 address, or its IPv6 /64 (a subscriber gets a whole /64, so
// counting per IPv6 address would be bypassed by changing the last bits). Behind Caddy, the client's address is the
// last of X-Forwarded-For (Caddy sets it from the connection: only Caddy can reach the middleware); without the
// header (tests, a direct call), the connection's.
func clientKey(r *http.Request) string {
	address := ""
	if forwarded := r.Header.Get("X-Forwarded-For"); forwarded != "" {
		parts := strings.Split(forwarded, ",")
		address = strings.TrimSpace(parts[len(parts)-1])
	} else if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		address = host
	}
	ip, err := netip.ParseAddr(address)
	if err != nil {
		return "unknown" // every request without a readable address shares one count
	}
	ip = ip.Unmap() // an IPv4 address written as IPv6 is the IPv4 address
	if ip.Is4() {
		return ip.String()
	}
	prefix, _ := ip.Prefix(64)
	return prefix.String()
}

// rateLimiter remembers, per client, the start times of its requests of the last 24 h (at most perDay).
type rateLimiter struct {
	mu                sync.Mutex
	clients           map[string][]time.Time
	perMinute, perDay int
}

func newRateLimiter(perMinute, perDay int) *rateLimiter {
	return &rateLimiter{clients: map[string][]time.Time{}, perMinute: perMinute, perDay: perDay}
}

// allow records a computation of the client at now and returns true, or returns false and how long to wait.
func (l *rateLimiter) allow(key string, now time.Time) (bool, time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()
	times := l.clients[key]
	// Forget what is older than a day
	kept := times[:0]
	for _, t := range times {
		if now.Sub(t) < 24*time.Hour {
			kept = append(kept, t)
		}
	}
	times = kept
	if len(times) == 0 && len(l.clients) >= maxClients {
		return false, busyRetrySeconds * time.Second
	}
	if len(times) >= l.perDay {
		l.clients[key] = times
		return false, times[0].Add(24 * time.Hour).Sub(now)
	}
	if len(times) >= l.perMinute {
		if oldest := times[len(times)-l.perMinute]; now.Sub(oldest) < time.Minute {
			l.clients[key] = times
			return false, oldest.Add(time.Minute).Sub(now)
		}
	}
	l.clients[key] = append(times, now)
	return true, 0
}

// undo forgets the client's last computation: it was refused as busy, so it should not count.
func (l *rateLimiter) undo(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if times := l.clients[key]; len(times) > 0 {
		l.clients[key] = times[:len(times)-1]
	}
}

// purge forgets the clients without a computation in the last day, so that the memory does not grow forever.
func (l *rateLimiter) purge(now time.Time) {
	l.mu.Lock()
	defer l.mu.Unlock()
	for key, times := range l.clients {
		if len(times) == 0 || now.Sub(times[len(times)-1]) >= 24*time.Hour {
			delete(l.clients, key)
		}
	}
}

// purgeEvery purges in the background, until stop is closed.
func (l *rateLimiter) purgeEvery(period time.Duration, stop <-chan struct{}) {
	ticker := time.NewTicker(period)
	defer ticker.Stop()
	for {
		select {
		case now := <-ticker.C:
			l.purge(now)
		case <-stop:
			return
		}
	}
}

// retryAfter is a wait in whole seconds, at least 1.
func retryAfter(wait time.Duration) int {
	seconds := int((wait + time.Second - 1) / time.Second)
	if seconds < 1 {
		return 1
	}
	return seconds
}
