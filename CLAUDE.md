# Notes for Claude Code sessions

Rendez-vous: meeting point finder for the Toulouse area. GitHub `NicolasGresset/rendez-vous` (public),
deployed by Vercel from `main`. A project shown on the author's site gresset-bourgeois.fr (repository
`NicolasGresset/portfolio`, where it was born: history before 2026-10-30 says "location page", "site").
This file is excluded from the deployment (`.vercelignore`) but versioned on GitHub.

## Working rules

- UI text in French; code, names, comments, logs and docs in English (`legal.html` is in English).
  PEP8 for any Python.
- Never hard-code or commit keys; never print secret values (redact `.env`).
- List methodological choices (scoring, candidates, time handling, data sources, new external
  services) with trade-offs and ask before coding them. The user likes to measure and test before deciding.
- Commit often on `main`; **push only when the user asks** (each push triggers a Vercel deploy).
- Keep `docs/pipeline.md` (Mermaid diagrams, API calls, data sources) up to date with every change.
- Keep API usage conservative.

## Layout

- Vanilla HTML/CSS/JS, no build step, no server code: `index.html` (the tool) and `legal.html` (legal
  notice and privacy), each with its static navigation and footer. Styles: `css/fonts.css`,
  `css/base.css` (variables, navigation, footer, cards), then `css/rendez-vous.css` or `css/legal.css`.
  Code and CSS classes keep the tool's former `location` name (`location-*` classes, `location.*`
  localStorage keys).
- Local dev: `node scripts/dev-server.js` (port 3001; the portfolio's uses 3000); it applies
  `vercel.json`'s `cleanUrls` and headers, and `CSP_REPORT=1` (or `only`, not enforced) logs
  Content-Security-Policy violations.
- `vercel.json`: `cleanUrls` (`/legal`; `/legal.html` and `/index.html` 308-redirect), a
  Content-Security-Policy for every path, long cache for `assets/fonts/`. **Any new external service
  called from the page (fetch, image, script) must be added to the CSP**, and the third-party list of
  `legal.html` kept true.
- Fonts (`assets/fonts`, no italic), Leaflet (`assets/vendor/leaflet`) and the places file are served
  with the tool: no third-party request on load besides the map tiles. No cookies.
- Browser tests: headless Firefox (`/snap/bin/firefox`) against the dev server, driven through
  WebDriver BiDi by `scripts/firefox-bidi.js` (`withFirefox(async ({ send, context, evaluate,
  screenshot, errors }) => …)`: navigation, in-page scenarios, console errors, screenshots under
  `~/snap/firefox/common/shots`). Always go through it, never launch Firefox by hand: it picks a
  free port (`--remote-debugging-port 0`), uses a fresh profile it deletes, and closes with
  `browser.close`. Pitfalls it avoids (2026-10-29): the snap launcher hides Firefox's arguments, so
  `pgrep -f <profile>` never finds it and a kill hits only its shell (Firefox survives, keeps its
  port: "exit 69" on the next start, and recreates its profile after `rm`); a Bash background task
  killed by hand reports "failed, exit 143/144", which is not a Firefox failure. Startup ~9 s.
- UI tests without API calls: `scripts/location-fixture.js` replays a stored computation
  (`scripts/fixtures/rendez-vous.json`: 3 participants, Transitous answers recorded 2026-10-30, slimmed;
  page clock set back to the recording, openrouteservice made up in the page). `openWithFixture(page)`
  then `runComputation(page, scenario)` inside `withFirefox`; `node scripts/location-fixture.js shot`
  screenshots the results, `record` re-records (~24 Transitous calls, only when the format changes).
  Use it for every graphical / UX change of the results.
- Evaluation of the proposals (since 2026-10-30, `docs/evaluation.md`): `scripts/eval/` compares
  the tool's 3 proposals (its own `evaluate()`, calls redirected) with the best candidate places of
  the whole file, on 10 fixed groups x 3 mode configurations, with exact times from a **local
  MOTIS** (`~/motis`, Tisséo GTFS + OSM extract, port 8080, setup in the doc; no quota). Oracle
  files in `~/motis/eval`. Scores there: mean per person, and mean + ½ (max − mean).
  Branch `demo-motis` (not merged, not deployed): the page's demonstrator with a "MOTIS local"
  engine scoring every candidate place, test case picker, Tisséo lines layer (doc § Demonstrator).
- `docs/`, `scripts/`, `data/README.md` (sources, ODbL licence of the places file) and
  `data/tisseo-area.json` (input of the places build) are not deployed.

## The tool (`index.html`, `js/`)

Proposes the 3 meeting places with the best score (group's total travel time, or mean + gap) for an arrival within a 15 min slot,
Toulouse area. Fully client-side; the user's own openrouteservice key is stored in localStorage only.
Full pipeline: `docs/pipeline.md`.

- `main.js` UI glue (keys, form, progress), `search.js` local address search (no DOM), `slots.js`
  arrival slot picker, `map.js` Leaflet drawing, `results.js` results HTML, `labels.js` shared labels, duration format and `escapeHtml`;
  `engine.js` candidates and scoring, `ors.js` openrouteservice (matrix 50/day,
  directions 200/day), `transitous.js` public transport (Transitous `/plan`, max 3 parallel calls,
  > 720 calls / 24 h needs coordination) or `tisseo.js` (optional, visitor's key), `keys.js` localStorage.
- Address search: local instant lookup in `data/pois-toulouse.json` (≥ 2 chars), then IGN Géoplateforme
  completion (≥ 3 chars, Haute-Garonne, addresses and IGN points of interest, no companies).
- `data/pois-toulouse.json`: one list `places` (~17,400) with one `category` code each (OSM `key=value`
  such as `amenity=bar`, `office=company`, or GTFS `metro` / `bus`) and a `categories` label table.
  Candidates: `amenity=bar`, `amenity=restaurant`, `metro`, `bus` (only they keep an `id`); the rest is
  for the address search. Address split into street / postcode / city (normalized at generation),
  `addrSrc`, `near`; `aliases` and `oldNames` apart. Same name within 300 m = one place (bar > restaurant
  > …). Rules and fields: `docs/pipeline.md` § 6. Rebuilt from scratch by
  `scripts/regenerate-places.sh` (download + osmium + `scripts/build-places.js`; output reproducible). ~3.1 MB raw, ~325 KB at the highest brotli level but ~490 KB as Vercel serves it (measured 2026-10-30), loaded once the page is shown (window load).
- Local search: scored over name, aliases, oldNames, category label + synonyms, city; weights and bonuses
  are constants in `search.js` (`SEARCH_WEIGHTS`…), doc § 2. Typos (2026-10-30): 1 from 4 letters,
  2 from 8 (Damerau, start of a word), quality 1 only where the place has no exact / prefix match,
  places found without typos always first; no phonetic matching (declined). Sorted word index built in the browser after
  loading (~16 ms), ~0.4 ms per keystroke on a PC (scan fallback for very common prefixes).
- Declined by the user: Photon, a service worker, Tisséo API (key refused), Strasbourg/CTS.

## Next big steps (stated by the user, 2026-10-28)

1. **Home server**: a second-hand machine with Debian, hosted at home behind the ISP box with a port
   opened, exposing routing services callable from anywhere. Goal: replace openrouteservice and
   Transitous (street times, transit journeys, paths), with home-made algorithms (pedagogical
   interest), and deal with deployment, caching, latency (ping to the box from outside unknown).
   Points raised: HTTPS needed (the site is HTTPS: mixed content), domain / dynamic DNS, security of an
   exposed home machine, power draw of an old server vs a mini PC, fallback when the box is down.
   It would also hold secret keys (Tisséo) and proxy APIs without CORS.
2. **Better meeting point algorithm** (the original goal; the user finds the current result
   disappointing): the plain barycenter ignores modes and is not the Fermat-Weber point (a weighted
   geometric median, Weiszfeld, weights ~ 1 / speed of each participant's mode, is easy); candidates
   within 1 km are too close to each other, so the transit calls bring little information. Ideas:
   cheap estimate over many places, then exact times for a geographically diverse short list;
   a second round around the best area; with one's own one-to-many engine (Dijkstra, CSA / RAPTOR),
   every place could be scored exactly.

Tisséo API (key obtained 2026-10-28, `TISSEO_API_KEY` in `.env` for tests only): now an optional
transit engine picked in the page (`js/tisseo.js`), called from the browser with the visitor's
own key like openrouteservice (Tisséo accepts public keys, doc § 2.7). CORS headers only on XML answers,
so `journeys.xml` + `DOMParser`; departure time only, so 2 calls per trip (4 journeys an hour before the
end of the slot, then 4 leaving shortest travel time + 10 min before it); 6 in parallel. Measured: 20
journeys in 2.0 s vs 27.7 s for Transitous at 3 in parallel; a full computation (2 participants, 8
stations) in 3.9 s with 32 calls. Tisséo network only (no TER / liO); no count of stops travelled.
Quotas: monitored per key, possibly paid beyond thresholds one day (doc § 2.3).

## Open topics (update when they move)

- Extracted from the portfolio on 2026-10-30 (`git filter-repo`, 52 commits kept; early commits
  lack their styles, which lived in the portfolio's shared `css/style.css`). Not pushed yet; the user
  creates the Vercel project and the DNS record for `rendez-vous.gresset-bourgeois.fr` (domain to
  confirm). Then the portfolio drops the tool (files, CSP entries, `legal.html` section), redirects
  `/rendez-vous` and `/location` here, and presents it on a projects page. A new origin: keys and
  settings in localStorage must be entered again once.
- Transitous audit leftovers (2026-10-28): `maxItineraries=5&detailedTransfers=false` (measured: half
  the size, same best trip on 11/12 trips); the 720 calls / 24 h shared counter is deferred to the
  home server.
- Make sure the repository holds no dead code (stated by the user, 2026-10-28).
- Local search: scoring implemented 2026-10-28 with starting weights; the user tunes them after testing.
  Sorted index: built in the browser on purpose (shipping it: +103 KB brotli, slower below ~16 Mbit/s).
  Not yet measured on the user's phone (Galaxy A33). Since 2026-10-29, at equal rounded score the
  category (metro > others > bus) wins over distance ("jean jau": the metro station before a nearer
  hairdresser). Reference queries to compare rankings: `node scripts/search-queries.js [query…]`.
- Later, once the page's purpose is settled (personal service, demonstrator…): cache of
  openrouteservice times and paths (they do not depend on the time of day; changing the slot
  re-calls the matrix today), favourite addresses with custom names in the autocompletion.
- Local street routing measured 2026-10-28 (not decided): the OSM extract's highways in the Tisséo box
  give 199,000 graph nodes (intersections) and 268,000 edges; naive binary 4.5 MB, 1.9 MB brotli
  (without the shapes needed to draw paths); one full walking Dijkstra 77 ms on a PC. Would replace the
  openrouteservice matrix (50/day) by one Dijkstra per participant and mode.
- Transit robustness (2026-10-28, after a walk-instead-of-metro report from Viveris, Ramonville, not
  reproduced; most likely a failed Transitous call silently replaced by walking): 1 retry after 2 s,
  failures counted in the progress, failed candidates marked incomplete and chosen only if nothing
  complete is reachable. Arriving before the slot is accepted, the wait counted in the time.
- Placing on the map (2026-10-29): a click places the *active* participant (last card focused or
  touched, then the next one to fill; none during and after a computation), a double click only
  zooms, points draggable on computers only (the user feared it would misbehave on phones). Doc § 2.
  Not yet tried on the user's phone.
- Possibly more candidate categories (pub, biergarten, café): one line in `CATEGORIES`, user's call.
- Score (decided 2026-10-30 for the evaluation; the tool's settings not changed yet): Ogryczak's
  (1 − β)·mean + β·max with β = ½ replaces "moyenne + écart", which can prefer a place worse for
  everyone ((10, 30) min: 40; (20, 30): 35). β = 0 is the mean (same ranking as "temps total").
- Routing engines (2026-10-30): no Valhalla (MOTIS also gives walk, bike and car times); a
  home-made CSA later, possibly **run in the browser** (a day of Tisséo connections is a few MB),
  to investigate another day.
- Transitous is the slow step: (A) cache and pruning, or (C) local Connection Scan Algorithm on Tisséo
  GTFS (~2.6 MB/day of connections, estimated 600–900 lines). Waiting for the user's decision.
- Comparison with togather (meettogather.com), studied 2026-10-29: Astro + React page, Google Maps JS
  (map, Places autocomplete, key in the page), one backend call `POST api.togather.fr/compute-location`
  {venueType (free text), locations [{address, transport: walking|bicycling|transit|driving, position}]}
  -> 3 Google venues (placeId, rating) with each person's time; measured 1.0 s for 2 people. Speed most
  likely from a server-side Google matrix (all people x all venues in one request) and Places search
  (inferred from mode names, fields and error messages; the backend is not visible). Score: average
  time + gap longest-shortest, weighted equally (their page). No arrival time, share link where
  others add their start, GA4 + PostHog analytics.
- Size of the API answers (measured 2026-10-30, Capitole -> avenue de l'URSS; no change decided):
  Transitous `/plan` ~210 KB raw, ~31 KB gzip (a computation, 3 participants x 8 places: ~750 KB
  downloaded, ~5 MB of JSON parsed); 45 % alerts (no parameter to drop them in the MOTIS spec), 24 %
  walking `steps`; `detailedLegs=false` gives 130 KB raw / 14 KB gzip (scores intact, coarse paths).
  Tisséo `journeys.xml` 89 KB, not compressed (a computation: ~4.3 MB); mostly walking streets and
  WKT; no slimming parameter known (their developer documentation not checked). openrouteservice not
  measured (no key here); `instructions: false` would drop the unused turn-by-turn steps. Possible
  work: `detailedLegs=false` for the scoring calls, then a detailed call per participant for the shown
  place only (+P calls on the shared Transitous quota); ORS `instructions: false`. The user's view:
  little to gain in practice; the real limit is that Transitous and Tisséo seem not to offer selecting
  the fields needed (not checked in detail). The home server would return only those, compressed.
- Transitous `/api/experimental/one-to-many-intermodal` (MOTIS) works: `arriveBy=true` gives many ->
  one transit durations (and transfers) for an arrival time, so one call per candidate for all
  participants (C calls instead of P x C); 4.6 s per call (2 calls measured), durations only (no legs:
  /plan still needed for the chosen place). Not used: estimated ~15 s instead of ~22 s, the real
  speed-up is the home server.
- Decided 2026-10-29 after the togather study (the user values open source and open data, no Google
  API): score picked in the settings (temps total, or moyenne + écart as togather), 3 proposals,
  links to OpenStreetMap / Google Maps and a share button (no share link to the tool itself),
  practical (default) and demonstrator views, no name field (the user may change their mind).
  Settings kept in localStorage (`location.settings`, in `legal.html`).
- Next for the Rendez-vous tool (stated by the user 2026-10-29, for a new session):
  - **Diversity of the candidates** (high on the list): the 8 candidates must be spread out (two
    bars 50 m apart were proposed); choose the method with the user first.
  - People per participant: done 2026-10-29 (doc § 1): a chip (person icon, 1) after the modes opens
    a stepper − [n] + (the user preferred it folded to always visible), no upper bound, every person
    counts (weighted barycenter, total and mean over people, gap unchanged), at least 2 participants
    placed. On hold: the user once saw + step 1, 2, 4, 6, most likely their mouse double-clicking
    (not reproduced with real mouse and touch clicks in Firefox, one click event each).
