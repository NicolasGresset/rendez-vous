//go:build integration

package main

// Against a real MOTIS (not in CI): the Go client must choose the same transit trips as the page's
// js/transitous.js transitTrip, asked the same questions. Needs MOTIS (MOTIS_URL, default http://localhost:8080)
// and Node.js:
//
//	go test -tags integration -run Integration ./...

import (
	"context"
	"encoding/json"
	"math"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

// The page's transitTrip on the same pairs: one JSON line per pair, null when no trip
const pageTrips = `
import { transitTrip } from '../js/transitous.js';
const { url, pairs, from, to } = JSON.parse(process.argv[2]);
for (const [a, b] of pairs) {
    const trip = await transitTrip(a, b, from, to, url + '/api/v6/plan');
    console.log(JSON.stringify(trip && { seconds: trip.seconds, wait: trip.wait, departure: trip.departure, arrival: trip.arrival }));
}
`

func TestIntegrationTransitTripsAsThePage(t *testing.T) {
	base := os.Getenv("MOTIS_URL")
	if base == "" {
		base = "http://localhost:8080"
	}
	data, err := loadData(repoPlacesFile)
	if err != nil {
		t.Fatal(err)
	}
	// Starts spread over the area, and every 40th bar, café or restaurant zone's representative
	starts := []Point{{43.6045, 1.4442}, {43.5557, 1.4746}, {43.6301, 1.3757}, {43.5679, 1.4021}, {43.6481, 1.4693}}
	var places []Point
	for i := 0; i < len(data.Zones); i += 40 {
		p := data.Places[data.Zones[i].Representative]
		places = append(places, Point{p.Lat, p.Lon})
	}
	// Next Tuesday at 19:00, Toulouse time
	day := time.Now().In(toulouse)
	for day.Weekday() != time.Tuesday || !day.After(time.Now()) {
		day = day.AddDate(0, 0, 1)
	}
	slotStart := time.Date(day.Year(), day.Month(), day.Day(), 19, 0, 0, 0, toulouse)
	slotEnd := slotStart.Add(10 * time.Minute)

	type pt struct {
		Lat float64 `json:"lat"`
		Lon float64 `json:"lon"`
	}
	var pairs [][2]pt
	for _, s := range starts {
		for _, p := range places {
			pairs = append(pairs, [2]pt{{s.Lat, s.Lon}, {p.Lat, p.Lon}})
		}
	}
	input, _ := json.Marshal(map[string]any{"url": base, "pairs": pairs,
		"from": slotStart.Format("2006-01-02 15:04"), "to": slotEnd.Format("2006-01-02 15:04")})
	// Written in the module's directory, since it imports ../js/ relative to itself
	script := "page-trips.mjs"
	if err := os.WriteFile(script, []byte(pageTrips), 0o600); err != nil {
		t.Fatal(err)
	}
	defer os.Remove(script)
	out, err := exec.Command("node", script, string(input)).Output()
	if err != nil {
		t.Fatalf("node: %v", err)
	}
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	if len(lines) != len(pairs) {
		t.Fatalf("%d answers for %d pairs", len(lines), len(pairs))
	}

	client := NewMotisClient(base, 6)
	same, none := 0, 0
	for i, pair := range pairs {
		var page *struct {
			Seconds   float64   `json:"seconds"`
			Wait      float64   `json:"wait"`
			Departure time.Time `json:"departure"`
		}
		if err := json.Unmarshal([]byte(lines[i]), &page); err != nil {
			t.Fatal(err)
		}
		trip, err := client.TransitTrip(context.Background(), Point{pair[0].Lat, pair[0].Lon}, Point{pair[1].Lat, pair[1].Lon},
			slotStart, slotEnd)
		if err != nil {
			t.Fatal(err)
		}
		switch {
		case page == nil && trip == nil:
			none++
		case page == nil || trip == nil:
			t.Errorf("pair %d: page %v, middleware %v", i, page, trip)
		case math.Abs(page.Seconds-trip.Seconds) > 0 || page.Wait != trip.Wait || !page.Departure.Equal(trip.Departure):
			t.Errorf("pair %d: page %+v, middleware %.0f s, wait %.0f, leaving %s", i, *page, trip.Seconds, trip.Wait, trip.Departure)
		default:
			same++
		}
	}
	t.Logf("%d pairs: %d identical trips, %d without trip on both sides", len(pairs), same, none)
}
