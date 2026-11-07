package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// fakeMotis answers every call with handle; the client points at it, without retry delay.
func fakeMotis(t *testing.T, parallel int, handle http.HandlerFunc) *MotisClient {
	t.Helper()
	server := httptest.NewServer(handle)
	t.Cleanup(server.Close)
	client := NewMotisClient(server.URL, parallel)
	client.retryDelay = 0
	return client
}

var (
	capitole   = Point{43.6045, 1.4442}
	ramonville = Point{43.5557, 1.4746}
)

func TestStreetDurationsAsksAsThePage(t *testing.T) {
	var got map[string]any
	client := fakeMotis(t, 1, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/v1/one-to-many" {
			t.Errorf("%s %s", r.Method, r.URL.Path)
		}
		_ = json.NewDecoder(r.Body).Decode(&got)
		io.WriteString(w, `[{"duration": 1260}, {}]`)
	})
	durations, err := client.StreetDurations(context.Background(), ModeBike, capitole, []Point{ramonville, capitole})
	if err != nil {
		t.Fatal(err)
	}
	if durations[0] != 1260 || durations[1] != Unreachable {
		t.Errorf("durations %v", durations)
	}
	// The body of js/motis.js streetDurations
	want := `{"arriveBy":false,"many":["43.5557;1.4746","43.6045;1.4442"],"max":14400,"maxMatchingDistance":250,"mode":"BIKE","one":"43.6045;1.4442"}`
	if b, _ := json.Marshal(got); string(b) != want {
		t.Errorf("body %s\nwant %s", b, want)
	}
}

func TestTransitEstimatesTakeTheShortest(t *testing.T) {
	var got map[string]any
	client := fakeMotis(t, 1, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/experimental/one-to-many-intermodal" {
			t.Errorf("path %s", r.URL.Path)
		}
		_ = json.NewDecoder(r.Body).Decode(&got)
		io.WriteString(w, `{"transit_durations": [[{"duration": 1500}, {"duration": 1320}], []]}`)
	})
	departure := time.Date(2026, 11, 9, 18, 0, 0, 0, toulouse)
	estimates, err := client.TransitEstimates(context.Background(), capitole, []Point{ramonville, capitole}, departure)
	if err != nil {
		t.Fatal(err)
	}
	if estimates[0] != 1320 || estimates[1] != Unreachable {
		t.Errorf("estimates %v", estimates)
	}
	want := `{"arriveBy":false,"many":["43.5557,1.4746","43.6045,1.4442"],"one":"43.6045,1.4442","time":"2026-11-09T17:00:00.000Z"}`
	if b, _ := json.Marshal(got); string(b) != want {
		t.Errorf("body %s\nwant %s", b, want)
	}
}

// The slot of the tests of tests/unit/transitous.test.mjs: 19:00 to 19:10 on 2026-11-03
var (
	slotStart = time.Date(2026, 11, 3, 19, 0, 0, 0, toulouse)
	slotEnd   = slotStart.Add(10 * time.Minute)
)

func at(hhmm string) time.Time {
	t, err := time.ParseInLocation("2006-01-02 15:04", "2026-11-03 "+hhmm, toulouse)
	if err != nil {
		panic(err)
	}
	return t
}

func journey(departure, arrival string) motisItinerary {
	return motisItinerary{StartTime: at(departure), EndTime: at(arrival)}
}

// The cases of the page's bestJourney tests, one by one
func TestBestJourney(t *testing.T) {
	if _, _, _, ok := bestJourney(nil, slotStart, slotEnd); ok {
		t.Error("nothing: found one")
	}
	if _, _, _, ok := bestJourney([]motisItinerary{journey("18:50", "19:11")}, slotStart, slotEnd); ok {
		t.Error("arriving after the window: found")
	}
	if _, seconds, _, ok := bestJourney([]motisItinerary{journey("18:50", "19:10")}, slotStart, slotEnd); !ok || seconds != 20*60 {
		t.Errorf("last minute of the window: %v %v", ok, seconds)
	}
	if _, seconds, wait, _ := bestJourney([]motisItinerary{journey("18:30", "18:50")}, slotStart, slotEnd); wait != 10*60 || seconds != 30*60 {
		t.Errorf("arriving early: seconds %v, wait %v", seconds, wait)
	}
	early, late := journey("18:20", "18:50"), journey("18:45", "19:05") // 40 min with the wait, 20 min
	if best, _, _, _ := bestJourney([]motisItinerary{early, late}, slotStart, slotEnd); !best.StartTime.Equal(late.StartTime) {
		t.Error("the time from leaving to being there decides, not the arrival")
	}
	a, b := journey("18:40", "19:00"), journey("18:45", "19:05")
	if best, _, _, _ := bestJourney([]motisItinerary{a, b}, slotStart, slotEnd); !best.StartTime.Equal(b.StartTime) {
		t.Error("at equal time, the latest departure")
	}
}

// A /plan answer: a walk only (dropped, as the page does today), then a walk and a metro line
const planAnswer = `{"itineraries": [
	{"startTime": "2026-11-03T17:40:00Z", "endTime": "2026-11-03T17:58:00Z",
	 "legs": [{"mode": "WALK", "startTime": "2026-11-03T17:40:00Z", "endTime": "2026-11-03T17:58:00Z"}]},
	{"startTime": "2026-11-03T17:41:00Z", "endTime": "2026-11-03T18:03:00Z", "legs": [
		{"mode": "WALK", "startTime": "2026-11-03T17:41:00Z", "endTime": "2026-11-03T17:45:00Z",
		 "from": {"name": "START"}, "to": {"name": "Capitole"},
		 "legGeometry": {"points": "_p~iF~ps|U_ulLnnqC", "precision": 5}},
		{"mode": "SUBWAY", "startTime": "2026-11-03T17:45:00Z", "endTime": "2026-11-03T18:03:00Z",
		 "from": {"name": "Capitole"}, "to": {"name": "Ramonville"}, "routeShortName": "B",
		 "headsign": "Ramonville", "routeColor": "FFD200;x", "intermediateStops": [{}, {}, {}]}
	]}
]}`

func TestTransitTripAsksAsThePage(t *testing.T) {
	var query map[string][]string
	client := fakeMotis(t, 1, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/api/v6/plan" {
			t.Errorf("%s %s", r.Method, r.URL.Path)
		}
		query = r.URL.Query()
		io.WriteString(w, planAnswer)
	})
	trip, err := client.TransitTrip(context.Background(), capitole, ramonville, slotStart, slotEnd)
	if err != nil || trip == nil {
		t.Fatalf("trip %v, err %v", trip, err)
	}
	for name, want := range map[string]string{
		"fromPlace": "43.6045,1.4442", "toPlace": "43.5557,1.4746", "time": "2026-11-03T18:10:00.000Z",
		"arriveBy": "true", "maxItineraries": "5", "detailedTransfers": "false",
	} {
		if got := query[name]; len(got) != 1 || got[0] != want {
			t.Errorf("%s = %v, want %s", name, got, want)
		}
	}
	if len(query) != 6 {
		t.Errorf("query %v", query)
	}
	// The walk-only journey is dropped: the metro one, 22 min, arriving 19:03
	if trip.Seconds != 22*60 || trip.Wait != 0 || len(trip.Legs) != 2 {
		t.Fatalf("trip %+v", trip)
	}
	walk, metro := trip.Legs[0], trip.Legs[1]
	if walk.Path == nil || walk.Path.Points != "_p~iF~ps|U_ulLnnqC" || walk.Line != "" || walk.Stops != 0 {
		t.Errorf("walk %+v", walk)
	}
	if metro.Line != "B" || metro.Stops != 4 || metro.Color != "" || metro.Path != nil || metro.To != "Ramonville" {
		t.Errorf("metro %+v (a color that is not one is dropped)", metro)
	}
}

func TestTransitTripWithoutLineIsNone(t *testing.T) {
	client := fakeMotis(t, 1, func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"itineraries": [{"startTime": "2026-11-03T17:50:00Z", "endTime": "2026-11-03T17:58:00Z",
			"legs": [{"mode": "WALK", "startTime": "2026-11-03T17:50:00Z", "endTime": "2026-11-03T17:58:00Z"}]}]}`)
	})
	if trip, err := client.TransitTrip(context.Background(), capitole, ramonville, slotStart, slotEnd); err != nil || trip != nil {
		t.Errorf("trip %v, err %v", trip, err)
	}
}

func TestAFailedCallIsTriedOnceMore(t *testing.T) {
	var calls atomic.Int32
	client := fakeMotis(t, 1, func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) == 1 {
			http.Error(w, "busy", http.StatusServiceUnavailable)
			return
		}
		io.WriteString(w, `[{"duration": 60}]`)
	})
	if d, err := client.StreetDurations(context.Background(), ModeWalk, capitole, []Point{ramonville}); err != nil || d[0] != 60 {
		t.Errorf("durations %v, err %v", d, err)
	}
	if calls.Load() != 2 {
		t.Errorf("%d calls", calls.Load())
	}
}

func TestTwoFailuresAreAnError(t *testing.T) {
	var calls atomic.Int32
	client := fakeMotis(t, 1, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		http.Error(w, "broken", http.StatusInternalServerError)
	})
	_, err := client.StreetDurations(context.Background(), ModeWalk, capitole, []Point{ramonville})
	if !errors.Is(err, errMotis) || calls.Load() != 2 {
		t.Errorf("err %v, %d calls", err, calls.Load())
	}
}

func TestAnAnswerOfTheWrongSizeIsNotBelieved(t *testing.T) {
	var calls atomic.Int32
	client := fakeMotis(t, 1, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		io.WriteString(w, `[{"duration": 60}, {"duration": 70}]`) // two durations for one point
	})
	_, err := client.StreetDurations(context.Background(), ModeWalk, capitole, []Point{ramonville})
	// Not tried again: the same question would get the same answer
	if !errors.Is(err, errMotis) || calls.Load() != 1 {
		t.Errorf("err %v, %d calls", err, calls.Load())
	}
}

func TestACancelledComputationStopsItsCalls(t *testing.T) {
	var calls atomic.Int32
	release := make(chan struct{})
	client := fakeMotis(t, 1, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		select { // a slow MOTIS
		case <-release:
		case <-r.Context().Done():
		}
	})
	defer close(release)
	ctx, cancel := context.WithCancel(context.Background())
	go func() { time.Sleep(50 * time.Millisecond); cancel() }()
	_, err := client.StreetDurations(ctx, ModeWalk, capitole, []Point{ramonville})
	if !errors.Is(err, context.Canceled) && !errors.Is(err, errMotis) {
		t.Errorf("err %v", err)
	}
	if ctx.Err() == nil || calls.Load() != 1 {
		t.Errorf("%d calls: no retry once cancelled", calls.Load())
	}
}

func TestCallsInFlightAreBounded(t *testing.T) {
	const parallel = 3
	var inFlight, most atomic.Int32
	client := fakeMotis(t, parallel, func(w http.ResponseWriter, r *http.Request) {
		n := inFlight.Add(1)
		for {
			m := most.Load()
			if n <= m || most.CompareAndSwap(m, n) {
				break
			}
		}
		time.Sleep(20 * time.Millisecond)
		inFlight.Add(-1)
		io.WriteString(w, `[{"duration": 60}]`)
	})
	var wg sync.WaitGroup
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := client.StreetDurations(context.Background(), ModeWalk, capitole, []Point{ramonville}); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	if most.Load() != parallel {
		t.Errorf("at most %d calls at once, want %d", most.Load(), parallel)
	}
}
