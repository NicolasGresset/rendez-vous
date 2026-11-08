package main

// The MOTIS client: the same questions as the page's debug view asks its local MOTIS (js/motis.js, js/transitous.js),
// so that the middleware's proposals can be compared with the page's before anything is changed on purpose
// (docs/architecture.md § The MOTIS client).

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"time"
)

const (
	motisCallTimeout   = 10 * time.Second // one call of the middleware to MOTIS
	motisRetryDelay    = 2 * time.Second  // a failed call is tried once more after this
	motisMaxAnswer     = 16 << 20         // an answer larger than this is refused (a /plan is ~200 KB)
	streetMaxSeconds   = 4 * 3600         // as js/motis.js STREET_MAX_S
	matchingDistanceM  = 250              // as js/motis.js MATCHING_DISTANCE_M
	planMaxItineraries = 5                // as js/transitous.js PLAN_OPTIONS
)

// Unreachable marks a duration MOTIS did not find.
const Unreachable = -1.0

var streetModes = map[Mode]string{ModeWalk: "WALK", ModeBike: "BIKE", ModeCar: "CAR"}

// Point is a position.
type Point struct{ Lat, Lon float64 }

func coord(f float64) string { return strconv.FormatFloat(f, 'f', -1, 64) } // shortest form, as JavaScript prints it

// motisTime is the time format of the page's calls (Date.toISOString).
func motisTime(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }

// MotisClient calls one MOTIS server. Its slots bound the calls in flight for the whole middleware, every
// computation together (MOTIS answers at most as many calls at once as it has threads, the others wait in its queue).
type MotisClient struct {
	base       string
	http       *http.Client
	slots      chan struct{}
	retryDelay time.Duration
}

func NewMotisClient(base string, parallel int) *MotisClient {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.MaxIdleConnsPerHost = parallel // keep a connection per slot open between calls
	return &MotisClient{
		base:       base,
		http:       &http.Client{Transport: transport},
		slots:      make(chan struct{}, parallel),
		retryDelay: motisRetryDelay,
	}
}

// errMotis is a failure of MOTIS itself (status, unreadable answer); the caller's cancellation is not one.
var errMotis = errors.New("motis")

// call sends one request (built anew for the retry) and decodes the JSON answer into out. It waits for a slot,
// gives up when ctx ends (the visitor left, or the computation's deadline), and tries once more after a failure.
func (c *MotisClient) call(ctx context.Context, newRequest func(context.Context) (*http.Request, error), out any) error {
	err := c.callOnce(ctx, newRequest, out)
	if err == nil || ctx.Err() != nil {
		return err
	}
	select {
	case <-time.After(c.retryDelay):
	case <-ctx.Done():
		return ctx.Err()
	}
	return c.callOnce(ctx, newRequest, out)
}

func (c *MotisClient) callOnce(ctx context.Context, newRequest func(context.Context) (*http.Request, error), out any) error {
	select {
	case c.slots <- struct{}{}:
	case <-ctx.Done():
		return ctx.Err()
	}
	defer func() { <-c.slots }()

	ctx, cancel := context.WithTimeout(ctx, motisCallTimeout)
	defer cancel()
	req, err := newRequest(ctx)
	if err != nil {
		return err
	}
	res, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("%w: %v", errMotis, err)
	}
	defer res.Body.Close()
	body, err := io.ReadAll(io.LimitReader(res.Body, motisMaxAnswer+1))
	if err != nil {
		return fmt.Errorf("%w: %v", errMotis, err)
	}
	if len(body) > motisMaxAnswer {
		return fmt.Errorf("%w: answer too large", errMotis)
	}
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("%w: status %d", errMotis, res.StatusCode)
	}
	if err := json.Unmarshal(body, out); err != nil {
		return fmt.Errorf("%w: %v", errMotis, err)
	}
	return nil
}

func (c *MotisClient) postJSON(path string, payload any) func(context.Context) (*http.Request, error) {
	return func(ctx context.Context) (*http.Request, error) {
		body, err := json.Marshal(payload)
		if err != nil {
			return nil, err
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.base+path, bytes.NewReader(body))
		if err == nil {
			req.Header.Set("Content-Type", "application/json")
		}
		return req, err
	}
}

// StreetDurations gives the walk, bike or car durations in seconds from one point to many (Unreachable when none),
// as js/motis.js streetDurations: one forward search, 4 h at most, points matched to the streets within 250 m.
func (c *MotisClient) StreetDurations(ctx context.Context, mode Mode, one Point, many []Point) ([]float64, error) {
	motisMode, ok := streetModes[mode]
	if !ok {
		return nil, fmt.Errorf("not a street mode: %s", mode)
	}
	payload := struct {
		One                 string   `json:"one"`
		Many                []string `json:"many"`
		Mode                string   `json:"mode"`
		Max                 int      `json:"max"`
		MaxMatchingDistance int      `json:"maxMatchingDistance"`
		ArriveBy            bool     `json:"arriveBy"`
	}{One: coord(one.Lat) + ";" + coord(one.Lon), Mode: motisMode, Max: streetMaxSeconds,
		MaxMatchingDistance: matchingDistanceM, ArriveBy: false}
	for _, p := range many {
		payload.Many = append(payload.Many, coord(p.Lat)+";"+coord(p.Lon))
	}
	var answer []struct {
		Duration *float64 `json:"duration"`
	}
	if err := c.call(ctx, c.postJSON("/api/v1/one-to-many", payload), &answer); err != nil {
		return nil, err
	}
	if len(answer) != len(many) {
		return nil, fmt.Errorf("%w: %d durations for %d points", errMotis, len(answer), len(many))
	}
	durations := make([]float64, len(many))
	for i, d := range answer {
		durations[i] = Unreachable
		if d.Duration != nil {
			durations[i] = *d.Duration
		}
	}
	return durations, nil
}

// TransitEstimates gives cheap transit durations in seconds from one point to many, leaving at departure
// (Unreachable when none), as js/motis.js transitEstimatesFrom: one RAPTOR search forward, no journey rebuilt,
// the wait for the first vehicle counted.
func (c *MotisClient) TransitEstimates(ctx context.Context, one Point, many []Point, departure time.Time) ([]float64, error) {
	payload := struct {
		One      string   `json:"one"`
		Many     []string `json:"many"`
		Time     string   `json:"time"`
		ArriveBy bool     `json:"arriveBy"`
	}{One: coord(one.Lat) + "," + coord(one.Lon), Time: motisTime(departure), ArriveBy: false}
	for _, p := range many {
		payload.Many = append(payload.Many, coord(p.Lat)+","+coord(p.Lon))
	}
	var answer struct {
		TransitDurations [][]struct {
			Duration float64 `json:"duration"`
		} `json:"transit_durations"`
	}
	if err := c.call(ctx, c.postJSON("/api/experimental/one-to-many-intermodal", payload), &answer); err != nil {
		return nil, err
	}
	if len(answer.TransitDurations) != len(many) {
		return nil, fmt.Errorf("%w: %d estimates for %d points", errMotis, len(answer.TransitDurations), len(many))
	}
	estimates := make([]float64, len(many))
	for i, set := range answer.TransitDurations {
		estimates[i] = Unreachable
		for _, e := range set {
			if estimates[i] == Unreachable || e.Duration < estimates[i] {
				estimates[i] = e.Duration
			}
		}
	}
	return estimates, nil
}

// Polyline is a path as MOTIS encodes it (Google's format), passed on to the page, which decodes it.
type Polyline struct {
	Points    string `json:"points"`
	Precision int    `json:"precision"`
}

// Leg is a walk or a ride of a journey, with what the page shows and draws (js/transitous.js itineraryLegs).
type Leg struct {
	Mode      string    `json:"mode"` // MOTIS's: WALK, BUS, SUBWAY, TRAM…; the page names them
	From      string    `json:"from,omitempty"`
	To        string    `json:"to,omitempty"`
	Departure time.Time `json:"departure"`
	Arrival   time.Time `json:"arrival"`
	Path      *Polyline `json:"path,omitempty"`
	Line      string    `json:"line,omitempty"`
	Headsign  string    `json:"headsign,omitempty"`
	Color     string    `json:"color,omitempty"` // "#RRGGBB", or empty when MOTIS gives none or not one
	Stops     int       `json:"stops,omitempty"` // stops travelled, the alighting one included
}

// Trip is the transit trip chosen for a participant and a place.
type Trip struct {
	Seconds   float64   `json:"seconds"` // from leaving to the meeting time or arrival, whichever is later
	Wait      float64   `json:"wait"`    // arriving before the meeting time: the wait until it
	Departure time.Time `json:"departure"`
	Arrival   time.Time `json:"arrival"`
	Legs      []Leg     `json:"legs"`
}

type motisLeg struct {
	Mode      string    `json:"mode"`
	StartTime time.Time `json:"startTime"`
	EndTime   time.Time `json:"endTime"`
	From      *struct {
		Name string `json:"name"`
	} `json:"from"`
	To *struct {
		Name string `json:"name"`
	} `json:"to"`
	LegGeometry *struct {
		Points    string `json:"points"`
		Precision int    `json:"precision"`
	} `json:"legGeometry"`
	RouteShortName    string            `json:"routeShortName"`
	Headsign          string            `json:"headsign"`
	RouteColor        string            `json:"routeColor"`
	IntermediateStops []json.RawMessage `json:"intermediateStops"`
}

type motisItinerary struct {
	StartTime time.Time  `json:"startTime"`
	EndTime   time.Time  `json:"endTime"`
	Legs      []motisLeg `json:"legs"`
}

var hexColor = regexp.MustCompile(`^#?[0-9a-fA-F]{6}$`)

// TransitTrip asks MOTIS's /plan for journeys arriving by slotEnd and keeps the best for the slot [slotStart, slotEnd],
// as js/transitous.js transitTrip; nil when no journey with a transit line arrives in time.
func (c *MotisClient) TransitTrip(ctx context.Context, from, to Point, slotStart, slotEnd time.Time) (*Trip, error) {
	query := url.Values{
		"fromPlace":         {coord(from.Lat) + "," + coord(from.Lon)},
		"toPlace":           {coord(to.Lat) + "," + coord(to.Lon)},
		"time":              {motisTime(slotEnd)},
		"arriveBy":          {"true"},
		"maxItineraries":    {strconv.Itoa(planMaxItineraries)},
		"detailedTransfers": {"false"},
	}
	newRequest := func(ctx context.Context) (*http.Request, error) {
		return http.NewRequestWithContext(ctx, http.MethodGet, c.base+"/api/v6/plan?"+query.Encode(), nil)
	}
	var answer struct {
		Itineraries []motisItinerary `json:"itineraries"`
	}
	if err := c.call(ctx, newRequest, &answer); err != nil {
		return nil, err
	}
	var journeys []motisItinerary
	for _, it := range answer.Itineraries {
		for _, leg := range it.Legs {
			if leg.Mode != "WALK" {
				journeys = append(journeys, it)
				break
			}
		}
	}
	best, seconds, wait, ok := bestJourney(journeys, slotStart, slotEnd)
	if !ok {
		return nil, nil
	}
	trip := &Trip{Seconds: seconds, Wait: wait, Departure: best.StartTime, Arrival: best.EndTime, Legs: legsOf(best)}
	return trip, nil
}

// StreetPath asks MOTIS's /plan for a walk, bike or car path, as js/motis.js routePath: its legs (usually one), or nil
// when MOTIS finds none.
func (c *MotisClient) StreetPath(ctx context.Context, mode Mode, from, to Point) ([]Leg, error) {
	motisMode, ok := streetModes[mode]
	if !ok {
		return nil, fmt.Errorf("not a street mode: %s", mode)
	}
	query := url.Values{
		"fromPlace":     {coord(from.Lat) + "," + coord(from.Lon)},
		"toPlace":       {coord(to.Lat) + "," + coord(to.Lon)},
		"directModes":   {motisMode},
		"transitModes":  {""},
		"maxDirectTime": {strconv.Itoa(streetMaxSeconds)},
	}
	newRequest := func(ctx context.Context) (*http.Request, error) {
		return http.NewRequestWithContext(ctx, http.MethodGet, c.base+"/api/v6/plan?"+query.Encode(), nil)
	}
	var answer struct {
		Direct []motisItinerary `json:"direct"`
	}
	if err := c.call(ctx, newRequest, &answer); err != nil {
		return nil, err
	}
	if len(answer.Direct) == 0 {
		return nil, nil
	}
	return legsOf(answer.Direct[0]), nil
}

// legsOf keeps of an itinerary's legs what the page shows and draws (js/transitous.js itineraryLegs).
func legsOf(it motisItinerary) []Leg {
	var legs []Leg
	for _, l := range it.Legs {
		leg := Leg{Mode: l.Mode, Departure: l.StartTime, Arrival: l.EndTime}
		if l.From != nil {
			leg.From = l.From.Name
		}
		if l.To != nil {
			leg.To = l.To.Name
		}
		if l.LegGeometry != nil && l.LegGeometry.Points != "" {
			leg.Path = &Polyline{Points: l.LegGeometry.Points, Precision: l.LegGeometry.Precision}
		}
		if !streetLeg[l.Mode] {
			leg.Line, leg.Headsign = l.RouteShortName, l.Headsign
			if hexColor.MatchString(l.RouteColor) {
				leg.Color = "#" + l.RouteColor[len(l.RouteColor)-6:]
			}
			leg.Stops = len(l.IntermediateStops) + 1
		}
		legs = append(legs, leg)
	}
	return legs
}

// streetLeg: the legs MOTIS gives for walk, bike and car, which have no line
var streetLeg = map[string]bool{"WALK": true, "BIKE": true, "CAR": true}

// bestJourney is js/transitous.js bestJourney: among the journeys arriving by slotEnd, the one taking the least time
// from leaving to being there when the slot starts or within it (arriving early counts the wait); at equal time,
// the latest departure. Returns the time and the wait in seconds.
func bestJourney(journeys []motisItinerary, slotStart, slotEnd time.Time) (best motisItinerary, seconds, wait float64, ok bool) {
	cost := func(j motisItinerary) time.Duration {
		arrival := j.EndTime
		if arrival.Before(slotStart) {
			arrival = slotStart
		}
		return arrival.Sub(j.StartTime)
	}
	for _, j := range journeys {
		if j.EndTime.After(slotEnd) {
			continue
		}
		if !ok || cost(j) < cost(best) || (cost(j) == cost(best) && j.StartTime.After(best.StartTime)) {
			best, ok = j, true
		}
	}
	if !ok {
		return best, 0, 0, false
	}
	return best, cost(best).Seconds(), math.Max(0, slotStart.Sub(best.EndTime).Seconds()), true
}
