// progress.js - The progress of a computation: one bar and one line (every view), the steps with
// their state and detail (debug view)

const STEPS = [
    { id: 'center',     label: 'Barycentre des participants' },
    { id: 'candidates', label: 'Lieux candidats (extrait local OSM + GTFS Tisséo)' },
    { id: 'matrix',     label: 'Temps marche, vélo, voiture (openrouteservice)' },
    { id: 'transit',    label: 'Temps en transports en commun' },
    { id: 'result',     label: 'Sélection du lieu' },
    { id: 'routes',     label: 'Tracés des itinéraires (openrouteservice directions, trajets en transports en commun)' },
];

export function createProgress() {
    const steps = document.getElementById('progress-steps');
    const progressBar = document.getElementById('progress-bar');
    const progressText = document.getElementById('progress-text');

    function resetSteps() {
        steps.innerHTML = STEPS.map(s => `
            <li class="progress-step" data-step="${s.id}" data-state="pending">
                <span class="progress-label">${s.label}</span>
                <span class="progress-detail location-muted"></span></li>`).join('');
        steps.hidden = false;
        setProgress(0, 'Recherche des lieux candidats…');
        document.getElementById('location-progress').hidden = false;
    }

    // Practical view: one bar and one line; the transit journeys are most of the waiting
    function setProgress(fraction, text) {
        progressBar.value = fraction;
        progressText.textContent = text;
    }

    function setStep(id, state, detail) {
        const li = steps.querySelector(`[data-step="${id}"]`);
        li.dataset.state = state;
        if (detail != null) li.querySelector('.progress-detail').textContent = detail;
    }

    function failRunningStep(message) {
        const running = steps.querySelector('[data-state="running"]') || steps.querySelector('[data-state="pending"]');
        if (running) setStep(running.dataset.step, 'error', message);
        setProgress(progressBar.value, `Échec : ${message}`);
    }

    // A step added after the usual ones (debug view)
    function addStep(id, label) {
        steps.insertAdjacentHTML('beforeend', `<li class="progress-step" data-step="${id}" data-state="running">
            <span class="progress-label">${label}</span>
            <span class="progress-detail location-muted"></span></li>`);
    }

    const setLabel = (id, text) => { steps.querySelector(`[data-step="${id}"] .progress-label`).textContent = text; };

    // The steps not reached (no matrix needed…), when the result is there; the paths still run
    function closeSteps() {
        STEPS.forEach(s => {
            const li = steps.querySelector(`[data-step="${s.id}"]`);
            if (s.id !== 'routes' && li.dataset.state !== 'done') setStep(s.id, 'done', s.id === 'result' ? null : '—');
        });
    }

    return { resetSteps, setProgress, setStep, failRunningStep, addStep, setLabel, closeSteps };
}
