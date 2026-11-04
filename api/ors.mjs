// ors.mjs - Vercel Function relaying the page's openrouteservice calls with the site's own key
// (OPENROUTESERVICE_API_KEY in Vercel's settings), so that visitors need none and never see it.
// Only the two services the page uses go through. An error's body is not relayed: it might repeat the key.

const PROFILE = '(?:foot-walking|cycling-regular|driving-car)';
const ALLOWED_PATH = new RegExp(`^(?:matrix/${PROFILE}|directions/${PROFILE}/geojson)$`);
const TIMEOUT_MS = 14000; // below the page's own timeout
const QUOTA_HEADERS = ['x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset'];

// { path, body } -> the service's answer. No key configured: 401, as for a refused key
export async function POST(request) {
    const key = process.env.OPENROUTESERVICE_API_KEY;
    if (!key) return new Response(null, { status: 401 });
    let path, body;
    try {
        ({ path, body } = await request.json());
    } catch {
        return new Response(null, { status: 400 });
    }
    if (!ALLOWED_PATH.test(path)) return new Response(null, { status: 400 });

    let answer;
    try {
        answer = await fetch(`https://api.openrouteservice.org/v2/${path}`, {
            method:  'POST',
            headers: { Authorization: key, 'Content-Type': 'application/json' },
            body:    JSON.stringify(body),
            signal:  AbortSignal.timeout(TIMEOUT_MS),
        });
    } catch {
        return new Response(null, { status: 502 });
    }
    const headers = { 'Content-Type': 'application/json' };
    QUOTA_HEADERS.filter(name => answer.headers.has(name)).forEach(name => { headers[name] = answer.headers.get(name); });
    return new Response(answer.ok ? await answer.text() : null, { status: answer.status, headers });
}
