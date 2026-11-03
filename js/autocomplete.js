// autocomplete.js - The suggestion list of a participant's address field: local places at once, then
// addresses from a service; keyboard and mouse, as a combobox

import { escapeHtml } from './labels.js';

const MIN_QUERY_LENGTH = 3;       // suggestions of the service
const MIN_LOCAL_QUERY_LENGTH = 2; // local place suggestions
const SUGGEST_DELAY_MS = 250;

// row: the participant's element. localPlaces(text): local suggestions, addresses(text): those of the
// service, onChoose(option) then onChosen(): an option was picked (the list closed in between),
// onEdit(): the field was edited, scrollToSection and finePointer: for touch screens, see below
export function attachAutocomplete(row, { localPlaces, addresses, onChoose, onChosen, onEdit, scrollToSection, finePointer }) {
    const input = row.querySelector('[name="address"]');
    const box = row.querySelector('.address-options');
    let options = [];
    let active = -1;
    let timer = null;
    let requestId = 0;

    // Touch screens: the keyboard covers the lower part of the screen, where the suggestions
    // open; the field moves to the top of the screen, below the navigation, to leave them room
    // (after the tap's own events: they would interrupt a smooth scroll started during them)
    input.addEventListener('focus', () => {
        if (!finePointer) setTimeout(() => scrollToSection(row.querySelector('.participant-address')), 50);
    });

    const close = () => {
        box.hidden = true;
        input.setAttribute('aria-expanded', 'false');
        input.removeAttribute('aria-activedescendant');
        active = -1;
    };
    const highlight = index => {
        active = index;
        [...box.children].forEach((li, i) => li.setAttribute('aria-selected', i === index ? 'true' : 'false'));
        if (index >= 0) input.setAttribute('aria-activedescendant', box.children[index].id);
    };
    const choose = index => {
        if (!options[index]) return;
        // A Géoplateforme answer still to come must not open the list again
        clearTimeout(timer);
        requestId++;
        onChoose(options[index]);
        close();
        onChosen();
    };
    // Local places (name, tag and address) first, then Géoplateforme addresses;
    // pending: Géoplateforme has not answered yet, so "no result" is not shown
    const render = (pending = false) => {
        if (!options.length && pending) return close();
        box.innerHTML = options.length
            ? options.map((o, i) => `
                <li role="option" id="${box.id}-${i}" aria-selected="false" data-index="${i}">
                    ${o.name
                        ? `<strong>${escapeHtml(o.name)}</strong> <span class="address-tag">${escapeHtml(o.kind)}</span>
                           <span class="address-detail">${escapeHtml(o.address)}</span>`
                        : `${escapeHtml(o.label)} <span class="location-muted">${escapeHtml(o.kind)}</span>`}</li>`).join('')
            : '<li class="address-empty">Aucun résultat en Haute-Garonne</li>';
        box.hidden = false;
        input.setAttribute('aria-expanded', 'true');
        active = -1;
    };

    input.addEventListener('input', async () => {
        onEdit();
        clearTimeout(timer);
        const id = ++requestId; // answers to older queries are ignored
        const text = input.value.trim();
        if (text.length < MIN_LOCAL_QUERY_LENGTH) return close();
        const local = await localPlaces(text);
        if (id !== requestId) return;
        options = local;
        render(true);
        if (text.length < MIN_QUERY_LENGTH) return;
        timer = setTimeout(async () => {
            try {
                const found = await addresses(text);
                if (id !== requestId) return;
                options = [...local, ...found];
                render();
            } catch (err) {
                console.error(err);
                row.querySelector('.participant-hint').textContent = 'géocodage indisponible';
            }
        }, SUGGEST_DELAY_MS);
    });

    input.addEventListener('keydown', e => {
        if (box.hidden || !options.length) return;
        if (e.key === 'ArrowDown') { e.preventDefault(); highlight((active + 1) % options.length); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); highlight((active - 1 + options.length) % options.length); }
        else if (e.key === 'Enter') { e.preventDefault(); choose(active >= 0 ? active : 0); }
        else if (e.key === 'Escape') close();
    });

    // mousedown fires before the input blur, so the click is not lost
    box.addEventListener('mousedown', e => {
        const li = e.target.closest('li[data-index]');
        if (!li) return;
        e.preventDefault();
        choose(Number(li.dataset.index));
    });
    input.addEventListener('blur', close);
}
