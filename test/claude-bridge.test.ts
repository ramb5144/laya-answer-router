import assert from 'node:assert/strict';
import test from 'node:test';
import { RecentContextStore } from '../backend/context-store.js';
import { collectAnswer, resolveRelayToken, validateRelayUrl } from '../backend/mcp-relay-client.js';
import { isAllowedMcpRequest } from '../backend/relay-auth.js';
import type { PageContext } from '../backend/types.js';

const context: PageContext = {
  question: 'What is shown?',
  selection: '',
  nearbyText: 'Relevant text',
  pageText: 'Page text',
  pageTitle: 'Example',
  pageUrl: 'https://example.test',
  answerControl: { kind: 'text', options: [] },
};

test('recent page context expires and is returned as a copy', () => {
  let now = 1_000;
  const store = new RecentContextStore(500, () => now);
  store.set(context);
  const current = store.get();
  assert.equal(current?.context.pageTitle, 'Example');
  if (current) current.context.pageTitle = 'Changed';
  assert.equal(store.get()?.context.pageTitle, 'Example');
  now = 1_501;
  assert.equal(store.get(), undefined);
});

test('MCP relay auth requires the complete configured bearer token', () => {
  const token = 'a-secure-token-that-is-long-enough';
  assert.equal(isAllowedMcpRequest({ headers: { authorization: `Bearer ${token}` } }, token), true);
  assert.equal(isAllowedMcpRequest({ headers: { authorization: 'Bearer wrong-token-that-is-long-enough' } }, token), false);
  assert.equal(isAllowedMcpRequest({ headers: {} }, token), false);
  assert.equal(isAllowedMcpRequest({ headers: { authorization: 'Bearer short' } }, 'short'), false);
});

test('Claude bridge refuses non-loopback relay URLs', () => {
  assert.equal(validateRelayUrl('http://127.0.0.1:8765').href, 'http://127.0.0.1:8765/');
  assert.throws(() => validateRelayUrl('https://example.com'), /only sends its secret/);
  assert.throws(() => validateRelayUrl('http://localhost:8765'), /only sends its secret/);
});

test('bridge token environment takes precedence over the token file', () => {
  assert.equal(resolveRelayToken('environment-token', '/missing/token/file'), 'environment-token');
  assert.equal(resolveRelayToken(undefined, '/missing/token/file'), '');
});

test('Claude bridge assembles a complete NDJSON answer', async () => {
  const body = [
    JSON.stringify({ type: 'route', model: 'fast-model', route: { lane: 'fast', confidence: 0.9, source: 'laya', reason: 'test' } }),
    JSON.stringify({ type: 'delta', delta: 'Hello ' }),
    JSON.stringify({ type: 'delta', delta: 'world' }),
    JSON.stringify({ type: 'done' }),
    '',
  ].join('\n');
  const result = await collectAnswer(new Response(body));
  assert.equal(result.answer, 'Hello world');
  assert.equal(result.model, 'fast-model');
  assert.equal(result.route.lane, 'fast');
});

test('Claude bridge rejects incomplete answers', async () => {
  const body = `${JSON.stringify({ type: 'route', model: 'fast-model', route: { lane: 'fast', confidence: 0.9, source: 'laya', reason: 'test' } })}\n`;
  await assert.rejects(collectAnswer(new Response(body)), /ended before completion/);
});
