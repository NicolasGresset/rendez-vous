//go:build integration

package main

// Against a real MOTIS (not in CI): how long the method takes. Needs MOTIS (MOTIS_URL, default
// http://localhost:8080, with onetomany_max_many: 4000):
//
//	go test -tags integration -run Integration -v ./...

import (
	"context"
	"os"
	"testing"
	"time"
)

// Each place type on three groups, walk + transit.
func TestIntegrationZonesTiming(t *testing.T) {
	base := os.Getenv("MOTIS_URL")
	if base == "" {
		base = "http://localhost:8080"
	}
	data, err := loadData(repoPlacesFile)
	if err != nil {
		t.Fatal(err)
	}
	day := time.Now().In(toulouse)
	for day.Weekday() != time.Tuesday || !day.After(time.Now()) {
		day = day.AddDate(0, 0, 1)
	}
	meeting := time.Date(day.Year(), day.Month(), day.Day(), 19, 0, 0, 0, toulouse)
	groups := [][]Point{
		{{43.60331, 1.43941}, {43.6005, 1.4760}, {43.59499, 1.43368}},
		{{43.60926, 1.33455}, {43.65693, 1.48431}, {43.54564, 1.47511}},
		{{43.66843, 1.42896}, {43.58264, 1.34517}, {43.51703, 1.498}, {43.58534, 1.53031}},
	}
	client := NewMotisClient(base, 6)
	for _, kind := range []PlaceType{"station", "bar", "cafe", "restaurant"} {
		for g, points := range groups {
			q := Question{MeetingTime: meeting, PlaceType: kind}
			for _, p := range points {
				q.Participants = append(q.Participants, Participant{Lat: p.Lat, Lon: p.Lon, Modes: []Mode{ModeWalk, ModeTransit}, People: 1})
			}
			start := time.Now()
			result, err := propose(context.Background(), q, data, client)
			if err != nil {
				t.Fatal(err)
			}
			t.Logf("%-10s group %d: %4d estimated, %3d exact, %4d journeys, %d zones, %v", kind, g, result.Estimated,
				result.Exact, result.Journeys, len(result.Zones), time.Since(start).Round(10*time.Millisecond))
		}
	}
}
