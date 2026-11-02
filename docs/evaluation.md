# Evaluating the choice of meeting places

How good are the 3 places the tool proposes, compared with the best places of the whole file?
Scripts in `scripts/eval/` (not deployed), started 2026-10-30. The question behind it: would
another way of choosing where to look (weighted geometric median, cheap estimate over every
place, a second round…) propose better places, in particular in degenerate cases?

## Vocabulary

- **starting point**: where a participant leaves from (a group of people may share one);
- **candidate place** (lieu candidat): a place of a candidate category in
  `data/pois-toulouse.json`: 573 bars (`amenity=bar`, `pub`, `biergarten`, `cafe`), 1,456 restaurants,
  37 metro stations, 1,742 bus stops (3,808 in all, 2026-11-02);
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
  transit; a car, a bike, then walk + transit; everyone walk + bike. Meeting time: Tuesday
  2026-11-03, 19:00, late tolerance 10 min (the tool's default; 15 min, the former slot, until the
  first results below). Candidate categories: bars (the tool's default) and all three.
- `oracle.js`: for every case, every participant's time to every candidate place by walk, bike,
  car and transit. Transit is computed as the tool does (`transitTrip` of `transitous.js`
  against the local server): `/plan` arriving by the meeting time + tolerance, an early arrival counting the
  wait until it starts. About 2.5 min per case (~12,000 `/plan` calls of ~20 ms). It also keeps
  MOTIS one-to-many durations for an arrival at meeting time + tolerance (`transitEstimate`), ~100
  times cheaper but counting the time up to that limit (checked with 15 min: 0 to 15 min more, plus ~2 min).
- `baseline.js`: the tool's `evaluate()` of `engine.js`, unchanged, on every case, configuration
  and category set; its Transitous calls go to the local server and its openrouteservice
  matrices are answered with MOTIS street times, so that the tool and the oracle use the same
  times. Its 3 proposals are compared with the 3 best candidate places of the file.
- `scoring.js`: two scores, lower is better: the mean time per person (the tool's "temps
  total" gives the same ranking), and the mean plus half the excess of the longest trip over the
  mean, `(1 − β)·mean + β·max` with β = ½ (decided 2026-10-30). Unlike the tool's "moyenne +
  écart", lengthening someone's trip never improves it: with two people, (10, 30) min gives mean +
  gap 40 and (20, 30) gives 35, although nobody gains.
- `journeys.js` and `sensitivity.js`: do the arrival rules change the proposals? The transit
  journeys themselves (two `/plan` calls per pair: arriving by 19:00 and by 19:15, ~4 min per
  case), then every place ranked under each rule (late tolerance 0, 5, 10, 15 min; with or without
  the first one to arrive counting the time until the second one arrives) and compared with the
  tool's (10 min, without), for the transit and mixed configurations.
- `validate.js`: the oracle against the services the tool uses: 30 transit trips also asked to
  the Tisséo API (60 calls), and 3 openrouteservice matrices (walk, bike, car; 10 x 10).

## Demonstrator in the page (developer's machine only)

With the dev server and a local MOTIS, the page offers a fourth transit engine, "MOTIS local
(démo)", and the demonstrator view a test case picker (the cases of `cases.js`, x 3 mode
configurations, slot 19:00 today) and a "Lignes Tisséo" map layer.

- `scripts/dev-server.js` relays `/motis/…` to `MOTIS_URL` (default `http://localhost:8080`): the
  page calls its own origin, no Content-Security-Policy or CORS change. Elsewhere than on
  `localhost`, `motis.available()` is false without any call and nothing is offered; the code is
  deployed with the page but stays unused (`js/motis.js`, `js/demo-motis.js`).
- With that engine, the tool runs as usual (barycenter, 8 candidates), its street times and
  paths also from MOTIS (no openrouteservice key needed), then `demo-motis.js` scores every
  candidate place of the picked categories: exact transit times for every place up to 600 places
  (bars: 573, not timed since the cafés; 240 took ~5 s), beyond that a cheap estimate for every place and exact times for the 100
  best of each score (all categories: ~40 s).
- Map: every place as a dot from green (the best) through yellow (+50 %) to red (twice the best),
  the best 3 as green pins, the tool's search radius dashed. Results: the tool's first proposal
  against the best of the file (gap, rank), the best 3 with each participant's mode and time.
- Lines: MOTIS `/api/experimental/map/routes` (GTFS shapes and colors), metro and tram thick.
- Time map (layer "Carte des temps (estimée)", computed when switched on, ~30 s): a grid of at
  most 2,500 cells (200 m or more) over the participants and the 10 best places + 1.5 km, scored
  like the places; street times exact, transit the cheap estimate (0 to 15 min too long). One
  pixel per cell stretched over the box, same colors as the places. Another score only redraws it.
- Test cases: those of `cases.js`, plus `DEMO_CASES` found with the demonstrator (picker only).
- A third score in the settings, "moyenne + ½ (max − moyenne)" (`half` in `engine.js`).

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

The same with a 10 min tolerance (the tool's default since 2026-10-30), oracle rebuilt: hardly any
change. Gap median / mean / max: mean score 1.3 / 1.7 / 6.7 (bars) and 1.5 / 2.2 / 7.0 (all);
mean + ½ (max − mean) 0.9 / 2.4 / 8.4 (bars) and 2.0 / 3.2 / 16.6 (all); rows above 5 min: 2, 4, 8,
7. Walk + bike still close (median 0.6, max 3.1), transit and mixed not (median 2.7 and 1.8, max
9.2 and 16.6).

### Arrival rules (`sensitivity.js`, 2026-10-30)

80 rows per rule (10 cases x transit and mixed x bars and all x 2 scores). Loss: how much worse,
under the rule's own definition, the place the tool's rule (10 min) puts first is than the best
place under the rule, in minutes per person.

| rule | same first place | places in common in the top 3 | loss median / max | mean best score |
|---|---|---|---|---|
| 0 min | 21 % | 0.90 | 0.6 / 6.1 | 27.3 |
| 5 min | 66 % | 2.11 | 0.0 / 6.7 | 25.5 |
| 10 min (tool) | 100 % | 3 | 0 / 0 | 24.8 |
| 15 min | 85 % | 2.50 | 0.0 / 2.8 | 24.6 |
| 10 min + first alone | 91 % | 2.85 | 0.0 / 0.3 | 24.9 |

- Counting the first one's wait until the second one arrives changes almost nothing (at most
  0.3 min lost): not worth its complexity. At 0 min it changes nothing at all (everyone counts up
  to the meeting time).
- The tolerance reorders the places (many are within a minute of each other), but the rule
  picked costs little: from 5 min on, the median loss is 0 and the worst 2.8 to 6.7 min; the mean
  best score shifts with it (27.3 -> 24.6 min). Whether that shift is the same for every place was
  not measured directly. One meeting time only (Tuesday 19:00, frequent service): at off-peak hours,
  where the tolerance matters most, the effect may be larger. 0 min reorders much more (same first place in 21 % of the rows).
- Computing cost: the same for any tolerance (one arrive-by search).
- Check: the stored journeys give back the oracle's time at 10 min for 98.2 % of the pairs
  (119,493 / 121,730); otherwise −6 to +8 min (median +1): two lists of 5 journeys do not always
  hold the best one. Also a sign that the tool's own 5 journeys are not always optimal.

### Diversity of the candidates (`diversity.js`, 2026-11-02)

The former rule took the closest places: in 20 to 26 rows of 30, two of the 3 proposals were
within 300 m of each other (median of the smallest distance: 95 to 143 m). Each rule below replayed
on the oracle, score mean + ½ (max − mean), bars then all categories; "last": the third proposal
against the best place of the file.

| 8 candidates | first, gap mean | gap max | rows > 5 min | last, gap mean | closest 2 proposals, median |
|---|---|---|---|---|---|
| closest (former) | 2.4 / 3.2 | 8.4 / 16.6 | 8 / 7 | 4.7 / 4.8 | 119 / 104 m |
| 500 m apart | 1.7 / 2.5 | 6.8 / 9.2 | 3 / 5 | 4.6 / 4.6 | 647 / 554 m |
| **700 m apart (tool)** | **1.3 / 2.3** | **6.7 / 10.7** | **1 / 3** | **4.8 / 4.9** | **787 / 740 m** |
| 800 m apart | 1.3 / 2.2 | 5.7 / 9.2 | 1 / 5 | 4.8 / 5.2 | 830 / 886 m |
| 1,200 m apart | 2.1 / 2.4 | 6.3 / 10.7 | 4 / 2 | 6.3 / 5.6 | 1,257 / 1,242 m |
| farthest-point, 1.5 km disk | 2.2 / 3.1 | 14.4 / 10.7 | 4 / 8 | 4.2 / 5.9 | 716 / 940 m |

- 700 m picked by the user, 800 m felt too much; the two measure alike. The results are not
  monotonic in the spacing (mean score, bars: 500 m 1.3, 700 m 0.7, 800 m 1.1): small differences
  between neighbouring spacings are noise on 10 groups and one meeting time.
- `baseline.js` with the tool's own `evaluate()` confirms it. Gap median / mean / max: mean score 0.4 /
  0.7 / 2.9 (bars) and 0.9 / 1.3 / 4.7 (all); mean + ½ (max − mean) 0.7 / 1.3 / 6.8 (bars) and 1.2 / 2.3 / 10.7 (all);
  rows above 5 min: 0, 0, 1, 3. By configuration (mean + ½ (max − mean)), mean gap: transit 3.9 -> 2.6,
  mixed 3.8 -> 2.2, walk + bike 0.7 -> 0.7.
- A minimum distance between the 3 proposals only, the candidates staying close, leaves fewer than
  3 proposals in 7 to 28 rows of 30 and does not improve the first one.
- Cost: 8 candidates in every row instead of 7.3 to 7.4 on average, so ~8 % more calls; the farthest
  one at 1.4 to 1.5 km from the barycenter instead of 0.6 to 0.8 km (median). Groups within about
  1 km of each other were not measured (out of the tool's use, as the user said).
- Whole file (the home server): the same rule on the ranking leaves the first place unchanged; 700 m
  costs 3.0 min on the third place (bars) and 1.5 min (all), mean + ½ (max − mean), instead of 1.3 and 0.4 min.

### Clusters of bars (`clusters.js`, 2026-11-02, not implemented)

Idea of the user: propose areas where bars are within a short walk of each other (Carmes, allées
Jean Jaurès) rather than single bars; score one point of each, then pick inside.

- Grouping the 240 `amenity=bar` of the time (pubs and cafés came after, same day). Chaining bars within a distance runs away: 250 m gives 115 bars over 2.3 km.
  With a maximum diameter (complete linkage, greedy): 200 m, 138 groups, 24 of 3 bars or more (102 bars);
  300 m, 117 groups, 27 (136 bars), 76 bars alone; 400 m, 103 groups, 26 (152 bars). 3 min of walking
  is ~216 m at MOTIS's speed. Cuts are arbitrary: at 300 m the Carmes make two groups (10 and 8 bars).
- Interchangeable members? Range of the score inside a group of 3 bars or more (mean + ½ (max −
  mean), 30 rows), median / 90 % / max: 0.8 / 2.9 / 7.2 min at 200 m, 1.0 / 3.8 / 7.3 at 300 m. Walk +
  bike 0.3 / 0.8 at 200 m, transit 1.3 / 3.6: often equivalent, not always with transit.
- Pipeline, bars, same score; a group's point is its member closest to its centroid, 8 spaced
  by 700 m, 300 m groups. First gap mean / max, rows > 5 min, last gap, places evaluated:
  - 8 spaced bars (tool): 1.3 / 6.7, 1, 4.8, 8;
  - groups of 3 or more, their point: 1.6 / 5.5, 1, 4.0, 8;
  - then every member of the 3 best groups: 0.9 / 3.9, 0, 3.5, 18.6;
  - groups and lone bars, every member of the 3 best: 1.2 / 5.5, 1, 4.6, 14.1.
- Not measured: restaurants and all categories.
- With pubs, biergartens and cafés (573 bars), 88 zones of 2 or more, measured by MOTIS: the walk is 1.4
  times the straight line (median; 90 %: 1.9), so 20 of the 300 m zones had a walk over 5 min. Max 5
  min on foot directly gives 225 zones (60 of 3 or more, 137 alone, largest 18), as a split of the
  300 m zones does (227, 61, 138, 21), with one rule instead of two: picked, and the walk limit in
  the data file since. Some detours look odd but are kept: Le Cri de la Mouette, a barge, is 73 m
  from Friend's Café across the water, 9.1 min on foot (Google Maps: 4 min).
- Names: closest metro or bus stop (bus stops name 66 of the 88 zones). Priority to the metro makes more shared names (fewer
  stations); street names resolve them: no shared name left. `docs/pipeline.md` § 6.

### Bars, pubs, biergartens and cafés (2026-11-02)

"Bars" now means `amenity=bar`, `pub`, `biergarten` and `cafe` (573 places, 3,808 candidate places): the
Black Lion, a pub, was missing. File regenerated (OSM of 2026-10-28), oracle rebuilt; the figures
above were on 240 bars. `baseline.js`, gap median / mean / max, rows above 5 min of 30:

| score | places | gap median | gap mean | gap max | rows > 5 min |
|---|---|---|---|---|---|
| mean | bars | 1.0 | 1.6 | 5.5 | 1 |
| mean | all | 0.9 | 1.2 | 5.7 | 1 |
| mean + ½ (max − mean) | bars | 1.1 | 2.1 | 6.0 | 3 |
| mean + ½ (max − mean) | all | 1.2 | 2.1 | 8.5 | 3 |

By configuration (mean + ½ (max − mean), mean gap): transit 3.0, mixed 2.6, walk + bike 0.7. The best place
of the file: within 1 km of the barycenter in 43 rows of 120, 1 to 3 km in 71, beyond 3 km in 6.

### The method planned with the zones (`zones.js`, 2026-11-02, not in the engine yet)

Bars, 30 rows, mean + ½ (max − mean), against the best bar of the file. Each zone's representative scored
within a radius of the barycenter (growing until 8 zones), the best 3 zones at least 700 m apart,
then every bar of these 3 scored and the best of each shown. Journeys: transit journeys, mean over
the configurations (walk + bike needs none) / most.

| method | first, gap median / mean / max | rows > 5 min | last, gap mean | places scored | journeys |
|---|---|---|---|---|---|
| the tool: 8 bars 700 m apart | 1.1 / 2.1 / 6.0 | 3 | 4.9 | 8 | 13 / 32 |
| every bar, best 3 apart | 0 / 0 / 0 | 0 | 2.4 | 573 | 955 / 2,292 |
| every zone, then inside | 0.0 / 0.1 / 0.5 | 0 | 2.5 | 240 | 401 / 1,008 |
| zones within 2 km, then inside | 0.0 / 0.9 / 8.1 | 2 | 3.6 | 58 | 96 / 348 |
| **zones within 3 km, then inside** | **0.0 / 0.2 / 4.8** | **0** | **3.1** | **87** | **148 / 464** |
| zones within 4 km, then inside | 0.0 / 0.2 / 4.8 | 0 | 2.8 | 109 | 186 / 532 |

- The second round adds little to the first proposal's gap (0.4 -> 0.2 min at 3 km), but it gives
  each zone's actual best bar, which the times shown need.
- Same 10 groups the rules were looked at with, one meeting time: to be confirmed on other groups and at off-peak hours.
- Scores are the oracle's (Tisséo only). Local MOTIS served ~100 journeys a second on a 16-core PC.
