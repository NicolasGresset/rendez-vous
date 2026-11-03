// debug-view.js - The page's debug view with a local MOTIS (dev server only, debug-motis.js): the
// method by zones and every candidate place of the file scored below the tool's result, test cases of
// scripts/eval, and the map's optional layers (the network's lines, a time map, the zones)

import { beginBatch } from './cancel.js';
import { enumeratePlaces, scorePlaces, scoreZones, timeGrid } from './debug-motis.js';
import { escapeHtml } from './labels.js';
import { drawCenter, drawEnumeration, drawNetworkLines, drawRadius, drawTimeGrid, drawZoneResults, drawZones } from './map.js';
import * as motis from './motis.js';
import { METRIC_LABELS } from './results.js';

// getCurrent(): the displayed result (main.js), categoryLabels(): those of the places file,
// progress: progress.js, participantForm: participants.js
export function createDebugView({ map, getData, getCurrent, categoryLabels, isDebug, renderResults, drawSelection, clearResults,
    progress, participantForm, slotValue, setStatus }) {
    const { setProgress, setStep, addStep, setLabel } = progress;
    let timeLayer = null;     // its time map layer, once offered
    let enumLayer = null;     // its layer of every place of the file (off by default), once offered
    let layersControl = null; // the map's optional layers, debug view only
    let optionalLayers = {};

    // The practical view has the default map and no option: the debug view's layers go with it
    function showMapOptions() {
        if (!layersControl) return;
        if (isDebug()) return layersControl.addTo(map);
        layersControl.remove();
        Object.values(optionalLayers).forEach(layer => map.removeLayer(layer));
    }

    // The steps' labels name openrouteservice: the debug view's engine computes everything locally
    function stepLabels() {
        setLabel('matrix', 'Temps marche, vélo, voiture (MOTIS local)');
        setLabel('routes', 'Tracés des itinéraires (MOTIS local)');
    }

    // The method by zones; another score changes the zones kept, so it is computed again (local, no quota)
    async function computeZones(onProgress = text => setProgress(0.99, text)) {
        const shown = getCurrent();
        const { data } = shown;
        beginBatch();
        const result = await scoreZones(data.participants, shown.zoneInput.categories, data.slot,
            shown.zoneInput.data, data.metric, onProgress);
        if (getCurrent() !== shown) return result; // the result was cleared meanwhile
        shown.zones = result;
        renderResults();
        drawSelection(false);
        return result;
    }

    async function addZones() {
        addStep('zones', 'Par zones : estimation de toutes, puis temps exacts des meilleures (MOTIS local, debug)');
        const result = await computeZones(text => {
            setStep('zones', 'running', text);
            setProgress(0.96, text);
        });
        setStep('zones', 'done', result
            ? `${result.estimated} zones estimées, ${result.journeys} trajets exacts, ${result.seconds.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} s`
            : 'aucune zone pour ces types de lieux');
    }

    async function enumerate(input, data, state) {
        const shown = getCurrent();
        addStep('enum', 'Tous les lieux candidats du fichier (MOTIS local, debug)');
        const progress = text => {
            setStep('enum', 'running', text);
            setProgress(0.97, text);
        };
        const found = await enumeratePlaces(input.participants, input.categories, shown.data.slot, data, progress);
        if (getCurrent() !== shown) return; // the result was cleared meanwhile
        const people = input.participants.map(p => p.people);
        shown.enum = { ...found, ranking: scorePlaces(found.places, shown.data.metric, people) };
        setStep('enum', 'done', `${found.places.length} lieux${found.estimated ? `, dont ${found.estimated} avec bus/métro estimé` : ''}`);
        setProgress(1, `Terminé en ${Math.round((performance.now() - state.startedAt) / 1000)} s (énumération comprise).`);
        drawSelection(true);
        renderResults();
        if (map.hasLayer(timeLayer)) await computeTimeGrid();
    }

    // Time map: computed once per result, when its layer is on; another score only redraws it
    async function computeTimeGrid() {
        const shown = getCurrent();
        if (!shown?.enum || shown.grid || shown.gridPending) return;
        shown.gridPending = true;
        beginBatch();
        const best = shown.enum.ranking.slice(0, 10).map(j => shown.enum.places[j]);
        const grid = await timeGrid(shown.data.participants, best, shown.data.slot, text => setProgress(0.99, text));
        if (getCurrent() !== shown) return;
        shown.grid = grid;
        setProgress(1, `Carte des temps : ${grid.cells.length} cases (bus/métro estimé, trop long de 0 à 15 min).`);
        showTimeGrid();
    }

    function showTimeGrid() {
        const current = getCurrent();
        scorePlaces(current.grid.cells, current.data.metric, current.data.participants.map(p => p.people));
        timeLayer.clearLayers();
        drawTimeGrid(timeLayer, current.grid);
    }

    function loadCase(testCase, modes) {
        participantForm.replaceWith(testCase.points, modes);
        if (!slotValue.select('19:00')) setStatus('19:00 est passé pour aujourd\'hui : heure du rendez-vous inchangée.');
        clearResults();
    }

    // The local MOTIS answers: its layers and test cases are offered
    async function setup() {
        map.createPane('network').style.zIndex = 350; // under the other drawings (overlay pane: 400)
        const linesLayer = L.layerGroup();
        timeLayer = L.layerGroup();
        enumLayer = L.layerGroup();
        const zoneLayers = new Map([['bar', L.layerGroup()], ['cafe', L.layerGroup()], ['restaurant', L.layerGroup()]]);
        optionalLayers = { 'Tous les lieux du fichier': enumLayer, 'Lignes Tisséo (MOTIS local)': linesLayer,
            'Carte des temps (estimée)': timeLayer, 'Zones de bars': zoneLayers.get('bar'),
            'Zones de cafés': zoneLayers.get('cafe'), 'Zones de restaurants': zoneLayers.get('restaurant') };
        layersControl = L.control.layers(null, optionalLayers, { collapsed: false });
        showMapOptions();
        map.on('overlayadd', async e => {
            if (e.layer === timeLayer) return computeTimeGrid();
            const kind = [...zoneLayers].find(([, layer]) => layer === e.layer)?.[0];
            if (kind && !e.layer.getLayers().length) {
                const { zones, places } = await getData();
                return drawZones(e.layer, zones, places, kind);
            }
            if (e.layer !== linesLayer || linesLayer.getLayers().length) return;
            drawNetworkLines(linesLayer, await motis.networkLines(43.42, 1.20, 43.75, 1.62), 'network');
        });

        // Test cases: served by the dev server from scripts/ (not deployed)
        const module = await import('/scripts/eval/cases.js');
        const { CONFIGS } = module;
        const CASES = [...module.CASES, ...(module.DEBUG_CASES || [])];
        document.getElementById('participants').insertAdjacentHTML('beforebegin', `<div class="location-field debug-only debug-cases">
            <label for="debug-case">Cas de test (scripts/eval, debug)</label>
            <select id="debug-case"><option value="">—</option>${CASES.flatMap(c => Object.entries(CONFIGS).map(([k, config]) =>
                `<option value="${c.id}:${k}">${c.id} ${escapeHtml(c.label)} · ${escapeHtml(config.label)}</option>`)).join('')}</select></div>`);
        document.getElementById('debug-case').addEventListener('change', e => {
            const [id, config] = e.target.value.split(':');
            if (id) loadCase(CASES.find(c => c.id === id), CONFIGS[config].modes);
        });
    }

    // After the tool's own computation: the same participants by zones, then every place
    async function compute(input, data, state) {
        beginBatch();
        getCurrent().zoneInput = { categories: input.categories, data };
        await addZones();
        await enumerate(input, data, state);
    }

    // The score changed: the times are kept, the zones computed again (local, no quota)
    function rerank() {
        const current = getCurrent();
        const { data } = current;
        if (current.enum) current.enum.ranking = scorePlaces(current.enum.places, data.metric, data.participants.map(p => p.people));
        if (current.grid) showTimeGrid();
        if (current.zones) computeZones().catch(console.error);
    }

    // The result's drawings of this view, under the places (nothing in the practical view)
    function drawResult(layer) {
        const current = getCurrent();
        const { data } = current;
        const debug = isDebug();
        enumLayer?.clearLayers();
        if (debug && current.enum) {
            drawRadius(layer, data.center, current.radius);
            drawEnumeration(enumLayer, current.enum.places, current.enum.ranking, categoryLabels(), METRIC_LABELS[data.metric]);
        }
        if (debug && current.zones) drawZoneResults(layer, current.zones.zones, METRIC_LABELS[data.metric]);
        if (debug) drawCenter(layer, data.center);
    }

    // Places of this view the map should show when fitting the result
    function placesToShow() {
        const current = getCurrent();
        if (!isDebug()) return [];
        return [
            ...(current.enum && map.hasLayer(enumLayer) ? current.enum.ranking.slice(0, 3).map(j => current.enum.places[j]) : []),
            ...(current.zones ? current.zones.zones.flatMap(zone => zone.places) : []),
        ];
    }

    function clearLayers() {
        timeLayer?.clearLayers();
        enumLayer?.clearLayers();
    }

    return { setup, stepLabels, compute, rerank, drawResult, placesToShow, clearLayers, showMapOptions };
}
