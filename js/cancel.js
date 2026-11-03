// cancel.js - The work running for the displayed result: its calls share one signal, cancelled as
// soon as the result is no longer wanted (a participant or a setting changed), so that an old
// answer is never shown and no call is made for nothing

export let batch = new AbortController();
export const cancelBatch = () => batch.abort();
// The signal of the running work, a new one after a cancellation
export const beginBatch = () => {
    if (batch.signal.aborted) batch = new AbortController();
    return batch.signal;
};
