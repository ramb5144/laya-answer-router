import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('packaged Claude server lists tools and answers over MCP stdio', async () => {
  const token = 'test-token-that-is-at-least-twenty-four-characters';
  const tokenDirectory = await mkdtemp(join(tmpdir(), 'laya-mcp-test-'));
  const tokenFile = join(tokenDirectory, 'mcp-token');
  await writeFile(tokenFile, `${token}\n`, { mode: 0o600 });
  const relay = createServer((request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    if (request.method === 'GET' && request.url === '/api/mcp/context') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        capturedAt: new Date(0).toISOString(),
        ageMs: 0,
        context: {
          question: 'What is two plus two?',
          selection: '',
          nearbyText: 'A simple arithmetic question.',
          pageText: '',
          pageTitle: 'Test page',
          pageUrl: 'https://example.test',
        },
      }));
      return;
    }
    if (request.method === 'POST' && request.url === '/api/mcp/answer') {
      response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      response.end([
        JSON.stringify({ type: 'route', model: 'stub-model', route: { lane: 'fast', confidence: 0.99, source: 'laya', reason: 'stub' } }),
        JSON.stringify({ type: 'delta', delta: 'Four.' }),
        JSON.stringify({ type: 'done' }),
        '',
      ].join('\n'));
      return;
    }
    response.writeHead(404).end();
  });

  await new Promise<void>((resolveListen) => relay.listen(0, '127.0.0.1', resolveListen));
  const address = relay.address();
  assert(address && typeof address === 'object');

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [process.env.LAYA_MCP_SERVER || resolve('claude-extension/server/index.js')],
    env: {
      LAYA_RELAY_URL: `http://127.0.0.1:${address.port}`,
      LAYA_MCP_TOKEN_FILE: tokenFile,
    },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'laya-bridge-test', version: '0.1.0' });

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map(({ name }) => name), [
      'laya_get_current_page',
      'laya_answer_current_page',
      'laya_answer_question',
    ]);

    const result = await client.callTool({
      name: 'laya_answer_current_page',
      arguments: { mode: 'auto' },
    });
    assert.equal(result.isError, undefined);
    const content = result.content;
    assert(Array.isArray(content));
    const first = content[0] as { type?: unknown; text?: unknown } | undefined;
    assert(first && first.type === 'text');
    if (typeof first.text !== 'string') throw new Error('Expected a text tool result.');
    assert.match(first.text, /Four\./);
    assert.match(first.text, /Route: fast via laya \(99%\)/);
  } finally {
    await transport.close();
    await new Promise<void>((resolveClose, reject) => relay.close((error) => error ? reject(error) : resolveClose()));
    await rm(tokenDirectory, { recursive: true });
  }
});
