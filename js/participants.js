// participants.js - The participants: their cards in the form (address, modes, people), their points
// on the map (a click places the active one, dragging moves one on computers), and what the
// computation reads from them. Knows nothing of the computation: it says when its result is stale.

import { attachAutocomplete } from './autocomplete.js';
import { reverseGeocode, suggestPlaces } from './geocode.js';
import { TOULOUSE } from './map.js';
import { MODE_LABELS, PARTICIPANT_COLORS } from './labels.js';
import { createPlaceSearch } from './search.js';

function rowHtml(uid, checkedModes) {
    return `
            <legend class="participant-legend"></legend>
            <div class="location-field participant-address">
                <label class="visually-hidden" for="address-${uid}">Adresse ou lieu</label>
                <!-- Address field and position button: one control for one thing, the place -->
                <div class="address-group">
                    <input type="text" id="address-${uid}" name="address" placeholder="Adresse ou lieu"
                        autocomplete="off" role="combobox" aria-autocomplete="list" aria-expanded="false"
                        aria-controls="address-options-${uid}">
                    <!-- Own drawing (a target): no third-party icon -->
                    <button type="button" class="location-button location-button--icon" data-action="locate" tabindex="-1"
                    aria-label="Ma position actuelle" title="Ma position actuelle">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                        stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.5"
                        fill="currentColor" stroke="none"/><path d="M12 1v4M12 19v4M1 12h4M19 12h4"/></svg>
            </button>
                    <ul class="address-options" id="address-options-${uid}" role="listbox" hidden></ul>
                </div>
                <span class="participant-hint"></span>
            </div>
            <div class="participant-options">
                <div class="participant-modes chips" role="group" aria-label="Modes de transport">
                    ${Object.entries(MODE_LABELS).map(([mode, label]) => `
                        <label class="chip"><input type="checkbox" name="modes" value="${mode}" tabindex="-1"${checkedModes.includes(mode) ? ' checked' : ''}><span>${label}</span></label>
                    `).join('')}
                </div>
                <!-- People leaving from this place (a team, a company): 1 by default, no upper bound;
                     folded into a chip (a person and 1) until opened. Own drawing: no third-party icon -->
                <div class="participant-people stepper" role="group" aria-label="Personnes au départ de ce lieu">
                    <button type="button" class="chip people-open" data-action="people-open" tabindex="-1"
                        aria-label="1 personne, en ajouter" title="Plusieurs personnes partent de ce lieu ?">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                        <circle cx="12" cy="7" r="4"/><path d="M4 21a8 8 0 0 1 16 0z"/></svg>1</button>
                    <button type="button" class="stepper-button" data-action="people-less" tabindex="-1"
                        aria-label="Une personne de moins" title="Une personne de moins" disabled>−</button>
                    <input type="number" name="people" value="1" min="1" step="1" inputmode="numeric" tabindex="-1"
                        aria-label="Nombre de personnes">
                    <button type="button" class="stepper-button" data-action="people-more" tabindex="-1"
                        aria-label="Une personne de plus" title="Une personne de plus">+</button>
                    <svg class="stepper-unit" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                        <circle cx="12" cy="7" r="4"/><path d="M4 21a8 8 0 0 1 16 0z"/></svg>
                </div>
            </div>
            <button type="button" class="location-button location-button--ghost participant-remove" data-action="remove" tabindex="-1"
                aria-label="Retirer ce participant" title="Retirer ce participant">×</button>`;
}

// map: the Leaflet map, finePointer: a computer's mouse or touchpad (keyboard flow between the fields,
// draggable points), getData: the places file, defaultModes() and maxParticipants(): settings of the
// moment, scrollToSection and setStatus: of the page, onStale(): a change makes the displayed result
// stale, onGeocode(): a geocoding call is made
export function createParticipants({ map, finePointer, getData, defaultModes, maxParticipants, scrollToSection, setStatus,
    onStale }) {
    const form = document.getElementById('location-form');
    const list = document.getElementById('participants');
    const addBtn = document.getElementById('add-participant');
    const mapElement = document.getElementById('location-map');
    const mapHint = document.getElementById('map-hint');
    const participantMarkers = new Map(); // participant row -> marker

    // Participants are told apart by their number and color (no name field)
    const participantLabel = row => `participant ${[...list.children].indexOf(row) + 1}`;

    const colorOf = row => PARTICIPANT_COLORS[[...list.children].indexOf(row) % PARTICIPANT_COLORS.length];

    // People leaving from a participant's place: a whole number from 1, anything else typed reads as
    // the nearest one (empty or below 1: 1)
    const peopleOf = row => Number(row.querySelector('[name="people"]').value);
    function setPeople(row, value) {
        const people = Math.max(1, Math.round(Number(value)) || 1);
        row.querySelector('[name="people"]').value = people;
        row.querySelector('[data-action="people-less"]').disabled = people === 1;
        if (people > 1) row.querySelector('.participant-people').classList.add('participant-people--open');
        updateMarker(row);
        onStale();
    }

    function fitParticipants() {
        const points = [...participantMarkers.values()].map(m => m.getLatLng());
        if (points.length === 1) map.setView(points[0], 14);
        else if (points.length > 1) map.fitBounds(points, { padding: [40, 40], maxZoom: 15 });
    }

    function updateMarker(row) {
        let marker = participantMarkers.get(row);
        if (!row.dataset.lat) {
            if (marker) { marker.remove(); participantMarkers.delete(row); }
            return updateMapHint();
        }
        const latLng = [Number(row.dataset.lat), Number(row.dataset.lon)];
        if (!marker) {
            // A disc in the participant's color with their number, as in their card; a click on it
            // does not place the active participant there (markers do not pass clicks to the map)
            marker = L.marker(latLng, {
                icon: L.divIcon({ className: `participant-marker${finePointer ? ' participant-marker--draggable' : ''}`,
                    iconSize: [24, 24], popupAnchor: [0, -12] }),
                keyboard: false, zIndexOffset: 1500,
            }).addTo(map);
            if (finePointer) makeDraggable(marker, row);
            participantMarkers.set(row, marker);
        }
        // Updated in place: a new icon would drop the drag listener on its element
        const element = marker.setLatLng(latLng).unbindPopup().getElement();
        element.textContent = [...list.children].indexOf(row) + 1;
        element.dataset.people = peopleOf(row) > 1 ? `×${peopleOf(row)}` : '';
        element.style.background = colorOf(row);
        element.title = participantLabel(row) + (peopleOf(row) > 1 ? `, ${peopleOf(row)} personnes` : '');
        updateMapHint();
    }

    // ---- Placing participants on the map: a click places the active participant (the one
    //      whose card was used last), dragging a participant's point moves it (computers only) ----
    const DOUBLE_CLICK_MS = 300;
    const DRAG_THRESHOLD_PX = 3;
    let activeRow = null;
    let clickTimer = null;
    let dragJustEnded = false;

    function setActive(row) {
        activeRow = row;
        [...list.children].forEach(r => r.classList.toggle('participant--active', r === row));
        mapElement.classList.toggle('location-map--picking', !!row);
        updateMapHint();
    }

    function updateMapHint() {
        const dragHint = finePointer && participantMarkers.size ? ' Glissez un point pour le déplacer.' : '';
        if (!activeRow) {
            mapHint.textContent = `Choisissez un participant pour le placer sur la carte.${dragHint}`;
            return;
        }
        const name = document.createElement('strong');
        name.textContent = participantLabel(activeRow);
        name.style.color = colorOf(activeRow);
        mapHint.replaceChildren('Cliquez sur la carte pour placer ', name, `.${dragHint}`);
    }

    // First participant without a position after row (then from the top), null if all are placed
    function nextToFill(row) {
        const rows = [...list.children];
        const start = rows.indexOf(row) + 1;
        return [...rows.slice(start), ...rows.slice(0, start)].find(r => !r.dataset.lat) || null;
    }

    // Once the active participant is placed, the next one to fill becomes active
    function placed(row) {
        if (activeRow === row) setActive(nextToFill(row));
    }

    // The exact position is kept at once; the address, which only describes it, follows
    async function placeAt(row, lat, lon, fallbackLabel, options) {
        setPosition(row, { lat, lon, label: `${fallbackLabel} (adresse en cours…)` }, options);
        placed(row);
        const label = await reverseGeocode(lat, lon);
        if (row.dataset.lat !== String(lat) || row.dataset.lon !== String(lon)) return; // moved meanwhile
        row.querySelector('[name="address"]').value = label || fallbackLabel;
    }

    // A double click (or double tap) only zooms: a single click waits to be sure it is one
    map.on('click', e => {
        if (dragJustEnded) return;
        if (clickTimer) {
            clearTimeout(clickTimer);
            clickTimer = null;
            return;
        }
        clickTimer = setTimeout(() => {
            clickTimer = null;
            // The map does not move under the cursor: the clicked point stays in view
            if (activeRow) placeAt(activeRow, e.latlng.lat, e.latlng.lng, 'point sur la carte', { fit: false });
        }, DOUBLE_CLICK_MS);
    });

    // Leaflet only drags its image markers: a participant's circle follows the mouse by hand,
    // listened on its own element so that the map does not pan at the same time
    function makeDraggable(marker, row) {
        marker.getElement().addEventListener('mousedown', down => {
            if (down.button !== 0) return;
            down.preventDefault();
            down.stopPropagation();
            const start = marker.getLatLng();
            let moved = false;
            mapElement.classList.add('location-map--dragging');
            const move = e => {
                moved = moved || Math.hypot(e.clientX - down.clientX, e.clientY - down.clientY) > DRAG_THRESHOLD_PX;
                if (moved) marker.setLatLng(map.mouseEventToLatLng(e));
            };
            const up = () => {
                document.removeEventListener('mousemove', move);
                mapElement.classList.remove('location-map--dragging');
                if (!moved) return marker.setLatLng(start);
                // The click that follows a drop is not a click on the map
                dragJustEnded = true;
                setTimeout(() => { dragJustEnded = false; });
                const { lat, lng } = marker.getLatLng();
                placeAt(row, lat, lng, 'point sur la carte', { fit: false });
            };
            document.addEventListener('mousemove', move);
            document.addEventListener('mouseup', up, { once: true });
        });
    }

    // ---- Local place search (search.js), without any call ----
    let placeSearch = null; // search(text, origin), once the places are loaded and indexed

    function loadPlaceIndex() {
        return getData()
            .then(data => { placeSearch = placeSearch || createPlaceSearch(data); })
            .catch(err => console.error(err));
    }


    // Load the places and build the search index as soon as the page is shown (after its own
    // resources, so the map is not slowed down): the search is ready before the first address is typed
    if (document.readyState === 'complete') loadPlaceIndex();
    else window.addEventListener('load', loadPlaceIndex, { once: true });

    async function localPlaces(text) {
        if (!placeSearch) await loadPlaceIndex(); // typed before the data file arrived
        return placeSearch ? placeSearch(text, searchOrigin()) : [];
    }

    // Center of the participants already located, the Capitole (TOULOUSE) if none
    function searchOrigin() {
        const located = [...list.children].filter(r => r.dataset.lat);
        if (!located.length) return { lat: TOULOUSE[0], lon: TOULOUSE[1] };
        return {
            lat: located.reduce((s, r) => s + Number(r.dataset.lat), 0) / located.length,
            lon: located.reduce((s, r) => s + Number(r.dataset.lon), 0) / located.length,
        };
    }

    // fit: false when the position was picked on the map, which then stays where it is
    function setPosition(row, place, { fit = true } = {}) {
        if (place) {
            row.dataset.lat = place.lat;
            row.dataset.lon = place.lon;
            row.querySelector('[name="address"]').value = place.label;
        } else {
            delete row.dataset.lat;
            delete row.dataset.lon;
        }
        row.classList.toggle('participant--located', !!place);
        // How to pick an address is said once, above the participants
        row.querySelector('.participant-hint').textContent = place ? '✓ position enregistrée' : '';
        updateMarker(row);
        onStale();
        if (place && fit) fitParticipants();
    }

    // ---- Form ----
    // Keyboard flow on computers: Tab goes from address to address; choosing an address goes to
    // the next participant to fill, or to "Trouver le lieu". Not on touch screens, where focusing
    // opens the keyboard.

    function focusNextParticipant(row) {
        if (!finePointer) return;
        const rows = [...list.children];
        const next = rows.slice(rows.indexOf(row) + 1).find(r => !r.dataset.lat);
        (next ? next.querySelector('[name="address"]') : form.querySelector('[type="submit"]')).focus();
    }

    let rowCounter = 0;
    function addParticipant() {
        const uid = ++rowCounter;
        const row = document.createElement('fieldset');
        row.className = 'participant';
        row.innerHTML = rowHtml(uid, defaultModes());
        list.appendChild(row);
        attachAutocomplete(row, {
            localPlaces,
            addresses: suggestPlaces,
            onChoose: option => { setPosition(row, option); placed(row); },
            onChosen: () => focusNextParticipant(row),
            onEdit: () => { if (row.dataset.lat) setPosition(row, null); },
            scrollToSection,
            finePointer,
        });
        refreshRows();
        return row;
    }

    function refreshRows() {
        [...list.children].forEach((row, i) => {
            // A disc in the participant's color with its number; the label for screen readers only
            const legend = row.querySelector('legend');
            legend.innerHTML = `<span class="participant-number" aria-hidden="true">${i + 1}</span>
                <span class="visually-hidden">participant ${i + 1}</span>`;
            row.style.setProperty('--participant', PARTICIPANT_COLORS[i]);
            row.querySelector('[data-action="remove"]').hidden = list.children.length <= 1;
            updateMarker(row);
        });
        addBtn.hidden = list.children.length >= maxParticipants();
    }

    // The people stepper, opened from its chip, folds again when the focus leaves it with one person
    list.addEventListener('focusout', e => {
        const group = e.target.closest('.participant-people');
        if (group && !group.contains(e.relatedTarget) && peopleOf(group.closest('.participant')) === 1) {
            group.classList.remove('participant-people--open');
        }
    });

    // The participant whose card is used is the one a click on the map places
    list.addEventListener('focusin', e => setActive(e.target.closest('.participant')));
    // pointerdown, before the suggestion chosen with mousedown moves on to the next participant
    list.addEventListener('pointerdown', e => {
        const row = e.target.closest('.participant');
        if (row && row !== activeRow) setActive(row);
    });

    list.addEventListener('change', e => {
        if (e.target.name === 'people') return setPeople(e.target.closest('.participant'), e.target.value);
        if (e.target.name !== 'modes') return;
        onStale();
    });

    list.addEventListener('click', e => {
        const button = e.target.closest('button[data-action]');
        if (!button) return;
        const row = button.closest('.participant');
        if (button.dataset.action === 'people-open') {
            button.parentElement.classList.add('participant-people--open');
            return button.parentElement.querySelector('[data-action="people-more"]').focus();
        }
        if (button.dataset.action === 'people-less' || button.dataset.action === 'people-more') {
            return setPeople(row, peopleOf(row) + (button.dataset.action === 'people-more' ? 1 : -1));
        }
        if (button.dataset.action === 'remove') {
            participantMarkers.get(row)?.remove();
            participantMarkers.delete(row);
            row.remove();
            refreshRows();
            if (activeRow === row) setActive(nextToFill(null));
            onStale();
            return;
        }
        if (!navigator.geolocation) return setStatus('Géolocalisation non disponible dans ce navigateur.');
        button.disabled = true;
        navigator.geolocation.getCurrentPosition(pos => {
            button.disabled = false;
            placeAt(row, pos.coords.latitude, pos.coords.longitude, 'ma position actuelle');
        }, () => {
            setStatus('Position refusée ou introuvable.');
            button.disabled = false;
        }, { enableHighAccuracy: true, timeout: 10000 });
    });

    addBtn.addEventListener('click', () => {
        const row = addParticipant();
        setActive(row);
        if (finePointer) row.querySelector('[name="address"]').focus();
    });
    // Participants left untouched (no address) are ignored: three are shown by default
    function readParticipants() {
        const untouched = row => !row.dataset.lat && !row.querySelector('[name="address"]').value.trim();
        const rows = [...list.children].filter(row => !untouched(row));
        if (rows.length < 2) throw new Error('Choisissez une adresse pour au moins deux participants.');
        if (rows.length > maxParticipants()) throw new Error(`${maxParticipants()} participants au plus : retirez-en ${rows.length - maxParticipants()}.`);
        return rows.map(row => {
            const label = participantLabel(row);
            const modes = [...row.querySelectorAll('[name="modes"]:checked')].map(c => c.value);
            if (!row.dataset.lat) {
                row.querySelector('[name="address"]').focus();
                throw new Error(`Choisissez une adresse dans la liste, un point sur la carte ou « ma position actuelle » pour le ${label}.`);
            }
            if (!modes.length) throw new Error(`Choisissez au moins un mode de transport pour le ${label}.`);
            // Label and color go with the participant: an ignored one before it must not shift the others'
            return { label, modes, people: peopleOf(row), lat: Number(row.dataset.lat), lon: Number(row.dataset.lon),
                color: colorOf(row), row };
        });
    }

    return {
        add: addParticipant,
        refresh: refreshRows,
        read: readParticipants,
        setActive,
        fit: fitParticipants,
        markerOf: row => participantMarkers.get(row),
        unbindPopups: () => participantMarkers.forEach(m => m.unbindPopup()),
        // The first cards of the page; those left untouched are ignored
        start(count) {
            const rows = Array.from({ length: count }, addParticipant);
            setActive(rows[0]);
            if (finePointer) rows[0].querySelector('[name="address"]').focus();
        },
        // Replaces every card by these points ({ lat, lon, name, people }), modes(i) for each
        replaceWith(points, modes) {
            [...list.children].forEach(row => {
                participantMarkers.get(row)?.remove();
                participantMarkers.delete(row);
                row.remove();
            });
            points.forEach((point, i) => {
                const row = addParticipant();
                row.querySelectorAll('[name="modes"]').forEach(box => { box.checked = modes(i).includes(box.value); });
                if (point.people > 1) setPeople(row, point.people);
                setPosition(row, { lat: point.lat, lon: point.lon, label: point.name }, { fit: false });
            });
            refreshRows();
            setActive(null);
            fitParticipants();
        },
    };
}
