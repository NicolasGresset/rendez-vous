package main

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const siteOrigin = "https://rendez-vous.gresset-bourgeois.fr"

// serve sends one request through the whole handler chain and returns the answer.
func serve(t *testing.T, method, path string, headers map[string]string) *http.Response {
	t.Helper()
	handler := newHandler(parseOrigins(siteOrigin), slog.New(slog.NewTextHandler(io.Discard, nil)))
	req := httptest.NewRequest(method, path, nil)
	for name, value := range headers {
		req.Header.Set(name, value)
	}
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec.Result()
}

func body(t *testing.T, res *http.Response) string {
	t.Helper()
	b, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	return strings.TrimSpace(string(b))
}

func TestHealth(t *testing.T) {
	res := serve(t, http.MethodGet, "/v1/health", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status %d, want 200", res.StatusCode)
	}
	if got := body(t, res); got != `{"status":"ok"}` {
		t.Errorf("body %s", got)
	}
	if got := res.Header.Get("Content-Type"); got != "application/json" {
		t.Errorf("Content-Type %q", got)
	}
}

func TestHealthRefusesPost(t *testing.T) {
	res := serve(t, http.MethodPost, "/v1/health", nil)
	if res.StatusCode != http.StatusMethodNotAllowed || body(t, res) != `{"error":"method_not_allowed"}` {
		t.Errorf("status %d", res.StatusCode)
	}
}

func TestUnknownPathIsAFixedError(t *testing.T) {
	res := serve(t, http.MethodGet, "/v1/<script>", nil)
	if res.StatusCode != http.StatusNotFound || body(t, res) != `{"error":"not_found"}` {
		t.Errorf("status %d", res.StatusCode)
	}
}

func TestAllowedOriginCanRead(t *testing.T) {
	res := serve(t, http.MethodGet, "/v1/health", map[string]string{"Origin": siteOrigin})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status %d", res.StatusCode)
	}
	if got := res.Header.Get("Access-Control-Allow-Origin"); got != siteOrigin {
		t.Errorf("Access-Control-Allow-Origin %q", got)
	}
}

func TestPreflightOfAllowedOrigin(t *testing.T) {
	res := serve(t, http.MethodOptions, "/v1/proposals", map[string]string{
		"Origin":                         siteOrigin,
		"Access-Control-Request-Method":  "POST",
		"Access-Control-Request-Headers": "content-type",
	})
	if res.StatusCode != http.StatusNoContent {
		t.Fatalf("status %d, want 204", res.StatusCode)
	}
	for name, want := range map[string]string{
		"Access-Control-Allow-Origin":  siteOrigin,
		"Access-Control-Allow-Methods": "GET, POST",
		"Access-Control-Allow-Headers": "Content-Type",
		"Access-Control-Max-Age":       corsMaxAge,
	} {
		if got := res.Header.Get(name); got != want {
			t.Errorf("%s %q, want %q", name, got, want)
		}
	}
}

func TestOtherOriginIsRefused(t *testing.T) {
	for _, method := range []string{http.MethodGet, http.MethodOptions} {
		res := serve(t, method, "/v1/health", map[string]string{
			"Origin":                        "https://evil.example",
			"Access-Control-Request-Method": "GET",
		})
		if res.StatusCode != http.StatusForbidden || body(t, res) != `{"error":"origin_not_allowed"}` {
			t.Errorf("%s: status %d", method, res.StatusCode)
		}
		if got := res.Header.Get("Access-Control-Allow-Origin"); got != "" {
			t.Errorf("%s: Access-Control-Allow-Origin %q", method, got)
		}
	}
}

func TestParseOrigins(t *testing.T) {
	got := parseOrigins(" https://a.example ,, https://b.example ,")
	if len(got) != 2 || !got["https://a.example"] || !got["https://b.example"] {
		t.Errorf("%v", got)
	}
	if len(parseOrigins("")) != 0 {
		t.Error("an empty value gives origins")
	}
}

func TestHealthcheckExitCode(t *testing.T) {
	ok := httptest.NewServer(http.HandlerFunc(handleHealth))
	defer ok.Close()
	if code := checkHealth(ok.URL); code != 0 {
		t.Errorf("healthy server: exit %d", code)
	}
	failing := httptest.NewServer(http.NotFoundHandler())
	defer failing.Close()
	if code := checkHealth(failing.URL); code != 1 {
		t.Errorf("failing server: exit %d", code)
	}
}
