export const MAX_AUTOMATIC_ANSWER_RETRIES = 3;

const RETRY_DELAYS_MS = Object.freeze([2_000, 5_000, 10_000]);

export function automaticAnswerRetryDelay(attempt) {
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > MAX_AUTOMATIC_ANSWER_RETRIES) return null;
  return RETRY_DELAYS_MS[attempt - 1];
}

export function isRelayConnectionError(error) {
  const message = error instanceof Error ? error.message : String(error || '');
  return /failed to fetch|networkerror|network request failed|load failed|relay unavailable|connection refused/i.test(message);
}

export function formatRetryDelay(delayMs) {
  return Math.max(1, Math.ceil(Number(delayMs) / 1_000));
}
