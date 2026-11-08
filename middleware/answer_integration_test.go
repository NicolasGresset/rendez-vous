//go:build integration

package main

// Against a real MOTIS (not in CI): what an answer weighs, raw and compressed, and what the street paths cost
// (docs/architecture.md § The answer). go test -tags integration -run IntegrationAnswer -v ./...

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"os"
	"testing"
	"time"
)

func TestIntegrationAnswerSizeAndPathCost(t *testing.T) {
	base := os.Getenv("MOTIS_URL")
	if base == "" {
		base = "http://localhost:8080"
	}
	data, err := loadData(repoPlacesFile)
	if err != nil {
		t.Fatal(err)
	}
	client := NewMotisClient(base, motisParallel)
	day := time.Now().In(toulouse)
	for day.Weekday() != time.Tuesday || !day.After(time.Now()) {
		day = day.AddDate(0, 0, 1)
	}
	meeting := time.Date(day.Year(), day.Month(), day.Day(), 19, 0, 0, 0, toulouse)
	groups := map[string][]Point{
		"T1": {{43.60331, 1.43941}, {43.6005, 1.4760}, {43.59499, 1.43368}},
		"Q3": {{43.66843, 1.42896}, {43.58264, 1.34517}, {43.51703, 1.498}, {43.58534, 1.53031}},
	}
	configs := map[string]func(i int) []Mode{
		"transit": func(int) []Mode { return []Mode{ModeWalk, ModeTransit} },
		"mixed": func(i int) []Mode {
			return [][]Mode{{ModeCar}, {ModeBike}, {ModeWalk, ModeTransit}, {ModeWalk, ModeTransit}}[i]
		},
	}
	for _, kind := range []PlaceType{"bar", "restaurant", "station"} {
		for g, points := range groups {
			for name, modes := range configs {
				q := Question{MeetingTime: meeting, PlaceType: kind}
				for i, p := range points {
					q.Participants = append(q.Participants, Participant{Lat: p.Lat, Lon: p.Lon, Modes: modes(i), People: 1})
				}
				start := time.Now()
				result, err := propose(context.Background(), q, data, client)
				if err != nil {
					t.Fatal(err)
				}
				computed := time.Since(start)
				answer, err := buildAnswer(context.Background(), q, data, client, result)
				if err != nil {
					t.Fatal(err)
				}
				paths := time.Since(start) - computed
				calls := 0
				for _, p := range answer.Places {
					for _, trip := range p.Trips {
						if trip.Mode != ModeTransit {
							calls++
						}
					}
				}
				raw, _ := json.Marshal(answer)
				var compressed bytes.Buffer
				zw, _ := gzip.NewWriterLevel(&compressed, gzip.DefaultCompression)
				zw.Write(raw)
				zw.Close()
				t.Logf("%-10s %s %-7s: %2d places, %2d street paths in %4dms (computation %4dms); answer %3d KB, gzip %2d KB",
					kind, g, name, len(answer.Places), calls, paths.Milliseconds(), computed.Milliseconds(),
					len(raw)/1024, compressed.Len()/1024)
			}
		}
	}
}
