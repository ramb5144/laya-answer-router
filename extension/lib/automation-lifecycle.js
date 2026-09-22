export const AUTOMATION_PHASE = Object.freeze({
  NEW: 'new',
  ANSWERING: 'answering',
  FILLED: 'filled',
  SUBMITTED: 'submitted',
  AWAITING_RESULT: 'awaiting-result',
  CORRECT: 'correct',
  INCORRECT: 'incorrect',
  NAVIGATED: 'navigated',
});

const TRANSITIONS = Object.freeze({
  answer: Object.freeze({ from: [AUTOMATION_PHASE.NEW], to: AUTOMATION_PHASE.ANSWERING, effect: 'answer' }),
  'answer-failed': Object.freeze({ from: [AUTOMATION_PHASE.ANSWERING], to: AUTOMATION_PHASE.NEW }),
  filled: Object.freeze({ from: [AUTOMATION_PHASE.ANSWERING], to: AUTOMATION_PHASE.FILLED }),
  submit: Object.freeze({ from: [AUTOMATION_PHASE.FILLED], to: AUTOMATION_PHASE.SUBMITTED, effect: 'submit' }),
  'submit-failed': Object.freeze({ from: [AUTOMATION_PHASE.SUBMITTED], to: AUTOMATION_PHASE.FILLED }),
  'await-result': Object.freeze({ from: [AUTOMATION_PHASE.SUBMITTED], to: AUTOMATION_PHASE.AWAITING_RESULT }),
  correct: Object.freeze({
    from: [
      AUTOMATION_PHASE.NEW,
      AUTOMATION_PHASE.ANSWERING,
      AUTOMATION_PHASE.FILLED,
      AUTOMATION_PHASE.SUBMITTED,
      AUTOMATION_PHASE.AWAITING_RESULT,
    ],
    to: AUTOMATION_PHASE.CORRECT,
  }),
  incorrect: Object.freeze({
    from: [
      AUTOMATION_PHASE.NEW,
      AUTOMATION_PHASE.ANSWERING,
      AUTOMATION_PHASE.FILLED,
      AUTOMATION_PHASE.SUBMITTED,
      AUTOMATION_PHASE.AWAITING_RESULT,
    ],
    to: AUTOMATION_PHASE.INCORRECT,
  }),
  navigate: Object.freeze({ from: [AUTOMATION_PHASE.CORRECT], to: AUTOMATION_PHASE.NAVIGATED, effect: 'navigate' }),
  'navigate-failed': Object.freeze({ from: [AUTOMATION_PHASE.NAVIGATED], to: AUTOMATION_PHASE.CORRECT }),
});

export function createAutomationLifecycle() {
  return Object.freeze({ records: Object.freeze([]) });
}

export function getQuestionPhase(lifecycle, questionKey) {
  assertLifecycle(lifecycle);
  assertQuestionKey(questionKey);
  return lifecycle.records.find((record) => record.questionKey === questionKey)?.phase ?? AUTOMATION_PHASE.NEW;
}

export function shouldSubmit(confidence) {
  return Number.isFinite(confidence) && confidence > 0.5;
}

/**
 * Advances one stable question independently of every other question.
 *
 * The returned effect reserves an external action atomically: callers should
 * replace their lifecycle with `result.lifecycle` before starting that action.
 * A denied or duplicate event returns the original lifecycle and no effect.
 */
export function reduceAutomationLifecycle(lifecycle, questionKey, event, details = {}) {
  assertLifecycle(lifecycle);
  assertQuestionKey(questionKey);
  const transition = TRANSITIONS[event];
  if (!transition) throw new RangeError(`Unknown automation event: ${String(event)}`);

  const currentPhase = getQuestionPhase(lifecycle, questionKey);
  if (!transition.from.includes(currentPhase)) return unchanged(lifecycle);
  if (event === 'submit' && !shouldSubmit(details.confidence)) return unchanged(lifecycle);

  const nextRecord = Object.freeze({ questionKey, phase: transition.to });
  const retained = lifecycle.records.filter((record) => record.questionKey !== questionKey);
  const nextLifecycle = Object.freeze({ records: Object.freeze([...retained, nextRecord]) });
  return Object.freeze({ lifecycle: nextLifecycle, effect: transition.effect ?? null, changed: true });
}

function unchanged(lifecycle) {
  return Object.freeze({ lifecycle, effect: null, changed: false });
}

function assertLifecycle(value) {
  if (!value || !Array.isArray(value.records)) throw new TypeError('A valid automation lifecycle is required.');
}

function assertQuestionKey(value) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError('A non-empty stable question key is required.');
}
