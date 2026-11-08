package main

import (
	"encoding/json"
	"errors"
	"io"
	"math"
	"mime"
	"net/http"
	"time"
	_ "time/tzdata" // the time zone database inside the binary: Toulouse time does not depend on the image
)

// Limits of the request (docs/architecture.md § API contract).
const (
	maxBodyBytes    = 16 << 10
	minParticipants = 2
	maxParticipants = 10
	maxPeople       = 15
	// The page offers the quarter hour already begun (slots.js): a meeting time up to 15 min in the past is accepted.
	pastTolerance = 15 * time.Minute
	timeLayout    = "2006-01-02T15:04"
)

// The area where positions are accepted: the OpenStreetMap extract MOTIS routes on (docs/evaluation.md).
const (
	minLat, maxLat = 43.32, 43.85
	minLon, maxLon = 1.10, 1.72
)

var toulouse = mustLoadLocation("Europe/Paris")

func mustLoadLocation(name string) *time.Location {
	loc, err := time.LoadLocation(name)
	if err != nil {
		panic(err)
	}
	return loc
}

// Mode is a way of travelling of a participant.
type Mode string

const (
	ModeWalk    Mode = "walk"
	ModeBike    Mode = "bike"
	ModeCar     Mode = "car"
	ModeTransit Mode = "transit"
)

var validModes = map[Mode]bool{ModeWalk: true, ModeBike: true, ModeCar: true, ModeTransit: true}

// PlaceType is the kind of place proposed.
type PlaceType string

var validPlaceTypes = map[PlaceType]bool{"station": true, "bar": true, "cafe": true, "restaurant": true}

// proposalsRequest is the body as sent. Pointers tell a missing field from a zero value (a latitude of 0, no
// people); everything is checked by validate before use.
type proposalsRequest struct {
	MeetingTime  *string            `json:"meetingTime"`
	PlaceType    *string            `json:"placeType"`
	Participants []participantInput `json:"participants"`
}

type participantInput struct {
	Lat    *float64 `json:"lat"`
	Lon    *float64 `json:"lon"`
	Modes  []string `json:"modes"`
	People *int     `json:"people"`
}

// Question is a validated request: every value is typed and within its bounds.
type Question struct {
	MeetingTime  time.Time
	PlaceType    PlaceType
	Participants []Participant
}

type Participant struct {
	Lat, Lon float64
	Modes    []Mode
	People   int
}

// requestError is a refusal: an HTTP status and a fixed code, plus, when it concerns one participant, its index
// (so that the page can point at the card). Nothing in it comes from the request.
type requestError struct {
	status      int
	code        string
	participant *int
}

func (e *requestError) Error() string { return e.code }

func refuse(code string) *requestError {
	return &requestError{status: http.StatusBadRequest, code: code}
}

func refuseParticipant(code string, index int) *requestError {
	return &requestError{status: http.StatusBadRequest, code: code, participant: &index}
}

// readQuestion decodes and validates the body of POST /v1/proposals. now is passed in for the tests.
func readQuestion(w http.ResponseWriter, r *http.Request, now time.Time) (Question, *requestError) {
	var req proposalsRequest
	if refusal := decodeBody(w, r, &req); refusal != nil {
		return Question{}, refusal
	}
	return validate(req, now)
}

// placeRequest is the body of POST /v1/place: the question, and one place of a kept zone (its id, from an answer).
type placeRequest struct {
	proposalsRequest
	Place *string `json:"place"`
}

// maxPlaceIDLength bounds the place's id before it is looked up (an OpenStreetMap id such as "node/13013557499").
const maxPlaceIDLength = 64

// readPlaceQuestion decodes and validates the body of POST /v1/place: the place must be a candidate of a zone, of
// the place type asked. Its id is only looked up in the places loaded, never used otherwise.
func readPlaceQuestion(w http.ResponseWriter, r *http.Request, now time.Time, data *Data) (Question, int, *requestError) {
	var req placeRequest
	if refusal := decodeBody(w, r, &req); refusal != nil {
		return Question{}, 0, refusal
	}
	q, refusal := validate(req.proposalsRequest, now)
	if refusal != nil {
		return q, 0, refusal
	}
	if req.Place == nil || len(*req.Place) > maxPlaceIDLength {
		return q, 0, refuse("invalid_place")
	}
	index, found := data.ByID[*req.Place]
	if !found || data.Places[index].Zone < 0 || data.Zones[data.Places[index].Zone].Kind != q.PlaceType {
		return q, 0, refuse("invalid_place")
	}
	return q, index, nil
}

// decodeBody reads a JSON body into target: application/json only (a browser then always sends a preflight first,
// CORS), 16 KB at most, no unknown field, exactly one JSON value.
func decodeBody(w http.ResponseWriter, r *http.Request, target any) *requestError {
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		return &requestError{status: http.StatusUnsupportedMediaType, code: "unsupported_media_type"}
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBodyBytes))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			return &requestError{status: http.StatusRequestEntityTooLarge, code: "body_too_large"}
		}
		return refuse("invalid_json")
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return refuse("invalid_json")
	}
	return nil
}

// validate turns a decoded request into a Question, or refuses it with the first rule broken.
func validate(req proposalsRequest, now time.Time) (Question, *requestError) {
	var q Question

	if req.MeetingTime == nil {
		return q, refuse("invalid_time")
	}
	meeting, err := time.ParseInLocation(timeLayout, *req.MeetingTime, toulouse)
	// Formatting back must give the same text: refuses a time that does not exist (the hour skipped in spring)
	if err != nil || meeting.Format(timeLayout) != *req.MeetingTime || meeting.Minute()%15 != 0 {
		return q, refuse("invalid_time")
	}
	// The end of the imported timetable is not known yet: until then, 30 days ahead
	if meeting.Before(now.Add(-pastTolerance)) || meeting.After(now.Add(30*24*time.Hour)) {
		return q, refuse("time_out_of_range")
	}
	q.MeetingTime = meeting

	if req.PlaceType == nil || !validPlaceTypes[PlaceType(*req.PlaceType)] {
		return q, refuse("invalid_place_type")
	}
	q.PlaceType = PlaceType(*req.PlaceType)

	if len(req.Participants) < minParticipants || len(req.Participants) > maxParticipants {
		return q, refuse("invalid_participants")
	}
	for i, p := range req.Participants {
		if p.Lat == nil || p.Lon == nil || math.IsNaN(*p.Lat) || math.IsNaN(*p.Lon) {
			return q, refuseParticipant("invalid_position", i)
		}
		if *p.Lat < minLat || *p.Lat > maxLat || *p.Lon < minLon || *p.Lon > maxLon {
			return q, refuseParticipant("outside_area", i)
		}
		if len(p.Modes) == 0 || len(p.Modes) > len(validModes) {
			return q, refuseParticipant("invalid_modes", i)
		}
		modes := make([]Mode, 0, len(p.Modes))
		seen := map[Mode]bool{}
		for _, m := range p.Modes {
			mode := Mode(m)
			if !validModes[mode] || seen[mode] {
				return q, refuseParticipant("invalid_modes", i)
			}
			seen[mode] = true
			modes = append(modes, mode)
		}
		if p.People == nil || *p.People < 1 || *p.People > maxPeople {
			return q, refuseParticipant("invalid_people", i)
		}
		q.Participants = append(q.Participants, Participant{Lat: *p.Lat, Lon: *p.Lon, Modes: modes, People: *p.People})
	}
	return q, nil
}

// writeRequestError answers a refusal.
func writeRequestError(w http.ResponseWriter, e *requestError) {
	body := map[string]any{"error": e.code}
	if e.participant != nil {
		body["participant"] = *e.participant
	}
	writeJSON(w, e.status, body)
}
