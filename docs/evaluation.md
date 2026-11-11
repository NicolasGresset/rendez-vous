# Evaluating the choice of meeting places

How good are the 3 places the tool proposes, compared with the best places of the whole file?
Scripts in `scripts/eval/` (not deployed), started 2026-10-30. The question behind it: would
another way of choosing where to look (weighted geometric median, cheap estimate over every
place, a second round…) propose better places, in particular in degenerate cases?

## Vocabulary

- **starting point**: where a participant leaves from (a group of people may share one);
- **candidate place** (lieu candidat): a place of a candidate category in
  `data/pois-toulouse.json`: 316 bars (`amenity=bar`, `pub`, `biergarten`), 257 cafés, 1,456 restaurants,
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
  car and transit. Transit is computed as the service does (`transitTrip` of `common.js`,
  the rule of `middleware/motis.go`, against the local server): `/plan` arriving by the meeting time + tolerance, an early arrival counting the
  wait until it starts. About 2.5 min per case (~12,000 `/plan` calls of ~20 ms). It also keeps
  MOTIS one-to-many durations for an arrival at meeting time + tolerance (`transitEstimate`), ~100
  times cheaper but counting the time up to that limit (checked with 15 min: 0 to 15 min more, plus ~2 min).
- `baseline.js`: since 2026-11-08, the service's proposals, asked to its API (a local middleware on a MOTIS with the
  oracle's timetable), for every case, configuration and place type, compared with the 3 best candidate places of the
  file. The API refuses a past date: the oracle is then built for a date to come (`EVAL_DATE`, `EVAL_DIR`). Until
  2026-11-08 it ran the former page's `evaluate()` (`engine.js`, removed), its Transitous calls sent to the local server
  and its openrouteservice matrices answered with MOTIS street times: the results of 2026-10-30 to 2026-11-03 below were
  measured that way.
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
- `validate.js` (removed 2026-11-08 with openrouteservice and the Tisséo API): the oracle against the services the tool
  used then: 30 transit trips also asked to the Tisséo API (60 calls), and 3 openrouteservice matrices (walk, bike, car;
  10 x 10).

## Debug view in the page (developer's machine only; removed 2026-11-08)

Removed with the page's engines when the computation moved to the server. What it offered, for the measures made with it below:

With the dev server and a local MOTIS, the page offers a fourth transit engine, "MOTIS local
(debug)", and the debug view a test case picker (the cases of `cases.js`, x 3 mode
configurations, slot 19:00 today) and a "Lignes Tisséo" map layer.

- `scripts/dev-server.js` relays `/motis/…` to `MOTIS_URL` (default `http://localhost:8080`): the
  page calls its own origin, no Content-Security-Policy or CORS change. Elsewhere than on
  `localhost`, `motis.available()` is false without any call and nothing is offered; the code is
  deployed with the page but stays unused (`js/motis.js`, `js/debug-motis.js`).
- With that engine, the tool runs as usual (barycenter, 8 candidates), its street times and
  paths also from MOTIS (no openrouteservice key needed), then `debug-motis.js` scores every
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
- Test cases: those of `cases.js`, plus `DEBUG_CASES` found with the debug view (picker only).
- The method by zones (`scoreZones`, § Around which center): 3 zones with their best place and
  the others folded, against the best place of the file; a layer per kind of zone. Every place of the
  file is a layer too, off by default.
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

Full tables then: `baseline.js` as it was (20 s once the oracle was built). Since 2026-11-08 it asks the API (§ The service against the best places).

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

### Bars, pubs, biergartens; cafés apart (2026-11-02)

"Bars" now means `amenity=bar`, `pub`, `biergarten` (316 places; the Black Lion, a pub, was missing), and
"cafés" is a fourth type (257). 3,808 candidate places. File regenerated (OSM of 2026-10-28), oracle
rebuilt; the figures above were on 240 bars. `baseline.js`, gap median / mean / max, rows above 5 min of 30:

| score | places | gap median | gap mean | gap max | rows > 5 min |
|---|---|---|---|---|---|
| mean | bars | 0.5 | 0.9 | 2.9 | 0 |
| mean | all four | 1.1 | 1.6 | 6.3 | 2 |
| mean + ½ (max − mean) | bars | 0.8 | 1.6 | 7.1 | 3 |
| mean + ½ (max − mean) | all four | 1.4 | 2.0 | 7.3 | 1 |

### The method with the zones (`zones.js`, 2026-11-02, in the debug view then; the service's method since 2026-11-08)

Bars, 30 rows, mean + ½ (max − mean), against the best bar of the file. Each zone's representative scored
within a radius of the barycenter (growing until 8 zones), the best 3 zones at least 700 m apart,
then every bar of these 3 scored and the best of each shown. Journeys: transit journeys, mean over
the configurations (walk + bike needs none) / most.

| method | first, gap median / mean / max | rows > 5 min | last, gap mean | places scored | journeys |
|---|---|---|---|---|---|
| the tool: 8 bars 700 m apart | 0.8 / 1.6 / 6.9 | 3 | 5.2 | 8 | 13 / 32 |
| every bar, best 3 with no rule | 0 / 0 / 0 | 0 | 1.1 | 316 | 527 / 1,264 |
| every bar, best 3 apart | 0 / 0 / 0 | 0 | 2.7 | 316 | 527 / 1,264 |
| every zone, then inside | 0.0 / 0.0 / 0.3 | 0 | 2.9 | 170 | 287 / 720 |
| zones within 2 km, then inside | 0.0 / 1.0 / 8.4 | 3 | 4.2 | 40 | 68 / 256 |
| **zones within 3 km, then inside** | **0.0 / 0.3 / 6.6** | **1** | **3.5** | **63** | **108 / 344** |
| zones within 4 km, then inside | 0.0 / 0.3 / 6.6 | 1 | 3.3 | 77 | 134 / 392 |

- The second round adds little to the first proposal's gap (0.4 -> 0.3 min at 3 km), but it gives
  each zone's actual best bar, which the times shown need.
- Why the first proposal is not the best bar, at 3 km (30 rows): found in 22; 5 rows, at most 0.3 min, a
  better zone within 700 m; 1 row, 0.1 min, a representative worse than its zone's best bar; 2 rows, up
  to 6.6 min, the best bar beyond the radius. So the radius causes the large misses.
- Variety: with no rule, the 3 best bars are a median 96 m apart, and 2 of them share a zone in 25 rows of
  30. It is the 700 m between zones that spreads them (759 m), as it does for every bar scored (725 m).
- Same 10 groups the rules were looked at with, one meeting time: to be confirmed on other groups and at off-peak hours.
- Scores are the oracle's (Tisséo only). Local MOTIS served ~100 journeys a second on a 16-core PC.

### Around which center, how far apart? (`centers.js`, 2026-11-02)

Decided by the user: every zone estimated, no center nor radius; 500 m between zones. These values were
measured on Toulouse's bars: for another city, redo the reasoning and the measures, not the values.

Bars, 30 rows, mean + ½ (max − mean), first proposal against the best bar of the file; 700 m between
zones unless said. Straight-line speeds measured on the oracle, km/h (median): walk 3.7, bike 12.6, car 26
(12 under 3 km, 35 over 12 km), transit 10 (6 under 3 km, 12 over 12 km). A median's weight: people / speed of the fastest mode.

| zones scored | gap mean / max | rows > 5 min | journeys mean / max | estimates |
|---|---|---|---|---|
| within 3 km of the barycenter | 0.3 / 6.6 | 1 | 108 / 344 | 0 |
| within 3 km of the geometric median, people | 1.4 / 13.2 | 2 | 101 / 320 | 0 |
| within 3 km of the geometric median, people / speed | 1.6 / 12.1 | 4 | 96 / 320 | 0 |
| within 3 km of the point with the best score (distance / speed) | 0.2 / 3.1 | 0 | 93 / 336 | 0 |
| every zone estimated (one-to-many), the 20 best exact | **0.0 / 0.3** | **0** | **52 / 156** | **161** |

- The geometric median is worse than the barycenter on this score: it minimizes a sum, so it ignores the
  one coming from far, whom the score protects. With the mean score it is about even (0.2 / 4.4
  against 0.1 / 2.3).
- The estimate is biased (0 to 10 min too long, `oracle.js`) but good enough to filter. 161 estimates took
  1.7 s (8 in parallel, local MOTIS). No center nor radius is needed. Not measured on restaurants (581 zones).
- Distance between the 3 zones kept (barycenter, 3 km; closest two, median; rows with two under 300 m; third
  place's gap): none 264 m, 15 rows, 2.1 min; 300 m 549 m, 3 rows, 2.7 min; 500 m 659 m, 0, 3.0 min; 700 m 759 m, 0,
  3.5 min. So zones alone do not spread the proposals: neighbouring zones are often the best 3.
- How the estimate works (`src/endpoints/one_to_many.cc`, MOTIS v2.11.4): one RAPTOR search backward from the
  place at the fixed arrival time, over the whole network and round by round (one per transfer), then
  for each starting point the walk to its nearby stops plus the time read at those stops. So one
  search serves every participant, and no journey is rebuilt. It is not a rough routing: it is too long
  because the time runs up to the end of the tolerance, even for a journey arriving earlier.
- In the debug view (T4, transit, local MOTIS, 8 in parallel): bars, 161 zones estimated, 87 exact journeys,
  2.7 s (2.3 s with the 3 km radius: not faster here, but no radius). Bars, cafés and restaurants (T2, transit):
  851 zones, 120 journeys, 10 s: the estimate grows with the zones.
- One search per participant instead of one per zone (`estimates.js`, adopted 2026-11-02): forward, leaving 60 min before
  the meeting time, read at every zone; T4, 161 zones: 3 searches, 0.5 s instead of 1.6 s; 851 zones 2 s. 20 zones
  scored exactly, not 10: Tuesday 19:00 can do with 10, but off-peak the first proposal then loses more (mean score,
  mean / max, 10 then 20 zones: Tuesday 14:30 0.4 / 2.0, 0.1 / 0.7; 22:00 0.7 / 4.7, 0.2 / 1.0; Sunday 10:30 0.3 / 2.3, 0.0 / 0.2). More
  zones are scored while fewer than 3 are kept 500 m apart. Walk + transit, 10 groups. In the practical view (T4,
  local MOTIS, 8 in parallel): bars 1.8 s, bars, cafés and restaurants (851 zones) 3.2 s, 10 participants and bars 4.0 s.

### The method retained, in the page (2026-11-02, branch `practical-zones`)

Every case of `cases.js`, practical view, local MOTIS (16-core PC, 8 in parallel), today at 19:00; calls counted in the
page, times from the button to the end. Median / most:

| | runs | time | `/plan` journeys | all calls |
|---|---|---|---|---|
| bars, walk + transit | 10 | 1.8 / 2.3 s | 104 / 156 | 115 / 168 |
| bars, car, bike, walk + transit | 10 | 1.2 / 1.7 s | 40 / 78 | 49 / 90 |
| bars, walk + bike | 10 | 0.3 / 0.4 s | 0 | 15 / 20 |
| bars, cafés, restaurants, walk + transit | 10 | 3.4 / 4.8 s | 102 / 240 | 112 / 252 |

Always 3 proposals. First proposal against the best of the file, per-participant estimate, 20 exact zones, mean + ½ (max −
mean), mean / max: bars 0.0 / 0.3 min (the former candidates 1.6 / 7.1), bars, cafés and restaurants 0.2 / 1.3; bars off-peak:
Tuesday 14:30 0.2 / 2.0, 22:00 0.2 / 1.0, Sunday 10:30 0.0 / 0.3 (walk + transit).

### What the zones bring, once estimates exist (`zones-gain.js`, 2026-11-02)

One forward search does not cost the same whatever the destinations: 66 ms for 10, 363 ms for 100, 587 ms for 161, 1.16 s
for 316, 2.9 s for 851, 6.9 s for 2,029 (one participant, sequential): ~3.4 ms per destination, most likely the
street routing from each destination to its nearby stops (`get_offsets` in `one_to_many.cc`), on top of the transit search.

The same method without zones (every place estimated, the K best exact, the best 3 places 500 m apart), mean + ½ (max − mean),
30 rows, first proposal mean / max against the best place, exact journeys mean / max:

| places | method | destinations | first | journeys |
|---|---|---|---|---|
| bars | zones | 161 | 0.0 / 0.3 | 51 / 156 |
| bars | no zones, K = 40 | 316 | 0.0 / 0.0 | 71 / 240 |
| bars, cafés, restaurants | zones | 851 | 0.2 / 1.3 | 61 / 240 |
| bars, cafés, restaurants | no zones, K = 60 | 2,029 | 0.1 / 0.7 | 126 / 800 |
| bars, cafés, restaurants | no zones, K = 100 | 2,029 | 0.0 / 0.0 | 182 / 800 |

So the zones do not improve the best place. They halve the estimate's time (2 to 2.4 times fewer destinations) and lower
the exact journeys, mostly in the worst case. With an engine of one's own, reading precomputed street times to stops, the first gain would mostly go.
What stays is the shape of the answer: areas with several places to choose from.


### A maximum of places scored exactly per zone (`zone-cap.js`, adopted 2026-11-03: 5 places, farthest first)

The zone's other places stay listed and are scored when chosen; the proposals and their order do not change then. Measured in the page (T1,
3 participants, restaurants, local MOTIS on this PC, no network): ~0.2 s from the click to the place shown, 2 stages of calls (street times, then transit journeys).

Idea of the user: in the third phase, at most 4 places besides the representative, already exact. Picked farthest first (each time the
place farthest from those picked, as the crow flies, the distance to a set being the one to its closest member; Gonzalez's k-center
heuristic), since the closest ones would mostly repeat the same destination. Replayed on the oracle, score "équitable", 30 rows, loss in
minutes on the first proposal (mean / max) and per zone kept, against every place of the 3 zones:

| places | method | first | zone's best place found | loss per zone | third phase, journeys |
|---|---|---|---|---|---|
| bars | every place | 0 / 0 | 100 % | 0 / 0 | 17.9 / 76 |
| bars | 5 closest | 0.00 / 0.1 | 96 % | 0.01 / 0.5 | 11.6 / 40 |
| bars | 5 farthest first | 0.02 / 0.5 | 91 % | 0.02 / 0.5 | 11.6 / 40 |
| cafés | every place | 0 / 0 | 100 % | 0 / 0 | 22.0 / 84 |
| cafés | 5 closest | 0.00 / 0.0 | 93 % | 0.01 / 0.2 | 10.8 / 36 |
| cafés | 5 farthest first | 0.01 / 0.3 | 87 % | 0.05 / 0.8 | 10.8 / 36 |
| restaurants | every place | 0 / 0 | 100 % | 0 / 0 | 36.1 / 188 |
| restaurants | 5 closest | 0.16 / 1.2 | 77 % | 0.14 / 1.8 | 14.3 / 48 |
| restaurants | 5 farthest first | 0.02 / 0.5 | 81 % | 0.04 / 0.7 | 14.3 / 48 |
| bars, cafés, restaurants | every place | 0 / 0 | 100 % | 0 / 0 | 19.4 / 80 |
| bars, cafés, restaurants | 5 closest | 0.00 / 0.1 | 91 % | 0.04 / 1.3 | 10.8 / 48 |
| bars, cafés, restaurants | 5 farthest first | 0.00 / 0.0 | 91 % | 0.03 / 0.8 | 10.8 / 48 |

Farthest first is clearly better on restaurants, the only kind with large zones, and slightly worse on bars and cafés. 3 and 8 places per zone
are in the script's output. Real time of the third phase's journeys on the local MOTIS (16-core PC, 8 in parallel, walk + transit, 10 groups, mean /
most): restaurants 0.86 / 1.90 s for every place, 0.31 / 0.49 s for 5 farthest first; bars 0.40 / 0.78 s, 0.26 / 0.42 s. Tuesday 19:00 only.

### The service against the best places of the file (`baseline.js` through the API, 2026-11-08)

The first run through the API, to check the script, on one group only: T1 (centre, compact), Tuesday 2026-11-10 at 19:00,
a local middleware on the local MOTIS, oracle built for that date. Score: mean + ½ (max − mean), in minutes; gap: the
service's first proposal minus the best place of the file of that type; rank among the places everyone can reach.

| modes | bars | cafés | restaurants | stations |
|---|---|---|---|---|
| walk + transit | 0 (1st of 313) | 0 (1st of 254) | 0 (1st of 1,426) | 0 (1st of 1,779) |
| car, bike, walk + transit | 0.1 (4th of 309) | 0.3 (3rd of 247) | 0.3 (7th of 1,415) | 0 (1st of 1,777) |
| walk + bike | 0 (1st of 316) | 0 (1st of 257) | 0 (1st of 1,455) | 0 (1st of 1,779) |

Stations as zones of their own (decided 2026-11-08) give the best station of the file in all three configurations here.
One group of ten: the whole table (10 groups, oracle ~2.5 min per group) is still to run before concluding.

