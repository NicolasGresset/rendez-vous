// cases.js - Fixed test cases for evaluating how the tool picks meeting places: starting points
// (5 groups of 3, 5 groups of 4), mode configurations, arrival slot. Starting points are town
// halls and neighbourhood places taken from data/pois-toulouse.json, not metro stations, which
// would favour transit. Côte Pavée is 50 m off its post office (43.60086, 1.47638), where MOTIS
// finds no bike route at all. See docs/evaluation.md.

// A Tuesday evening within the Tisséo GTFS validity (2026-10-29 to 2026-12-02)
export const DATE = '2026-11-03';
export const SLOT = '19:00';      // meeting time
export const TOLERANCE_MIN = 10; // late tolerance, the tool's default

const p = (name, lat, lon, people = 1) => ({ name, lat, lon, people });

export const CASES = [
    { id: 'T1', label: 'centre, compact', points: [
        p('Lycée Pierre de Fermat', 43.60331, 1.43941), p('Côte Pavée', 43.6005, 1.4760),
        p('Collège Lamartine (Saint-Cyprien)', 43.59499, 1.43368)] },
    { id: 'T2', label: 'très étalé', points: [
        p('Mairie de Colomiers', 43.60926, 1.33455), p("Mairie de L'Union", 43.65693, 1.48431),
        p('Mairie de Ramonville', 43.54564, 1.47511)] },
    { id: 'T3', label: 'deux proches, un loin', points: [
        p('Les Minimes', 43.61782, 1.43535), p('Croix-Daurade', 43.6309, 1.46351),
        p('Mairie de Portet-sur-Garonne', 43.52053, 1.40018)] },
    { id: 'T4', label: 'le long du métro A', points: [
        p('Saint-Simon', 43.5568, 1.38024), p('Lycée Pierre de Fermat', 43.60331, 1.43941),
        p('Mairie de Balma', 43.60545, 1.50217)] },
    { id: 'T5', label: 'périurbain sud-ouest', points: [
        p('Mairie de Tournefeuille', 43.58264, 1.34517), p('Mairie de Cugnaux', 43.53709, 1.34369),
        p('Mairie de Seysses', 43.49879, 1.31096)] },
    { id: 'Q1', label: 'centre, compact', points: [
        p('Les Minimes', 43.61782, 1.43535), p('Pont des Demoiselles', 43.58734, 1.461),
        p('Lycée Pierre de Fermat', 43.60331, 1.43941), p('Côte Pavée', 43.6005, 1.4760)] },
    { id: 'Q2', label: 'un très loin', points: [
        p('Lycée Pierre de Fermat', 43.60331, 1.43941), p('Bonnefoy', 43.62533, 1.45899),
        p('Collège Lamartine (Saint-Cyprien)', 43.59499, 1.43368), p('Mairie de Castanet-Tolosan', 43.51703, 1.498)] },
    { id: 'Q3', label: 'quatre points cardinaux', points: [
        p('Mairie d\'Aucamville', 43.66843, 1.42896), p('Mairie de Tournefeuille', 43.58264, 1.34517),
        p('Mairie de Castanet-Tolosan', 43.51703, 1.498), p('Mairie de Quint-Fonsegrives', 43.58534, 1.53031)] },
    { id: 'Q4', label: 'un participant de 3 personnes', points: [
        p('Sept Deniers', 43.61715, 1.40914, 3), p('Pont des Demoiselles', 43.58734, 1.461),
        p('Lardenne', 43.58965, 1.37886), p('Croix-Daurade', 43.6309, 1.46351)] },
    { id: 'Q5', label: 'ouest chargé, asymétrique', points: [
        p('Mairie de Blagnac', 43.63519, 1.39656), p('Mairie de Colomiers', 43.60926, 1.33455),
        p('Mairie de Launaguet', 43.67392, 1.45583), p('Mairie de Portet-sur-Garonne', 43.52053, 1.40018)] },
];

// Modes of each participant (by position) per configuration
export const CONFIGS = {
    transit: { label: 'marche + transport en commun', modes: () => ['walk', 'transit'] },
    mixed:   { label: 'voiture, vélo, puis marche + transport en commun',
        modes: i => (i === 0 ? ['car'] : i === 1 ? ['bike'] : ['walk', 'transit']) },
    soft:    { label: 'marche + vélo', modes: () => ['walk', 'bike'] },
};

// Candidate categories: the tool's default (bars), and all three
export const CATEGORY_SETS = { bars: ['bar'], all: ['station', 'bar', 'restaurant'] };

// Scenarios found with the demonstrator, offered in its test case picker only (not in the
// evaluation, whose set stays fixed)
export const DEMO_CASES = [
    { id: 'D1', label: 'trois stations, le meilleur entre deux lignes', points: [
        p('Rue des Fauvettes (Ramonville)', 43.552865, 1.47322), p('Jardin Niel (Empalot / Saint-Agne)', 43.5794, 1.4474),
        p('Université du Mirail', 43.5752, 1.4018)] },
];
