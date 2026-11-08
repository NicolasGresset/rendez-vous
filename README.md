# Rendez-vous

Where should a group meet? Rendez-vous takes each person's starting point and how they travel
(walking, cycling, driving, public transport), and proposes 3 stations, bars, cafés or restaurants of
the Toulouse area that everyone can reach in a comparable time, for a chosen meeting time.

It is a decision aid, not a decision maker: the group still weighs habits, prices and the rest.

**Try it:** [rendez-vous.gresset-bourgeois.fr](https://rendez-vous.gresset-bourgeois.fr) (French
interface, Toulouse area only). A project by [Nicolas Gresset-Bourgeois](https://gresset-bourgeois.fr).

![Three participants, the proposed places and their journeys on the map](docs/screenshot.jpg)

## How it works

1. **Zones**: the places of a kind (bars, cafés, restaurants) are grouped beforehand into zones within a 5 min walk; a
   station is a zone of its own. The places come from a local file of about 17,400 Toulouse places built from
   OpenStreetMap and the Tisséo GTFS feed.
2. **Coarse, then finer**: every zone is estimated, the 20 best are computed exactly, the 3 best at least 500 m apart are
   kept, then a few places of each. Travel times come from a self-hosted [MOTIS](https://github.com/motis-project/motis)
   server: walking, cycling, driving, public transport. A journey may arrive up to 10 min after the meeting
   time; arriving before it counts as waiting.
3. **Score**: the mean time per person plus half the excess of the longest trip over the mean, so that the one coming
   from far is not penalized much. The 3 best places are shown with each person's journey, step by step.

The page is static (Vercel) and asks one question to the API (`middleware/`, in Go, on the author's home server), which
does all the computing. Addresses are completed instantly from the local file, then by the French IGN Géoplateforme.

How a computation goes is in [docs/pipeline.md](docs/pipeline.md); how the proposals were measured against the best
places of the whole file is in [docs/evaluation.md](docs/evaluation.md); the self-hosted architecture and the reasons of
each choice are in [docs/architecture.md](docs/architecture.md).

## Status

A working prototype, running on a home server. Next: a load test to set its limits, then deciding what can be cached,
and in the longer run a home-made routing engine.

## Running it locally

No build step, no dependency: vanilla HTML, CSS and JavaScript modules, with
[Leaflet](https://leafletjs.com) served from `assets/vendor/`.

```sh
node scripts/dev-server.js    # http://localhost:3001
```

The dev server applies the clean URLs and the Content-Security-Policy of `vercel.json`, and relays `/v1/` to the API
(`API_URL`, default the deployed one, which accepts only the site's origin).

The server side (Go 1.22 or later):

```sh
cd middleware && go test ./...
ALLOWED_ORIGINS=http://localhost:3001 PLACES_FILE=../data/pois-toulouse.json MOTIS_URL=http://localhost:8080 LISTEN_ADDR=:8090 go run .
```

Tests (not deployed; the site itself still has no dependency and no build step):

```sh
npm ci                                        # ESLint and Playwright, development only
npx playwright install firefox                # with: chromium --only-shell, for the phone tests
npm test                                      # lint, unit tests (tests/unit), browser tests (tests/e2e)
```

They make no API call: the browser tests replay a recorded answer of the API. On GitHub
(`.github/workflows/ci.yml`) every push runs them, on a phone-sized Safari too; Vercel's Deployment Checks hold
production until they pass (jobs `lint-and-unit` and `browser-tests`).

Development scripts (not deployed):

- `scripts/location-fixture.js shot`: replays a recorded answer in headless Firefox, without any API call, and
  screenshots the results (`scripts/firefox-bidi.js` drives Firefox).
- `scripts/search-queries.js [query…]`: rankings of the local address search for reference queries.
- `scripts/regenerate-places.sh`: rebuilds `data/pois-toulouse.json` from scratch (downloads, osmium,
  `scripts/build-places.js`, then `scripts/build-zones.js`, which needs MOTIS).
- `scripts/eval/`: the measures of `docs/evaluation.md`, on fixed test groups (needs MOTIS; `baseline.js` asks a local
  middleware).

## Layout

```
index.html, legal.html   the tool, and its legal notice and privacy page
middleware/              the server side (Go): validation, limits, method by zones, calls to MOTIS; not deployed by Vercel
js/                      api.js, answer.js (the API: calls, question and answer), search.js, geocode.js, autocomplete.js
                         (address search), main.js, participants.js, map.js, results.js, slots.js, cancel.js, labels.js
css/                     base.css (shared), rendez-vous.css, legal.css, fonts.css
data/                    pois-toulouse.json (places), tisseo-area.json (build input), README.md (sources)
docs/                    pipeline.md (a computation, end to end), evaluation.md (measures),
                         architecture.md (the self-hosted target and its decisions)
scripts/                 dev server, recorded computation, places build, eval/ (measures)
tests/                   unit/ (Node's test runner), e2e/ (Playwright)
```

## Privacy

No account, no cookies, no analytics. The browser sends the participants' positions to the author's server only,
which keeps neither them nor IP addresses in its logs, and what is typed in an address field to the IGN Géoplateforme;
details in [legal.html](legal.html).

## Licences

- Code: [MIT](LICENSE).
- `data/pois-toulouse.json`: [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/), derived from
  © OpenStreetMap contributors and © Tisséo data, with addresses from the Base Adresse Nationale
  (see [data/README.md](data/README.md)).
- Fonts DM Sans and Space Mono: SIL Open Font License (`assets/fonts/`); Leaflet: BSD 2-Clause
  (`assets/vendor/leaflet/LICENSE`).
