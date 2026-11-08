package main

import (
	"bytes"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// now of the tests: Monday 2026-11-09, 18:30 in Toulouse
var testNow = time.Date(2026, 11, 9, 18, 30, 0, 0, toulouse)

// validBody is a correct request; each case below changes one thing in it.
const validBody = `{
	"meetingTime": "2026-11-09T19:00",
	"placeType": "bar",
	"participants": [
		{"lat": 43.6045, "lon": 1.4442, "modes": ["walk", "transit"], "people": 1},
		{"lat": 43.5557, "lon": 1.4746, "modes": ["bike"], "people": 2}
	]
}`

// ask sends a body to readQuestion as the page would, and returns the question or the refusal.
func ask(t *testing.T, contentType, body string) (Question, *requestError) {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/v1/proposals", strings.NewReader(body))
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	return readQuestion(httptest.NewRecorder(), req, testNow)
}

func TestValidRequest(t *testing.T) {
	q, refusal := ask(t, "application/json", validBody)
	if refusal != nil {
		t.Fatalf("refused: %s", refusal.code)
	}
	if want := time.Date(2026, 11, 9, 19, 0, 0, 0, toulouse); !q.MeetingTime.Equal(want) {
		t.Errorf("meeting time %v", q.MeetingTime)
	}
	if q.PlaceType != "bar" || len(q.Participants) != 2 {
		t.Fatalf("question %+v", q)
	}
	p := q.Participants[0]
	if p.Lat != 43.6045 || p.Lon != 1.4442 || p.People != 1 || len(p.Modes) != 2 || p.Modes[1] != ModeTransit {
		t.Errorf("participant %+v", p)
	}
}

// Each case replaces one fragment of validBody and expects a refusal: its code, and the participant concerned (-1: none).
func TestRefusals(t *testing.T) {
	cases := []struct {
		name, from, to, code string
		participant          int
	}{
		{"time missing", `"meetingTime": "2026-11-09T19:00",`, ``, "invalid_time", -1},
		{"time with a space", `2026-11-09T19:00`, `2026-11-09 19:00`, "invalid_time", -1},
		{"time without zero", `2026-11-09T19:00`, `2026-11-9T19:00`, "invalid_time", -1},
		{"time with seconds", `2026-11-09T19:00`, `2026-11-09T19:00:00`, "invalid_time", -1},
		{"time with a zone", `2026-11-09T19:00`, `2026-11-09T19:00Z`, "invalid_time", -1},
		{"time not a quarter", `2026-11-09T19:00`, `2026-11-09T19:10`, "invalid_time", -1},
		{"time skipped in spring", `2026-11-09T19:00`, `2026-03-29T02:30`, "invalid_time", -1},
		{"time as a number", `"2026-11-09T19:00"`, `1900`, "invalid_json", -1},
		{"time long past", `2026-11-09T19:00`, `2026-11-09T18:00`, "time_out_of_range", -1},
		{"time too far", `2026-11-09T19:00`, `2026-12-10T19:00`, "time_out_of_range", -1},
		{"place type missing", `"placeType": "bar",`, ``, "invalid_place_type", -1},
		{"place type unknown", `"bar"`, `"pub"`, "invalid_place_type", -1},
		{"one participant", `,
		{"lat": 43.5557, "lon": 1.4746, "modes": ["bike"], "people": 2}`, ``, "invalid_participants", -1},
		{"latitude missing", `"lat": 43.5557, `, ``, "invalid_position", 1},
		{"latitude as text", `43.5557`, `"43.5557"`, "invalid_json", -1},
		{"outside the area", `"lat": 43.5557`, `"lat": 48.8566`, "outside_area", 1},
		{"no mode", `["bike"]`, `[]`, "invalid_modes", 1},
		{"modes missing", `"modes": ["bike"], `, ``, "invalid_modes", 1},
		{"unknown mode", `["bike"]`, `["plane"]`, "invalid_modes", 1},
		{"mode twice", `["bike"]`, `["bike", "bike"]`, "invalid_modes", 1},
		{"no people", `"people": 2`, `"people": 0`, "invalid_people", 1},
		{"too many people", `"people": 2`, `"people": 16`, "invalid_people", 1},
		{"half a person", `"people": 2`, `"people": 1.5`, "invalid_json", -1},
		{"people missing", `, "people": 2`, ``, "invalid_people", 1},
		{"unknown field", `"placeType": "bar",`, `"placeType": "bar", "score": "equitable",`, "invalid_json", -1},
		{"unknown participant field", `"people": 2`, `"people": 2, "name": "Bob"`, "invalid_json", -1},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if !strings.Contains(validBody, c.from) {
				t.Fatalf("fragment %q not in validBody", c.from)
			}
			_, refusal := ask(t, "application/json", strings.Replace(validBody, c.from, c.to, 1))
			if refusal == nil {
				t.Fatalf("accepted, want %s", c.code)
			}
			if refusal.code != c.code {
				t.Errorf("code %s, want %s", refusal.code, c.code)
			}
			got := -1
			if refusal.participant != nil {
				got = *refusal.participant
			}
			if got != c.participant {
				t.Errorf("participant %d, want %d", got, c.participant)
			}
		})
	}
}

func TestQuarterAlreadyBegunIsAccepted(t *testing.T) {
	// At 18:30, the page still offers 18:15 (its first slot is the quarter before the current time)
	if _, refusal := ask(t, "application/json", strings.Replace(validBody, "19:00", "18:15", 1)); refusal != nil {
		t.Errorf("refused: %s", refusal.code)
	}
}

func TestNullParticipantsAreRefused(t *testing.T) {
	body := `{"meetingTime": "2026-11-09T19:00", "placeType": "bar", "participants": null}`
	if _, refusal := ask(t, "application/json", body); refusal == nil || refusal.code != "invalid_participants" {
		t.Errorf("refusal %v", refusal)
	}
}

func TestEleventhParticipantIsRefused(t *testing.T) {
	one := `{"lat": 43.6, "lon": 1.44, "modes": ["walk"], "people": 1}`
	body := `{"meetingTime": "2026-11-09T19:00", "placeType": "bar", "participants": [` +
		strings.Repeat(one+",", 10) + one + `]}`
	if _, refusal := ask(t, "application/json", body); refusal == nil || refusal.code != "invalid_participants" {
		t.Errorf("refusal %v", refusal)
	}
}

func TestBodyRules(t *testing.T) {
	cases := []struct {
		name, contentType, body, code string
		status                        int
	}{
		{"no content type", "", validBody, "unsupported_media_type", http.StatusUnsupportedMediaType},
		{"text body", "text/plain", validBody, "unsupported_media_type", http.StatusUnsupportedMediaType},
		{"json with charset", "application/json; charset=utf-8", validBody, "", 0},
		{"not json", "application/json", "meetingTime=19:00", "invalid_json", http.StatusBadRequest},
		{"two values", "application/json", validBody + validBody, "invalid_json", http.StatusBadRequest},
		{"too large", "application/json", `{"placeType": "` + strings.Repeat("a", maxBodyBytes) + `"}`,
			"body_too_large", http.StatusRequestEntityTooLarge},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, refusal := ask(t, c.contentType, c.body)
			if c.code == "" {
				if refusal != nil {
					t.Errorf("refused: %s", refusal.code)
				}
				return
			}
			if refusal == nil || refusal.code != c.code || refusal.status != c.status {
				t.Errorf("refusal %+v, want %s %d", refusal, c.code, c.status)
			}
		})
	}
}

func TestProposalsRouteRefusesBadQuestions(t *testing.T) {
	post := func(body string) *http.Response {
		req := httptest.NewRequest(http.MethodPost, "/v1/proposals", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		newHandler(parseOrigins(siteOrigin), slog.New(slog.NewTextHandler(&bytes.Buffer{}, nil)), nil).ServeHTTP(rec, req)
		return rec.Result()
	}
	// A meeting time in the near future, whatever the day the test runs
	soon := time.Now().In(toulouse).Add(time.Hour).Truncate(15 * time.Minute)
	valid := strings.Replace(validBody, "2026-11-09T19:00", soon.Format(timeLayout), 1)
	res := post(strings.Replace(valid, `"people": 2`, `"people": 99`, 1))
	if got := body(t, res); res.StatusCode != http.StatusBadRequest || got != `{"error":"invalid_people","participant":1}` {
		t.Errorf("status %d, body %s", res.StatusCode, got)
	}
	if res := serve(t, http.MethodGet, "/v1/proposals", nil); res.StatusCode != http.StatusMethodNotAllowed {
		t.Errorf("GET: status %d", res.StatusCode)
	}
}

func TestSuccessfulHealthIsNotLogged(t *testing.T) {
	var logs bytes.Buffer
	handler := newHandler(parseOrigins(siteOrigin), slog.New(slog.NewTextHandler(&logs, nil)), nil)
	handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/v1/health", nil))
	if logs.Len() != 0 {
		t.Errorf("logged: %s", logs.String())
	}
	refused := httptest.NewRequest(http.MethodGet, "/v1/health", nil)
	refused.Header.Set("Origin", "https://evil.example")
	handler.ServeHTTP(httptest.NewRecorder(), refused)
	if !strings.Contains(logs.String(), "status=403") {
		t.Errorf("refused health check not logged: %q", logs.String())
	}
}
