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
	Name     string  `json:"name"`
	Category string  `json:"category"`
	Lat      float64 `json:"lat"`
	Lon      float64 `json:"lon"`
}

type AnswerPlace struct {
	Name     string       `json:"name"`
	Category string       `json:"category"`
	Lat      float64      `json:"lat"`
	Lon      float64      `json:"lon"`
	Zone     *int         `json:"zone,omitempty"` // index in Answer.Zones; absent for a station
	Score    float64      `json:"score"`          // seconds, lower is better
	Trips    []AnswerTrip `json:"trips"`          // one per participant, in the question's order
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
		legs               []Leg
	}
	var calls []*pathCall

	for _, zr := range result.Zones {
		var zoneIndex *int
		if zr.Zone >= 0 {
			zone := data.Zones[zr.Zone]
			az := AnswerZone{Name: zone.Name, Kind: zone.Kind, Places: []int{}, Others: []OtherPlace{}}
			for _, m := range zr.Unscored {
				p := data.Places[m]
				az.Others = append(az.Others, OtherPlace{Name: p.Name, Category: p.Category, Lat: p.Lat, Lon: p.Lon})
			}
			answer.Zones = append(answer.Zones, az)
			z := len(answer.Zones) - 1
			zoneIndex = &z
		}
		for k, cand := range zr.Places {
			p := data.Places[cand.Place]
			index := len(answer.Places)
			ap := AnswerPlace{Name: p.Name, Category: p.Category, Lat: p.Lat, Lon: p.Lon, Zone: zoneIndex, Score: cand.Score}
			for i, choice := range cand.Choices {
				trip := AnswerTrip{Mode: choice.Mode, Seconds: choice.Seconds, Travel: choice.Travel, Legs: []Leg{}}
				if choice.Mode == ModeTransit && cand.Trips[i] != nil {
					departure, arrival := cand.Trips[i].Departure, cand.Trips[i].Arrival
					trip.Departure, trip.Arrival, trip.Legs = &departure, &arrival, cand.Trips[i].Legs
				} else if choice.Mode != ModeTransit {
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

	tasks := make([]func(context.Context) error, len(calls))
	for k, call := range calls {
		call := call
		participant := q.Participants[call.participant]
		tasks[k] = func(ctx context.Context) error {
			legs, err := motis.StreetPath(ctx, call.mode, Point{participant.Lat, participant.Lon}, call.to)
			if err != nil && ctx.Err() != nil {
				return ctx.Err() // cancelled or out of time: the whole answer stops
			}
			call.legs = legs // a failure of MOTIS for one path only leaves it out, as the page does
			return nil
		}
	}
	if err := runAll(ctx, tasks); err != nil {
		return nil, err
	}
	for _, call := range calls {
		if call.legs != nil {
			answer.Places[call.place].Trips[call.participant].Legs = call.legs
		}
	}
	return answer, nil
}
