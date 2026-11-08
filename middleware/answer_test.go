package main

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// askProposals posts a question for three participants, soon, to a handler on this MOTIS.
func askProposals(t *testing.T, motis *MotisClient, deadline time.Duration, kind string, modes string) *http.Response {
	t.Helper()
	data, err := loadData(repoPlacesFile)
	if err != nil {
		t.Fatal(err)
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	handler := newHandler(parseOrigins(siteOrigin), logger, &service{data: data, motis: motis, deadline: deadline, logger: logger})
	soon := time.Now().In(toulouse).Add(time.Hour).Truncate(15 * time.Minute).Format(timeLayout)
	body := `{"meetingTime": "` + soon + `", "placeType": "` + kind + `", "participants": [
		{"lat": 43.60331, "lon": 1.43941, "modes": ` + modes + `, "people": 1},
		{"lat": 43.6005, "lon": 1.4760, "modes": ` + modes + `, "people": 2},
		{"lat": 43.59499, "lon": 1.43368, "modes": ` + modes + `, "people": 1}]}`
	req := httptest.NewRequest(http.MethodPost, "/v1/proposals", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec.Result()
}

func TestTheAnswer(t *testing.T) {
	res := askProposals(t, distanceMotis(t), computationDeadline, "bar", `["walk", "transit"]`)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status %d: %s", res.StatusCode, body(t, res))
	}
	var answer Answer
	if err := json.NewDecoder(res.Body).Decode(&answer); err != nil {
		t.Fatal(err)
	}
	if len(answer.Proposals) != proposalCount || len(answer.Zones) != proposalCount || answer.Data.SHA256 == "" {
		t.Fatalf("%d proposals, %d zones, data %+v", len(answer.Proposals), len(answer.Zones), answer.Data)
	}
	for z, zone := range answer.Zones {
		if len(zone.Places) == 0 || zone.Places[0] != answer.Proposals[z] || zone.Kind != "bar" {
			t.Errorf("zone %d: places %v, proposal %d", z, zone.Places, answer.Proposals[z])
		}
		for _, j := range zone.Places {
			if p := answer.Places[j]; p.Zone == nil || *p.Zone != z {
				t.Errorf("place %d is not in zone %d", j, z)
			}
		}
	}
	for j, p := range answer.Places {
		if len(p.Trips) != 3 {
			t.Fatalf("place %d: %d trips", j, len(p.Trips))
		}
		for i, trip := range p.Trips {
			if len(trip.Legs) == 0 || trip.Travel > trip.Seconds {
				t.Errorf("place %d, participant %d: %+v", j, i, trip)
			}
			if trip.Mode == ModeTransit && (trip.Departure == nil || trip.Arrival == nil) {
				t.Errorf("place %d, participant %d: transit without its times", j, i)
			}
			if trip.Mode == ModeWalk && (trip.Departure != nil || trip.Legs[0].Path == nil || trip.Legs[0].Mode != "WALK") {
				t.Errorf("place %d, participant %d: walk without its path: %+v", j, i, trip)
			}
		}
	}
}

func TestStationsHaveNoZone(t *testing.T) {
	res := askProposals(t, distanceMotis(t), computationDeadline, "station", `["bike"]`)
	var answer Answer
	if err := json.NewDecoder(res.Body).Decode(&answer); err != nil || res.StatusCode != http.StatusOK {
		t.Fatalf("status %d, %v", res.StatusCode, err)
	}
	if len(answer.Zones) != 0 || len(answer.Proposals) != proposalCount {
		t.Fatalf("%d zones, %d proposals", len(answer.Zones), len(answer.Proposals))
	}
	for _, p := range answer.Places {
		if p.Zone != nil || p.Trips[0].Mode != ModeBike || len(p.Trips[0].Legs) == 0 || p.Trips[0].Legs[0].Mode != "BIKE" {
			t.Errorf("station %+v", p)
		}
	}
}

func TestMotisDownIsA503(t *testing.T) {
	down := fakeMotis(t, 6, func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "down", http.StatusServiceUnavailable)
	})
	res := askProposals(t, down, computationDeadline, "bar", `["walk"]`)
	if got := body(t, res); res.StatusCode != http.StatusServiceUnavailable || got != `{"error":"engine_unavailable"}` {
		t.Errorf("status %d, %s", res.StatusCode, got)
	}
}

func TestTooLongIsA504(t *testing.T) {
	slow := fakeMotis(t, 6, func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-time.After(time.Second):
		case <-r.Context().Done():
		}
	})
	start := time.Now()
	res := askProposals(t, slow, 200*time.Millisecond, "bar", `["walk"]`)
	if got := body(t, res); res.StatusCode != http.StatusGatewayTimeout || got != `{"error":"timeout"}` {
		t.Errorf("status %d, %s", res.StatusCode, got)
	}
	if time.Since(start) > 2*time.Second {
		t.Errorf("answered after %v: the calls did not stop at the deadline", time.Since(start))
	}
}
