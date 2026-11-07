package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"
)

// A fake MOTIS whose times grow with the distance as the crow flies: walking at 1.2 m/s, transit at 5 m/s plus
// 5 min, the exact trip arriving at the meeting time. Enough for the method's rules, not for its results.
func distanceMotis(t *testing.T) *MotisClient {
	parse := func(s, sep string) Point {
		parts := strings.Split(s, sep)
		lat, _ := strconv.ParseFloat(parts[0], 64)
		lon, _ := strconv.ParseFloat(parts[1], 64)
		return Point{lat, lon}
	}
	far := func(a, b Point) float64 { return haversine(a.Lat, a.Lon, b.Lat, b.Lon) }
	return fakeMotis(t, 6, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/one-to-many":
			var q struct {
				One  string   `json:"one"`
				Many []string `json:"many"`
			}
			_ = json.NewDecoder(r.Body).Decode(&q)
			var out []map[string]float64
			for _, m := range q.Many {
				out = append(out, map[string]float64{"duration": far(parse(q.One, ";"), parse(m, ";")) / 1.2})
			}
			_ = json.NewEncoder(w).Encode(out)
		case "/api/experimental/one-to-many-intermodal":
			var q struct {
				One  string   `json:"one"`
				Many []string `json:"many"`
			}
			_ = json.NewDecoder(r.Body).Decode(&q)
			var out [][]map[string]float64
			for _, m := range q.Many {
				out = append(out, []map[string]float64{{"duration": far(parse(q.One, ","), parse(m, ","))/5 + 600}})
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"transit_durations": out})
		case "/api/v6/plan":
			query, _ := url.ParseQuery(r.URL.RawQuery)
			seconds := far(parse(query.Get("fromPlace"), ","), parse(query.Get("toPlace"), ","))/5 + 300
			end, _ := time.Parse(time.RFC3339, query.Get("time"))
			end = end.Add(-lateTolerance)
			start := end.Add(-time.Duration(seconds) * time.Second).Format(time.RFC3339)
			fmt.Fprintf(w, `{"itineraries": [{"startTime": %q, "endTime": %q, "legs": [{"mode": "BUS", "startTime": %q, "endTime": %q}]}]}`,
				start, end.Format(time.RFC3339), start, end.Format(time.RFC3339))
		default:
			t.Errorf("unexpected call %s", r.URL.Path)
		}
	})
}

func question(kind PlaceType, modes ...Mode) Question {
	q := Question{MeetingTime: time.Date(2026, 11, 10, 19, 0, 0, 0, toulouse), PlaceType: kind}
	for _, p := range []Point{{43.60331, 1.43941}, {43.6005, 1.4760}, {43.59499, 1.43368}} {
		q.Participants = append(q.Participants, Participant{Lat: p.Lat, Lon: p.Lon, Modes: modes, People: 1})
	}
	return q
}

func TestZonesFollowTheMethodsRules(t *testing.T) {
	data, err := loadData(repoPlacesFile)
	if err != nil {
		t.Fatal(err)
	}
	for _, kind := range []PlaceType{"bar", "cafe", "restaurant"} {
		result, err := propose(context.Background(), question(kind, ModeWalk, ModeTransit), data, distanceMotis(t))
		if err != nil {
			t.Fatal(err)
		}
		if len(result.Zones) != proposalCount || result.Exact < zoneShortlist || result.Estimated != countZones(data, kind) {
			t.Fatalf("%s: %d zones, %d exact, %d estimated", kind, len(result.Zones), result.Exact, result.Estimated)
		}
		for z, zr := range result.Zones {
			zone := data.Zones[zr.Zone]
			if zone.Kind != kind || len(zr.Places) == 0 || len(zr.Places) > zoneExactPlaces {
				t.Fatalf("%s zone %d: kind %s, %d places", kind, z, zone.Kind, len(zr.Places))
			}
			if want := min(zoneExactPlaces, len(zone.Members)); len(zr.Places) != want || len(zr.Places)+len(zr.Unscored) != len(zone.Members) {
				t.Errorf("%s zone %d: %d scored, %d unscored, %d members", kind, z, len(zr.Places), len(zr.Unscored), len(zone.Members))
			}
			for k := 1; k < len(zr.Places); k++ {
				if zr.Places[k].Score < zr.Places[k-1].Score {
					t.Errorf("%s zone %d: places not best first", kind, z)
				}
			}
			if z > 0 && zr.Places[0].Score < result.Zones[z-1].Places[0].Score {
				t.Errorf("%s: zones not best first", kind)
			}
			for _, other := range result.Zones[:z] {
				a, b := data.Places[zone.Representative], data.Places[data.Zones[other.Zone].Representative]
				if haversine(a.Lat, a.Lon, b.Lat, b.Lon) < zoneSpacingM {
					t.Errorf("%s: two zones kept closer than %d m", kind, zoneSpacingM)
				}
			}
			for _, p := range zr.Places {
				if !p.Reachable || p.Trips[0] == nil || p.Choices[0].Mode != ModeTransit && p.Choices[0].Mode != ModeWalk {
					t.Errorf("%s: place %d without an exact trip", kind, p.Place)
				}
			}
		}
	}
}

func countZones(data *Data, kind PlaceType) int {
	n := 0
	for _, z := range data.Zones {
		if z.Kind == kind {
			n++
		}
	}
	return n
}

func TestStationsAreZonesOfTheirOwn(t *testing.T) {
	data, err := loadData(repoPlacesFile)
	if err != nil {
		t.Fatal(err)
	}
	result, err := propose(context.Background(), question("station", ModeWalk, ModeBike), data, distanceMotis(t))
	if err != nil {
		t.Fatal(err)
	}
	if result.Estimated != len(data.ByType["station"]) || len(result.Zones) != proposalCount || result.Journeys != 0 {
		t.Fatalf("%d estimated, %d zones, %d journeys (no transit participant)", result.Estimated, len(result.Zones), result.Journeys)
	}
	for _, zr := range result.Zones {
		if zr.Zone != -1 || len(zr.Places) != 1 || len(zr.Unscored) != 0 || data.Places[zr.Places[0].Place].Zone != -1 {
			t.Errorf("station zone %+v", zr)
		}
		for i, choice := range zr.Places[0].Choices {
			if choice.Mode == ModeTransit || zr.Places[0].Trips[i] != nil {
				t.Errorf("participant %d travels by transit, a mode they did not choose", i)
			}
		}
	}
}

func TestFarthestFirst(t *testing.T) {
	// On a line, from the representative at 0: 300 m first, then 0 is covered and 100 m is 100 m from both, 200 m
	// 100 m from 300 m: the first of the ties, 100 m
	data := &Data{}
	for _, metres := range []float64{0, 100, 200, 300} {
		data.Places = append(data.Places, Place{Lat: 43.6, Lon: 1.44 + metres/80600})
	}
	c := &computation{data: data}
	if got := c.farthestFirst(0, []int{1, 2, 3}, 2); len(got) != 2 || got[0] != 3 || got[1] != 1 {
		t.Errorf("picked %v, want [3 1]", got)
	}
	if got := c.farthestFirst(0, []int{1, 2, 3}, 5); len(got) != 3 {
		t.Errorf("more asked than there are: %v", got)
	}
}

func TestAFailureOfMotisFailsTheComputation(t *testing.T) {
	data, err := loadData(repoPlacesFile)
	if err != nil {
		t.Fatal(err)
	}
	broken := fakeMotis(t, 6, func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "down", http.StatusServiceUnavailable)
	})
	if _, err := propose(context.Background(), question("bar", ModeWalk), data, broken); !errors.Is(err, errMotis) {
		t.Errorf("err %v", err)
	}
}
