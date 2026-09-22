import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import type { LayaRoute, PageContext } from './types.js';

type Pending = {
  resolve: (value: LayaRoute) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type WorkerMessage = Partial<LayaRoute> & {
  id?: string;
  type?: string;
  error?: string;
};

export class LayaClient {
  private process: ChildProcessWithoutNullStreams | undefined;
  private starting: Promise<void> | undefined;
  private readonly pending = new Map<string, Pending>();
  private sequence = 0;
  private state: 'cold' | 'warming' | 'ready' | 'failed' = 'cold';
  private detail = '';

  status() {
    return { state: this.state, detail: this.detail };
  }

  async prewarm(): Promise<void> {
    if (this.state !== 'cold') return;
    try {
      await this.ensureProcess();
    } catch (error) {
      this.markFailed(error);
    }
  }

  async route(context: PageContext, timeoutMs = 3_000): Promise<LayaRoute> {
    await this.ensureProcess();
    const child = this.process;
    if (!child || child.killed) throw new Error('Laya worker is unavailable.');

    const id = `route-${Date.now()}-${++this.sequence}`;
    return await new Promise<LayaRoute>((resolveRoute, rejectRoute) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectRoute(new Error('Laya routing timed out.'));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolveRoute, reject: rejectRoute, timer });
      child.stdin.write(`${JSON.stringify({ id, method: 'route', context })}\n`);
    });
  }

  close(): void {
    this.process?.kill('SIGTERM');
    this.process = undefined;
    this.rejectAll(new Error('Laya worker closed.'));
  }

  private async ensureProcess(): Promise<void> {
    if (this.process && !this.process.killed) return;
    if (this.state === 'failed') throw new Error(this.detail || 'Laya worker failed.');
    if (this.starting) return await this.starting;

    this.starting = this.startProcess();
    try {
      await this.starting;
    } finally {
      this.starting = undefined;
    }
  }

  private async startProcess(): Promise<void> {
    const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const defaultPython = resolve(projectRoot, '..', 'laya-demo', '.venv', 'bin', 'python');
    const python = process.env.LAYA_PYTHON || defaultPython;
    await access(python);

    const workerPath = resolve(dirname(fileURLToPath(import.meta.url)), 'laya_worker.py');
    this.state = 'warming';
    const child = spawn(python, ['-u', workerPath], {
      cwd: projectRoot,
      env: {
        ...process.env,
        HF_HUB_OFFLINE: process.env.HF_HUB_OFFLINE || '1',
        TRANSFORMERS_OFFLINE: process.env.TRANSFORMERS_OFFLINE || '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.process = child;

    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => this.onLine(line));
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim();
      if (text) this.detail = text.split('\n').at(-1)?.slice(0, 240) || this.detail;
    });
    child.once('error', (error) => this.markFailed(error));
    child.once('exit', (code) => {
      if (this.process !== child) return;
      this.process = undefined;
      if (code !== 0) this.markFailed(new Error(`Laya worker exited with code ${String(code)}.`));
    });
  }

  private onLine(line: string): void {
    let message: WorkerMessage;
    try {
      message = JSON.parse(line) as WorkerMessage;
    } catch {
      return;
    }
    if (message.type === 'ready') {
      this.state = 'ready';
      this.detail = 'Local Laya router is warm.';
      return;
    }
    if (!message.id) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      pending.reject(new Error(message.error));
      return;
    }
    pending.resolve(message as LayaRoute);
  }

  private markFailed(error: unknown): void {
    this.state = 'failed';
    this.detail = error instanceof Error ? error.message : 'Unknown Laya error.';
    this.rejectAll(new Error(this.detail));
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
