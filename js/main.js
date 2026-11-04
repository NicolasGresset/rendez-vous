// main.js - Meeting point finder, in the browser, the site's relays holding the API keys: the settings
// (practical or debug view, score), the form's submission and the computation's events,
// API call counters, the results, and the glue between the engine and the page's other modules.

import { loadData, evaluate, placeRoutes, rankCandidates } from './engine.js';
import { loadSettings, saveSettings } from './keys.js';
import { slotPicker } from './slots.js';
import { createMap, drawCenter, drawCandidates, drawRoute as drawPath } from './map.js';
import { resultsHtml, enumerationHtml, zonesHtml, choiceText, placeLinks, shareText, proposalsOf, inSameZone, METRIC_DESCRIPTIONS } from './results.js';
import { MODE_LABELS, escapeHtml } from './labels.js';
import * as motis from './motis.js';
import { evaluateByZones, scoreZonePlace } from './debug-motis.js';
import { beginBatch, cancelBatch } from './cancel.js';
import { createParticipants } from './participants.js';
import { createProgress } from './progress.js';
import { createDebugView } from './debug-view.js';

(function () {
    const form = document.getElementById('location-form');
    if (!form || !window.L) return;

    // Public services (Transitous' quota is shared, a journey per participant and place): 5; local MOTIS: 10
    const MAX_PARTICIPANTS = { motis: 10, other: 5 };
    const ORS_MODES = ['walk', 'bike', 'car'];
    // Modes checked for every new participant
    const defaultModes = () => ['walk', 'transit'];
    // Plurals of the candidate categories; every category's label comes with the data
    const CATEGORY_PLURALS = {
        'amenity=bar': 'bars', 'amenity=pub': 'pubs', 'amenity=biergarten': 'biergartens', 'amenity=cafe': 'cafés',
        'amenity=restaurant': 'restaurants', metro: 'stations de métro', bus: 'arrêts de bus',
    };

    const slot    = document.getElementById('slot');
    const status  = document.getElementById('location-status');
    const results = document.getElementById('location-results');
    const callsEl = document.getElementById('location-calls');
    const layout  = document.querySelector('.location-layout');

    // Bring a section into view (below the fixed navigation, see scroll-margin-top in the CSS)
    function scrollToSection(el) {
        const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        el.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
    }

    function setStatus(text) {
        status.textContent = text || '';
        status.hidden = !text;
    }

    // The transit engine is picked in the settings panel, outside the participants form
    const engineInput = value => document.querySelector(`[name="transit-engine"][value="${value}"]`);
    // Reloading, Firefox restores the radios as they were: with the local MOTIS checked, whose radio
    // is only added later, none is checked here
    if (!document.querySelector('[name="transit-engine"]:checked')) engineInput('tisseo').checked = true;
    const candidateCount = document.getElementById('candidate-count');
    const scoreDescription = document.getElementById('score-description');
    const ENGINE_NAMES = { transitous: 'Transitous', tisseo: 'Tisséo', motis: 'MOTIS local' };
    let motisReady = false; // a local MOTIS answers through the dev server (debug view, motis.js)

    // Under the criteria, only the picked one's explanation
    function showScoreDescription() {
        const text = METRIC_DESCRIPTIONS[checkedValue('score-metric')];
        scoreDescription.textContent = `${text[0].toUpperCase()}${text.slice(1)}.`;
    }

    // ---- Settings, kept in this browser: view, score, number of candidates, transit engine ----
    const checkedValue = name => document.querySelector(`[name="${name}"]:checked`).value;
    const isDebug = () => checkedValue('view-mode') === 'debug';
    const SETTING_RADIOS = { view: 'view-mode', metric: 'score-metric', engine: 'transit-engine' };

    function restoreSettings() {
        const saved = loadSettings();
        Object.entries(SETTING_RADIOS).forEach(([key, name]) => {
            const input = saved[key] && document.querySelector(`[name="${name}"][value="${CSS.escape(saved[key])}"]`);
            if (input) input.checked = true;
        });
        if ([...candidateCount.options].some(o => o.value === saved.candidates)) candidateCount.value = saved.candidates;
    }

    function storeSettings() {
        saveSettings({ ...Object.fromEntries(Object.entries(SETTING_RADIOS).map(([key, name]) => [key, checkedValue(name)])),
            candidates: candidateCount.value });
    }

    const maxParticipants = () => MAX_PARTICIPANTS[checkedValue('transit-engine') === 'motis' ? 'motis' : 'other'];

    // ---- External API calls: last computation and whole session (since the page was loaded) ----
    const session = { geocode: 0, orsMatrix: 0, orsDirections: 0, transitous: 0, tisseo: 0, motis: 0 };
    let lastRun = null;   // calls of the last (or running) computation
    let running = false;  // lastRun is not yet added to session
    // { limit, remaining, reset } per openrouteservice service, from its last answer
    const orsQuota = { matrix: null, directions: null };

    function renderCalls() {
        const last = key => (lastRun ? lastRun[key] : 0);
        const total = key => session[key] + (running ? last(key) : 0);
        const row = (name, key, note = '') => `
            <div class="location-calls-row"><dt>${name}</dt>
            <dd>${key !== 'geocode' ? `${last(key)} <span class="location-muted">dernier calcul</span> · ` : ''}${total(key)}
                <span class="location-muted">session</span>${note}</dd></div>`;
        const quota = q => (q?.remaining != null
            ? ` · <strong>quota restant ${q.remaining}/${q.limit}</strong>`
                + (q.reset ? ` <span class="location-muted">(réinitialisé à ${new Date(q.reset * 1000)
                    .toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })})</span>` : '')
            : '');
        callsEl.innerHTML = row('Géocodage (Géoplateforme)', 'geocode')
            + row('openrouteservice matrix', 'orsMatrix', quota(orsQuota.matrix))
            + row('openrouteservice directions', 'orsDirections', quota(orsQuota.directions))
            + row('Transitous', 'transitous', ' <span class="location-muted">(au-delà de 720/24 h, se coordonner avec Transitous)</span>')
            + row('Tisséo', 'tisseo', ' <span class="location-muted">(2 appels par trajet)</span>')
            + (motisReady ? row('MOTIS local', 'motis', ' <span class="location-muted">(debug, sans l\'énumération)</span>') : '');
    }
    renderCalls();

    // ---- Arrival slot (slots.js) ----
    const slotValue = slotPicker(slot, document.getElementById('slot-options'));

    // Computers (mouse or touchpad): keyboard flow between the fields, draggable participant points
    const finePointer = window.matchMedia('(pointer: fine)').matches;

    // ---- Map (map.js) ----
    const map = createMap('location-map');
    const resultLayer = L.layerGroup().addTo(map);
    let routeLayers = [];    // per participant: layer group holding its path to the selected place
    // Displayed result: { data (result event), rows, selected (candidate index),
    // routes (place id -> participant index -> route event) }
    let current = null;

    // Any change to the participants makes the displayed result stale
    function clearResults() {
        cancelBatch(); // what still runs for this result is no longer wanted
        resultLayer.clearLayers();
        debugView.clearLayers();
        routeLayers = [];
        current = null;
        participantForm.unbindPopups();
        results.hidden = true;
    }

    // Places (with their precomputed addresses) and category labels, loaded once per page, as
    // soon as the page is shown (see loadPlaceIndex below)
    let dataPromise = null;
    let categoryLabels = {};
    const getData = () => {
        dataPromise = dataPromise || loadData()
            .then(data => { categoryLabels = data.categories; return data; })
            .catch(err => { dataPromise = null; throw err; });
        return dataPromise;
    };

    const progress = createProgress();
    const { resetSteps, setProgress, setStep, failRunningStep, closeSteps } = progress;

    function describeCandidates(candidates) {
        const counts = {};
        candidates.forEach(c => { counts[c.category] = (counts[c.category] || 0) + 1; });
        const parts = Object.entries(counts)
            .map(([category, n]) => `${n} ${n > 1 ? CATEGORY_PLURALS[category] : categoryLabels[category]}`);
        return `${candidates.length} lieu${candidates.length > 1 ? 'x' : ''}${parts.length ? ` : ${parts.join(', ')}` : ''}`;
    }

    const participantForm = createParticipants({ map, finePointer, getData, defaultModes, maxParticipants, scrollToSection, setStatus,
        onStale: clearResults,
        onGeocode: () => {
            session.geocode++;
            renderCalls();
        },
    });
    participantForm.start(3);

    // ---- Results (results.js): the chosen place, each participant's trip to it, and the paths
    //      on the map ----
    function drawRoute(i) {
        const place = current.data.candidates[current.selected];
        const route = current.routes.get(place.id)?.get(i);
        const p = current.data.participants[i];
        drawPath(routeLayers[i], p, place, route, p.color);
    }

    // Practical view: the proposals only; debug view: the barycenter and every candidate too
    function drawSelection(fit) {
        const { data, rows, selected } = current;
        const place = data.candidates[selected];
        const debug = isDebug();
        resultLayer.clearLayers();
        debugView.drawResult(resultLayer);
        drawCandidates(resultLayer, data.candidates, categoryLabels,
            { selected, proposals: proposalsOf(data), all: debug, onSelect: selectPlace,
                also: place?.zoneInfo ? inSameZone(data, place) : [] });
        routeLayers = data.participants.map((p, i) => {
            participantForm.markerOf(rows[i])
                ?.bindPopup(`<strong>${escapeHtml(p.label)}</strong><br>${choiceText(place?.choices[i])}`);
            return place ? L.layerGroup().addTo(resultLayer) : null;
        });
        if (place) data.participants.forEach((_, i) => drawRoute(i));
        if (fit) {
            const shown = [...(debug ? data.candidates : proposalsOf(data).map(j => data.candidates[j])), ...debugView.placesToShow()];
            const points = [...shown.map(c => [c.lat, c.lon]), ...data.participants.map(p => [p.lat, p.lon])];
            if (points.length) map.fitBounds(points, { padding: [30, 30], maxZoom: 16 });
        }
    }

    // Route events, from the computation or from a later selection, kept per place
    function storeRoute(event) {
        if (!current) return;
        if (!current.routes.has(event.place)) current.routes.set(event.place, new Map());
        current.routes.get(event.place).set(event.participant, event);
        if (current.data.candidates[current.selected]?.id === event.place) drawRoute(event.participant);
    }

    // A place of a zone without times (method by zones): scored now, then shown unless another place
    // was chosen meanwhile
    async function scoreThenSelect(j) {
        const shown = current;
        const { data } = shown;
        shown.wanted = j;
        if (data.candidates[j].computing) return;
        data.candidates[j].computing = true;
        data.candidates[j].failed = false;
        renderResults();
        try {
            data.candidates[j] = await scoreZonePlace(data.candidates[j], data.participants, data.slot, data.metric);
        } catch (err) {
            if (current !== shown) return; // the result was cleared meanwhile
            console.error(err);
            data.candidates[j].computing = false;
            data.candidates[j].failed = true;
        }
        if (current !== shown) return;
        if (shown.wanted === j && data.candidates[j].score != null) return selectPlace(j);
        renderResults();
        drawSelection(false);
    }

    // Show another place; its openrouteservice paths are fetched once, only when it is shown
    async function selectPlace(j) {
        if (current?.data.candidates[j]?.pending) return scoreThenSelect(j);
        if (!current || j === current.selected || current.data.candidates[j]?.score == null) return;
        current.wanted = j;
        current.selected = j;
        renderResults();
        drawSelection(false);
        const place = current.data.candidates[j];
        if (current.routes.has(place.id)) return;
        const shown = current;
        shown.routes.set(place.id, new Map());
        const before = lastRun.orsDirections;
        try {
            await placeRoutes(shown.data.participants, place, lastRun, event => {
                if (current !== shown) return;
                if (event.orsQuota) orsQuota.directions = event.orsQuota;
                storeRoute(event);
                renderCalls();
            }, checkedValue('transit-engine'), beginBatch());
        } catch (err) {
            if (err.name === 'AbortError') return; // the result was cleared meanwhile
            throw err;
        }
        if (!running) session.orsDirections += lastRun.orsDirections - before;
        renderCalls();
    }

    function renderResults() {
        const othersOpen = results.querySelector('.zone-others')?.open;
        results.innerHTML = resultsHtml(current.data, current.selected, categoryLabels, { debug: isDebug() })
            + (isDebug() && current.zones ? zonesHtml(current.data, current.zones, current.enum, categoryLabels) : '')
            + (isDebug() && current.enum ? enumerationHtml(current.data, current.enum, categoryLabels) : '');
        results.querySelector('#place-select')?.addEventListener('change', e => selectPlace(Number(e.target.value)));
        results.querySelectorAll('.proposal, .zone-other').forEach(button =>
            button.addEventListener('click', () => selectPlace(Number(button.dataset.place))));
        if (othersOpen && results.querySelector('.zone-others')) results.querySelector('.zone-others').open = true;
        results.querySelector('#place-share')?.addEventListener('click', sharePlace);
        // A click anywhere on a card folds or unfolds its details; the summary toggles natively,
        // the unfolded details and a text selection are left alone
        results.querySelectorAll('.trip-card, .zone-card').forEach(card => card.addEventListener('click', e => {
            const details = card.querySelector('details');
            if (!details || e.target.closest('summary, a, button')) return;
            if (details.open && details.contains(e.target)) return;
            if (String(window.getSelection())) return;
            details.open = !details.open;
        }));
        results.hidden = false;
    }

    // Phones: the system share sheet (messaging apps); otherwise the text and the OpenStreetMap
    // link are copied, to paste in a message. Nothing goes through this site
    async function sharePlace() {
        const place = current.data.candidates[current.selected];
        const text = shareText(place, current.data.slot);
        const url = placeLinks(place).osm;
        const shareStatus = results.querySelector('#place-share-status');
        try {
            if (navigator.share) return await navigator.share({ title: place.name, text, url });
            await navigator.clipboard.writeText(`${text}\n${url}`);
            shareStatus.textContent = 'Copié : à coller dans un message.';
        } catch (err) {
            if (err.name === 'AbortError') return; // share sheet closed
            console.error(err);
            shareStatus.textContent = 'Partage impossible : utilisez les liens ci-contre.';
        }
    }

    // Another score ranks the places again from the times already known: no new call (except
    // the openrouteservice paths of a new best place, if not fetched yet)
    function rerank() {
        if (!current) return;
        const { data } = current;
        // The method by zones keeps other zones for another score: computed again (local, no quota)
        if (data.proposals) return running ? undefined : form.requestSubmit();
        data.metric = checkedValue('score-metric');
        data.ranking = rankCandidates(data.candidates, data.metric, data.participants.map(p => p.people));
        debugView.rerank();
        data.best = data.ranking.length ? data.ranking[0] : null;
        if (data.best != null && data.best !== current.selected) return selectPlace(data.best);
        renderResults();
        drawSelection(false);
    }

    function applyView() {
        layout.classList.toggle('location--debug', isDebug());
        debugView.showMapOptions();
        if (!current) return;
        renderResults();
        drawSelection(false);
    }

    // ---- Run ----
    function handleEvent(event, participants, rows, state) {
        // Calls answer in parallel: within a run, keep the lowest remaining count of each service
        const quota = event.orsQuota;
        if (quota) {
            state.quotaSeen = state.quotaSeen || {};
            if (!state.quotaSeen[quota.service] || quota.remaining < orsQuota[quota.service].remaining) {
                orsQuota[quota.service] = quota;
                state.quotaSeen[quota.service] = true;
                renderCalls();
            }
        }

        switch (event.type) {
        case 'start': {
            setStep('center', 'done', `${event.center.lat.toFixed(4)}, ${event.center.lon.toFixed(4)}`);
            setStep('candidates', 'running', 'recherche autour du barycentre…');
            resultLayer.clearLayers();
            if (isDebug()) drawCenter(resultLayer, event.center);
            state.matrixModes = ORS_MODES.filter(m => participants.some(p => p.modes.includes(m)));
            state.matrixDone = [];
            break;
        }
        case 'candidates':
            state.radius = event.radius;
            setStep('candidates', 'done', `${describeCandidates(event.candidates)} `
                + `à moins de ${(event.radius / 1000).toLocaleString('fr-FR')} km `
                + `(données OSM du ${event.sources.osm || '—'}, GTFS du ${event.sources.gtfs})`);
            if (isDebug()) drawCandidates(resultLayer, event.candidates, categoryLabels);
            setProgress(0.05, `${describeCandidates(event.candidates)} : calcul des trajets…`);
            setStep('matrix', state.matrixModes.length ? 'running' : 'done',
                state.matrixModes.length ? `0/${state.matrixModes.length} matrice(s)` : 'aucun participant concerné');
            break;
        case 'matrix':
            state.matrixDone.push(MODE_LABELS[event.mode]);
            setStep('matrix', 'running', `${state.matrixDone.length}/${state.matrixModes.length} matrice(s) : `
                + `${state.matrixDone.join(', ')} (${event.sources} × ${event.destinations} temps chacune)`);
            break;
        case 'transit': {
            if (state.matrixModes.length) setStep('matrix', 'done');
            const usesTransit = participants.some(p => p.modes.includes('transit'));
            if (!usesTransit) setStep('transit', 'done', 'aucun participant concerné');
            else {
                const failed = event.errors ? `, ${event.errors} en erreur après 2 essais` : '';
                setStep('transit', event.done === event.total ? 'done' : 'running',
                    `${event.done}/${event.total} trajets (${ENGINE_NAMES[event.engine]})${failed}`);
                setProgress(0.05 + 0.85 * event.done / event.total, `Trajets en bus/métro : ${event.done}/${event.total}${failed}`);
            }
            if (event.done === event.total) setStep('result', 'running');
            break;
        }
        case 'result': {
            const reachable = event.candidates.filter(c => c.score != null).length;
            const evaluated = event.candidates.filter(c => !c.pending).length;
            closeSteps();
            setStep('result', 'done', event.best != null
                ? `${reachable}/${evaluated} candidats atteignables par tous`
                : 'aucun lieu retenu');
            state.routesTotal = event.best != null ? event.participants.length : 0;
            state.routesDone = 0;
            setStep('routes', state.routesTotal ? 'running' : 'done',
                state.routesTotal ? `0/${state.routesTotal}` : 'aucun lieu retenu');
            setProgress(0.95, event.best != null ? 'Tracé des itinéraires…' : 'Aucun lieu atteignable par tous.');
            current = { data: event, rows, selected: event.best, routes: new Map(), radius: state.radius };
            drawSelection(true);
            renderResults();
            // Score changed during the computation
            if (event.metric !== checkedValue('score-metric')) rerank();
            scrollToSection(results);
            break;
        }
        case 'zones':
            state.zonesProgress = Math.min(0.9, (state.zonesProgress ?? 0) + 0.25);
            setProgress(state.zonesProgress, event.text);
            break;
        case 'route':
            storeRoute(event);
            setStep('routes', 'running', `${++state.routesDone}/${state.routesTotal}`);
            break;
        case 'done':
            setStep('routes', 'done');
            setProgress(1, `Terminé en ${Math.round((performance.now() - state.startedAt) / 1000)} s.`);
            break;
        default:
            break;
        }
    }

    // Other place types, candidates or transit engine make the displayed result stale; another
    // score or view only changes how it is ranked or shown
    document.getElementById('categories').addEventListener('change', clearResults);
    [candidateCount, document.getElementById('transit-engine')].forEach(input => input.addEventListener('change', () => {
        storeSettings();
        clearResults();
        participantForm.refresh();
    }));
    document.getElementById('score-metric').addEventListener('change', () => {
        storeSettings();
        showScoreDescription();
        rerank();
    });
    document.getElementById('view-mode').addEventListener('change', () => {
        storeSettings();
        // With the local MOTIS, the two views do not compute the same result
        if (checkedValue('transit-engine') === 'motis') clearResults();
        applyView();
    });

    form.addEventListener('submit', async e => {
        e.preventDefault();
        const submit = form.querySelector('[type="submit"]');
        let participants;
        try {
            participants = participantForm.read();
        } catch (err) {
            return setStatus(err.message);
        }
        const categories = [...form.querySelectorAll('[name="categories"]:checked')].map(c => c.value);
        if (!categories.length) return setStatus('Choisissez au moins un type de lieu.');

        setStatus('');
        participantForm.setActive(null); // a click on the result map no longer moves anyone
        clearResults();
        const signal = beginBatch(); // cancelled by clearResults when a participant or a setting changes
        resetSteps();
        if (checkedValue('transit-engine') === 'motis') debugView.stepLabels();
        scrollToSection(document.getElementById('location-progress'));
        submit.disabled = true;
        lastRun = { orsMatrix: 0, orsDirections: 0, transitous: 0, tisseo: 0, motis: 0 };
        running = true;
        renderCalls();
        const rows = participants.map(p => p.row);
        const state = { startedAt: performance.now() };
        try {
            const data = await getData();
            const input = { slot: slotValue(), categories, transitEngine: checkedValue('transit-engine'),
                maxCandidates: Number(candidateCount.value), metric: checkedValue('score-metric'),
                participants: participants.map(({ row, ...p }) => p) };
            // lastRun is updated by the engine as calls are made
            const onEvent = event => {
                if (signal.aborted) return;
                handleEvent(event, participants, rows, state);
                renderCalls();
            };
            // The method by zones: the practical view with the local MOTIS, for the types of places
            // that have zones; the debug view compares it with the tool's below
            const byZones = input.transitEngine === 'motis' && !isDebug() && !categories.includes('station');
            if (byZones) await evaluateByZones(input, data, lastRun, onEvent);
            else await evaluate({ ...input, signal }, data, lastRun, onEvent);
            if (input.transitEngine === 'motis' && isDebug() && current) {
                await debugView.compute(input, data, state);
            }
        } catch (err) {
            if (err.name === 'AbortError') {
                failRunningStep('annulé : paramètres modifiés');
                setProgress(1, 'Calcul annulé : paramètres modifiés.');
                return;
            }
            console.error(err);
            failRunningStep(err.message || 'calcul impossible');
            setStatus(err.message || 'Calcul impossible.');
        } finally {
            Object.keys(lastRun).forEach(k => { session[k] += lastRun[k]; });
            running = false;
            submit.disabled = false;
            renderCalls();
        }
    });

    const debugView = createDebugView({ map, getData, getCurrent: () => current, categoryLabels: () => categoryLabels, isDebug,
        renderResults, drawSelection, clearResults, progress, participantForm, slotValue, setStatus });

    restoreSettings();
    showScoreDescription();
    applyView();
    motis.available().then(ok => {
        if (!ok) return;
        motisReady = true;
        document.querySelector('#transit-engine .chips').insertAdjacentHTML('beforeend',
            '<label class="chip"><input type="radio" name="transit-engine" value="motis"><span>MOTIS local (debug)</span></label>');
        if (loadSettings().engine === 'motis') engineInput('motis').checked = true;
        participantForm.refresh();
        renderCalls();
        return debugView.setup();
    });
})();
