package main

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// placeBody is validBody (bars) with a place id.
func placeBody(id string) string {
	soon := time.Now().In(toulouse).Add(time.Hour).Truncate(15 * time.Minute)
	body := strings.Replace(validBody, "2026-11-09T19:00", soon.Format(timeLayout), 1)
	return strings.Replace(body, `"placeType": "bar",`, `"placeType": "bar", "place": `+id+`,`, 1)
}

func postPlace(handler http.Handler, body, client string) *http.Response {
	req := httptest.NewRequest(http.MethodPost, "/v1/place", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Forwarded-For", client)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec.Result()
}

// aBarOfABigZone is a bar of a zone of more than 5 places: one that may be left without times by the proposals.
func aBarOfABigZone(t *testing.T, data *Data) Place {
	for _, zone := range data.Zones {
		if zone.Kind == "bar" && len(zone.Members) > zoneExactPlaces {
			return data.Places[zone.Members[len(zone.Members)-1]]
		}
	}
	t.Fatal("no bar zone of more than 5 places")
	return Place{}
}

func TestThePlaceRoute(t *testing.T) {
	handler, svc := proposalsHandler(t)
	bar := aBarOfABigZone(t, svc.data)
	res := postPlace(handler, placeBody(`"`+bar.ID+`"`), "203.0.113.7")
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status %d: %s", res.StatusCode, body(t, res))
	}
	var answer PlaceAnswer
	if err := json.NewDecoder(res.Body).Decode(&answer); err != nil {
		t.Fatal(err)
	}
	p := answer.Place
	if p.ID != bar.ID || p.Name != bar.Name || !p.Reachable || p.Score == nil || len(p.Trips) != 2 || answer.Data.SHA256 == "" {
		t.Fatalf("answer %+v", answer)
	}
	for i, trip := range p.Trips {
		if trip == nil || len(trip.Legs) == 0 {
			t.Errorf("participant %d: %+v", i, trip)
		}
	}
	if p.Trips[1].Mode != ModeBike || p.Trips[1].Legs[0].Mode != "BIKE" {
		t.Errorf("the cyclist: %+v", p.Trips[1])
	}
}

func TestOnlyAPlaceOfAZoneOfTheTypeAsked(t *testing.T) {
	handler, svc := proposalsHandler(t)
	var station, cafe string
	for _, p := range svc.data.Places {
		if p.Category == "metro" && station == "" {
			station = p.ID
		}
		if p.Category == "amenity=cafe" && cafe == "" {
			cafe = p.ID
		}
	}
	for name, id := range map[string]string{
		"missing": "", "unknown": `"node/0"`, "a station": `"` + station + `"`, "a café for bars": `"` + cafe + `"`,
		"too long": `"` + strings.Repeat("9", maxPlaceIDLength+1) + `"`, "a number": `42`,
	} {
		question := placeBody(id)
		if id == "" {
			question = strings.Replace(question, `"place": ,`, ``, 1)
		}
		res := postPlace(handler, question, "203.0.113.7")
		got := body(t, res)
		if res.StatusCode != http.StatusBadRequest || (got != `{"error":"invalid_place"}` && got != `{"error":"invalid_json"}`) {
			t.Errorf("%s: status %d, %s", name, res.StatusCode, got)
		}
	}
}

func TestAPlaceSomeoneCannotReach(t *testing.T) {
	data, err := loadData(repoPlacesFile)
	if err != nil {
		t.Fatal(err)
	}
	nowhere := fakeMotis(t, 6, func(w http.ResponseWriter, r *http.Request) {
		var q struct{ Many []string }
		_ = json.NewDecoder(r.Body).Decode(&q)
		io.WriteString(w, "["+strings.TrimSuffix(strings.Repeat("{},", len(q.Many)), ",")+"]") // no duration
	})
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	handler := newHandler(parseOrigins(siteOrigin), logger, newService(data, nowhere, logger))
	question := strings.ReplaceAll(placeBody(`"`+aBarOfABigZone(t, data).ID+`"`), `["walk", "transit"]`, `["walk"]`)
	question = strings.ReplaceAll(question, `["bike"]`, `["walk"]`)
	res := postPlace(handler, question, "203.0.113.7")
	var answer PlaceAnswer
	if err := json.NewDecoder(res.Body).Decode(&answer); err != nil || res.StatusCode != http.StatusOK {
		t.Fatalf("status %d, %v", res.StatusCode, err)
	}
	if answer.Place.Reachable || answer.Place.Score != nil || answer.Place.Trips[0] != nil || answer.Place.Trips[1] != nil {
		t.Errorf("place %+v", answer.Place)
	}
}

func TestPlacesHaveTheirOwnQuota(t *testing.T) {
	handler, svc := proposalsHandler(t)
	for k := 0; k < perMinute; k++ {
		if res := postFrom(handler, "203.0.113.7"); res.StatusCode != http.StatusOK {
			t.Fatalf("computation %d: status %d", k+1, res.StatusCode)
		}
	}
	id := `"` + aBarOfABigZone(t, svc.data).ID + `"`
	for k := 0; k < placesPerMinute; k++ {
		if res := postPlace(handler, placeBody(id), "203.0.113.7"); res.StatusCode != http.StatusOK {
			t.Fatalf("place %d after %d computations: status %d", k+1, perMinute, res.StatusCode)
		}
	}
	if res := postPlace(handler, placeBody(id), "203.0.113.7"); res.StatusCode != http.StatusTooManyRequests {
		t.Errorf("place %d in the minute: status %d", placesPerMinute+1, res.StatusCode)
	}
}
