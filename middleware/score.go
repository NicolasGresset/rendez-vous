package main

// Scores and ranking of the method by zones, as js/debug-motis.js scorePlaces and js/engine.js SCORES
// (docs/evaluation.md § Scores). Lower is better.

import (
	"math"
	"sort"
)

// Score is one way of ranking the places; the answer gives both.
type Score string

const (
	// Equitable is the mean time per person plus half of what the longest trip has more: (1 − β)·mean + β·max with
	// β = ½ (Ogryczak), so that the one coming from far is not penalized much. The page's "half", its default.
	Equitable Score = "equitable"
	// Egalitaire is the mean time per person: every minute counts the same, whoever spends it. The page's "mean".
	Egalitaire Score = "egalitaire"
)

var scores = []Score{Equitable, Egalitaire}

// modeOrder decides between two modes of equal time (the page's order is that of its asynchronous answers, so
// arbitrary): the same time either way, only the mode shown can differ.
var modeOrder = []Mode{ModeWalk, ModeBike, ModeCar, ModeTransit}

// Choice is a participant's fastest mode to a place. Seconds is what is scored (with transit, the wait until the
// meeting time when arriving early); Travel is the door-to-door time shown, without that wait.
type Choice struct {
	Mode    Mode
	Seconds float64
	Travel  float64
}

// fastest is the participant's fastest mode among the times known (Unreachable or absent: not available); false
// when none.
func fastest(times map[Mode]float64, transitWait float64) (Choice, bool) {
	var best Choice
	found := false
	for _, mode := range modeOrder {
		seconds, ok := times[mode]
		if !ok || seconds == Unreachable {
			continue
		}
		if !found || seconds < best.Seconds {
			travel := seconds
			if mode == ModeTransit {
				travel -= transitWait
			}
			best, found = Choice{Mode: mode, Seconds: seconds, Travel: travel}, true
		}
	}
	return best, found
}

// scoreOf computes a score from each participant's time and the people leaving from their point: every person
// counts, so a participant of 3 people counts 3 times in the mean (not in the longest trip).
func scoreOf(score Score, seconds []float64, people []int) float64 {
	total, persons, longest := 0.0, 0, 0.0
	for i, s := range seconds {
		total += float64(people[i]) * s
		persons += people[i]
		longest = math.Max(longest, s)
	}
	mean := total / float64(persons)
	if score == Egalitaire {
		return mean
	}
	return (mean + longest) / 2
}

// Candidate is a place being scored: each participant's times by mode, the transit wait, the transit trip kept.
type Candidate struct {
	Place   int // index in Data.Places
	Times   []map[Mode]float64
	Waits   []float64
	Trips   []*Trip
	Choices []Choice          // set by rank
	Scores  map[Score]float64 // set by rank; absent when someone cannot reach the place
}

func newCandidate(place, participants int) *Candidate {
	c := &Candidate{Place: place, Times: make([]map[Mode]float64, participants), Waits: make([]float64, participants),
		Trips: make([]*Trip, participants)}
	for i := range c.Times {
		c.Times[i] = map[Mode]float64{}
	}
	return c
}

// rank sets every candidate's choices and both scores, and returns the indices of those everyone can reach, best
// first for the given score. Equal scores keep the candidates' order, as JavaScript's stable sort does.
func rank(candidates []*Candidate, score Score, people []int) []int {
	var reachable []int
	for j, c := range candidates {
		c.Choices = c.Choices[:0]
		c.Scores = nil
		seconds := make([]float64, len(c.Times))
		ok := true
		for i := range c.Times {
			choice, found := fastest(c.Times[i], c.Waits[i])
			if !found {
				ok = false
				break
			}
			c.Choices = append(c.Choices, choice)
			seconds[i] = choice.Seconds
		}
		if !ok {
			c.Choices = nil
			continue
		}
		c.Scores = map[Score]float64{}
		for _, s := range scores {
			c.Scores[s] = scoreOf(s, seconds, people)
		}
		reachable = append(reachable, j)
	}
	sort.SliceStable(reachable, func(a, b int) bool {
		return candidates[reachable[a]].Scores[score] < candidates[reachable[b]].Scores[score]
	})
	return reachable
}
