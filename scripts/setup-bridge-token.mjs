import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

const envPath = resolve('.env');
const examplePath = resolve('.env.example');
const tokenDirectory = resolve(homedir(), '.config', 'laya-answer-router');
const tokenPath = resolve(tokenDirectory, 'mcp-token');

const existingEnv = await readOptional(envPath) || await readFile(examplePath, 'utf8');
const envToken = /^LAYA_MCP_TOKEN=(.+)$/m.exec(existingEnv)?.[1]?.trim();
const fileToken = (await readOptional(tokenPath))?.trim();
const token = envToken || fileToken || randomBytes(32).toString('hex');

if (token.length < 24) throw new Error('The existing LAYA_MCP_TOKEN is too short; remove it and run setup again.');

await mkdir(tokenDirectory, { recursive: true, mode: 0o700 });
await chmod(tokenDirectory, 0o700);
await writeFile(tokenPath, `${token}\n`, { mode: 0o600 });
await chmod(tokenPath, 0o600);

const nextEnv = /^LAYA_MCP_TOKEN=.*$/m.test(existingEnv)
  ? existingEnv.replace(/^LAYA_MCP_TOKEN=.*$/m, `LAYA_MCP_TOKEN=${token}`)
  : `${existingEnv.trimEnd()}\nLAYA_MCP_TOKEN=${token}\n`;
await writeFile(envPath, nextEnv, { mode: 0o600 });
await chmod(envPath, 0o600);

console.log('Configured one shared bridge token in .env and ~/.config/laya-answer-router/mcp-token.');
console.log('The OpenAI API key was not created or changed.');

async function readOptional(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return '';
    throw error;
  }
}
