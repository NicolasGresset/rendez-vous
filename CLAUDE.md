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
- Keep `docs/pipeline.md` (Mermaid diagrams, API calls, data sources) and `README.md` up to date with every change.
- Keep API usage conservative.
- UI rules (stated by the user, 2026-11-02): a click anywhere on a card folds or unfolds it, on every
  card of the project. Practical view: straight to the point, the default map and no display option.
  Debug view: more is available, but not all shown at once.

## Layout

- Vanilla HTML/CSS/JS, no build step, no server code but the two temporary relays of `api/` (see the trial in Open topics): `index.html` (the tool) and `legal.html` (legal
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
- Tests and CI (2026-11-03): `npm test` = ESLint, `tests/unit` (`node:test`, no dependency), `tests/e2e` (Playwright, Firefox and a
  phone-sized Chrome here; a phone-sized Safari on GitHub only, WebKit needing system libraries, and no sudo here). No API call, map
  tiles included; any page error or CSP violation fails a test. `.github/workflows/ci.yml` runs them on every push (actions pinned by
  commit). Vercel's Deployment Checks (set by the user, tried 2026-11-03: a failing test kept production as it was, then a passing commit reached it about 2 min after the push) require the jobs
  `lint-and-unit` and `browser-tests`: renaming a job means updating them in Vercel's settings. A push on `main` is thus live only once they pass; Force Promote on the deployment's page bypasses them. `package.json` is for development tools only (`dependencies` stays empty, a test checks it), kept out of the deployment
  (`.vercelignore`). **A bug fixed or a behaviour added comes with a test; check a new test can fail by breaking the code once.** MOTIS features and
  `scripts/eval` are not in CI (they need local data). `npm audit`: 5 moderate, all from `minimatch` inside ESLint (a tool, not deployed; `--force` would downgrade ESLint to 4).
- Ad hoc browser scenarios and screenshots: headless Firefox (`/snap/bin/firefox`) against the dev server, driven through
  WebDriver BiDi by `scripts/firefox-bidi.js` (`withFirefox(async ({ send, context, evaluate,
  screenshot, errors }) => …)`: navigation, in-page scenarios, console errors, screenshots under
  `~/snap/firefox/common/shots`). Always go through it, never launch Firefox by hand: it picks a
  free port (`--remote-debugging-port 0`), uses a fresh profile it deletes, and closes with
  `browser.close`. Pitfalls it avoids (2026-10-29): the snap launcher hides Firefox's arguments, so
  `pgrep -f <profile>` never finds it and a kill hits only its shell (Firefox survives, keeps its
  port: "exit 69" on the next start, and recreates its profile after `rm`); a Bash background task
  killed by hand reports "failed, exit 143/144", which is not a Firefox failure. Startup ~9 s.
- UI tests without API calls: `scripts/location-fixture.js` replays a stored computation
  (`scripts/fixtures/rendez-vous.json`: 3 participants, Transitous answers recorded 2026-11-02, slimmed;
  page clock set back to the recording, openrouteservice made up in the page). `openWithFixture(page)`
  then `runComputation(page, scenario)` inside `withFirefox`; `node scripts/location-fixture.js shot`
  screenshots the results, `record` re-records (~24 Transitous calls, when the format or the candidates change).
  Use it for every graphical / UX change of the results.
- Evaluation of the proposals (since 2026-10-30, `docs/evaluation.md`): `scripts/eval/` compares
  the tool's 3 proposals (its own `evaluate()`, calls redirected) with the best candidate places of
  the whole file, on 10 fixed groups x 3 mode configurations, with exact times from a **local
  MOTIS** (`~/motis`, Tisséo GTFS + OSM extract, port 8080, setup in the doc; no quota). Oracle
  files in `~/motis/eval`. Scores there: mean per person, and mean + ½ (max − mean).
  With the dev server on `localhost` and MOTIS running, the page's debug view also offers a
  "MOTIS local" engine scoring every candidate place, a test case picker, Tisséo lines and a time
  map (`js/motis.js`, `js/debug-motis.js`, doc § Debug view; deployed but unused elsewhere).
- `docs/`, `scripts/`, `data/README.md` (sources, ODbL licence of the places file) and
  `data/tisseo-area.json` (input of the places build) are not deployed.

## The tool (`index.html`, `js/`)

Proposes the 3 meeting places with the best score (équitable or égalitaire) for a meeting time with a fixed late tolerance (10 min),
Toulouse area. Fully client-side; the user's own openrouteservice key is stored in localStorage only.
Full pipeline: `docs/pipeline.md`.

- `main.js` keys, settings, the computation's events and the results; `participants.js` the cards and their points on the map;
  `autocomplete.js` an address field's list, `geocode.js` Géoplateforme, `progress.js` bar and steps, `debug-view.js` the page's debug
  view with MOTIS (split from a 1,250-line `main.js` on 2026-11-03); `search.js` local address search (no DOM), `slots.js`
  arrival slot picker, `map.js` Leaflet drawing, `results.js` results HTML, `labels.js` shared labels, duration format and `escapeHtml`;
  `cancel.js` the signal cancelling the work of a stale result; `engine.js` candidates and scoring, `ors.js` openrouteservice (matrix 50/day,
  directions 200/day), `transitous.js` public transport (Transitous `/plan`, max 3 parallel calls,
  > 720 calls / 24 h needs coordination) or `tisseo.js` (optional, visitor's key), `keys.js` localStorage.
- Address search: local instant lookup in `data/pois-toulouse.json` (≥ 2 chars), then IGN Géoplateforme
  completion (≥ 3 chars, Haute-Garonne, addresses and IGN points of interest, no companies).
- `data/pois-toulouse.json`: one list `places` (~17,400) with one `category` code each (OSM `key=value`
  such as `amenity=bar`, `office=company`, or GTFS `metro` / `bus`) and a `categories` label table.
  Candidates: `amenity=bar`, `pub`, `biergarten`, `cafe`, `restaurant`, `metro`, `bus` (only they keep an `id`); the rest is
  for the address search. Address split into street / postcode / city (normalized at generation),
  `addrSrc` (index in the `addressSources` table), `near`; `aliases` and `oldNames` apart. Same name within 300 m = one place (bar > restaurant
  > …). Rules and fields: `docs/pipeline.md` § 6. Rebuilt from scratch by
  `scripts/regenerate-places.sh` (download + osmium + `scripts/build-places.js`; output reproducible). ~3.1 MB raw, ~325 KB at the highest brotli level but ~490 KB as Vercel serves it (measured 2026-10-30), loaded once the page is shown (window load).
- Local search: scored over name, aliases, oldNames, category label + synonyms, city; weights and bonuses
  are constants in `search.js` (`SEARCH_WEIGHTS`…), doc § 2. Typos (2026-10-30): 1 from 4 letters,
  2 from 8 (Damerau, start of a word), quality 1 only where the place has no exact / prefix match,
  places found without typos always first; no phonetic matching (declined). Sorted word index built in the browser after
  loading (~16 ms), ~0.4 ms per keystroke on a PC (scan fallback for very common prefixes).
- Declined by the user: Photon, a service worker, Tisséo API (key refused), Strasbourg/CTS.

## What the tool is for (stated by the user, 2026-10-30)

A decision aid, not a decision maker: it answers "which place is reachable in a comparable time
by everyone, without penalizing anyone much", quickly and objectively, for anyone; the group then
also weighs habits, prices, a friendly waiter… Its behaviour must stay understandable and
interpretable (results logical to someone who knows the network), not opaque or over-specified:
prefer simple, explainable rules to fine modelling of edge cases. Lateness and personal habits
are out of scope.

## Next big steps (stated by the user, 2026-10-28)

Target architecture (stated by the user, 2026-11-03): Transitous and Tisséo go away for the home server. The page makes a single API call
(participants' positions and modes, then one answer); behind it, self-hosted engines and a middleware that splits the question and gathers the answer.

1. **Home server** (bought, stated 2026-11-02, due around 2026-11-06/08: refurbished Lenovo ThinkCentre M720q
   Tiny, i5-8400T 6 cores, 16 GB, 512 GB SSD; other services will share it, so MOTIS does not get
   all of it): a second-hand machine with Debian, hosted at home behind the ISP box with a port
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
3. **Once the home server runs** (stated by the user, 2026-11-02): decide which results can be cached;
   try the tool as it is on Paris, to see how it behaves on a more complex city it was not built for.

Tisséo API (key obtained 2026-10-28, `TISSEO_API_KEY` in `.env` for tests only): now an optional
transit engine picked in the page (`js/tisseo.js`), called from the browser with the visitor's
own key like openrouteservice (Tisséo accepts public keys, doc § 2.7). CORS headers only on XML answers,
so `journeys.xml` + `DOMParser`; departure time only, so 2 calls per trip (4 journeys an hour before the
end of the slot, then 4 leaving shortest travel time + 10 min before it); 6 in parallel. Measured: 20
journeys in 2.0 s vs 27.7 s for Transitous at 3 in parallel; a full computation (2 participants, 8
stations) in 3.9 s with 32 calls. Tisséo network only (no TER / liO); no count of stops travelled.
Quotas: monitored per key, possibly paid beyond thresholds one day (doc § 2.3).

## Open topics (update when they move)

- Browser tests sensitive to timing (measured 2026-11-05, Firefox and Chrome x 3 on 2 CPUs with 2 workers: 8 failures in 144 runs, 5 on the commit before the
  trial, so not new; cancelling during a computation, suggestions). `choosing another proposal` failed on GitHub (Firefox, click without effect), not
  reproduced here: smooth scrolling suspected, a much slower one in Firefox did not trigger it either, cause unknown. One retry on CI since then; a test
  reported flaky there is still worth a look. To do: make the cancellation tests independent of the machine's speed.
- Trial with a friend, until Sunday 2026-11-08 (asked by the user 2026-11-04): visitors enter no key, Tisséo is the default engine and
  the Vercel Functions `api/ors.mjs` and `api/tisseo.mjs` add the user's keys (`OPENROUTESERVICE_API_KEY`, `TISSEO_API_KEY` in Vercel's
  settings; the repository is public, so never in the code). Anyone can call them: quotas are the only limit. **Temporary: to undo
  afterwards** (remove the two variables, revert the commit). Where this file still says the key is the visitor's, it describes the state to return to.
- Extracted from the portfolio on 2026-10-30 (`git filter-repo`, 52 commits kept; early commits
  lack their styles, which lived in the portfolio's shared `css/style.css`). Pushed; Vercel project
  and DNS done, live at `rendez-vous.gresset-bourgeois.fr` (stated 2026-11-02). The portfolio (`~/repos/personal_web_page`) has
  dropped the tool, redirects `/rendez-vous` and `/location` here and presents it on a projects page (checked 2026-11-03). A new origin: keys and
  settings in localStorage must be entered again once.
- Transitous: `maxItineraries=5&detailedTransfers=false` kept (decided by the user 2026-11-03), knowing that the map then draws nothing
  on walks between two lines (doc § Transitous answer size). The 720 calls / 24 h shared counter is deferred to the home server.
- Make sure the repository holds no dead code (stated by the user, 2026-10-28). Audited 2026-11-03 (ESLint and a search of the uses of
  every export, id, CSS class and script), the debug view's experimental features being kept on purpose by the user for now.
- Local search: scoring implemented 2026-10-28 with starting weights; the user tunes them after testing.
  Sorted index: built in the browser on purpose (shipping it: +103 KB brotli, slower below ~16 Mbit/s).
  Speed satisfying on the user's phone (Galaxy A33, stated 2026-11-03). Since 2026-10-29, at equal rounded score the
  category (metro > others > bus) wins over distance ("jean jau": the metro station before a nearer
  hairdresser). Reference queries to compare rankings: `node scripts/search-queries.js [query…]`.
- Later, once the page's purpose is settled (personal service, debug view…): cache of
  openrouteservice times and paths (they do not depend on the time of day; changing the slot
  re-calls the matrix today), favourite addresses with custom names in the autocompletion.
- Local street routing measured 2026-10-28 (not decided): the OSM extract's highways in the Tisséo box
  give 199,000 graph nodes (intersections) and 268,000 edges; naive binary 4.5 MB, 1.9 MB brotli
  (without the shapes needed to draw paths); one full walking Dijkstra 77 ms on a PC. Would replace the
  openrouteservice matrix (50/day) by one Dijkstra per participant and mode.
- Known bug left as is (audit of 2026-11-03, the user's choice since Transitous is going away): for a short trip Transitous answers only a walk in
  `direct` (0 itineraries at ~150 m and ~600 m from the Capitole), which `transitous.js` ignores, so a place near a bus/metro-only participant (the
  default without a key) counts as unreachable. Keep it in mind for the home server's API: a short walk must be a valid answer.
- Transit robustness (2026-10-28, after a walk-instead-of-metro report from Viveris, Ramonville, not
  reproduced; most likely a failed Transitous call silently replaced by walking): 1 retry after 2 s,
  failures counted in the progress, failed candidates marked incomplete and chosen only if nothing
  complete is reachable. Arriving before the slot is accepted, the wait counted in the time.
- Placing on the map (2026-10-29): a click places the *active* participant (last card focused or
  touched, then the next one to fill; none during and after a computation), a double click only
  zooms, points draggable on computers only (the user feared it would misbehave on phones). Doc § 2.
  Works on the user's phone (stated 2026-11-03).
- Participants (decided 2026-11-02): 5 at most with the public services, whose quota is shared; 10 with the local MOTIS.
- Links to stops (decided 2026-11-02): no link to their OSM page, a marker there and a Google Maps text search (kind,
  name, city), checked on Carmes. OSM has several points per bus stop; 36 of the 37 metro stations would match.
- Zones kept (stated by the user 2026-11-02: good engineering, `docs/evaluation.md` § What the zones bring). Maximum of places per zone
  (decided by the user 2026-11-03, measured by `scripts/eval/zone-cap.js`): the representative + 4 places picked farthest first (each
  time the place farthest from those picked, the distance to a set being the one to its closest member), not the closest ones, which would
  mostly repeat the same destination. The zone's other places stay listed, their times computed when chosen; the proposals do not change then.
- Later (stated by the user 2026-11-02): on the home server, maybe an engine of one's own instead of MOTIS, doing only what is
  needed; the user has ideas on the transit times.
- Tuned on Toulouse's bars, to do again elsewhere (stated by the user, 2026-11-02): the 5 min on foot of
  the zones, the 500 m between zones, the 20 exact zones and the 700 m between candidates are measures on this data. For
  another city, export the reasoning and redo the measures (`scripts/eval/centers.js`, `zones.js`), not the values.
- Later (idea of the user, 2026-11-02): with the home server, send the participants' positions as they
  are filled in and validated, so that part of the computation is done before the button is pressed.
- Later, once the home server runs (stated by the user 2026-10-30 and 2026-11-02): an "about / how it
  works" tab (not the main page) explaining how to optimize the search for a city, the place selection, the typing optimizations of the address search, how the site is
  tuned for Toulouse and what another city would need (the same preprocessing of OSM places, and
  a transit source: an API key now, a GTFS feed once the home server computes).
- No keys for visitors (stated by the user 2026-10-30): as a private person they would not enter
  a key on an unknown site, nor create one; the service should work without any (home server).
- Results card (2026-11-02): times shown are door-to-door, without the wait until the meeting
  time (still in the score). Proposals show the mean and the longest trip; per-participant bars
  were tried and removed, the user will decide later what to show.
- Clusters of bars (idea of the user, 2026-11-02, for the home server): propose areas of bars within
  a short walk rather than one bar. Measured, `docs/evaluation.md` § Clusters: maximum diameter needed
  (chaining runs away, ruled out), members often but not always interchangeable with transit. Decided
  by the user: at most 5 min on foot between two bars (MOTIS times, trusted even when odd), arbitrary cuts
  accepted, lone bars are zones, no bonus for richer zones, names 100 % automatic (closest metro / bus stop,
  then street). The method, coarse then finer (the user likes this hierarchy: geographic and in
  computing time, not brute force, so that the service scales): every zone's representative estimated (MOTIS one-to-many,
  one forward search per participant, leaving 60 min before the meeting time; no center nor radius), the 20 best exact, the best 3 zones at least 500 m apart, then at most 5 places of each of these 3
  exact. Cafés and restaurants get zones the same way. The geometric median was measured worse on the
  équitable score, not adopted. Practical view (2026-11-02, MOTIS engine only, so not visible online until the home server): proposes each zone's best
  place, its zone as context, no address (stated by the user), the zone's other places folded and selectable, also as small grey pins for the zone of the chosen place only, whose proposal stays pressed (`evaluateByZones`); with stations (no
  zones) the former method. Done: `zone` + `zones` table
  in the data file (`scripts/build-zones.js`), "Zones de bars" layer of the debug view,
  measured by `scripts/eval/zones.js`, the method in the debug view (MOTIS only; `js/debug-motis.js`
  `scoreZones`). The debug view shows more without showing everything at once (stated by the user
  2026-11-02): the enumeration is a map layer, off by default, trips are folded.
- Place types (decided 2026-11-02): 4 chips, stations, bars (`amenity=bar`, `pub`, `biergarten`: the Black
  Lion, a pub, was missing), cafés (`amenity=cafe`, apart after seeing Starbucks proposed at 19:00),
  restaurants. No opening hours: incomplete data, a misleading filter. No restaurants open late, even if
  bars hide there (Café Triplette). The user does not want to list bars by hand to measure OSM's
  coverage for now.
- Scores (2026-10-30): "équitable" (default, Ogryczak's (1 − β)·mean + β·max with β = ½) and
  "égalitaire" (the mean per person); "moyenne + écart" dropped, it can prefer a place worse for
  everyone ((10, 30) min: 40; (20, 30): 35). The user wants few, trustworthy choices: a newcomer
  should not have to think about metrics (as on togather).
- Arrival time (done 2026-11-02): a round meeting time T (quarter hours) and a fixed late
  tolerance of 10 min, instead of the 15 min slot (no setting: measured, 5 to 15 min change little
  at Tuesday 19:00; off-peak not measured). Each participant is counted alone: the first one's wait
  until the second one arrives is not counted (measured: at most 0.3 min lost), arriving before T
  counts as waiting, arriving after T + 10 min is not allowed. The slot only exists for low-frequency
  transit (a bus arriving at 19:01 would otherwise force the one at 18:46).
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
  API): score picked in the settings (now équitable or égalitaire, see above), 3 proposals,
  links to OpenStreetMap / Google Maps and a share button (no share link to the tool itself),
  practical (default) and debug views, no name field (the user may change their mind).
  Settings kept in localStorage (`location.settings`, in `legal.html`).
- Next for the Rendez-vous tool (stated by the user 2026-10-29, for a new session):
  - Diversity of the candidates: done 2026-11-02, 8 candidates at least 700 m apart (the user's
    pick, 800 m felt too much), still at most 3 proposals; `docs/evaluation.md` § Diversity.
  - People per participant: done 2026-10-29 (doc § 1): a chip (person icon, 1) after the modes opens
    a stepper − [n] + (the user preferred it folded to always visible), no upper bound, every person
    counts (weighted barycenter, total and mean over people, gap unchanged), at least 2 participants
    placed. On hold: the user once saw + step 1, 2, 4, 6, most likely their mouse double-clicking
    (not reproduced with real mouse and touch clicks in Firefox, one click event each).
