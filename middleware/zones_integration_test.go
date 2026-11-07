//go:build integration

package main

// Against a real MOTIS (not in CI): the method by zones must propose what the page's js/debug-motis.js scoreZones
// proposes, on the evaluation's groups (scripts/eval/cases.js), for bars, cafés and restaurants. Needs MOTIS
// (MOTIS_URL, default http://localhost:8080, with onetomany_max_many: 4000) and Node.js:
//
//	go test -tags integration -run Integration -timeout 30m ./...

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"os/exec"
	"testing"
	"time"
)

// The page's scoreZones on one question: its zones (index, places best first with their scores, unscored count)
const pageZones = `
import fs from 'node:fs';
import { scoreZones } from '../js/debug-motis.js';
const { url, participants, kind, from, to } = JSON.parse(process.argv[2]);
const realFetch = globalThis.fetch;
globalThis.fetch = (resource, options) => realFetch(String(resource).replace(/^\/motis/, url), options);
const data = JSON.parse(fs.readFileSync('../data/pois-toulouse.json', 'utf8'));
const result = await scoreZones(participants, [kind], { from, to }, data, 'half', () => {});
console.log(JSON.stringify(result.zones.map(z => ({
    zone: z.places[0].zone, places: z.places.map(p => ({ id: p.id, score: p.score })), unscored: z.unscored.length }))));
`

type pageZone struct {
	Zone   int `json:"zone"`
	Places []struct {
		ID    string  `json:"id"`
		Score float64 `json:"score"`
	} `json:"places"`
	Unscored int `json:"unscored"`
}

func TestIntegrationZonesAsThePage(t *testing.T) {
	base := os.Getenv("MOTIS_URL")
	if base == "" {
		base = "http://localhost:8080"
	}
	data, err := loadData(repoPlacesFile)
	if err != nil {
		t.Fatal(err)
	}
	script := "page-zones.mjs" // in the module's directory, since it imports ../js/ relative to itself
	if err := os.WriteFile(script, []byte(pageZones), 0o600); err != nil {
		t.Fatal(err)
	}
	defer os.Remove(script)

	// The evaluation's groups (scripts/eval/cases.js), next Tuesday at 19:00 (the cases' date is past)
	type point struct {
		lat, lon float64
		people   int
	}
	cases := map[string][]point{
		"T1": {{43.60331, 1.43941, 1}, {43.6005, 1.4760, 1}, {43.59499, 1.43368, 1}},
		"T2": {{43.60926, 1.33455, 1}, {43.65693, 1.48431, 1}, {43.54564, 1.47511, 1}},
		"T3": {{43.61782, 1.43535, 1}, {43.6309, 1.46351, 1}, {43.52053, 1.40018, 1}},
		"T4": {{43.5568, 1.38024, 1}, {43.60331, 1.43941, 1}, {43.60545, 1.50217, 1}},
		"T5": {{43.58264, 1.34517, 1}, {43.53709, 1.34369, 1}, {43.49879, 1.31096, 1}},
		"Q1": {{43.61782, 1.43535, 1}, {43.58734, 1.461, 1}, {43.60331, 1.43941, 1}, {43.6005, 1.4760, 1}},
		"Q2": {{43.60331, 1.43941, 1}, {43.62533, 1.45899, 1}, {43.59499, 1.43368, 1}, {43.51703, 1.498, 1}},
		"Q3": {{43.66843, 1.42896, 1}, {43.58264, 1.34517, 1}, {43.51703, 1.498, 1}, {43.58534, 1.53031, 1}},
		"Q4": {{43.61715, 1.40914, 3}, {43.58734, 1.461, 1}, {43.58965, 1.37886, 1}, {43.6309, 1.46351, 1}},
		"Q5": {{43.63519, 1.39656, 1}, {43.60926, 1.33455, 1}, {43.67392, 1.45583, 1}, {43.52053, 1.40018, 1}},
	}
	configs := map[string]func(i int) []Mode{
		"transit": func(int) []Mode { return []Mode{ModeWalk, ModeTransit} },
		"mixed": func(i int) []Mode {
			switch i {
			case 0:
				return []Mode{ModeCar}
			case 1:
				return []Mode{ModeBike}
			}
			return []Mode{ModeWalk, ModeTransit}
		},
		"soft": func(int) []Mode { return []Mode{ModeWalk, ModeBike} },
	}
	day := time.Now().In(toulouse)
	for day.Weekday() != time.Tuesday || !day.After(time.Now()) {
		day = day.AddDate(0, 0, 1)
	}
	meeting := time.Date(day.Year(), day.Month(), day.Day(), 19, 0, 0, 0, toulouse)

	client := NewMotisClient(base, 6)
	runs, identical := 0, 0
	for _, kind := range []PlaceType{"bar", "cafe", "restaurant"} {
		for id, points := range cases {
			for config, modes := range configs {
				name := fmt.Sprintf("%s/%s/%s", kind, id, config)
				q := Question{MeetingTime: meeting, PlaceType: kind}
				type jsParticipant struct {
					Lat    float64  `json:"lat"`
					Lon    float64  `json:"lon"`
					Modes  []string `json:"modes"`
					People int      `json:"people"`
				}
				var js []jsParticipant
				for i, p := range points {
					q.Participants = append(q.Participants, Participant{Lat: p.lat, Lon: p.lon, Modes: modes(i), People: p.people})
					var names []string
					for _, m := range modes(i) {
						names = append(names, string(m))
					}
					js = append(js, jsParticipant{p.lat, p.lon, names, p.people})
				}
				input, _ := json.Marshal(map[string]any{"url": base, "participants": js, "kind": kind,
					"from": meeting.Format("2006-01-02 15:04"), "to": meeting.Add(lateTolerance).Format("2006-01-02 15:04")})
				out, err := exec.Command("node", script, string(input)).Output()
				if err != nil {
					t.Fatalf("%s: node: %v", name, err)
				}
				var page []pageZone
				if err := json.Unmarshal(out, &page); err != nil {
					t.Fatalf("%s: %v", name, err)
				}
				result, err := propose(context.Background(), q, data, client)
				if err != nil {
					t.Fatalf("%s: %v", name, err)
				}
				runs++
				if diff := compareZones(data, page, result); diff != "" {
					t.Errorf("%s: %s", name, diff)
				} else {
					identical++
				}
			}
		}
	}
	t.Logf("%d questions: %d identical proposals", runs, identical)
}

// compareZones returns how the middleware's zones differ from the page's, or "".
func compareZones(data *Data, page []pageZone, result *Result) string {
	if len(page) != len(result.Zones) {
		return fmt.Sprintf("%d zones, page %d", len(result.Zones), len(page))
	}
	for z, pz := range page {
		mz := result.Zones[z]
		if mz.Zone != pz.Zone {
			return fmt.Sprintf("zone %d: %d, page %d", z, mz.Zone, pz.Zone)
		}
		if len(mz.Places) != len(pz.Places) || len(mz.Unscored) != pz.Unscored {
			return fmt.Sprintf("zone %d: %d places and %d unscored, page %d and %d", z, len(mz.Places), len(mz.Unscored),
				len(pz.Places), pz.Unscored)
		}
		for k, pp := range pz.Places {
			if id := data.Places[mz.Places[k].Place].ID; id != pp.ID || math.Abs(mz.Places[k].Score-pp.Score) > 1e-6 {
				return fmt.Sprintf("zone %d, place %d: %s %.1f, page %s %.1f", z, k, id, mz.Places[k].Score, pp.ID, pp.Score)
			}
		}
	}
	return ""
}

// How long the method takes, without the page: each place type on every group of the transit configuration.
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
