// tisseo.mjs - Vercel Function relaying the page's Tisséo journey searches with the site's own key
// (TISSEO_API_KEY in Vercel's settings), so that visitors need none and never see it.
// A POST, so that the participants' positions stay out of the request logs. Only the fields the page
// sends go through. An error's body is not relayed: it might repeat the key.

const COORDINATES = /^-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?$/;
const FIELDS = {
    departurePlaceXY:       COORDINATES,
    arrivalPlaceXY:         COORDINATES,
    firstDepartureDatetime: /^\d{4}-\d\d-\d\d \d\d:\d\d$/,
    number:                 /^[1-9]$/,
};
const TIMEOUT_MS = 14000; // below the page's own timeout

// The fields above -> Tisséo's journeys as XML. No key configured: 401, as for a refused key
export async function POST(request) {
    const key = process.env.TISSEO_API_KEY;
    if (!key) return new Response(null, { status: 401 });
    let fields;
    try {
        fields = await request.json();
    } catch {
        return new Response(null, { status: 400 });
    }
    const valid = Object.entries(FIELDS).every(([name, format]) => format.test(fields?.[name]));
    if (!valid) return new Response(null, { status: 400 });

    const params = new URLSearchParams({ key, lang: 'fr' });
    Object.keys(FIELDS).forEach(name => params.set(name, fields[name]));
    let answer;
    try {
        answer = await fetch(`https://api.tisseo.fr/v2/journeys.xml?${params}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
        return new Response(null, { status: 502 });
    }
    return new Response(answer.ok ? await answer.text() : null,
        { status: answer.status, headers: { 'Content-Type': 'application/xml' } });
}
