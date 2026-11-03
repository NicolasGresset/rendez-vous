// geocode.js - French national address base and points of interest (IGN Géoplateforme), restricted
// to Haute-Garonne: what is typed in an address field, and the address of a position

import { TOULOUSE } from './map.js';

const PLACE_KINDS = { housenumber: 'adresse', street: 'voie', municipality: 'commune', locality: 'lieu-dit' };

export async function suggestPlaces(text) {
    const params = new URLSearchParams({
        text,
        terr:             '31',
        type:             'StreetAddress,PositionOfInterest',
        maximumResponses: 6,
        lonlat:           `${TOULOUSE[1]},${TOULOUSE[0]}`,
    });
    const res = await fetch(`https://data.geopf.fr/geocodage/completion/?${params}`);
    if (!res.ok) throw new Error(`Geocoding completion failed: ${res.status}`);
    return ((await res.json()).results || []).map(r => ({
        label: r.fulltext, kind: PLACE_KINDS[r.kind] || r.kind || '', lat: r.y, lon: r.x,
    }));
}

// Nearest address of a position, null if none or unavailable
export async function reverseGeocode(lat, lon) {
    try {
        const res = await fetch(`https://data.geopf.fr/geocodage/reverse?${new URLSearchParams({ lat, lon, limit: 1 })}`);
        if (!res.ok) throw new Error(`Reverse geocoding failed: ${res.status}`);
        return (await res.json()).features?.[0]?.properties.label || null;
    } catch (err) {
        console.error(err);
        return null;
    }
}
