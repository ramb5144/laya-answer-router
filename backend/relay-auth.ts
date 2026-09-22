import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

const MIN_TOKEN_LENGTH = 24;

export function isAllowedMcpRequest(
  request: Pick<IncomingMessage, 'headers'>,
  configuredToken = process.env.LAYA_MCP_TOKEN,
): boolean {
  const token = configuredToken?.trim();
  if (!token || token.length < MIN_TOKEN_LENGTH) return false;

  const authorization = request.headers.authorization;
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) return false;

  const supplied = authorization.slice('Bearer '.length);
  const expectedBytes = Buffer.from(token, 'utf8');
  const suppliedBytes = Buffer.from(supplied, 'utf8');
  return expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes);
}

export function hasUsableMcpToken(token = process.env.LAYA_MCP_TOKEN): boolean {
  return Boolean(token?.trim() && token.trim().length >= MIN_TOKEN_LENGTH);
}
