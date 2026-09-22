import assert from 'node:assert/strict';
import test from 'node:test';
import { chooseLane, fallbackRoute, manualRoute } from '../backend/routing.js';
import type { PageContext } from '../backend/types.js';

const context = (question: string): PageContext => ({
  question,
  selection: '',
  nearbyText: '',
  pageText: '',
  pageTitle: 'Test',
  pageUrl: 'https://example.test',
  answerControl: { kind: 'text', options: [] },
});

test('fallback keeps a direct question on the fast lane', () => {
  assert.equal(fallbackRoute(context('What is the capital of France?')).lane, 'fast');
});

test('fallback sends proofs and debugging to the deep lane', () => {
  assert.equal(fallbackRoute(context('Prove this theorem and derive every equality.')).lane, 'deep');
  assert.equal(fallbackRoute(context('Debug the root cause of this race condition.')).lane, 'deep');
});

test('uncertain Laya decisions favor the stronger lane', () => {
  assert.equal(chooseLane('fast', { fast: 0.54, deep: 0.46 }), 'deep');
  assert.equal(chooseLane('fast', { fast: 0.8, deep: 0.2 }), 'fast');
});

test('manual mode is explicit and deterministic', () => {
  assert.deepEqual(manualRoute('fast'), {
    lane: 'fast',
    confidence: 1,
    source: 'manual',
    reason: 'The fast lane was selected in the side panel.',
  });
});
