export function createReconnectController({
  start,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  onError = (error) => console.error('[WhatsApp reconnect]', error),
  baseDelayMs = 3000,
  maxDelayMs = 60000,
}) {
  let timer = null;
  let attempts = 0;

  function schedule() {
    if (timer !== null) return false;

    const delay = Math.min(
      baseDelayMs * (2 ** attempts),
      maxDelayMs,
    );
    attempts += 1;

    timer = setTimer(() => {
      timer = null;

      Promise.resolve()
        .then(() => start())
        .catch((error) => {
          onError(error);
          schedule();
        });
    }, delay);

    return delay;
  }

  function reset() {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    attempts = 0;
  }

  return {
    schedule,
    reset,
    getAttempts: () => attempts,
    hasPendingTimer: () => timer !== null,
  };
}
