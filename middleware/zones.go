package main

// The method by zones, coarse then finer, as js/debug-motis.js scoreZones (docs/evaluation.md § Zones): every
// zone's representative estimated (one search per participant, not per zone), the best ones exact, the best zones far
// enough apart kept, then a few other places of each kept zone exact. Stations have no zones: each station is a zone
// of its own (decided by the user 2026-11-08), so there is no second round for them.

import (
	"context"
	"math"
	"sort"
	"sync"
	"time"
)

// The method's constants, as js/debug-motis.js; measured on Toulouse's bars, to measure again on other data.
const (
	zoneShortlist     = 20               // representatives scored exactly, then more by this step while too few zones are kept
	zoneEstimateLead  = 60 * time.Minute // the estimate leaves this long before the meeting time
	zoneSpacingM      = 500              // between the zones kept
	zoneExactPlaces   = 5                // places of a kept zone scored exactly, its representative included
	proposalCount     = 3                // zones proposed
	carParkingSeconds = 5 * 60           // added to every car trip, as engine.js CAR_PARKING_S
	lateTolerance     = 10 * time.Minute // arriving after the meeting time + this is not allowed
)

// group is a zone as the method sees it: a representative and its members. A station is a group of one.
type group struct {
	zone           int // index in Data.Zones, -1 for a station
	representative int // index in Data.Places
	members        []int
}

// ZoneResult is a kept zone: its places scored, best first, and those left without times.
type ZoneResult struct {
	Zone     int // index in Data.Zones, -1 for a station
	Places   []*Candidate
	Unscored []int // indices in Data.Places
}

// Result is a computation's outcome, the zones best first, and what it cost.
type Result struct {
	Zones     []ZoneResult
	Estimated int // representatives estimated
	Exact     int // representatives scored exactly
	Journeys  int // exact transit journeys asked
}

// computation holds what one question needs.
type computation struct {
	question  Question
	data      *Data
	motis     *MotisClient
	people    []int
	slotStart time.Time // the meeting time
	slotEnd   time.Time // + the late tolerance
}

// propose runs the method by zones for a validated question.
func propose(ctx context.Context, q Question, data *Data, motis *MotisClient) (*Result, error) {
	c := &computation{question: q, data: data, motis: motis, slotStart: q.MeetingTime,
		slotEnd: q.MeetingTime.Add(lateTolerance)}
	for _, p := range q.Participants {
		c.people = append(c.people, p.People)
	}
	groups := c.groups()
	result := &Result{Estimated: len(groups)}
	if len(groups) == 0 {
		return result, nil
	}

	// First round: every representative estimated
	reps := make([]*Candidate, len(groups))
	for g, gr := range groups {
		reps[g] = newCandidate(gr.representative, len(q.Participants))
	}
	if err := c.streetTimes(ctx, reps); err != nil {
		return nil, err
	}
	if err := c.transitEstimates(ctx, reps); err != nil {
		return nil, err
	}
	order := rank(reps, c.people)

	// The best representatives exact, ZONE_SHORTLIST more at a time while fewer than 3 zones far enough apart are kept
	var shortlist, kept []int // indices in groups
	for len(kept) < proposalCount && len(shortlist) < len(order) {
		next := order[len(shortlist):min(len(shortlist)+zoneShortlist, len(order))]
		if err := c.exactTransit(ctx, pick(reps, next)); err != nil {
			return nil, err
		}
		result.Journeys += len(next) * c.transitParticipants()
		shortlist = append(shortlist, next...)
		kept = kept[:0]
		for _, j := range rank(pick(reps, shortlist), c.people) {
			g := shortlist[j]
			if len(kept) < proposalCount && c.farFromAll(groups[g], groups, kept) {
				kept = append(kept, g)
			}
		}
	}
	result.Exact = len(shortlist)

	// Second round: other places of the zones kept, spread farthest first around their representative
	scored := pick(reps, kept)
	var others []*Candidate
	for _, g := range kept {
		gr := groups[g]
		var rest []int
		for _, m := range gr.members {
			if m != gr.representative {
				rest = append(rest, m)
			}
		}
		for _, p := range c.farthestFirst(gr.representative, rest, zoneExactPlaces-1) {
			others = append(others, newCandidate(p, len(q.Participants)))
		}
	}
	if len(others) > 0 {
		if err := c.streetTimes(ctx, others); err != nil {
			return nil, err
		}
		if err := c.exactTransit(ctx, others); err != nil {
			return nil, err
		}
		result.Journeys += len(others) * c.transitParticipants()
	}
	scored = append(scored, others...)

	ranking := rank(scored, c.people)
	for _, g := range kept {
		gr := groups[g]
		zr := ZoneResult{Zone: gr.zone}
		isScored := map[int]bool{}
		for _, cand := range scored {
			isScored[cand.Place] = true
		}
		for _, j := range ranking {
			if c.groupOf(scored[j].Place, gr) {
				zr.Places = append(zr.Places, scored[j])
			}
		}
		for _, m := range gr.members {
			if !isScored[m] {
				zr.Unscored = append(zr.Unscored, m)
			}
		}
		result.Zones = append(result.Zones, zr)
	}
	sort.SliceStable(result.Zones, func(a, b int) bool {
		return result.Zones[a].Places[0].Score < result.Zones[b].Places[0].Score
	})
	return result, nil
}

// groups are the zones of the place type asked, or one group per station.
func (c *computation) groups() []group {
	var groups []group
	if c.question.PlaceType == "station" {
		for _, p := range c.data.ByType["station"] {
			groups = append(groups, group{zone: -1, representative: p, members: []int{p}})
		}
		return groups
	}
	for z, zone := range c.data.Zones {
		if zone.Kind == c.question.PlaceType {
			groups = append(groups, group{zone: z, representative: zone.Representative, members: zone.Members})
		}
	}
	return groups
}

func (c *computation) groupOf(place int, gr group) bool {
	if gr.zone == -1 {
		return place == gr.representative
	}
	return c.data.Places[place].Zone == gr.zone
}

// farFromAll: the group's representative is at least zoneSpacingM from those of the groups kept.
func (c *computation) farFromAll(gr group, groups []group, kept []int) bool {
	for _, k := range kept {
		if c.distance(gr.representative, groups[k].representative) < zoneSpacingM {
			return false
		}
	}
	return true
}

func (c *computation) distance(a, b int) float64 {
	pa, pb := c.data.Places[a], c.data.Places[b]
	return haversine(pa.Lat, pa.Lon, pb.Lat, pb.Lon)
}

// farthestFirst picks at most count of the places, each time the one farthest, as the crow flies, from those picked
// (the representative first), the distance to a set being the one to its closest member; ties: the first in order.
func (c *computation) farthestFirst(representative int, places []int, count int) []int {
	left := append([]int(nil), places...)
	distance := make([]float64, len(left))
	for k, p := range left {
		distance[k] = c.distance(representative, p)
	}
	var picked []int
	for len(picked) < count && len(left) > 0 {
		far := 0
		for k := range left {
			if distance[k] > distance[far] {
				far = k
			}
		}
		next := left[far]
		picked = append(picked, next)
		left = append(left[:far], left[far+1:]...)
		distance = append(distance[:far], distance[far+1:]...)
		for k, p := range left {
			distance[k] = math.Min(distance[k], c.distance(next, p))
		}
	}
	return picked
}

func (c *computation) point(i int) Point {
	p := c.question.Participants[i]
	return Point{p.Lat, p.Lon}
}

func (c *computation) points(candidates []*Candidate) []Point {
	points := make([]Point, len(candidates))
	for j, cand := range candidates {
		p := c.data.Places[cand.Place]
		points[j] = Point{p.Lat, p.Lon}
	}
	return points
}

func (c *computation) hasMode(i int, mode Mode) bool {
	for _, m := range c.question.Participants[i].Modes {
		if m == mode {
			return true
		}
	}
	return false
}

func (c *computation) transitParticipants() int {
	n := 0
	for i := range c.question.Participants {
		if c.hasMode(i, ModeTransit) {
			n++
		}
	}
	return n
}

// streetTimes: walk, bike and car times of every participant to every candidate, one call per participant and mode.
// Rounded to the second, the car's with its parking time, as js/debug-motis.js streetTimes. The calls run at once,
// each keeping its durations apart; they are written into the candidates' times once all are done, from this goroutine
// only (a Go map must not be written by two goroutines at once: two modes of one participant share a map).
func (c *computation) streetTimes(ctx context.Context, candidates []*Candidate) error {
	points := c.points(candidates)
	type call struct {
		participant int
		mode        Mode
		durations   []float64
	}
	var calls []*call
	for i := range c.question.Participants {
		for _, mode := range []Mode{ModeWalk, ModeBike, ModeCar} {
			if c.hasMode(i, mode) {
				calls = append(calls, &call{participant: i, mode: mode})
			}
		}
	}
	tasks := make([]func(context.Context) error, len(calls))
	for k, cl := range calls {
		cl := cl
		tasks[k] = func(ctx context.Context) (err error) {
			cl.durations, err = c.motis.StreetDurations(ctx, cl.mode, c.point(cl.participant), points)
			return err
		}
	}
	if err := runAll(ctx, tasks); err != nil {
		return err
	}
	for _, cl := range calls {
		for j, d := range cl.durations {
			if d == Unreachable {
				continue
			}
			if cl.mode == ModeCar {
				d += carParkingSeconds
			}
			candidates[j].Times[cl.participant][cl.mode] = math.Round(d)
		}
	}
	return nil
}

// transitEstimates: the cheap transit estimate of every transit participant to every candidate, leaving
// zoneEstimateLead before the meeting time; written once all calls are done, as streetTimes.
func (c *computation) transitEstimates(ctx context.Context, candidates []*Candidate) error {
	points := c.points(candidates)
	departure := c.slotStart.Add(-zoneEstimateLead)
	var participants []int
	for i := range c.question.Participants {
		if c.hasMode(i, ModeTransit) {
			participants = append(participants, i)
		}
	}
	estimates := make([][]float64, len(participants))
	tasks := make([]func(context.Context) error, len(participants))
	for k, i := range participants {
		k, i := k, i
		tasks[k] = func(ctx context.Context) (err error) {
			estimates[k], err = c.motis.TransitEstimates(ctx, c.point(i), points, departure)
			return err
		}
	}
	if err := runAll(ctx, tasks); err != nil {
		return err
	}
	for k, i := range participants {
		for j, d := range estimates[k] {
			if d != Unreachable {
				candidates[j].Times[i][ModeTransit] = d
			}
		}
	}
	return nil
}

// exactTransit: the exact transit trip of every transit participant to every candidate; no trip removes the estimate.
// Each call writes only its own participant's times of its own candidate: no two goroutines share a map.
func (c *computation) exactTransit(ctx context.Context, candidates []*Candidate) error {
	var tasks []func(context.Context) error
	for i := range c.question.Participants {
		if !c.hasMode(i, ModeTransit) {
			continue
		}
		for _, cand := range candidates {
			i, cand := i, cand
			place := c.data.Places[cand.Place]
			tasks = append(tasks, func(ctx context.Context) error {
				trip, err := c.motis.TransitTrip(ctx, c.point(i), Point{place.Lat, place.Lon}, c.slotStart, c.slotEnd)
				if err != nil {
					return err
				}
				if trip == nil {
					delete(cand.Times[i], ModeTransit)
					cand.Waits[i], cand.Trips[i] = 0, nil
					return nil
				}
				cand.Times[i][ModeTransit] = trip.Seconds
				cand.Waits[i], cand.Trips[i] = trip.Wait, trip
				return nil
			})
		}
	}
	return runAll(ctx, tasks)
}

// runAll runs the tasks at once (the MOTIS client bounds the calls in flight) and returns the first error; the
// first failure cancels the others.
func runAll(ctx context.Context, tasks []func(context.Context) error) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	var wg sync.WaitGroup
	var once sync.Once
	var first error
	for _, task := range tasks {
		wg.Add(1)
		go func(task func(context.Context) error) {
			defer wg.Done()
			if err := task(ctx); err != nil {
				once.Do(func() { first = err; cancel() })
			}
		}(task)
	}
	wg.Wait()
	return first
}

func pick(candidates []*Candidate, indices []int) []*Candidate {
	picked := make([]*Candidate, len(indices))
	for k, j := range indices {
		picked[k] = candidates[j]
	}
	return picked
}
