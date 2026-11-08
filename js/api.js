// api.js - The calls to the service's API (docs/architecture.md § API contract). On the developer's machine they go
// through the dev server (scripts/dev-server.js relays /v1/), the API accepting only the site's origin.

const LOCAL = ['localhost', '127.0.0.1'].includes(location.hostname);
const API = LOCAL ? '' : 'https://api.rendez-vous.gresset-bourgeois.fr';
const HEALTH_TIMEOUT_MS = 5000;

// A refusal or a failure of the API, its message ready to show. participant: the index of the one concerned
export class ApiError extends Error {
    constructor(message, participant = null) {
        super(message);
        this.name = 'ApiError';
        this.participant = participant;
    }
}

const UNAVAILABLE = 'Service momentanément indisponible. Réessayez dans un instant.';

const inSeconds = seconds => (seconds < 90 ? `${seconds} s` : `${Math.ceil(seconds / 60)} min`);

// What to tell the visitor for an error code of the API
export function errorMessage(body) {
    const who = body.participant != null ? `participant ${body.participant + 1}` : 'participant';
    switch (body.error) {
    case 'rate_limited': return `Beaucoup de calculs d'affilée : réessayez dans ${inSeconds(body.retryAfter)}.`;
    case 'busy': return `Beaucoup de calculs en ce moment : réessayez dans ${inSeconds(body.retryAfter)}.`;
    case 'timeout': return 'Le calcul a pris trop de temps. Réessayez dans un instant.';
    case 'time_out_of_range': return 'Cet horaire n\'est plus disponible : choisissez-en un autre.';
    case 'outside_area': return `L'adresse du ${who} est en dehors de l'agglomération toulousaine.`;
    case 'invalid_people': return `Le nombre de personnes du ${who} doit être entre 1 et 15.`;
    case 'invalid_participants': return 'Il faut entre 2 et 10 participants.';
    default: return UNAVAILABLE;
    }
}

async function post(path, body, signal) {
    let res;
    try {
        res = await fetch(`${API}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
    } catch (err) {
        if (err.name === 'AbortError') throw err;
        throw new ApiError(UNAVAILABLE);
    }
    const answer = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(errorMessage(answer), answer.participant ?? null);
    return answer;
}

export const askProposals = (question, signal) => post('/v1/proposals', question, signal);
export const askPlace = (question, id, signal) => post('/v1/place', { ...question, place: id }, signal);

// Opens the connection that the computation will reuse, and tells whether the service answers
export async function warmUp() {
    try {
        return (await fetch(`${API}/v1/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) })).ok;
    } catch {
        return false;
    }
}

export { UNAVAILABLE };
