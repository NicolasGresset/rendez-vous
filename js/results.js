// results.js - HTML of the results: the best places (proposals), the chosen one (the best by
// default, or picked among the proposals, on the map or, in the debug view, in the list of
// every candidate), links to it on OpenStreetMap and Google Maps, and each participant's trip to it
// (mode and time, the steps folded in the practical view)

import { MODE_LABELS, formatDuration, escapeHtml } from './labels.js';

const formatClock = iso => new Date(iso).toLocaleTimeString('fr-FR', {
    hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris',
});

export const PROPOSALS = 3; // best places offered: the group may prefer one it knows
export const METRIC_LABELS = { half: 'équitable', mean: 'égalitaire' };
export const METRIC_DESCRIPTIONS = {
    half: 'le trajet moyen plus la moitié de ce que le plus long a en plus, pour ne pas trop pénaliser celui qui vient de loin',
    mean: 'le trajet moyen, chaque minute comptant pareil quel que soit celui qui la passe',
};

export function choiceText(choice) {
    return choice ? `${formatDuration(choice.travel)} (${MODE_LABELS[choice.mode]})` : 'injoignable';
}

// Transitous names the trip's ends START and END
const stopName = (name, fallback) => (!name || name === 'START' || name === 'END' ? fallback : name);

// Readable text on a line's color
function textOn(hex) {
    const [r, g, b] = [1, 3, 5].map(k => parseInt(hex.slice(k, k + 2), 16));
    return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? '#0C1A2E' : '#FFFFFF';
}

// A line's badge, in its color when known
function lineBadge(leg) {
    return leg.color
        ? `<span class="line-badge" style="background: ${leg.color}; color: ${textOn(leg.color)}">${escapeHtml(leg.line || leg.mode)}</span>`
        : `<span class="line-badge">${escapeHtml(leg.line || leg.mode)}</span>`;
}

// Steps of a transit trip: departure, walks, lines with direction and stops, arrival
function transitSteps(trip, placeName) {
    const lines = trip.legs.filter(l => l.kind === 'line');
    const items = [`<li class="trip-step trip-step--time">Départ ${formatClock(trip.departure)}</li>`];
    trip.legs.forEach((leg, k) => {
        if (leg.kind === 'walk') {
            if (leg.seconds < 60) return;
            const target = k === trip.legs.length - 1 ? placeName : stopName(leg.to, 'l\'arrêt');
            items.push(`<li class="trip-step trip-step--walk">Marche ${formatDuration(leg.seconds)} jusqu'à ${escapeHtml(target)}</li>`);
            return;
        }
        items.push(`<li class="trip-step trip-step--line">
            ${lineBadge(leg)} <strong>${escapeHtml(leg.mode)}${leg.line ? ` ${escapeHtml(leg.line)}` : ''}</strong>
            ${leg.headsign ? `direction ${escapeHtml(leg.headsign)}` : ''}
            <span class="trip-step-detail">${escapeHtml(stopName(leg.from, ''))} ${formatClock(leg.departure)}
                → ${escapeHtml(stopName(leg.to, ''))} ${formatClock(leg.arrival)}
                ${leg.stops != null ? `· ${leg.stops} arrêt${leg.stops > 1 ? 's' : ''}` : ''}</span></li>`);
    });
    items.push(`<li class="trip-step trip-step--time">Arrivée ${formatClock(trip.arrival)}`
        + `${lines.length > 1 ? ` · ${lines.length - 1} correspondance${lines.length > 2 ? 's' : ''}` : ''}`
        + `${trip.wait >= 60 ? ` · en avance, ${formatDuration(trip.wait)} d'attente comptées` : ''}</li>`);
    return `<ol class="trip-steps">${items.join('')}</ol>`;
}

function modeDetails(modeTimes, retained) {
    return Object.entries(modeTimes)
        .filter(([mode]) => mode !== retained)
        .map(([mode, t]) => `${MODE_LABELS[mode]} : ${t.seconds != null ? formatDuration(t.seconds - (t.trip?.wait ?? 0)) : escapeHtml(t.error)}`)
        .join(' · ');
}

const placeAddress = place => [place.street, [place.postcode, place.city].filter(Boolean).join(' ')]
    .filter(Boolean).join(', ');

// How Google Maps is asked for a Tisséo stop: by its name (the address kept here is only the nearest one)
const STOP_SEARCH = { metro: 'Station de métro', bus: 'Arrêt de bus' };

// The place on OpenStreetMap (its own page for an OSM feature, a marker for a Tisséo stop) and on
// Google Maps (searched in text, which finds its page there: an OSM place by name and address, a
// stop by kind, name and city; by position otherwise). No key links the two: Google picks the match
export function placeLinks(place) {
    const { lat, lon } = place;
    const osm = /^(node|way|relation)\//.test(place.id)
        ? `https://www.openstreetmap.org/${place.id}`
        : `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=19/${lat}/${lon}`;
    const address = placeAddress(place);
    let query = `${lat},${lon}`;
    if (STOP_SEARCH[place.category]) query = `${STOP_SEARCH[place.category]} ${place.name}, ${place.city || 'Toulouse'}`;
    else if (address) query = `${place.name}, ${address}`;
    return { osm, google: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}` };
}

// Text sent by the share button: the place, its address, the meeting time and its OpenStreetMap link
export function shareText(place, slot) {
    const address = placeAddress(place);
    return `${place.name}${address ? `, ${address}` : ''} — rendez-vous à ${slot.from.slice(11)}`;
}

// A participant's trip: numbered disc (and ×3 for 3 people leaving from there), lines taken, mode and time, then the details (steps,
// other modes), folded
function tripCard(p, i, place) {
    const choice = place.choices[i];
    const others = modeDetails(place.times[i], choice.mode);
    const trip = choice.mode === 'transit' ? place.times[i].transit.trip : null;
    const lines = trip ? trip.legs.filter(l => l.kind === 'line') : [];
    const details = `
        ${trip ? transitSteps(trip, place.name)
            : `<p class="trip-card-direct">Trajet direct${choice.mode === 'car' ? ', dont 5 min pour se garer' : ''}.</p>`}
        ${others ? `<p class="location-muted">Autres modes : ${others}</p>` : ''}`;
    return `
        <article class="trip-card" style="--participant: ${p.color}">
            <h3 class="trip-card-title"><span class="participant-number" aria-hidden="true">${i + 1}</span>
                ${p.people > 1 ? `<span class="trip-card-people" aria-hidden="true">×${p.people}</span>` : ''}
                <span class="visually-hidden">${escapeHtml(p.label)}${p.people > 1 ? `, ${p.people} personnes` : ''}</span>
                ${lines.length ? `<span class="trip-card-lines">${lines.map(lineBadge).join(' → ')}</span>` : ''}
                <span class="trip-card-mode">${MODE_LABELS[choice.mode]} · ${formatDuration(choice.travel)}</span></h3>
            ${place.times[i].transit?.failed ? `<p class="location-warning">Transports en commun inconnus pour
                ce trajet (${escapeHtml(place.times[i].transit.error)}) : le temps retenu peut être trop long.</p>` : ''}
            <details class="trip-details"><summary>Voir l'itinéraire</summary>${details}</details>
        </article>`;
}

// The proposals among the candidates: the first in the ranking, or those the computation picked
export const proposalsOf = data => data.proposals ?? data.ranking.slice(0, PROPOSALS);

const ZONE_KINDS = { bar: ['bar', 'bars'], cafe: ['café', 'cafés'], restaurant: ['restaurant', 'restaurants'] };
export const inSameZone = (data, place) => data.candidates.map((_, j) => j).filter(j => data.candidates[j].zoneInfo?.index === place.zoneInfo.index);
const placesOfKind = (kind, n) => `${n} ${ZONE_KINDS[kind][n > 1 ? 1 : 0]}`;

// A proposal: its zone as context, the mean per person and the longest door-to-door trip, named
// once above the proposals. Pressed when it or another place of its zone is the chosen one
function proposalButton(data, j, rank, selected) {
    const { participants } = data;
    const c = data.candidates[j];
    const zoneSize = c.zoneInfo ? inSameZone(data, c).length : 0;
    const trips = c.choices.map(choice => choice.travel);
    const people = participants.reduce((sum, p) => sum + p.people, 0);
    const mean = trips.reduce((sum, t, i) => sum + participants[i].people * t, 0) / people;
    return `
        <li><button type="button" class="proposal" data-place="${j}" aria-pressed="${j === selected || (c.zoneInfo != null && c.zoneInfo.index === data.candidates[selected].zoneInfo?.index)}">
            <span class="rank-pin proposal-rank"><span>${rank + 1}</span></span>
            <span class="proposal-name">${escapeHtml(c.name)}</span>
            ${zoneSize > 1 ? `<span class="proposal-zone">${escapeHtml(c.zoneInfo.name)} · ${placesOfKind(c.zoneInfo.kind, zoneSize)}</span>` : ''}
            <span class="proposal-times" aria-label="moyenne ${formatDuration(mean)}, le plus long ${formatDuration(Math.max(...trips))}">${formatDuration(mean)} · ${formatDuration(Math.max(...trips))}</span>
        </button></li>`;
}

// The other places of the chosen one's zone, folded: any of them can be chosen instead
function zoneOthers(data, place, selected) {
    if (!place.zoneInfo) return '';
    const others = inSameZone(data, place).filter(j => j !== selected);
    if (!others.length) return '';
    const n = others.length;
    const difference = c => {
        const seconds = c.score - place.score;
        return Math.abs(seconds) < 30 ? 'pareil' : `${seconds > 0 ? '+' : '−'}${formatDuration(Math.abs(seconds))}`;
    };
    return `<details class="zone-others">
        <summary>${n > 1 ? `Les ${n} autres ${ZONE_KINDS[place.zoneInfo.kind][1]}` : `L'autre ${ZONE_KINDS[place.zoneInfo.kind][0]}`} de la zone ${escapeHtml(place.zoneInfo.name)}, à moins de 5 min à pied</summary>
        <ul class="zone-others-list">${others.map(j => `<li><button type="button" class="zone-other" data-place="${j}">
            <span class="zone-other-name">${escapeHtml(data.candidates[j].name)}</span>
            <span class="zone-other-time">${difference(data.candidates[j])}</span></button></li>`).join('')}</ul>
    </details>`;
}

// HTML of the results for the candidate `selected` of a result event; debug: the list of every
// candidate with its score, to pick any of them
export function resultsHtml(data, selected, categoryLabels, { debug = false } = {}) {
    const place = selected != null ? data.candidates[selected] : null;

    if (!place) {
        return `
            <div class="chart-header"><h2 class="chart-title">Propositions</h2></div>
            <p class="location-best">${data.candidates.length
                ? 'Aucun candidat n\'est atteignable par tous les participants.'
                : data.proposals ? 'Aucun lieu n\'est atteignable par tous les participants.'
                    : 'Aucun candidat trouvé à moins de 5 km du barycentre : essayez d\'autres types de lieux.'}</p>`;
    }

    const ranked = [...data.ranking, ...data.candidates.map((_, j) => j).filter(j => !data.ranking.includes(j))];
    const options = ranked.map(j => {
        const c = data.candidates[j];
        return `
        <option value="${j}"${j === selected ? ' selected' : ''}${c.score == null ? ' disabled' : ''}>
            ${escapeHtml(c.name)} (${categoryLabels[c.category]}) — ${c.score != null ? `score ${formatDuration(c.score)}` : 'injoignable'}${c.incomplete ? ' · incomplet' : ''}
        </option>`;
    }).join('');
    const proposals = proposalsOf(data);
    const links = placeLinks(place);
    const external = 'target="_blank" rel="noopener noreferrer"';

    return `
        <div class="chart-header">
            <h2 class="chart-title">Propositions</h2>
            ${debug ? `<label class="location-field location-place-select">
                <span>Tous les candidats (score : ${METRIC_LABELS[data.metric]})</span>
                <select id="place-select">${options}</select>
            </label>` : ''}
        </div>
        ${debug ? `<p class="location-muted location-ranking">Classées selon le critère ${METRIC_LABELS[data.metric]} (réglages) :
            ${METRIC_DESCRIPTIONS[data.metric]}.</p>` : ''}
        <p class="proposals-legend">Trajet moyen · trajet le plus long</p>
        <ol class="proposals">${proposals.map((j, rank) => proposalButton(data, j, rank, selected)).join('')}</ol>
        ${debug || !proposals.includes(selected) ? `<p class="location-best"><span class="rank-pin rank-pin--selected location-swatch--rank"></span>
            <strong>${escapeHtml(place.name)}</strong>
            <span>(${categoryLabels[place.category]})${placeAddress(place) ? ` · ${escapeHtml(placeAddress(place))}` : ''} — rendez-vous à ${data.slot.from.slice(11)}</span></p>` : ''}
        <p class="location-share">
            <a class="location-button" href="${links.osm}" ${external}>OpenStreetMap ↗</a>
            <a class="location-button" href="${links.google}" ${external}>Google Maps ↗</a>
            <button type="button" class="location-button" id="place-share">Partager le lieu</button>
            <span class="location-muted" id="place-share-status" role="status"></span>
        </p>
        ${zoneOthers(data, place, selected)}
        ${place.incomplete ? `<p class="location-warning">Calcul incomplet pour ce lieu : des trajets en transports
            en commun ont échoué deux fois${selected === data.best ? ', et aucun lieu au calcul complet n\'est atteignable par tous' : ''}.</p>` : ''}
        <div class="trip-cards">${data.participants.map((p, i) => tripCard(p, i, place)).join('')}</div>`;
}

// Debug view with the local MOTIS (debug-motis.js): the tool's first proposal against the best
// places of the whole file, for the same score and times
const km = (a, b) => {
    const rad = d => d * Math.PI / 180;
    const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon - a.lon) / 2) ** 2;
    return (2 * 6371 * Math.asin(Math.sqrt(h))).toLocaleString('fr-FR', { maximumFractionDigits: 1 });
};

export function enumerationHtml(data, enumeration, categoryLabels) {
    const { places, ranking, estimated } = enumeration;
    const head = `<div class="chart-header"><h2 class="chart-title">Tous les lieux du fichier (MOTIS local)</h2></div>`;
    if (!ranking.length) return `<section class="location-enum">${head}<p>Aucun lieu du fichier n'est atteignable par tous.</p></section>`;
    const best = places[ranking[0]];
    const tool = data.best != null ? data.candidates[data.best] : null;
    const toolIndex = tool ? places.findIndex(p => p.id === tool.id) : -1;
    const toolPlace = toolIndex >= 0 ? places[toolIndex] : null;
    const row = (p, label, pin) => `<tr>
        <td>${pin}</td><td>${label}</td>
        <td><strong>${escapeHtml(p.name)}</strong> <span class="location-muted">(${categoryLabels[p.category]})</span></td>
        <td>${formatDuration(p.score)}${p === best ? '' : ` <span class="location-muted">${p.score - best.score < 30 ? '≈' : `+${formatDuration(p.score - best.score)}`}</span>`}</td>
        <td>${p.choices.map(choiceText).join(' · ')}</td>
        <td>${km(data.center, p)} km</td></tr>`;
    const gap = toolPlace ? toolPlace.score - best.score : null;
    return `<section class="location-enum">${head}
        <p>${places.length} lieux candidats évalués${estimated ? ` (${estimated} avec un temps bus/métro seulement estimé, trop long de 0 à 15 min)` : ''},
            score ${METRIC_LABELS[data.metric]}.
            ${toolPlace ? `Proposition n° 1 de l'outil : <strong>${gap > 0 ? `+${formatDuration(gap)} (+${Math.round(gap / best.score * 100)} %)` : 'le meilleur du fichier'}</strong>,
            rang ${ranking.indexOf(toolIndex) + 1} sur ${ranking.length} lieux atteignables.` : ''}</p>
        <div class="location-enum-scroll"><table class="location-enum-table">
            <thead><tr><th></th><th>rang</th><th>lieu</th><th>score</th><th>trajets (participants 1, 2…)</th><th>au barycentre</th></tr></thead>
            <tbody>${ranking.slice(0, 3).map((j, rank) => row(places[j], rank + 1,
                `<span class="rank-pin rank-pin--best location-swatch--rank"><span>${rank + 1}</span></span>`)).join('')}
            ${toolPlace && !ranking.slice(0, 3).includes(toolIndex) ? row(toolPlace, ranking.indexOf(toolIndex) + 1,
                '<span class="rank-pin location-swatch--rank"><span>1</span></span>') : ''}</tbody>
        </table></div>
        <p class="location-muted">Sur la carte, couche « Tous les lieux du fichier » : chaque lieu, du vert (le meilleur) au jaune (50 % de plus) et au rouge (le double ou au-delà). Pointillés : le rayon de recherche de l'outil autour du barycentre.</p>
    </section>`;
}

// Debug view: the zones proposed (debug-motis.js scoreZones), each with its best place and the
// others, unfolded on request; against the best place of the file once the enumeration is done
export function zonesHtml(data, result, enumeration, categoryLabels) {
    const people = data.participants.reduce((sum, p) => sum + p.people, 0);
    const best = enumeration?.ranking.length ? enumeration.places[enumeration.ranking[0]] : null;
    const zoneItem = (zone, rank) => {
        const [first, ...others] = zone.places;
        const trips = first.choices.map(choice => choice.travel);
        const mean = trips.reduce((sum, t, i) => sum + data.participants[i].people * t, 0) / people;
        const row = p => `<tr><td><strong>${escapeHtml(p.name)}</strong> <span class="location-muted">(${categoryLabels[p.category]})</span></td>
            <td>${formatDuration(p.score)}</td><td>${p.choices.map(choiceText).join(' · ')}</td></tr>`;
        return `<li class="zone-card">
            <h3 class="zone-card-title"><span class="rank-pin rank-pin--zone location-swatch--rank"><span>${rank + 1}</span></span>
                ${escapeHtml(zone.name)} <span class="location-muted">${zone.places.length} lieu${zone.places.length > 1 ? 'x' : ''}</span></h3>
            <p><strong>${escapeHtml(first.name)}</strong> <span class="location-muted">(${categoryLabels[first.category]})</span> :
                moyenne ${formatDuration(mean)} · le plus long ${formatDuration(Math.max(...trips))}</p>
            <p class="location-muted">${first.choices.map(choiceText).join(' · ')}</p>
            ${others.length ? `<details><summary>Les ${others.length} autre${others.length > 1 ? 's' : ''} lieu${others.length > 1 ? 'x' : ''} de la zone</summary>
                <div class="location-enum-scroll"><table class="location-enum-table">
                    <thead><tr><th>lieu</th><th>score</th><th>trajets (participants 1, 2…)</th></tr></thead>
                    <tbody>${others.map(row).join('')}</tbody>
                </table></div></details>` : ''}
        </li>`;
    };
    const first = result.zones[0]?.places[0];
    const gap = best && first ? first.score - best.score : null;
    return `<section class="location-enum">
        <div class="chart-header"><h2 class="chart-title">Par zones (MOTIS local)</h2></div>
        ${result.zones.length ? `<p>${result.estimated} zones estimées, les ${result.exact} meilleures en temps exact,
            puis tous les lieux des ${result.zones.length} retenues, à au moins ${result.spacing} m l'une de l'autre :
            ${result.journeys} trajets bus/métro exacts, ${result.seconds.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} s.
            ${gap != null ? `Par rapport au meilleur lieu du fichier : <strong>${gap >= 30 ? `+${formatDuration(gap)}` : 'équivalent'}</strong>.` : ''}</p>
        <ol class="zone-cards">${result.zones.map(zoneItem).join('')}</ol>`
        : '<p>Aucune zone n\'est atteignable par tous.</p>'}
    </section>`;
}
