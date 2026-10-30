# Evaluating the choice of meeting places

How good are the 3 places the tool proposes, compared with the best places of the whole file?
Scripts in `scripts/eval/` (not deployed), started 2026-10-30. The question behind it: would
another way of choosing where to look (weighted geometric median, cheap estimate over every
place, a second round…) propose better places, in particular in degenerate cases?

## Vocabulary

- **starting point**: where a participant leaves from (a group of people may share one);
- **candidate place** (lieu candidat): a place of a candidate category in
  `data/pois-toulouse.json`: 240 bars, 1,459 restaurants, 37 metro stations, 1,742 bus stops
  (3,478 in all, 2026-10-30);
- **proposals**: the 3 candidate places the tool shows, its output;
- **stop**: a stop of the Tisséo network (GTFS).

## The oracle: a local MOTIS

[MOTIS](https://github.com/motis-project/motis) (MIT licence) is the routing engine behind
Transitous. Run locally on the Tisséo GTFS and an OpenStreetMap extract, it answers without
quota, so every participant's time to every candidate place can be computed exactly. Its
public transport core (`nigiri`) implements RAPTOR (and a GPU variant) and Trip-Based Routing,
not CSA. Network: Tisséo only (no TER, no liO), unlike Transitous.

Set up (2026-10-30, MOTIS v2.11.4, outside the repository, in `~/motis`):

```bash
mkdir -p ~/motis && cd ~/motis
curl -fLO https://github.com/motis-project/motis/releases/download/v2.11.4/motis-linux-amd64.tar.bz2
tar xf motis-linux-amd64.tar.bz2
# Tisséo GTFS (open data, no key): the file tisseo_gtfs_v2.zip of this dataset
URL=$(curl -fsSL 'https://data.toulouse-metropole.fr/api/explore/v2.1/catalog/datasets/tisseo-gtfs/records?limit=20' \
  | python3 -c "import json,sys; print([r['file']['url'] for r in json.load(sys.stdin)['results'] if (r.get('file') or {}).get('filename') == 'tisseo_gtfs_v2.zip'][0])")
curl -fsSL -o tisseo-gtfs.zip "$URL"
# OpenStreetMap: Geofabrik's Midi-Pyrénées extract, cut to the Tisséo area + 0.1° (364 -> 77 MB)
curl -fLO https://download.geofabrik.de/europe/france/midi-pyrenees-latest.osm.pbf
osmium extract -b 1.10,43.32,1.72,43.85 midi-pyrenees-latest.osm.pbf -o toulouse.osm.pbf
./motis config toulouse.osm.pbf tisseo-gtfs.zip
```

Then, in `config.yml`: remove the `tiles:` section, set `num_days: 40` (the GTFS covers about
5 weeks), `osr_footpath: true` (transfers walked on the street network), `geocoding: false`,
`reverse_geocoding: false`, and add

```yaml
limits:
  onetomany_max_many: 4000
```

(default 128: one street call must reach every candidate place). `./motis import` (5 s, 107 MB
in `data/`), then `./motis server` (port 8080). The server reads `data/config.yml`, the copy made
by the import: a later change of `config.yml` must be copied there too (or imported again).

The GTFS must cover the evaluated date (`scripts/eval/cases.js`): the feed of 2026-10-30 runs
from 2026-10-29 to 2026-12-02. A new feed changes the times: the oracle must then be rebuilt.

### Street times in MOTIS (`osr`, read in its profiles, 2026-10-30)

- walk: distance on the footways / streets at 1.2 m/s (4.3 km/h); busy roads cost more for the
  route choice, not for the time;
- bike: 4.2 m/s (15 km/h) whatever the slope (the elevation only steers the route choice, and only
  when elevation data is loaded, which is not the case here);
- car: each way at its speed limit (OSM `maxspeed`, else most likely a default per road type); U-turns
  penalized; no traffic, no traffic lights, no junction delays. The tool adds 5 min to park, as
  for openrouteservice.

## Method

- `cases.js`: 10 groups (5 of 3, 5 of 4) of starting points (town halls and neighbourhood places,
  not metro stations, which would favour transit), each in 3 mode configurations: everyone walk +
  transit; a car, a bike, then walk + transit; everyone walk + bike. Arrival slot: Tuesday
  2026-11-03, 19:00-19:15. Candidate categories: bars (the tool's default) and all three.
- `oracle.js`: for every case, every participant's time to every candidate place by walk, bike,
  car and transit. Transit is computed as the tool does (`transitTrip` of `transitous.js`
  against the local server): `/plan` arriving by the end of the slot, an early arrival counting the
  wait until it starts. About 2.5 min per case (~12,000 `/plan` calls of ~20 ms). It also keeps
  MOTIS one-to-many durations for an arrival at the end of the slot (`transitEstimate`), ~100 times
  cheaper but counting the time up to the end of the slot (checked: 0 to 15 min more, plus ~2 min).
- `baseline.js`: the tool's `evaluate()` of `engine.js`, unchanged, on every case, configuration
  and category set; its Transitous calls go to the local server and its openrouteservice
  matrices are answered with MOTIS street times, so that the tool and the oracle use the same
  times. Its 3 proposals are compared with the 3 best candidate places of the file.
- `scoring.js`: two scores, lower is better: the mean time per person (the tool's "temps
  total" gives the same ranking), and the mean plus half the excess of the longest trip over the
  mean, `(1 − β)·mean + β·max` with β = ½ (decided 2026-10-30). Unlike the tool's "moyenne +
  écart", lengthening someone's trip never improves it: with two people, (10, 30) min gives mean +
  gap 40 and (20, 30) gives 35, although nobody gains.
- `validate.js`: the oracle against the services the tool uses: 30 transit trips also asked to
  the Tisséo API (60 calls), and 3 openrouteservice matrices (walk, bike, car; 10 x 10).

## Results (2026-10-30)

### The oracle against the services the tool uses (`validate.js`)

- Transit, Tisséo API vs oracle, 30 trips: 25 answered by both, mean |difference| 1.8 min, median
  −0.9 min (Tisséo slightly faster), extremes −9.4 and +4.7 min. Tisséo gave no journey for 5
  trips of 56 to 69 min: the tool's Tisséo calls only look at journeys leaving from 1 h before the
  end of the slot (`tisseo.js`).
- The tool's own transit times (`/plan` through `transitous.js`) and the oracle's are the same on
  all 721 pairs the baseline asked: by construction, a check of the plumbing.
- The cheap estimate (one-to-many at the end of the slot) is 8 min above the exact time (median;
  −8 to +33 min, 118,000 pairs): usable to filter, not to rank.
- Street, openrouteservice / MOTIS (median ratio, 100 pairs each): walk 0.88 (openrouteservice
  walks at 5 km/h, MOTIS 4.3), bike 0.90, car **1.40**: MOTIS drives at the speed limits, so its
  car is optimistic in town. The tool and the oracle use the same MOTIS times here, so the
  comparison holds, but car participants look faster than in the deployed tool.

### The tool against the best places of the file (`baseline.js`)

30 rows per score and category set (10 cases x 3 configurations). Gap: score of the tool's first
proposal minus the best score of the file, in minutes per person.

| score | places | gap median | gap mean | gap max | rows > 5 min |
|---|---|---|---|---|---|
| mean | bars | 1.2 | 1.5 | 6.7 (+19 %) | 2 |
| mean | all | 1.8 | 2.2 | 6.9 | 3 |
| mean + ½ (max − mean) | bars | 0.7 | 2.1 | 7.8 | 6 |
| mean + ½ (max − mean) | all | 1.9 | 3.2 | 16.6 (+102 %) | 5 |

- By configuration (both scores, both category sets): walk + bike is close to the best (median
  gap 0.3 to 0.8 min, max 3.1), transit and mixed modes are not (median 1.5 to 2.6 min, max 9.8
  and 16.6 min). As expected: with similar speeds, places near the barycenter are near the
  minimum; with transit and different modes, they are not.
- The best place of the file lies 1 to 3 km from the barycenter in 72 rows of 120, within 1 km
  (the tool's first search radius) in 44, beyond 3 km in 4: the best places are often just
  outside the tool's search, typically near a metro station.
- The tool's first proposal is often far down the file's ranking (e.g. 124th of 235 bars for T2
  in transit), although its score is only a few minutes worse: many places are close to the best.
- Worst row: T5 (south-west outskirts), mixed modes, all categories, mean + ½ (max − mean): the
  tool proposes 33 min, the best place (the Méroc bus stop, 1.8 km from the barycenter) 16 min.
  The tool found only 5 candidates around a barycenter in a sparse area.

Full tables: `node scripts/eval/baseline.js` (20 s once the oracle is built).
