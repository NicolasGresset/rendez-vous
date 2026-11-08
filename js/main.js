// main.js - Meeting point finder: the form's submission, the service's answer, the results and the glue between the
// page's modules. The computation is on the server (docs/architecture.md).

import { askPlace, askProposals, ApiError, UNAVAILABLE, warmUp } from './api.js';
import { placeOf, questionOf, resultOf } from './answer.js';
import { slotPicker } from './slots.js';
import { createMap, drawCandidates, drawRoute as drawPath } from './map.js';
import { resultsHtml, choiceText, placeLinks, shareText, inSameZone } from './results.js';
import { escapeHtml } from './labels.js';
import { beginBatch, cancelBatch } from './cancel.js';
import { createParticipants } from './participants.js';

(function () {
    const form = document.getElementById('location-form');
    if (!form || !window.L) return;

    const MAX_PARTICIPANTS = 10;
    // Modes checked for every new participant
    const defaultModes = () => ['walk', 'transit'];

    const status  = document.getElementById('location-status');
    const results = document.getElementById('location-results');

    // Bring a section into view (below the fixed navigation, see scroll-margin-top in the CSS)
    function scrollToSection(el) {
        const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        el.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
    }

    function setStatus(text) {
        status.textContent = text || '';
        status.hidden = !text;
    }

    const slotValue = slotPicker(document.getElementById('slot'), document.getElementById('slot-options'));

    // Computers (mouse or touchpad): keyboard flow between the fields, draggable participant points
    const finePointer = window.matchMedia('(pointer: fine)').matches;

    const map = createMap('location-map');
    const resultLayer = L.layerGroup().addTo(map);
    let routeLayers = [];    // per participant: layer group holding its path to the selected place
    // Displayed result: { data (answer.js resultOf), question, rows, selected (candidate index), wanted }
    let current = null;

    // Any change to the participants or the place type makes the displayed result stale
    function clearResults() {
        cancelBatch(); // what still runs for this result is no longer wanted
        resultLayer.clearLayers();
        routeLayers = [];
        current = null;
        participantForm.unbindPopups();
        results.hidden = true;
    }

    // Places for the address search and category labels, loaded once per page, as soon as it is shown
    let dataPromise = null;
    let categoryLabels = {};
    const getData = () => {
        dataPromise = dataPromise || fetch('data/pois-toulouse.json')
            .then(res => {
                if (!res.ok) throw new Error(`data/pois-toulouse.json failed: ${res.status}`);
                return res.json();
            })
            .then(data => { categoryLabels = data.categories; return data; })
            .catch(err => { dataPromise = null; throw err; });
        return dataPromise;
    };

    const participantForm = createParticipants({ map, finePointer, getData, defaultModes, maxParticipants: () => MAX_PARTICIPANTS,
        scrollToSection, setStatus, onStale: clearResults });
    participantForm.start(3);

    // ---- The connection, opened at the first use of the form; a service that does not answer is told at once ----
    let warmedUp = false;
    async function warmUpOnce() {
        if (warmedUp) return;
        warmedUp = true;
        if (await warmUp()) {
            if (status.textContent === UNAVAILABLE) setStatus('');
        } else {
            warmedUp = false; // tried again at the next use
            setStatus(UNAVAILABLE);
        }
    }
    form.addEventListener('focusin', warmUpOnce);
    form.addEventListener('pointerdown', warmUpOnce);
    map.on('click', warmUpOnce);

    // ---- Results (results.js): the chosen place, each participant's trip to it, the paths on the map ----
    function drawSelection(fit) {
        const { data, rows, selected } = current;
        const place = data.candidates[selected];
        resultLayer.clearLayers();
        drawCandidates(resultLayer, data.candidates, categoryLabels, { selected, proposals: data.proposals, onSelect: selectPlace,
            also: place?.zoneInfo ? inSameZone(data, place) : [] });
        routeLayers = data.participants.map((p, i) => {
            participantForm.markerOf(rows[i])
                ?.bindPopup(`<strong>${escapeHtml(p.label)}</strong><br>${choiceText(place?.choices[i])}`);
            return place ? L.layerGroup().addTo(resultLayer) : null;
        });
        if (place) data.participants.forEach((p, i) => drawPath(routeLayers[i], p, place, place.routes[i], p.color));
        if (fit) {
            const shown = data.proposals.map(j => data.candidates[j]);
            const points = [...shown.map(c => [c.lat, c.lon]), ...data.participants.map(p => [p.lat, p.lon])];
            if (points.length) map.fitBounds(points, { padding: [30, 30], maxZoom: 16 });
        }
    }

    // A place of a zone without times: asked now, then shown unless another place was chosen meanwhile
    async function scoreThenSelect(j) {
        const shown = current;
        const { data } = shown;
        shown.wanted = j;
        if (data.candidates[j].computing) return;
        data.candidates[j].computing = true;
        data.candidates[j].failed = false;
        renderResults();
        try {
            data.candidates[j] = placeOf(await askPlace(shown.question, data.candidates[j].id, beginBatch()), data.candidates[j]);
        } catch (err) {
            if (current !== shown) return; // the result was cleared meanwhile
            if (err.name !== 'ApiError') console.error(err);
            data.candidates[j].computing = false;
            data.candidates[j].failed = true;
        }
        if (current !== shown) return;
        if (shown.wanted === j && data.candidates[j].score != null) return selectPlace(j);
        renderResults();
        drawSelection(false);
    }

    function selectPlace(j) {
        if (current?.data.candidates[j]?.pending) return scoreThenSelect(j);
        if (!current || j === current.selected || current.data.candidates[j]?.score == null) return;
        current.wanted = j;
        current.selected = j;
        renderResults();
        drawSelection(false);
    }

    function renderResults() {
        const othersOpen = results.querySelector('.zone-others')?.open;
        results.innerHTML = resultsHtml(current.data, current.selected, categoryLabels);
        results.querySelectorAll('.proposal, .zone-other').forEach(button =>
            button.addEventListener('click', () => selectPlace(Number(button.dataset.place))));
        if (othersOpen && results.querySelector('.zone-others')) results.querySelector('.zone-others').open = true;
        results.querySelector('#place-share')?.addEventListener('click', sharePlace);
        // A click anywhere on a card folds or unfolds its details; the summary toggles natively,
        // the unfolded details and a text selection are left alone
        results.querySelectorAll('.trip-card').forEach(card => card.addEventListener('click', e => {
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

    document.getElementById('place-type').addEventListener('change', clearResults);

    form.addEventListener('submit', async e => {
        e.preventDefault();
        const submit = form.querySelector('[type="submit"]');
        let participants;
        try {
            participants = participantForm.read();
        } catch (err) {
            return setStatus(err.message);
        }
        const placeType = form.querySelector('[name="place-type"]:checked').value;
        const slot = slotValue();
        const rows = participants.map(p => p.row);
        const question = questionOf(participants, placeType, slot);

        participantForm.setActive(null); // a click on the result map no longer moves anyone
        clearResults();
        const signal = beginBatch(); // cancelled by clearResults when a participant or the place type changes
        setStatus('Recherche des meilleurs lieux…');
        submit.disabled = true;
        try {
            await getData();
            const answer = await askProposals(question, signal);
            if (signal.aborted) return;
            const data = resultOf(answer, participants.map(({ row, ...p }) => p), slot);
            current = { data, question, rows, selected: data.best };
            setStatus('');
            drawSelection(true);
            renderResults();
            scrollToSection(results);
        } catch (err) {
            if (err.name === 'AbortError') return setStatus('');
            if (!(err instanceof ApiError)) console.error(err);
            setStatus(err instanceof ApiError ? err.message : UNAVAILABLE);
        } finally {
            submit.disabled = false;
        }
    });
})();
