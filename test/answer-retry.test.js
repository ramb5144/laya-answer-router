import assert from 'node:assert/strict';
import test from 'node:test';
import {
  automaticAnswerRetryDelay,
  formatRetryDelay,
  isRelayConnectionError,
  MAX_AUTOMATIC_ANSWER_RETRIES,
} from '../extension/lib/answer-retry.js';

test('automatic answer retries are bounded and back off', () => {
  assert.equal(MAX_AUTOMATIC_ANSWER_RETRIES, 3);
  assert.deepEqual([1, 2, 3].map(automaticAnswerRetryDelay), [2_000, 5_000, 10_000]);
  assert.equal(automaticAnswerRetryDelay(0), null);
  assert.equal(automaticAnswerRetryDelay(4), null);
});

test('relay connection failures are distinguished from model answer failures', () => {
  assert.equal(isRelayConnectionError(new TypeError('Failed to fetch')), true);
  assert.equal(isRelayConnectionError(new Error('Connection refused')), true);
  assert.equal(isRelayConnectionError(new Error('The model response was incomplete')), false);
});

test('retry delays are displayed as whole seconds', () => {
  assert.equal(formatRetryDelay(2_001), 3);
  assert.equal(formatRetryDelay(0), 1);
});
