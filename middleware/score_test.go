package main

import (
	"reflect"
	"testing"
)

// The cases of the page's score tests (tests/unit/engine.test.mjs)
func TestScores(t *testing.T) {
	if got := scoreOf(Egalitaire, []float64{10, 30}, []int{1, 1}); got != 20 {
		t.Errorf("égalitaire is the mean per person: %v", got)
	}
	if got := scoreOf(Egalitaire, []float64{10, 30}, []int{3, 1}); got != 15 {
		t.Errorf("every person counts: %v", got)
	}
	if got := scoreOf(Equitable, []float64{10, 30}, []int{1, 1}); got != 25 {
		t.Errorf("équitable is the mean plus half of what the longest trip has more: %v", got)
	}
	if got := scoreOf(Equitable, []float64{20, 20}, []int{1, 1}); got != 20 {
		t.Errorf("équitable of equal trips: %v", got)
	}
	if got := scoreOf(Equitable, []float64{10, 30}, []int{3, 1}); got != (15+30)/2.0 {
		t.Errorf("people weigh in the mean, not in the longest trip: %v", got)
	}
	// The reason "moyenne + écart" was dropped: (10, 30) scored worse than (20, 30)
	for _, s := range scores {
		if scoreOf(s, []float64{20, 30}, []int{1, 1}) < scoreOf(s, []float64{10, 30}, []int{1, 1}) {
			t.Errorf("%s: a longer trip for someone improves the score", s)
		}
	}
}

func TestFastestMode(t *testing.T) {
	choice, ok := fastest(map[Mode]float64{ModeWalk: 1500, ModeTransit: 900}, 120)
	if !ok || choice != (Choice{Mode: ModeTransit, Seconds: 900, Travel: 780}) {
		t.Errorf("transit, its wait not shown: %+v", choice)
	}
	choice, _ = fastest(map[Mode]float64{ModeBike: 600, ModeTransit: 900}, 120)
	if choice != (Choice{Mode: ModeBike, Seconds: 600, Travel: 600}) {
		t.Errorf("bike: %+v", choice)
	}
	if _, ok := fastest(map[Mode]float64{ModeWalk: Unreachable}, 0); ok {
		t.Error("unreachable on foot: found")
	}
	if _, ok := fastest(map[Mode]float64{}, 0); ok {
		t.Error("no time: found")
	}
	choice, _ = fastest(map[Mode]float64{ModeTransit: 600, ModeWalk: 600}, 0)
	if choice.Mode != ModeWalk {
		t.Errorf("equal times: %s, want the first of walk, bike, car, transit", choice.Mode)
	}
}

// candidateOf is a place reached on foot in these seconds by each participant (Unreachable: not reached).
func candidateOf(seconds ...float64) *Candidate {
	c := newCandidate(0, len(seconds))
	for i, s := range seconds {
		c.Times[i][ModeWalk] = s
	}
	return c
}

func TestRank(t *testing.T) {
	people := []int{1, 1}
	if got := rank([]*Candidate{candidateOf(10, 30), candidateOf(19, 20)}, Equitable, people); !reflect.DeepEqual(got, []int{1, 0}) {
		t.Errorf("équitable: %v", got)
	}
	if got := rank([]*Candidate{candidateOf(10, 20), candidateOf(16, 16)}, Egalitaire, people); !reflect.DeepEqual(got, []int{0, 1}) {
		t.Errorf("égalitaire: %v", got)
	}
	places := []*Candidate{candidateOf(10, Unreachable), candidateOf(40, 40)}
	if got := rank(places, Equitable, people); !reflect.DeepEqual(got, []int{1}) {
		t.Errorf("a place someone cannot reach is left out: %v", got)
	}
	if places[0].Scores != nil || places[0].Choices != nil || places[1].Scores[Egalitaire] != 40 {
		t.Errorf("scores %v %v", places[0].Scores, places[1].Scores)
	}
	equal := []*Candidate{candidateOf(20, 20), candidateOf(10, 30), candidateOf(20, 20)}
	if got := rank(equal, Egalitaire, people); !reflect.DeepEqual(got, []int{0, 1, 2}) {
		t.Errorf("equal scores keep their order: %v", got)
	}
}

func TestRankIsStableOnManyPlaces(t *testing.T) {
	// Enough places for the sort not to fall back on an insertion sort (stable by chance below 12 elements)
	var places []*Candidate
	for j := 0; j < 60; j++ {
		c := candidateOf(float64(10*(j%3)), 20)
		c.Place = j
		places = append(places, c)
	}
	order := rank(places, Egalitaire, []int{1, 1})
	for k := 1; k < len(order); k++ {
		a, b := places[order[k-1]], places[order[k]]
		if a.Scores[Egalitaire] == b.Scores[Egalitaire] && a.Place > b.Place {
			t.Fatalf("places %d and %d of equal score swapped", a.Place, b.Place)
		}
	}
}
