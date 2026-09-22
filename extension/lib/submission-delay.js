export const MAX_SUBMISSION_DELAY_SECONDS = 300;

export function normalizeSubmissionDelaySeconds(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.min(MAX_SUBMISSION_DELAY_SECONDS, Math.round(number));
}

export function createSubmissionDelay({
  seconds,
  onTick = () => {},
  now = () => Date.now(),
  setTimer = (callback, delay) => setTimeout(callback, delay),
  clearTimer = (timer) => clearTimeout(timer),
} = {}) {
  const delaySeconds = normalizeSubmissionDelaySeconds(seconds);
  const deadline = now() + delaySeconds * 1_000;
  let active = true;
  let timer = null;
  let settle;
  const promise = new Promise((resolve) => { settle = resolve; });

  const finish = (ready) => {
    if (!active) return;
    active = false;
    if (timer !== null) clearTimer(timer);
    settle(ready);
  };

  const tick = () => {
    if (!active) return;
    const remainingMs = Math.max(0, deadline - now());
    const remainingSeconds = Math.ceil(remainingMs / 1_000);
    onTick(remainingSeconds);
    if (remainingMs <= 0) {
      finish(true);
      return;
    }
    timer = setTimer(tick, Math.min(1_000, remainingMs));
  };

  tick();
  return Object.freeze({
    deadline,
    promise,
    cancel: () => finish(false),
    get active() { return active; },
  });
}
