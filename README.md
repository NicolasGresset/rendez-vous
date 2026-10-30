# Rendez-vous

Where should a group meet? Rendez-vous takes each person's starting point and how they travel
(walking, cycling, driving, public transport), and proposes the bars, restaurants or stations of the
Toulouse area that are the fastest to reach for everyone, for an arrival within a chosen 15-minute slot.

**Try it:** [rendez-vous.gresset-bourgeois.fr](https://rendez-vous.gresset-bourgeois.fr) (French
interface, Toulouse area only). A project by [Nicolas Gresset-Bourgeois](https://gresset-bourgeois.fr).

![Three participants, the proposed places and their journeys on the map](docs/screenshot.jpg)

## How it works

1. **Candidates**: a few places of the chosen kinds around the participants' weighted barycenter,
   taken from a local database of about 17,400 Toulouse places built from OpenStreetMap and the
   Tisséo GTFS feed.
2. **Travel times**: walking, cycling and driving times from
   [openrouteservice](https://openrouteservice.org) (one matrix request per mode), public transport journeys
   for the arrival slot from [Transitous](https://transitous.org) or, optionally, the Tisséo API.
3. **Score**: the group's total travel time, or the mean plus the gap between the longest and the
   shortest trip; the 3 best places are shown with each person's journey, step by step.

Everything runs in the browser: there is no backend, and the API keys (openrouteservice is free,
Tisséo optional) are the visitor's own, stored in their browser only. Addresses are completed
instantly from the local database, then by the French IGN Géoplateforme.

The full pipeline, with diagrams, API calls, quotas and data sources, is in
[docs/pipeline.md](docs/pipeline.md).

## Status

A working prototype. Next steps: spreading the candidates out (today two may stand 50 m apart), a
better meeting point than the barycenter (a weighted geometric median), and in the longer run a
home-made routing engine (Dijkstra for the streets, Connection Scan or RAPTOR for public transport)
served from a home server, to score every place exactly instead of a short list.

## Running it locally

No build step, no dependency: vanilla HTML, CSS and JavaScript modules, with
[Leaflet](https://leafletjs.com) served from `assets/vendor/`.

```sh
node scripts/dev-server.js    # http://localhost:3001
```

The dev server applies the clean URLs and the Content-Security-Policy of `vercel.json`. An
openrouteservice key is needed as soon as someone walks, cycles or drives.

Development scripts (not deployed):

- `scripts/location-fixture.js shot`: replays a recorded computation in headless Firefox, without any
  API call, and screenshots the results (`scripts/firefox-bidi.js` drives Firefox).
- `scripts/search-queries.js [query…]`: rankings of the local address search for reference queries.
- `scripts/regenerate-places.sh`: rebuilds `data/pois-toulouse.json` from scratch (downloads, osmium,
  `scripts/build-places.js`).

## Layout

```
index.html, legal.html   the tool, and its legal notice and privacy page
js/                      engine.js (candidates, scoring), ors.js, transitous.js, tisseo.js (routing),
                         search.js (address search), main.js, map.js, results.js, slots.js (interface)
css/                     base.css (shared), rendez-vous.css, legal.css, fonts.css
data/                    pois-toulouse.json (places), tisseo-area.json (build input), README.md (sources)
docs/pipeline.md         how a computation runs, end to end
scripts/                 dev server, browser tests, places build
```

## Privacy

No account, no cookies, no analytics. The browser sends the participants' positions to the routing
services listed above, and what is typed in an address field to the IGN Géoplateforme; details in
[legal.html](legal.html).

## Licences

- Code: [MIT](LICENSE).
- `data/pois-toulouse.json`: [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/), derived from
  © OpenStreetMap contributors and © Tisséo data, with addresses from the Base Adresse Nationale
  (see [data/README.md](data/README.md)).
- Fonts DM Sans and Space Mono: SIL Open Font License (`assets/fonts/`); Leaflet: BSD 2-Clause
  (`assets/vendor/leaflet/LICENSE`).
