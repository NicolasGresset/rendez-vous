package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"sort"
)

// Categories of candidate places for each place type. A place of another category is only
// for the page's address search: the middleware does not keep it.
var placeCategories = map[PlaceType][]string{
	"station":    {"metro", "bus"},
	"bar":        {"amenity=bar", "amenity=pub", "amenity=biergarten"},
	"cafe":       {"amenity=cafe"},
	"restaurant": {"amenity=restaurant"},
}

// The file as written by scripts/build-places.js and scripts/build-zones.js (docs/pipeline.md § 6); only the
// fields the middleware uses.
type placesFile struct {
	Sources map[string]string `json:"sources"`
	Zones   []struct {
		Kind string  `json:"kind"`
		Name string  `json:"name"`
		Lat  float64 `json:"lat"`
		Lon  float64 `json:"lon"`
	} `json:"zones"`
	Places []struct {
		ID       string  `json:"id"`
		Category string  `json:"category"`
		Name     string  `json:"name"`
		Lat      float64 `json:"lat"`
		Lon      float64 `json:"lon"`
		Zone     *int    `json:"zone"`
		Street   string  `json:"street"`
		Postcode string  `json:"postcode"`
		City     string  `json:"city"`
	} `json:"places"`
}

// Place is a candidate meeting place.
type Place struct {
	ID       string
	Category string
	Name     string
	Lat, Lon float64
	Zone     int // index in Data.Zones, -1 for a station (stations have no zone)
	Address  Address
}

// Address is a place's address, as far as it is known, for the page's links and its share button.
type Address struct {
	Street   string `json:"street,omitempty"`
	Postcode string `json:"postcode,omitempty"`
	City     string `json:"city,omitempty"`
}

// Zone is a group of places within a short walk of each other (docs/evaluation.md § Zones).
type Zone struct {
	Kind           PlaceType
	Name           string
	Lat, Lon       float64
	Members        []int // indices in Data.Places
	Representative int   // the member closest to the zone's position: estimated for the whole zone
}

// Data is what the middleware knows of the places, loaded once at start-up and never changed afterwards (so
// concurrent requests can read it without locking).
type Data struct {
	Places  []Place
	Zones   []Zone
	ByType  map[PlaceType][]int // candidate places of each place type, indices in Places
	ByID    map[string]int      // candidate places by id
	Version DataVersion
}

// DataVersion identifies the file, for the answers (and a future report mode).
type DataVersion struct {
	Sources map[string]string `json:"sources"` // dates of the OpenStreetMap, GTFS and address extracts
	SHA256  string            `json:"sha256"`  // first 12 hex digits of the file's hash
}

// loadData reads and checks the places file. The file comes from this repository, but a broken one must stop the
// start-up rather than give wrong proposals.
func loadData(path string) (*Data, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var file placesFile
	if err := json.Unmarshal(raw, &file); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	sum := sha256.Sum256(raw)
	data := &Data{
		ByType:  map[PlaceType][]int{},
		ByID:    map[string]int{},
		Version: DataVersion{Sources: file.Sources, SHA256: hex.EncodeToString(sum[:])[:12]},
	}
	typeOf := map[string]PlaceType{}
	for placeType, categories := range placeCategories {
		for _, category := range categories {
			typeOf[category] = placeType
		}
	}

	for i, z := range file.Zones {
		kind := PlaceType(z.Kind)
		if !validPlaceTypes[kind] || kind == "station" || !finitePosition(z.Lat, z.Lon) {
			return nil, fmt.Errorf("zone %d: kind %q or position invalid", i, z.Kind)
		}
		data.Zones = append(data.Zones, Zone{Kind: kind, Name: z.Name, Lat: z.Lat, Lon: z.Lon, Representative: -1})
	}

	for _, p := range file.Places {
		placeType, candidate := typeOf[p.Category]
		if p.ID == "" || !candidate {
			continue // for the address search only
		}
		if !finitePosition(p.Lat, p.Lon) {
			return nil, fmt.Errorf("place %s: position invalid", p.ID)
		}
		place := Place{ID: p.ID, Category: p.Category, Name: p.Name, Lat: p.Lat, Lon: p.Lon, Zone: -1,
			Address: Address{Street: p.Street, Postcode: p.Postcode, City: p.City}}
		index := len(data.Places)
		if p.Zone != nil {
			if *p.Zone < 0 || *p.Zone >= len(data.Zones) || data.Zones[*p.Zone].Kind != placeType {
				return nil, fmt.Errorf("place %s: zone %d invalid", p.ID, *p.Zone)
			}
			place.Zone = *p.Zone
			data.Zones[*p.Zone].Members = append(data.Zones[*p.Zone].Members, index)
		} else if placeType != "station" {
			return nil, fmt.Errorf("place %s: a %s without zone", p.ID, placeType)
		}
		if _, twice := data.ByID[p.ID]; twice {
			return nil, fmt.Errorf("place %s: twice", p.ID)
		}
		data.ByID[p.ID] = index
		data.Places = append(data.Places, place)
		data.ByType[placeType] = append(data.ByType[placeType], index)
	}

	for i := range data.Zones {
		zone := &data.Zones[i]
		if len(zone.Members) == 0 {
			return nil, fmt.Errorf("zone %d (%s) has no place", i, zone.Name)
		}
		// The first of the closest, in the file's order
		best := math.Inf(1)
		for _, m := range zone.Members {
			if d := haversine(zone.Lat, zone.Lon, data.Places[m].Lat, data.Places[m].Lon); d < best {
				best, zone.Representative = d, m
			}
		}
	}
	return data, nil
}

func finitePosition(lat, lon float64) bool {
	return !math.IsNaN(lat) && !math.IsNaN(lon) && math.Abs(lat) <= 90 && math.Abs(lon) <= 180
}

// haversine is the great-circle distance in metres.
func haversine(lat1, lon1, lat2, lon2 float64) float64 {
	const earthRadiusM = 6371000
	rad := math.Pi / 180
	dLat := (lat2 - lat1) * rad
	dLon := (lon2 - lon1) * rad
	a := math.Sin(dLat/2)*math.Sin(dLat/2) + math.Cos(lat1*rad)*math.Cos(lat2*rad)*math.Sin(dLon/2)*math.Sin(dLon/2)
	return 2 * earthRadiusM * math.Asin(math.Sqrt(a))
}

// summary is logged at start-up: how many candidates and zones of each type.
func (d *Data) summary() map[string]int {
	counts := map[string]int{"zones": len(d.Zones)}
	types := make([]string, 0, len(d.ByType))
	for t := range d.ByType {
		types = append(types, string(t))
	}
	sort.Strings(types)
	for _, t := range types {
		counts[t] = len(d.ByType[PlaceType(t)])
	}
	return counts
}
