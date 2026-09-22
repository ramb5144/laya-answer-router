import type { PageContext, RouteDecision, RouteMode } from './types.js';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_RELAY_URL = 'http://127.0.0.1:8765';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export type RelayPageSnapshot = {
  context: PageContext;
  capturedAt: string;
  ageMs: number;
};

export type RelayAnswer = {
  answer: string;
  model: string;
  route: RouteDecision;
};

type AnswerEvent =
  | { type: 'route'; model: string; route: RouteDecision }
  | { type: 'delta'; delta: string }
  | { type: 'done' }
  | { type: 'error'; message: string };

export class McpRelayClient {
  private readonly baseUrl: URL;

  constructor(
    relayUrl = process.env.LAYA_RELAY_URL || DEFAULT_RELAY_URL,
    private readonly token = resolveRelayToken(),
  ) {
    this.baseUrl = validateRelayUrl(relayUrl);
    if (token.trim().length < 24) {
      throw new Error('The Claude extension needs the same relay token configured as LAYA_MCP_TOKEN in the local relay.');
    }
  }

  async getCurrentPage(): Promise<RelayPageSnapshot> {
    const response = await this.request('/api/mcp/context', { method: 'GET' }, 10_000);
    return await readJsonResponse<RelayPageSnapshot>(response);
  }

  async answer(context: PageContext, mode: RouteMode): Promise<RelayAnswer> {
    const response = await this.request('/api/mcp/answer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ context, mode }),
    }, 180_000);
    return await collectAnswer(response);
  }

  private async request(path: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    const response = await fetch(new URL(path, this.baseUrl), {
      ...init,
      headers: {
        ...init.headers,
        Authorization: `Bearer ${this.token}`,
      },
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as { error?: unknown };
      const detail = typeof payload.error === 'string' ? payload.error : `Relay returned HTTP ${response.status}.`;
      throw new Error(detail);
    }
    return response;
  }
}

export function resolveRelayToken(
  environmentToken = process.env.LAYA_MCP_TOKEN,
  tokenFile = process.env.LAYA_MCP_TOKEN_FILE || join(homedir(), '.config', 'laya-answer-router', 'mcp-token'),
): string {
  if (environmentToken?.trim()) return environmentToken.trim();
  try {
    return readFileSync(tokenFile, 'utf8').trim();
  } catch {
    return '';
  }
}

export function validateRelayUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('The relay URL is not valid.');
  }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password) {
    throw new Error('The Claude extension only sends its secret to http://127.0.0.1.');
  }
  url.pathname = '/';
  url.search = '';
  url.hash = '';
  return url;
}

export async function collectAnswer(response: Response): Promise<RelayAnswer> {
  if (!response.body) throw new Error('The relay returned an empty answer stream.');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let bytesRead = 0;
  let answer = '';
  let model = '';
  let route: RouteDecision | undefined;
  let completed = false;

  const handleLine = (line: string) => {
    if (!line.trim()) return;
    const event = JSON.parse(line) as AnswerEvent;
    if (event.type === 'route') {
      model = event.model;
      route = event.route;
    } else if (event.type === 'delta') {
      answer += event.delta;
    } else if (event.type === 'done') {
      completed = true;
    } else if (event.type === 'error') {
      throw new Error(event.message || 'The relay could not complete the answer.');
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (value) {
      bytesRead += value.byteLength;
      if (bytesRead > MAX_RESPONSE_BYTES) throw new Error('The relay answer exceeded its safety limit.');
      buffer += decoder.decode(value, { stream: !done });
    }
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) handleLine(line);
    if (done) break;
  }
  if (buffer.trim()) handleLine(buffer);
  if (!completed || !route || !model) throw new Error('The relay answer ended before completion.');
  return { answer, model, route };
}

async function readJsonResponse<T>(response: Response): Promise<T> {
  return await response.json() as T;
}
