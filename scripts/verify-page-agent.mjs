import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mergeFramePageContext, selectFrameCandidate } from '../extension/lib/frame-selection.js';

const port = Number(process.argv[2] || 9335);
const base = `http://127.0.0.1:${port}`;
const source = await readFile(new URL('../extension/content/page-agent.js', import.meta.url), 'utf8');
const targets = await fetch(`${base}/json/list`).then((response) => response.json());
const page = targets.find((target) => target.type === 'page');
if (!page?.webSocketDebuggerUrl) throw new Error('No test page target is available.');

class CdpSession {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.socket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data);
      if (!message.id) return;
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result);
    });
  }

  async ready() {
    if (this.socket.readyState === WebSocket.OPEN) return;
    await new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
    });
  }

  async call(method, params = {}) {
    await this.ready();
    const id = this.nextId++;
    const promise = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.socket.send(JSON.stringify({ id, method, params }));
    return await promise;
  }

  async evaluate(expression) {
    const result = await this.call('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Browser evaluation failed.');
    return result.result.value;
  }
}

const cdp = new CdpSession(page.webSocketDebuggerUrl);
await cdp.call('Page.enable');
await cdp.call('Runtime.enable');
await cdp.call('Page.navigate', { url: 'http://127.0.0.1:8765/demo-context' });

for (let attempt = 0; attempt < 100; attempt += 1) {
  if (await cdp.evaluate('document.readyState === "complete"')) break;
  await new Promise((resolve) => setTimeout(resolve, 50));
}

await cdp.evaluate(`(() => {
  window.chrome = { runtime: { onMessage: { addListener(listener) { window.__layaTestListener = listener; } } } };
  ${source}
  window.__sendLayaTestMessage = (message) => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Page agent message timed out.')), 5000);
    const sendResponse = (value) => { clearTimeout(timeout); resolve(value); };
    window.__layaTestListener(message, {}, sendResponse);
  });
})()`);

const capture = await cdp.evaluate('__sendLayaTestMessage({ type: "laya-capture-v16" })');
assert.equal(capture.answerControl.kind, 'single_select');
const increase = capture.answerControl.options.find((option) => option.label === 'increase');
assert.ok(increase, 'The dropdown options should include increase.');

const handle = {
  documentToken: capture.documentToken,
  targetId: capture.targetId,
  submitTargetId: capture.submitTargetId,
  questionFingerprint: capture.questionFingerprint,
};
const applied = await cdp.evaluate(`__sendLayaTestMessage(${JSON.stringify({
  type: 'laya-apply-answer-v16',
  text: 'increase',
  optionId: increase.id,
  handle,
})})`);
assert.equal(applied.ok, true);

const staleSubmission = await cdp.evaluate(`__sendLayaTestMessage(${JSON.stringify({
  type: 'laya-submit-answer-v16',
  confidence: 0.99,
  handle,
})})`);
assert.match(staleSubmission.error, /Check answer control changed/);

await new Promise((resolve) => setTimeout(resolve, 2_050));
const fresh = await cdp.evaluate('__sendLayaTestMessage({ type: "laya-capture-v16" })');
assert.equal(fresh.questionFingerprint, capture.questionFingerprint);
const freshHandle = {
  documentToken: fresh.documentToken,
  targetId: fresh.targetId,
  submitTargetId: fresh.submitTargetId,
  questionFingerprint: fresh.questionFingerprint,
};
const submitted = await cdp.evaluate(`__sendLayaTestMessage(${JSON.stringify({
  type: 'laya-submit-answer-v16',
  confidence: 0.99,
  handle: freshHandle,
})})`);
assert.equal(submitted.submitted, true);

const events = await cdp.evaluate('window.testEvents || []');
const filled = events.find((event) => event.type === 'filled');
const checked = events.find((event) => event.type === 'checked');
assert.equal(filled.value, 'increase');
assert.equal(checked.value, 'increase');
assert.ok(checked.at - filled.at >= 2_000, `Expected a 2s delay, observed ${checked.at - filled.at}ms.`);

await cdp.call('Page.navigate', { url: 'http://127.0.0.1:8765/demo-full-context' });
for (let attempt = 0; attempt < 100; attempt += 1) {
  if (await cdp.evaluate('document.readyState === "complete" && frames[0]?.document?.readyState === "complete"')) break;
  await new Promise((resolve) => setTimeout(resolve, 50));
}
const frameCaptures = await cdp.evaluate(`(async () => {
  async function install(view) {
    view.chrome = { runtime: { onMessage: { addListener(listener) { view.__layaTestListener = listener; } } } };
    const script = view.document.createElement('script');
    script.textContent = ${JSON.stringify(source)};
    view.document.documentElement.append(script);
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Frame capture timed out.')), 5000);
      view.__layaTestListener({ type: 'laya-capture-v16' }, {}, (value) => {
        clearTimeout(timeout);
        resolve(value);
      });
    });
  }
  return { top: await install(window), inner: await install(frames[0]) };
})()`);
const candidates = [
  { ...frameCaptures.top, frameId: 0 },
  { ...frameCaptures.inner, frameId: 1 },
];
const selected = selectFrameCandidate(candidates);
const fullPageContext = mergeFramePageContext(candidates, selected);
assert.equal(selected.frameId, 1);
assert.match(fullPageContext, /Course reference: for elastic demand/);
assert.match(fullPageContext, /If the demand for orange juice is elastic/);

console.log(JSON.stringify({
  ok: true,
  staleHandleRejected: true,
  freshHandleSubmitted: true,
  observedDelayMs: Math.round(checked.at - filled.at),
  retainedItemContext: fresh.itemContext.includes('elastic'),
  selectedQuestionFrame: selected.frameId,
  fullContextHasShellAndAssignment: true,
}, null, 2));
cdp.socket.close();
