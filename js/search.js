// search.js - Local place search: every place with an address (candidates and search-only places
// such as companies, shops, schools…), instant and without any call. Each typed word (accents and
// case ignored) is matched against the name, aliases, former names, category and city of every
// place, and scored; see docs/pipeline.md § 2. No DOM: it runs in Node too.

const MAX_SUGGESTIONS = 5;

const normalize = str => str.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const words = str => normalize(str).split(/[^a-z0-9]+/).filter(Boolean);
// Score of a place: for each typed word, its best match, quality x weight of the field
const SEARCH_WEIGHTS = { name: 1, alias: 0.8, category: 0.6, city: 0.6, oldName: 0.3 };
const MATCH_EXACT = 3;       // the typed word is a whole word of the field
const MATCH_PREFIX = 2;      // the typed word starts a word of the field
const MATCH_TYPO = 1;        // the typed word starts a word of the field with typos (see maxTypos)
const BONUS_NAME_START = 2;  // the name starts with the whole query
const BONUS_ALL_IN_NAME = 1; // every required typed word matches in the name
// Optional words: they add to the score when they match, but are not required
const STOP_WORDS = new Set(['le', 'la', 'les', 'l', 'de', 'du', 'des', 'd', 'au', 'aux']);
// Usual abbreviations typed for words of place names, matched as the whole word
const ABBREVIATIONS = { st: 'saint', ste: 'sainte', av: 'avenue', bd: 'boulevard', pl: 'place', r: 'rue' };
// Other words people type for a category, on top of its label
const CATEGORY_SYNONYMS = {
    'metro': 'station', 'amenity=restaurant': 'resto', 'amenity=fast_food': 'fast food snack',
    'amenity=townhall': 'hotel de ville', 'amenity=post_office': 'poste', 'amenity=university': 'fac faculte campus',
    'amenity=hospital': 'chu', 'amenity=doctors': 'docteur cabinet medical', 'amenity=cinema': 'cine',
    'office=company': 'societe', 'shop=hairdresser': 'coiffure',
};
// Typos allowed in a typed word (letter replaced, added, removed, or two letters swapped): none in
// short words, which would match almost anything
const maxTypos = token => (token.length >= 8 ? 2 : token.length >= 4 ? 1 : 0);
// At equal score: metro stations, then every other place, then the numerous bus stops (before the
// distance, so that "jean jau" gives the metro station before a nearer hairdresser of the same name)
const categoryRank = category => (category === 'metro' ? 0 : category === 'bus' ? 2 : 1);
const placeAddress = p => [p.street, [p.postcode, p.city].filter(Boolean).join(' ')].filter(Boolean).join(', ');

// Index of the places of the data file (see loadData in engine.js), built once (~16 ms on a PC);
// returns search(text, origin)
export function createPlaceSearch(data) {
    // [{ place, rank, name (normalized words joined), nameLength, fields: [{ field, weight, words }] }]
    const placeIndex = data.places.filter(p => p.street || p.city).map(p => {
        const nameWords = words(p.name);
        const fields = [
            { field: 'name', words: nameWords },
            { field: 'alias', words: (p.aliases || []).flatMap(words) },
            { field: 'oldName', words: (p.oldNames || []).flatMap(words) },
            { field: 'category', words: words(`${data.categories[p.category]} ${CATEGORY_SYNONYMS[p.category] || ''}`) },
            { field: 'city', words: words(p.city || '') },
        ].filter(f => f.words.length).map(f => ({ ...f, weight: SEARCH_WEIGHTS[f.field] }));
        return { place: p, rank: categoryRank(p.category), name: nameWords.join(' '), nameLength: p.name.length, fields };
    });
    // Sorted word index, built in the browser right after the data file (~16 ms on a PC; shipping it
    // would add ~100 KB to download): every distinct word of every field, sorted, and for each the
    // placeIndex positions of the places that have it. A typed word then finds its places with a
    // binary search instead of a scan of every place
    let indexWords = null;    // sorted distinct words
    let indexPostings = null; // indexPostings[i]: placeIndex positions of the places with indexWords[i]
    let indexShared = null;   // indexShared[i]: number of first letters indexWords[i] shares with the next word

    function buildWordIndex() {
        const postings = new Map();
        placeIndex.forEach((entry, i) => {
            new Set(entry.fields.flatMap(f => f.words)).forEach(w => {
                const list = postings.get(w);
                if (list) list.push(i);
                else postings.set(w, [i]);
            });
        });
        indexWords = [...postings.keys()].sort();
        indexPostings = indexWords.map(w => postings.get(w));
        indexShared = new Uint8Array(indexWords.length);
        for (let i = 0; i + 1 < indexWords.length; i++) {
            const [a, b] = [indexWords[i], indexWords[i + 1]];
            let n = 0;
            while (n < 255 && n < a.length && a[n] === b[n]) n++;
            indexShared[i] = n;
        }
    }
    buildWordIndex();

    // Position of the first indexed word >= word
    function lowerBound(word) {
        let low = 0;
        let high = indexWords.length;
        while (low < high) {
            const mid = (low + high) >> 1;
            if (indexWords[mid] < word) low = mid + 1;
            else high = mid;
        }
        return low;
    }

    // Positions in indexWords of the words starting with token with at most typos typos (optimal
    // string alignment distance between token and a start of the word, so that a word still being
    // typed matches). The sorted words are walked as an implicit trie: one row of distances per
    // letter of the word, kept for the next word as long as it shares the letters (indexShared),
    // and every word sharing a start is skipped (all match, or none can) once that start decides
    function typoPositions(token, typos) {
        const width = token.length + 1;
        // Row j (token vs the first j letters of the word) at j * width; grown for longer words
        let rows = new Int32Array(width * 32);
        for (let t = 0; t < width; t++) rows[t] = t;
        const positions = [];
        let shared = 0; // letters the current word shares with the last one walked
        let i = 0;
        while (i < indexWords.length) {
            const word = indexWords[i];
            if ((word.length + 1) * width > rows.length) {
                const grown = new Int32Array((word.length + 1) * width * 2);
                grown.set(rows);
                rows = grown;
            }
            let decided = word.length + 1; // the start of word whose letters decide, if any
            let match = false;
            for (let j = shared + 1; j <= word.length; j++) {
                const row = j * width;
                const above = row - width;
                const letter = word.charCodeAt(j - 1);
                const before = j > 1 ? word.charCodeAt(j - 2) : -1;
                rows[row] = j;
                let lowest = j;
                for (let t = 1; t < width; t++) {
                    const typed = token.charCodeAt(t - 1);
                    let d = Math.min(rows[above + t] + 1, rows[row + t - 1] + 1, rows[above + t - 1] + (typed === letter ? 0 : 1));
                    if (t > 1 && typed === before && token.charCodeAt(t - 2) === letter) {
                        d = Math.min(d, rows[above - width + t - 2] + 1);
                    }
                    rows[row + t] = d;
                    if (d < lowest) lowest = d;
                }
                match = rows[row + width - 1] <= typos;
                if (match || lowest > typos) {
                    decided = j;
                    break;
                }
            }
            // Next word not starting with the deciding letters; shared: least common start on the way
            shared = word.length;
            do {
                if (match) positions.push(i);
                shared = Math.min(shared, indexShared[i]);
                i++;
            } while (i < indexWords.length && shared >= decided);
        }
        return positions;
    }

    // Indexed words matching token (starting with it, possibly with typos, see typoPositions, or
    // equal to its abbreviation's word): { positions in indexWords, size: number of places listed,
    // duplicates included }, or null as soon as more than limit places are listed
    function indexRange(token, typoMatches, limit) {
        const positions = [];
        let size = 0;
        const add = i => {
            positions.push(i);
            size += indexPostings[i].length;
            return size <= limit;
        };
        if (typoMatches) {
            for (const i of typoMatches) if (!add(i)) return null;
        } else {
            for (let i = lowerBound(token); i < indexWords.length && indexWords[i].startsWith(token); i++) {
                if (!add(i)) return null;
            }
        }
        const expanded = ABBREVIATIONS[token];
        if (expanded && !expanded.startsWith(token)) {
            const i = lowerBound(expanded);
            if (indexWords[i] === expanded && !add(i)) return null;
        }
        return { positions, size };
    }

    // Places to score: those matching the most selective required word (scorePlace checks the
    // others), in placeIndex order; every place when even that word is very common ("to" matches
    // the city Toulouse): building that set would cost more than a scan
    const SCAN_RATIO = 0.25;
    function candidatePlaces(tokens, typoMatches, required) {
        let best = null;
        tokens.forEach((token, i) => {
            const range = required[i] && indexRange(token, typoMatches[i], best ? best.size : placeIndex.length * SCAN_RATIO);
            if (range) best = range;
        });
        if (!best) return placeIndex;
        const found = new Set();
        best.positions.forEach(i => indexPostings[i].forEach(j => found.add(j)));
        return [...found].sort((a, b) => a - b).map(j => placeIndex[j]);
    }

    // Best match of one typed word in a place: { score, inName, typo }; typoWords (words it starts with
    // typos, or null) only count when the place has no word equal to it or starting with it
    function bestMatch(entry, token, typoWords) {
        const expanded = ABBREVIATIONS[token];
        let score = 0;
        let inName = false;
        for (const { field, weight, words: fieldWords } of entry.fields) {
            for (const w of fieldWords) {
                const quality = w === token || w === expanded ? MATCH_EXACT : w.startsWith(token) ? MATCH_PREFIX : 0;
                if (quality * weight > score) score = quality * weight;
                if (quality && field === 'name') inName = true;
            }
        }
        if (score || !typoWords) return { score, inName, typo: false };
        for (const { field, weight, words: fieldWords } of entry.fields) {
            if (fieldWords.some(w => typoWords.has(w))) {
                if (MATCH_TYPO * weight > score) score = MATCH_TYPO * weight;
                if (field === 'name') inName = true;
            }
        }
        return { score, inName, typo: score > 0 };
    }

    // Score of a place for the typed words: { score, typo: some word matched only with typos },
    // null when a required word matches nothing
    function scorePlace(entry, tokens, typoWords, required) {
        let score = 0;
        let allInName = true;
        let typo = false;
        for (let i = 0; i < tokens.length; i++) {
            const match = bestMatch(entry, tokens[i], typoWords[i]);
            if (!match.score && required[i]) return null;
            score += match.score;
            if (match.typo) typo = true;
            if (required[i] && !match.inName) allInName = false;
        }
        if (entry.name.startsWith(tokens.join(' '))
            || entry.name.startsWith(tokens.map(t => ABBREVIATIONS[t] || t).join(' '))) score += BONUS_NAME_START;
        if (allInName) score += BONUS_ALL_IN_NAME;
        return { score, typo };
    }

    // origin: center of the participants already located (Capitole if none), to rank near places first
    return function search(text, origin) {
        const tokens = words(text);
        if (!tokens.length) return [];
        // Stop words are optional, unless the query has nothing else
        const onlyStopWords = tokens.every(t => STOP_WORDS.has(t));
        const required = tokens.map(t => onlyStopWords || !STOP_WORDS.has(t));
        const typoMatches = tokens.map(t => (maxTypos(t) ? typoPositions(t, maxTypos(t)) : null));
        const typoWords = typoMatches.map(m => m && new Set(m.map(i => indexWords[i])));
        // Squared equirectangular distance: enough to compare places a few km apart
        const cosLat = Math.cos(origin.lat * Math.PI / 180);
        const distance = p => (p.lat - origin.lat) ** 2 + ((p.lon - origin.lon) * cosLat) ** 2;
        const found = [];
        for (const entry of candidatePlaces(tokens, typoMatches, required)) {
            const match = scorePlace(entry, tokens, typoWords, required);
            if (match) found.push({ entry, typo: match.typo, score: Math.floor(match.score), distance: distance(entry.place) });
        }
        // Places found without typos first, whatever their score
        return found
            .sort((a, b) => a.typo - b.typo
                || b.score - a.score
                || a.entry.rank - b.entry.rank
                || a.distance - b.distance
                || a.entry.nameLength - b.entry.nameLength)
            .slice(0, MAX_SUGGESTIONS)
            .map(({ entry: { place: p } }) => {
                const address = `${p.near ? 'près de ' : ''}${placeAddress(p)}`;
                return { label: `${p.name} — ${address}`, name: p.name, address, kind: data.categories[p.category], lat: p.lat, lon: p.lon };
            });
    };
}
