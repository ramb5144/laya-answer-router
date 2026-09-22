import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AUTOMATION_PHASE,
  createAutomationLifecycle,
  getQuestionPhase,
  reduceAutomationLifecycle,
  shouldSubmit,
} from '../extension/lib/automation-lifecycle.js';

function advance(lifecycle, questionKey, event, details) {
  return reduceAutomationLifecycle(lifecycle, questionKey, event, details).lifecycle;
}

function filledQuestion(questionKey = 'question-a') {
  let lifecycle = createAutomationLifecycle();
  lifecycle = advance(lifecycle, questionKey, 'answer');
  return advance(lifecycle, questionKey, 'filled');
}

test('submission requires finite confidence strictly greater than one half', () => {
  assert.equal(shouldSubmit(0.5), false);
  assert.equal(shouldSubmit(0.500001), true);
  assert.equal(shouldSubmit(1), true);
  assert.equal(shouldSubmit(Number.NaN), false);
  assert.equal(shouldSubmit(Number.POSITIVE_INFINITY), false);

  const lifecycle = filledQuestion();
  const denied = reduceAutomationLifecycle(lifecycle, 'question-a', 'submit', { confidence: 0.5 });
  assert.equal(denied.changed, false);
  assert.equal(denied.lifecycle, lifecycle);
  assert.equal(getQuestionPhase(lifecycle, 'question-a'), AUTOMATION_PHASE.FILLED);

  const allowed = reduceAutomationLifecycle(lifecycle, 'question-a', 'submit', { confidence: 0.500001 });
  assert.equal(allowed.effect, 'submit');
  assert.equal(getQuestionPhase(allowed.lifecycle, 'question-a'), AUTOMATION_PHASE.SUBMITTED);
});

test('a question can reserve answering only once across all later phases', () => {
  let lifecycle = createAutomationLifecycle();
  const started = reduceAutomationLifecycle(lifecycle, 'question-a', 'answer');
  assert.equal(started.effect, 'answer');
  lifecycle = started.lifecycle;

  for (const [event, expectedPhase] of [
    [null, AUTOMATION_PHASE.ANSWERING],
    ['filled', AUTOMATION_PHASE.FILLED],
    ['submit', AUTOMATION_PHASE.SUBMITTED],
    ['await-result', AUTOMATION_PHASE.AWAITING_RESULT],
  ]) {
    if (event === 'submit') lifecycle = advance(lifecycle, 'question-a', event, { confidence: 0.9 });
    else if (event) lifecycle = advance(lifecycle, 'question-a', event);
    assert.equal(getQuestionPhase(lifecycle, 'question-a'), expectedPhase);
    const duplicate = reduceAutomationLifecycle(lifecycle, 'question-a', 'answer');
    assert.equal(duplicate.changed, false);
    assert.equal(duplicate.effect, null);
    assert.equal(duplicate.lifecycle, lifecycle);
  }
});

test('a correct question can reserve navigation exactly once', () => {
  let lifecycle = filledQuestion();
  lifecycle = advance(lifecycle, 'question-a', 'submit', { confidence: 0.9 });
  lifecycle = advance(lifecycle, 'question-a', 'await-result');
  lifecycle = advance(lifecycle, 'question-a', 'correct');

  const first = reduceAutomationLifecycle(lifecycle, 'question-a', 'navigate');
  assert.equal(first.effect, 'navigate');
  assert.equal(getQuestionPhase(first.lifecycle, 'question-a'), AUTOMATION_PHASE.NAVIGATED);

  const duplicate = reduceAutomationLifecycle(first.lifecycle, 'question-a', 'navigate');
  assert.equal(duplicate.changed, false);
  assert.equal(duplicate.effect, null);
  assert.equal(duplicate.lifecycle, first.lifecycle);
});

test('a new stable question key has an independent lifecycle', () => {
  let lifecycle = filledQuestion('__proto__');
  lifecycle = advance(lifecycle, '__proto__', 'submit', { confidence: 0.8 });
  lifecycle = advance(lifecycle, '__proto__', 'await-result');
  lifecycle = advance(lifecycle, '__proto__', 'correct');
  lifecycle = advance(lifecycle, '__proto__', 'navigate');

  assert.equal(getQuestionPhase(lifecycle, '__proto__'), AUTOMATION_PHASE.NAVIGATED);
  assert.equal(getQuestionPhase(lifecycle, 'question-b'), AUTOMATION_PHASE.NEW);

  const next = reduceAutomationLifecycle(lifecycle, 'question-b', 'answer');
  assert.equal(next.effect, 'answer');
  assert.equal(getQuestionPhase(next.lifecycle, 'question-b'), AUTOMATION_PHASE.ANSWERING);
  assert.equal(getQuestionPhase(next.lifecycle, '__proto__'), AUTOMATION_PHASE.NAVIGATED);
});

test('observed outcomes stop answering and failed effects can be retried safely', () => {
  let lifecycle = createAutomationLifecycle();
  lifecycle = advance(lifecycle, 'question-a', 'answer');
  lifecycle = advance(lifecycle, 'question-a', 'answer-failed');
  assert.equal(getQuestionPhase(lifecycle, 'question-a'), AUTOMATION_PHASE.NEW);

  lifecycle = advance(lifecycle, 'question-a', 'answer');
  lifecycle = advance(lifecycle, 'question-a', 'filled');
  lifecycle = advance(lifecycle, 'question-a', 'submit', { confidence: 0.9 });
  lifecycle = advance(lifecycle, 'question-a', 'submit-failed');
  assert.equal(getQuestionPhase(lifecycle, 'question-a'), AUTOMATION_PHASE.FILLED);

  lifecycle = advance(lifecycle, 'question-a', 'submit', { confidence: 0.9 });
  lifecycle = advance(lifecycle, 'question-a', 'await-result');
  lifecycle = advance(lifecycle, 'question-a', 'incorrect');
  assert.equal(getQuestionPhase(lifecycle, 'question-a'), AUTOMATION_PHASE.INCORRECT);
  assert.equal(reduceAutomationLifecycle(lifecycle, 'question-a', 'answer').changed, false);
});
