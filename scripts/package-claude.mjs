import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';

execFileSync('npm', ['run', 'build:claude'], { stdio: 'inherit' });
await mkdir('dist', { recursive: true });
execFileSync('node_modules/.bin/mcpb', [
  'pack',
  'claude-extension',
  'dist/laya-answer-router-0.4.0.mcpb',
], { stdio: 'inherit' });
