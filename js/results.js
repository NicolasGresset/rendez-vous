// results.js - HTML of the results: the best places (proposals), the chosen one (the best by default, or picked
// among the proposals, on the map or among the other places of its zone), links to it on OpenStreetMap and Google
// Maps, and each participant's trip to it (mode and time, the steps folded)

import { MODE_LABELS, formatDuration, escapeHtml } from './labels.js';

const formatClock = iso => new Date(iso).toLocaleTimeString('fr-FR', {
    hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris',
});

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

// A participant's trip: numbered disc (and ×3 for 3 people leaving from there), lines taken, mode and time, then the
// steps, folded
function tripCard(p, i, place) {
    const choice = place.choices[i];
    const trip = place.journeys[i];
    const lines = trip ? trip.legs.filter(l => l.kind === 'line') : [];
    const details = trip ? transitSteps(trip, place.name)
        : `<p class="trip-card-direct">Trajet direct${choice.mode === 'car' ? ', dont 5 min pour se garer' : ''}.</p>`;
    return `
        <article class="trip-card" style="--participant: ${p.color}">
            <h3 class="trip-card-title"><span class="participant-number" aria-hidden="true">${i + 1}</span>
                ${p.people > 1 ? `<span class="trip-card-people" aria-hidden="true">×${p.people}</span>` : ''}
                <span class="visually-hidden">${escapeHtml(p.label)}${p.people > 1 ? `, ${p.people} personnes` : ''}</span>
                ${lines.length ? `<span class="trip-card-lines">${lines.map(lineBadge).join(' → ')}</span>` : ''}
                <span class="trip-card-mode">${MODE_LABELS[choice.mode]} · ${formatDuration(choice.travel)}</span></h3>
            <details class="trip-details"><summary>Voir l'itinéraire</summary>${details}</details>
        </article>`;
}

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

// The other places of the chosen one's zone, folded: any of them can be chosen instead, those not scored
// yet being scored then. Best first, then those without a score
function zoneOthers(data, place, selected) {
    if (!place.zoneInfo) return '';
    const scoreOf = j => data.candidates[j].score ?? Infinity;
    const others = inSameZone(data, place).filter(j => j !== selected).sort((a, b) => scoreOf(a) - scoreOf(b));
    if (!others.length) return '';
    const n = others.length;
    const difference = c => {
        if (c.computing) return 'calcul…';
        if (c.failed) return 'échec, réessayer';
        if (c.pending) return 'calculer';
        if (c.score == null) return 'injoignable';
        const seconds = c.score - place.score;
        return Math.abs(seconds) < 30 ? 'pareil' : `${seconds > 0 ? '+' : '−'}${formatDuration(Math.abs(seconds))}`;
    };
    const unreachable = c => c.score == null && !c.pending;
    return `<details class="zone-others">
        <summary>${n > 1 ? `Les ${n} autres ${ZONE_KINDS[place.zoneInfo.kind][1]}` : `L'autre ${ZONE_KINDS[place.zoneInfo.kind][0]}`} de la zone ${escapeHtml(place.zoneInfo.name)}, à moins de 5 min à pied</summary>
        <ul class="zone-others-list">${others.map(j => `<li><button type="button" class="zone-other" data-place="${j}"${unreachable(data.candidates[j]) ? ' disabled' : ''}>
            <span class="zone-other-name">${escapeHtml(data.candidates[j].name)}</span>
            <span class="zone-other-time">${difference(data.candidates[j])}</span></button></li>`).join('')}</ul>
    </details>`;
}

// HTML of the results for the candidate `selected`
export function resultsHtml(data, selected, categoryLabels) {
    const place = selected != null ? data.candidates[selected] : null;

    if (!place) {
        return `
            <div class="chart-header"><h2 class="chart-title">Propositions</h2></div>
            <p class="location-best">Aucun lieu n'est atteignable par tous les participants.</p>`;
    }

    const links = placeLinks(place);
    const external = 'target="_blank" rel="noopener noreferrer"';

    return `
        <div class="chart-header"><h2 class="chart-title">Propositions</h2></div>
        <p class="proposals-legend">Trajet moyen · trajet le plus long</p>
        <ol class="proposals">${data.proposals.map((j, rank) => proposalButton(data, j, rank, selected)).join('')}</ol>
        ${!data.proposals.includes(selected) ? `<p class="location-best"><span class="rank-pin rank-pin--selected location-swatch--rank"></span>
            <strong>${escapeHtml(place.name)}</strong>
            <span>(${escapeHtml(categoryLabels[place.category] ?? '')})${placeAddress(place) ? ` · ${escapeHtml(placeAddress(place))}` : ''} — rendez-vous à ${data.slot.from.slice(11)}</span></p>` : ''}
        <p class="location-share">
            <a class="location-button" href="${links.osm}" ${external}>OpenStreetMap ↗</a>
            <a class="location-button" href="${links.google}" ${external}>Google Maps ↗</a>
            <button type="button" class="location-button" id="place-share">Partager le lieu</button>
            <span class="location-muted" id="place-share-status" role="status"></span>
        </p>
        ${zoneOthers(data, place, selected)}
        <div class="trip-cards">${data.participants.map((p, i) => tripCard(p, i, place)).join('')}</div>`;
}
