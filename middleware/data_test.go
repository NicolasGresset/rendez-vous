package main

import (
	"os"
	"path/filepath"
	"testing"
)

// The repository's own file: the image is built with it, so it must load.
const repoPlacesFile = "../data/pois-toulouse.json"

func TestRepositoryFileLoads(t *testing.T) {
	data, err := loadData(repoPlacesFile)
	if err != nil {
		t.Fatal(err)
	}
	if len(data.Zones) == 0 || len(data.ByType["station"]) == 0 || len(data.ByType["bar"]) == 0 {
		t.Fatalf("counts %v", data.summary())
	}
	if len(data.Version.SHA256) != 12 || data.Version.Sources["gtfs"] == "" {
		t.Errorf("version %+v", data.Version)
	}
	for i, zone := range data.Zones {
		rep := data.Places[zone.Representative]
		if rep.Zone != i {
			t.Fatalf("zone %d: representative %s is in zone %d", i, rep.ID, rep.Zone)
		}
		// The representative is the closest member to the zone's position
		d := haversine(zone.Lat, zone.Lon, rep.Lat, rep.Lon)
		for _, m := range zone.Members {
			if haversine(zone.Lat, zone.Lon, data.Places[m].Lat, data.Places[m].Lon) < d {
				t.Fatalf("zone %d: %s is closer than its representative", i, data.Places[m].ID)
			}
		}
	}
	for _, i := range data.ByType["station"] {
		if data.Places[i].Zone != -1 {
			t.Fatalf("station %s has a zone", data.Places[i].ID)
		}
	}
}

func TestBrokenFilesAreRefused(t *testing.T) {
	zone := `{"kind": "bar", "name": "Z", "lat": 43.6, "lon": 1.44}`
	bar := func(zoneField string) string {
		return `{"id": "node/1", "category": "amenity=bar", "name": "B", "lat": 43.6, "lon": 1.44` + zoneField + `}`
	}
	cases := map[string]string{
		"not json":           `{"places": [`,
		"zone out of range":  `{"zones": [` + zone + `], "places": [` + bar(`, "zone": 1`) + `]}`,
		"negative zone":      `{"zones": [` + zone + `], "places": [` + bar(`, "zone": -1`) + `]}`,
		"bar without zone":   `{"zones": [` + zone + `], "places": [` + bar(``) + `]}`,
		"zone without place": `{"zones": [` + zone + `], "places": []}`,
		"zone of a station":  `{"zones": [{"kind": "station", "name": "S", "lat": 43.6, "lon": 1.44}], "places": []}`,
		"zone of other kind": `{"zones": [{"kind": "cafe", "name": "C", "lat": 43.6, "lon": 1.44}], "places": [` + bar(`, "zone": 0`) + `]}`,
	}
	for name, content := range cases {
		t.Run(name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "places.json")
			if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
				t.Fatal(err)
			}
			if _, err := loadData(path); err == nil {
				t.Error("accepted")
			}
		})
	}
}

func TestOnlyCandidatesAreKept(t *testing.T) {
	content := `{"zones": [], "places": [
		{"category": "amenity=bank", "name": "Banque", "lat": 43.6, "lon": 1.44},
		{"id": "node/2", "category": "office=company", "name": "Bureau", "lat": 43.6, "lon": 1.44},
		{"id": "metro/1", "category": "metro", "name": "Capitole", "lat": 43.6045, "lon": 1.4442}
	]}`
	path := filepath.Join(t.TempDir(), "places.json")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	data, err := loadData(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(data.Places) != 1 || data.Places[0].Name != "Capitole" || len(data.ByType["station"]) != 1 {
		t.Errorf("places %+v", data.Places)
	}
}

func TestHaversine(t *testing.T) {
	// Capitole to the Ramonville metro station: 5,953 m as the crow flies (the same formula in Python)
	if d := haversine(43.6045, 1.4442, 43.5557, 1.4746); d < 5952 || d > 5954 {
		t.Errorf("%.0f m", d)
	}
}
