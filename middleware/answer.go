package main

// The answer of POST /v1/proposals (docs/architecture.md § API contract): complete, so that the page needs no file
// to show it, and indirect (places and zones in tables, proposals as indices).

import (
	"context"
	"time"
)

type Answer struct {
	MeetingTime string        `json:"meetingTime"` // as asked, Toulouse time
	Proposals   []int         `json:"proposals"`   // indices in Places: each zone's best place, best first
	Zones       []AnswerZone  `json:"zones"`
	Places      []AnswerPlace `json:"places"`
	Data        DataVersion   `json:"data"`
}

// AnswerZone is a kept zone. A station is a zone of its own and has no entry: its place has no zone.
type AnswerZone struct {
	Name   string       `json:"name"`
	Kind   PlaceType    `json:"kind"`
	Places []int        `json:"places"` // indices in Answer.Places, best first
	Others []OtherPlace `json:"others"` // the zone's places without times, scored when chosen (a later route)
}

type OtherPlace struct {
	ID       string  `json:"id"` // to ask its trips (POST /v1/place)
	Name     string  `json:"name"`
	Category string  `json:"category"`
	Lat      float64 `json:"lat"`
	Lon      float64 `json:"lon"`
}

type AnswerPlace struct {
	ID       string  `json:"id"`
	Name     string  `json:"name"`
	Category string  `json:"category"`
	Lat      float64 `json:"lat"`
	Lon      float64 `json:"lon"`
	Address
	Zone  *int         `json:"zone,omitempty"` // index in Answer.Zones; absent for a station
	Score float64      `json:"score"`          // seconds, lower is better
	Trips []AnswerTrip `json:"trips"`          // one per participant, in the question's order
}

// AnswerTrip is a participant's fastest way to a place.
type AnswerTrip struct {
	Mode      Mode       `json:"mode"`
	Seconds   float64    `json:"seconds"` // scored: with transit, the wait until the meeting time when arriving early
	Travel    float64    `json:"travel"`  // shown: door to door
	Departure *time.Time `json:"departure,omitempty"`
	Arrival   *time.Time `json:"arrival,omitempty"`
	Legs      []Leg      `json:"legs"` // with transit, the journey's; otherwise the street path; empty when MOTIS had none
}

// buildAnswer turns a result into the answer, asking MOTIS the street paths of every scored place (one call per
// participant whose fastest mode there is walk, bike or car). A path MOTIS cannot give leaves the trip without legs.
func buildAnswer(ctx context.Context, q Question, data *Data, motis *MotisClient, result *Result) (*Answer, error) {
	answer := &Answer{MeetingTime: q.MeetingTime.Format(timeLayout), Proposals: []int{}, Zones: []AnswerZone{},
		Places: []AnswerPlace{}, Data: data.Version}
	type pathCall struct {
		place, participant int
		mode               Mode
		to                 Point
	}
	var calls []*pathCall

	for _, zr := range result.Zones {
		var zoneIndex *int
		if zr.Zone >= 0 {
			zone := data.Zones[zr.Zone]
			az := AnswerZone{Name: zone.Name, Kind: zone.Kind, Places: []int{}, Others: []OtherPlace{}}
			for _, m := range zr.Unscored {
				p := data.Places[m]
				az.Others = append(az.Others, OtherPlace{ID: p.ID, Name: p.Name, Category: p.Category, Lat: p.Lat, Lon: p.Lon})
			}
			answer.Zones = append(answer.Zones, az)
			z := len(answer.Zones) - 1
			zoneIndex = &z
		}
		for k, cand := range zr.Places {
			p := data.Places[cand.Place]
			index := len(answer.Places)
			ap := AnswerPlace{ID: p.ID, Name: p.Name, Category: p.Category, Lat: p.Lat, Lon: p.Lon, Address: p.Address, Zone: zoneIndex, Score: cand.Score}
			for i, choice := range cand.Choices {
				trip, street := tripOf(choice, cand.Trips[i])
				if street {
					calls = append(calls, &pathCall{place: index, participant: i, mode: choice.Mode, to: Point{p.Lat, p.Lon}})
				}
				ap.Trips = append(ap.Trips, trip)
			}
			answer.Places = append(answer.Places, ap)
			if zoneIndex != nil {
				answer.Zones[*zoneIndex].Places = append(answer.Zones[*zoneIndex].Places, index)
			}
			if k == 0 {
				answer.Proposals = append(answer.Proposals, index)
			}
		}
	}

	paths := make([]streetPathCall, len(calls))
	for k, call := range calls {
		participant := q.Participants[call.participant]
		paths[k] = streetPathCall{mode: call.mode, from: Point{participant.Lat, participant.Lon}, to: call.to}
	}
	if err := fillStreetPaths(ctx, motis, paths); err != nil {
		return nil, err
	}
	for k, call := range calls {
		if paths[k].legs != nil {
			answer.Places[call.place].Trips[call.participant].Legs = paths[k].legs
		}
	}
	return answer, nil
}

// tripOf is a participant's trip for their fastest mode; street: its path is still to ask.
func tripOf(choice Choice, transit *Trip) (trip AnswerTrip, street bool) {
	trip = AnswerTrip{Mode: choice.Mode, Seconds: choice.Seconds, Travel: choice.Travel, Legs: []Leg{}}
	if choice.Mode != ModeTransit {
		return trip, true
	}
	if transit != nil {
		departure, arrival := transit.Departure, transit.Arrival
		trip.Departure, trip.Arrival, trip.Legs = &departure, &arrival, transit.Legs
	}
	return trip, false
}

type streetPathCall struct {
	mode     Mode
	from, to Point
	legs     []Leg
}

// fillStreetPaths asks MOTIS the street paths at once. A path MOTIS cannot give is left out, as the page does; the
// computation's end (cancelled, out of time) stops them all.
func fillStreetPaths(ctx context.Context, motis *MotisClient, calls []streetPathCall) error {
	tasks := make([]func(context.Context) error, len(calls))
	for k := range calls {
		call := &calls[k]
		tasks[k] = func(ctx context.Context) error {
			legs, err := motis.StreetPath(ctx, call.mode, call.from, call.to)
			if err != nil && ctx.Err() != nil {
				return ctx.Err()
			}
			call.legs = legs
			return nil
		}
	}
	return runAll(ctx, tasks)
}

// PlaceAnswer is the answer of POST /v1/place: the trips to one other place of a kept zone, chosen in the page.
type PlaceAnswer struct {
	Place PlaceTrips  `json:"place"`
	Data  DataVersion `json:"data"`
}

// PlaceTrips is a place's trips. Unlike the proposals, someone may not reach it: then Reachable is false, Score is
// absent and that participant's trip is null.
type PlaceTrips struct {
	ID       string  `json:"id"`
	Name     string  `json:"name"`
	Category string  `json:"category"`
	Lat      float64 `json:"lat"`
	Lon      float64 `json:"lon"`
	Address
	Reachable bool          `json:"reachable"`
	Score     *float64      `json:"score,omitempty"`
	Trips     []*AnswerTrip `json:"trips"`
}

// placeTrips computes one place's trips, as js/debug-motis.js scoreZonePlace: street times, exact transit, each
// participant's fastest mode, the score when everyone reaches it, the street paths.
func placeTrips(ctx context.Context, q Question, data *Data, motis *MotisClient, place int) (*PlaceAnswer, error) {
	c := &computation{question: q, data: data, motis: motis, slotStart: q.MeetingTime, slotEnd: q.MeetingTime.Add(lateTolerance)}
	cand := newCandidate(place, len(q.Participants))
	if err := c.streetTimes(ctx, []*Candidate{cand}); err != nil {
		return nil, err
	}
	if err := c.exactTransit(ctx, []*Candidate{cand}); err != nil {
		return nil, err
	}
	p := data.Places[place]
	answer := &PlaceAnswer{Place: PlaceTrips{ID: p.ID, Name: p.Name, Category: p.Category, Lat: p.Lat, Lon: p.Lon, Address: p.Address,
		Trips: make([]*AnswerTrip, len(q.Participants))}, Data: data.Version}
	var paths []streetPathCall
	var pathOf []int // the participant of each path
	seconds := make([]float64, len(q.Participants))
	people := make([]int, len(q.Participants))
	reachable := true
	for i := range q.Participants {
		people[i] = q.Participants[i].People
		choice, found := fastest(cand.Times[i], cand.Waits[i])
		if !found {
			reachable = false
			continue
		}
		seconds[i] = choice.Seconds
		trip, street := tripOf(choice, cand.Trips[i])
		answer.Place.Trips[i] = &trip
		if street {
			paths = append(paths, streetPathCall{mode: choice.Mode, from: c.point(i), to: Point{p.Lat, p.Lon}})
			pathOf = append(pathOf, i)
		}
	}
	if reachable {
		score := scoreOf(seconds, people)
		answer.Place.Reachable, answer.Place.Score = true, &score
	}
	if err := fillStreetPaths(ctx, motis, paths); err != nil {
		return nil, err
	}
	for k, i := range pathOf {
		if paths[k].legs != nil {
			answer.Place.Trips[i].Legs = paths[k].legs
		}
	}
	return answer, nil
}
