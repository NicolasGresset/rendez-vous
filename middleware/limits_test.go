package main

import (
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestClientKey(t *testing.T) {
	cases := []struct{ remote, forwarded, want string }{
		{"203.0.113.7:51000", "", "203.0.113.7"},
		{"172.18.0.3:40000", "203.0.113.7", "203.0.113.7"},               // behind Caddy
		{"172.18.0.3:40000", "198.51.100.1, 203.0.113.7", "203.0.113.7"}, // the last one is the one Caddy saw
		{"172.18.0.3:40000", "2a01:cb19:9936:7000:be24:11ff:fe36:8e5a", "2a01:cb19:9936:7000::/64"},
		{"172.18.0.3:40000", "2a01:cb19:9936:7000::1", "2a01:cb19:9936:7000::/64"}, // same subscriber, same count
		{"172.18.0.3:40000", "::ffff:203.0.113.7", "203.0.113.7"},
		{"172.18.0.3:40000", "not an address", "unknown"},
	}
	for _, c := range cases {
		r := httptest.NewRequest(http.MethodPost, "/v1/proposals", nil)
		r.RemoteAddr = c.remote
		if c.forwarded != "" {
			r.Header.Set("X-Forwarded-For", c.forwarded)
		}
		if got := clientKey(r); got != c.want {
			t.Errorf("%q, %q: %s, want %s", c.remote, c.forwarded, got, c.want)
		}
	}
}

func TestFiveAMinute(t *testing.T) {
	l := newRateLimiter(perMinute, perDay)
	start := time.Date(2026, 11, 8, 20, 0, 0, 0, time.UTC)
	for k := 0; k < perMinute; k++ {
		if ok, _ := l.allow("a", start.Add(time.Duration(k)*time.Second)); !ok {
			t.Fatalf("computation %d refused", k+1)
		}
	}
	ok, wait := l.allow("a", start.Add(10*time.Second))
	if ok || wait != 50*time.Second {
		t.Errorf("sixth in the minute: %v, wait %v (until the first is a minute old)", ok, wait)
	}
	if ok, _ := l.allow("b", start.Add(10*time.Second)); !ok {
		t.Error("another client is refused")
	}
	if ok, _ := l.allow("a", start.Add(time.Minute)); !ok {
		t.Error("refused once the first is a minute old")
	}
}

func TestHundredADay(t *testing.T) {
	l := newRateLimiter(perMinute, perDay)
	start := time.Date(2026, 11, 8, 0, 0, 0, 0, time.UTC)
	for k := 0; k < perDay; k++ {
		if ok, _ := l.allow("a", start.Add(time.Duration(k)*10*time.Minute)); !ok {
			t.Fatalf("computation %d refused", k+1)
		}
	}
	last := start.Add(perDay * 10 * time.Minute)
	ok, wait := l.allow("a", last)
	if ok || wait != 24*time.Hour-perDay*10*time.Minute {
		t.Errorf("101st in the day: %v, wait %v", ok, wait)
	}
	if ok, _ := l.allow("a", start.Add(24*time.Hour)); !ok {
		t.Error("refused once the first is a day old")
	}
}

func TestUndoAndPurge(t *testing.T) {
	l := newRateLimiter(perMinute, perDay)
	now := time.Date(2026, 11, 8, 20, 0, 0, 0, time.UTC)
	for k := 0; k < perMinute; k++ {
		l.allow("a", now)
	}
	l.undo("a")
	if ok, _ := l.allow("a", now); !ok {
		t.Error("a computation refused as busy still counts")
	}
	l.allow("b", now.Add(-25*time.Hour))
	l.purge(now)
	if _, kept := l.clients["b"]; kept || len(l.clients["a"]) != perMinute {
		t.Errorf("after the purge: %v", l.clients)
	}
}

func TestClientsRememberedAreBounded(t *testing.T) {
	l := newRateLimiter(perMinute, perDay)
	now := time.Now()
	for k := 0; k < maxClients; k++ {
		l.allow(fmt.Sprint(k), now)
	}
	if ok, _ := l.allow("new", now); ok {
		t.Error("one client more than remembered is accepted")
	}
	if ok, _ := l.allow("0", now); !ok {
		t.Error("a client already remembered is refused")
	}
}

func TestRetryAfterRoundsUp(t *testing.T) {
	if retryAfter(1500*time.Millisecond) != 2 || retryAfter(0) != 1 || retryAfter(50*time.Second) != 50 {
		t.Error("retryAfter")
	}
}

// proposalsHandler is the route on the fake MOTIS of distanceMotis, for limits tests.
func proposalsHandler(t *testing.T) (http.Handler, *service) {
	t.Helper()
	data, err := loadData(repoPlacesFile)
	if err != nil {
		t.Fatal(err)
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	svc := newService(data, distanceMotis(t), logger)
	return newHandler(parseOrigins(siteOrigin), logger, svc), svc
}

func postFrom(handler http.Handler, client string) *http.Response {
	soon := time.Now().In(toulouse).Add(time.Hour).Truncate(15 * time.Minute)
	body := strings.Replace(validBody, "2026-11-09T19:00", soon.Format(timeLayout), 1)
	req := httptest.NewRequest(http.MethodPost, "/v1/proposals", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Forwarded-For", client)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec.Result()
}

func TestTheSixthComputationOfTheMinuteIsA429(t *testing.T) {
	handler, _ := proposalsHandler(t)
	for k := 0; k < perMinute; k++ {
		if res := postFrom(handler, "2a01:cb19:9936:7000::"+fmt.Sprint(k+1)); res.StatusCode != http.StatusOK {
			t.Fatalf("computation %d: status %d", k+1, res.StatusCode)
		}
	}
	res := postFrom(handler, "2a01:cb19:9936:7000::99") // another address of the same /64
	got := body(t, res)
	if res.StatusCode != http.StatusTooManyRequests || !strings.HasPrefix(got, `{"error":"rate_limited","retryAfter":`) ||
		res.Header.Get("Retry-After") == "" {
		t.Errorf("status %d, %s, Retry-After %q", res.StatusCode, got, res.Header.Get("Retry-After"))
	}
	if res := postFrom(handler, "2a01:cb19:9936:7001::1"); res.StatusCode != http.StatusOK {
		t.Errorf("another /64: status %d", res.StatusCode)
	}
}

func TestBusyIsA503AndDoesNotCount(t *testing.T) {
	handler, svc := proposalsHandler(t)
	svc.wait = 50 * time.Millisecond
	for k := 0; k < maxComputations; k++ {
		svc.slots <- struct{}{} // every place taken
	}
	res := postFrom(handler, "203.0.113.7")
	if got := body(t, res); res.StatusCode != http.StatusServiceUnavailable || got != `{"error":"busy","retryAfter":10}` ||
		res.Header.Get("Retry-After") != "10" {
		t.Errorf("status %d, %s", res.StatusCode, got)
	}
	<-svc.slots // one place free again
	for k := 0; k < perMinute; k++ {
		if res := postFrom(handler, "203.0.113.7"); res.StatusCode != http.StatusOK {
			t.Fatalf("computation %d after the busy one: status %d (the busy one counted?)", k+1, res.StatusCode)
		}
	}
	if len(svc.slots) != maxComputations-1 {
		t.Errorf("%d places taken after the computations, want %d: a place was not given back", len(svc.slots), maxComputations-1)
	}
}
