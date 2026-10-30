// scoring.js - Scores of the evaluation (lower is better), from each participant's fastest time in
// seconds and the people leaving with them: the tool's two scores (engine.js SCORES), the mean time
// per person ("égalitaire") and the mean plus half the excess of the longest trip over the mean
// ("équitable", Ogryczak's (1 - β) mean + β max with β = 1/2)

const mean = (seconds, people) => seconds.reduce((s, x, i) => s + people[i] * x, 0) / people.reduce((s, n) => s + n, 0);

export const METRICS = {
    mean: { label: 'temps moyen par personne', score: mean },
    half: { label: 'moyenne + ½ (max − moyenne)',
        score: (seconds, people) => mean(seconds, people) + (Math.max(...seconds) - mean(seconds, people)) / 2 },
};

// Score of every place of the oracle for the participants' modes, null when someone cannot reach it
export function oracleScores(oracle, participants, metricName, carParkingS) {
    const people = participants.map(p => p.people);
    return oracle.venues.map((_, j) => {
        const seconds = participants.map((p, i) => {
            const times = p.modes
                .map(mode => oracle.times[i][mode][j] ?? null)
                .map((t, k) => (t != null && p.modes[k] === 'car' ? t + carParkingS : t))
                .filter(t => t != null);
            return times.length ? Math.min(...times) : null;
        });
        return seconds.every(t => t != null) ? METRICS[metricName].score(seconds, people) : null;
    });
}

// Positions (in pool) of the k places with the lowest score
export function topPlaces(scores, pool, k) {
    return pool.filter(j => scores[j] != null).sort((a, b) => scores[a] - scores[b]).slice(0, k);
}
