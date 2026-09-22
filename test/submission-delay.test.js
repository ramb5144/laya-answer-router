import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createSubmissionDelay,
  MAX_SUBMISSION_DELAY_SECONDS,
  normalizeSubmissionDelaySeconds,
} from '../extension/lib/submission-delay.js';

test('normalizes submission delays to whole seconds within the supported range', () => {
  assert.equal(normalizeSubmissionDelaySeconds('invalid'), 0);
  assert.equal(normalizeSubmissionDelaySeconds(-2), 0);
  assert.equal(normalizeSubmissionDelaySeconds(1.6), 2);
  assert.equal(normalizeSubmissionDelaySeconds(999), MAX_SUBMISSION_DELAY_SECONDS);
});

test('zero delay becomes ready immediately and executes at most once', async () => {
  let ticks = 0;
  const schedule = createSubmissionDelay({ seconds: 0, onTick: () => { ticks += 1; } });
  assert.equal(await schedule.promise, true);
  schedule.cancel();
  assert.equal(ticks, 1);
});

test('delay reports countdown and does not become ready before its deadline', async () => {
  let current = 1_000;
  const timers = [];
  const ticks = [];
  const schedule = createSubmissionDelay({
    seconds: 2,
    now: () => current,
    onTick: (value) => ticks.push(value),
    setTimer: (callback, delay) => {
      const timer = { callback, delay, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => { timer.cleared = true; },
  });
  assert.deepEqual(ticks, [2]);
  assert.equal(schedule.active, true);
  current = 2_000;
  timers.shift().callback();
  assert.deepEqual(ticks, [2, 1]);
  assert.equal(schedule.active, true);
  current = 3_000;
  timers.shift().callback();
  assert.equal(await schedule.promise, true);
  assert.deepEqual(ticks, [2, 1, 0]);
  assert.equal(schedule.active, false);
});

test('cancelling a pending delay prevents readiness', async () => {
  let callback;
  const schedule = createSubmissionDelay({
    seconds: 5,
    setTimer: (value) => { callback = value; return 1; },
    clearTimer: () => {},
  });
  schedule.cancel();
  callback();
  assert.equal(await schedule.promise, false);
  assert.equal(schedule.active, false);
});
