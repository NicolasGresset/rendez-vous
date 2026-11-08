package main

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// corsMaxAge is how long a browser may reuse a preflight answer (browsers cap it: 2 h in Chrome, 24 h in Firefox)
const corsMaxAge = "7200"

// knownPaths are the routes logged by name; any other path is logged as "other", so that no string chosen by
// the client reaches the logs.
var knownPaths = map[string]bool{"/v1/health": true, "/v1/proposals": true}

// computationDeadline bounds a whole computation, from the visitor's request to the answer (under the server's 30 s
// write timeout); each call to MOTIS has its own, shorter, timeout.
const computationDeadline = 25 * time.Second

// service is what the routes need: the places, MOTIS, and the deadline of a computation (shorter in tests).
type service struct {
	data     *Data
	motis    *MotisClient
	deadline time.Duration
	logger   *slog.Logger
	limits   *rateLimiter  // per client
	slots    chan struct{} // the computations running, maxComputations at most
	wait     time.Duration // how long a request waits for a slot
}

func newService(data *Data, motis *MotisClient, logger *slog.Logger) *service {
	return &service{data: data, motis: motis, deadline: computationDeadline, logger: logger, limits: newRateLimiter(),
		slots: make(chan struct{}, maxComputations), wait: computationWait}
}

// newHandler builds the whole chain: request log, then CORS, then the routes.
func newHandler(origins map[string]bool, logger *slog.Logger, svc *service) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/health", handleHealth)
	mux.HandleFunc("/v1/proposals", svc.handleProposals)
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		writeError(w, http.StatusNotFound, "not_found")
	})
	return logRequests(logger, withCORS(origins, mux))
}

// handleHealth answers that the middleware runs. The page calls it as soon as the form is in use, which also opens
// the connection that the computation will reuse.
func handleHealth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// handleProposals validates the question, runs the method by zones and answers the proposals. MOTIS failing
// (after its retry) is a 503, the deadline passed a 504; a visitor who left gets nothing (the calls stopped).
func (svc *service) handleProposals(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	q, refusal := readQuestion(w, r, time.Now())
	if refusal != nil {
		writeRequestError(w, refusal)
		return
	}
	// Per client: refused before any work, with the wait; counted only once the computation runs
	key := clientKey(r)
	if ok, wait := svc.limits.allow(key, time.Now()); !ok {
		writeRetry(w, http.StatusTooManyRequests, "rate_limited", retryAfter(wait))
		return
	}
	// For the service: a place among the computations running, waited for a few seconds
	select {
	case svc.slots <- struct{}{}:
		defer func() { <-svc.slots }()
	case <-time.After(svc.wait):
		svc.limits.undo(key)
		writeRetry(w, http.StatusServiceUnavailable, "busy", busyRetrySeconds)
		return
	case <-r.Context().Done():
		svc.limits.undo(key)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), svc.deadline)
	defer cancel()
	answer, err := svc.answer(ctx, q)
	switch {
	case err == nil:
		w.Header().Set("Cache-Control", "no-store")
		writeJSON(w, http.StatusOK, answer)
	case r.Context().Err() != nil:
		// The visitor left: nobody to answer
	case errors.Is(ctx.Err(), context.DeadlineExceeded): // the computation's own deadline, whatever the call that hit it
		writeError(w, http.StatusGatewayTimeout, "timeout")
	default:
		svc.logger.Error("computation", "error", err.Error())
		writeError(w, http.StatusServiceUnavailable, "engine_unavailable")
	}
}

func (svc *service) answer(ctx context.Context, q Question) (*Answer, error) {
	result, err := propose(ctx, q, svc.data, svc.motis)
	if err != nil {
		return nil, err
	}
	return buildAnswer(ctx, q, svc.data, svc.motis, result)
}

// withCORS lets the allowed origins read the answers, answers their preflight requests, and refuses any request
// carrying another origin. Browsers enforce CORS on their side; refusing here too means a page of another site
// gets no work done by the server, even with a request that browsers send without a preflight.
// Requests without an Origin header (curl, Docker's health check) are not concerned.
func withCORS(origins map[string]bool, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Add("Vary", "Origin")
		origin := r.Header.Get("Origin")
		if origin == "" {
			next.ServeHTTP(w, r)
			return
		}
		if !origins[origin] {
			writeError(w, http.StatusForbidden, "origin_not_allowed")
			return
		}
		h.Set("Access-Control-Allow-Origin", origin)
		if r.Method == http.MethodOptions && r.Header.Get("Access-Control-Request-Method") != "" {
			h.Set("Access-Control-Allow-Methods", "GET, POST")
			h.Set("Access-Control-Allow-Headers", "Content-Type")
			h.Set("Access-Control-Max-Age", corsMaxAge)
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// parseOrigins reads ALLOWED_ORIGINS: comma-separated, spaces and empty items ignored.
func parseOrigins(value string) map[string]bool {
	origins := map[string]bool{}
	for _, origin := range strings.Split(value, ",") {
		if origin = strings.TrimSpace(origin); origin != "" {
			origins[origin] = true
		}
	}
	return origins
}

// statusRecorder remembers the status written by a handler, for the log.
type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (s *statusRecorder) WriteHeader(status int) {
	s.status = status
	s.ResponseWriter.WriteHeader(status)
}

// logRequests logs one line per request: method, route, status, duration. Never the IP address nor the body
// (docs/architecture.md § Security of the API). Successful health checks are not logged: Docker makes one every
// 30 s, and the page one per visit (about 2,900 useless lines a day).
func logRequests(logger *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		recorder := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(recorder, r)
		route := "other"
		if knownPaths[r.URL.Path] {
			route = r.URL.Path
		}
		if route == "/v1/health" && recorder.status == http.StatusOK {
			return
		}
		method := r.Method
		if len(method) > 10 {
			method = "other"
		}
		logger.Info("request", "method", method, "route", route, "status", recorder.status,
			"ms", time.Since(start).Milliseconds())
	})
}

// writeRetry refuses for now: the code, and when to come back (the Retry-After header and the body, in seconds).
func writeRetry(w http.ResponseWriter, status int, code string, seconds int) {
	w.Header().Set("Retry-After", strconv.Itoa(seconds))
	writeJSON(w, status, map[string]any{"error": code, "retryAfter": seconds})
}

// writeError answers a fixed error code, never anything taken from the request.
func writeError(w http.ResponseWriter, status int, code string) {
	writeJSON(w, status, map[string]string{"error": code})
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	h := w.Header()
	h.Set("Content-Type", "application/json")
	h.Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
