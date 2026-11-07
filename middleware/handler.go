package main

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
	"time"
)

// corsMaxAge is how long a browser may reuse a preflight answer (browsers cap it: 2 h in Chrome, 24 h in Firefox)
const corsMaxAge = "7200"

// knownPaths are the routes logged by name; any other path is logged as "other", so that no string chosen by
// the client reaches the logs.
var knownPaths = map[string]bool{"/v1/health": true}

// newHandler builds the whole chain: request log, then CORS, then the routes.
func newHandler(origins map[string]bool, logger *slog.Logger) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/health", handleHealth)
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
// (docs/architecture.md § Security of the API).
func logRequests(logger *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		recorder := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(recorder, r)
		route := "other"
		if knownPaths[r.URL.Path] {
			route = r.URL.Path
		}
		method := r.Method
		if len(method) > 10 {
			method = "other"
		}
		logger.Info("request", "method", method, "route", route, "status", recorder.status,
			"ms", time.Since(start).Milliseconds())
	})
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
