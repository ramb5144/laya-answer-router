import {
  AUTOMATION_PHASE,
  createAutomationLifecycle,
  getQuestionPhase,
  reduceAutomationLifecycle,
  shouldSubmit as shouldSubmitConfidence,
} from '../lib/automation-lifecycle.js';
import {
  createSubmissionDelay,
  normalizeSubmissionDelaySeconds,
} from '../lib/submission-delay.js';
import {
  automaticAnswerRetryDelay,
  formatRetryDelay,
  isRelayConnectionError,
} from '../lib/answer-retry.js';

const relayUrl = 'http://127.0.0.1:8765';
const ANSWER_TIMEOUT_MS = 60_000;
const RELAY_RECONNECT_MS = 2_000;
const OUTCOME_POLL_DELAYS_MS = Object.freeze([
  400, 800, 1_500, 3_000,
  5_000, 5_000, 5_000, 5_000, 5_000, 5_000, 5_000, 5_000,
]);
const SUBMISSION_REVALIDATION_DELAYS_MS = Object.freeze([0, 400, 1_000]);
const elements = {
  answer: document.querySelector('#answer'),
  ask: document.querySelector('#ask'),
  autoSubmit: document.querySelector('#auto-submit'),
  connection: document.querySelector('#connection'),
  contextSize: document.querySelector('#context-size'),
  copy: document.querySelector('#copy'),
  directMode: document.querySelector('#direct-mode'),
  fullContext: document.querySelector('#full-context'),
  insert: document.querySelector('#insert'),
  modelLabel: document.querySelector('#model-label'),
  pageTitle: document.querySelector('#page-title'),
  question: document.querySelector('#question'),
  refresh: document.querySelector('#refresh'),
  routeNote: document.querySelector('#route-note'),
  routeStrip: document.querySelector('.route-strip'),
  status: document.querySelector('#status'),
  submitDelay: document.querySelector('#submit-delay'),
};

let pageContext = null;
let captureHandle = null;
let answerText = '';
let fillText = '';
let answerOptionId = '';
let answerConfidence = null;
let answerComplete = false;
let relayConfigured = false;
let controller = null;
let activeRunId = 0;
let readGeneration = 0;
let refreshTimer = 0;
let boundTabId = null;
let automationLifecycle = createAutomationLifecycle();
let activeQuestionKey = '';
let pendingOutcome = null;
let pendingSubmission = null;
let deferredDocumentRead = false;
let reconnectTimer = 0;
const answerRetryCounts = new Map();

void initialize();

async function initialize() {
  const saved = await chrome.storage.local.get({
    routeMode: 'auto',
    directMode: true,
    autoSubmit: true,
    submitDelaySeconds: 0,
  });
  const input = document.querySelector(`input[name="mode"][value="${saved.routeMode}"]`);
  if (input) input.checked = true;
  elements.directMode.checked = saved.directMode;
  elements.autoSubmit.checked = saved.autoSubmit;
  elements.submitDelay.value = String(normalizeSubmissionDelaySeconds(saved.submitDelaySeconds));
  syncDirectControls();

  document.querySelectorAll('input[name="mode"]').forEach((radio) => {
    radio.addEventListener('change', () => chrome.storage.local.set({ routeMode: selectedMode() }));
  });
  elements.directMode.addEventListener('change', async () => {
    if (!elements.directMode.checked) cancelActiveWork('Direct mode is off. Any filled answer was left for review.');
    syncDirectControls();
    await chrome.storage.local.set({ directMode: elements.directMode.checked });
    if (elements.directMode.checked) scheduleRead(0);
  });
  elements.autoSubmit.addEventListener('change', async () => {
    if (!elements.autoSubmit.checked) cancelPendingSubmission('Auto-submit is off. The answer remains filled for review.');
    syncDirectControls();
    await chrome.storage.local.set({ autoSubmit: elements.autoSubmit.checked });
  });
  elements.submitDelay.addEventListener('change', async () => {
    const seconds = normalizeSubmissionDelaySeconds(elements.submitDelay.value);
    elements.submitDelay.value = String(seconds);
    await chrome.storage.local.set({ submitDelaySeconds: seconds });
  });
  elements.refresh.addEventListener('click', () => void readPage());
  elements.ask.addEventListener('click', () => controller || pendingSubmission
    ? cancelAnswer()
    : void answerQuestion({ autoFill: elements.directMode.checked }));
  elements.copy.addEventListener('click', copyAnswer);
  elements.insert.addEventListener('click', () => void applyAnswer());
  chrome.runtime.onMessage.addListener(handleExtensionMessage);

  const relayReady = await checkRelay();
  if (!relayReady) markRelayDisconnected();
  const pending = await chrome.storage.session.get('pendingQuestion');
  if (pending.pendingQuestion) {
    elements.question.value = pending.pendingQuestion;
    await chrome.storage.session.remove('pendingQuestion');
  }
  await readPage({ preserveQuestion: Boolean(elements.question.value.trim()) });
}

async function checkRelay() {
  try {
    const response = await fetch(`${relayUrl}/api/health`, { cache: 'no-store' });
    if (!response.ok) throw new Error('Relay unavailable');
    const health = await response.json();
    relayConfigured = Boolean(health.configured);
    const laya = health.laya?.state === 'ready' ? 'Laya ready' : health.laya?.state === 'warming' ? 'Laya warming' : 'Laya fallback';
    elements.connection.textContent = relayConfigured ? `${laya} · key server-side` : `${laya} · server-side key needed`;
    elements.connection.style.color = relayConfigured ? '' : 'var(--warn)';
    return relayConfigured;
  } catch {
    relayConfigured = false;
    elements.connection.textContent = 'Start the local relay on port 8765';
    elements.connection.style.color = 'var(--danger)';
    return false;
  }
}

async function readPage(options = {}) {
  window.clearTimeout(refreshTimer);
  refreshTimer = 0;
  const generation = ++readGeneration;
  deferredDocumentRead = false;
  invalidateActiveRun();
  setStatus('Reading every frame in the active page…');
  const result = await chrome.runtime.sendMessage({ type: 'capture-context', tabId: boundTabId });
  if (generation !== readGeneration) return;
  if (result?.error) {
    pageContext = null;
    captureHandle = null;
    setStatus(result.error, 'error');
    return;
  }
  if (boundTabId === null) boundTabId = result.tabId;
  if (result.tabId !== boundTabId) {
    setStatus('The captured page came from a different tab. Jev stopped.', 'error');
    return;
  }

  pageContext = result;
  captureHandle = result.captureHandle || null;
  const sharedWithClaude = await shareContextWithClaude(result);
  if (generation !== readGeneration) return;
  if (!options.preserveQuestion || !elements.question.value.trim()) elements.question.value = result.question || '';
  elements.fullContext.value = result.fullPageContext || result.pageText || '';
  elements.pageTitle.textContent = result.pageTitle || 'Untitled page';
  const contextCharacters = (result.question?.length || 0) + (result.itemContext?.length || 0) +
    (result.nearbyText?.length || 0) + (result.fullPageContext?.length || result.pageText?.length || 0);
  elements.contextSize.textContent = `${Math.round(contextCharacters / 100) / 10}k chars`;
  elements.insert.disabled = !result.canInsert || !fillText;
  const questionKey = stableQuestionKey(captureHandle);
  activeQuestionKey = questionKey;
  if (pendingOutcome && questionKey !== pendingOutcome.questionKey && result.canAutoFill) {
    pendingOutcome = null;
  }
  const outcomeKey = pendingOutcome?.questionKey || questionKey;

  if (!result.question) {
    setStatus('No question was detected in the page or its frames.', 'warn');
    return;
  }
  if (elements.directMode.checked && pendingOutcome) {
    const outcome = await chrome.runtime.sendMessage({
      type: 'inspect-outcome',
      handle: pendingOutcome.handle,
    });
    if (generation !== readGeneration) return;
    if (outcome?.isIncorrect || result.isIncorrect) {
      transitionQuestion(outcomeKey, 'incorrect');
      pendingOutcome = null;
      setStatus('Pearson marked this answer incorrect. Jev stopped and will not navigate.', 'error');
      return;
    }
    if (outcome?.isCorrect || result.isCorrect) {
      transitionQuestion(outcomeKey, 'correct');
      if (outcome.canNavigateNext && !outcome.hasLockedRemainingParts) {
        const navigation = transitionQuestion(outcomeKey, 'navigate');
        if (navigation.effect === 'navigate') {
          await navigateNext({ questionKey: outcomeKey, handle: pendingOutcome.handle });
        }
      } else {
        setStatus('Correct answer confirmed. Waiting for Pearson to expose the next question…');
        scheduleRead(450);
      }
      return;
    }
    const pollIndex = pendingOutcome.checks || 0;
    const pollDelay = OUTCOME_POLL_DELAYS_MS[pollIndex];
    pendingOutcome.checks = pollIndex + 1;
    if (pollDelay !== undefined) {
      const detail = outcome?.error ? ` (${outcome.error})` : '';
      setStatus(`Answer submitted. Waiting for Pearson to finish grading…${detail}`);
      scheduleRead(pollDelay);
    } else {
      setStatus('Pearson has not exposed a final result yet. Jev paused for review.', 'warn');
    }
    return;
  }
  if (elements.directMode.checked && result.isIncorrect) {
    transitionQuestion(outcomeKey, 'incorrect');
    pendingOutcome = null;
    setStatus('Pearson marked this answer incorrect. Jev stopped and will not navigate.', 'error');
    return;
  }
  if (
    elements.directMode.checked &&
    result.isCorrect &&
    !result.hasUnansweredControl &&
    result.canNavigateNext
  ) {
    transitionQuestion(outcomeKey, 'correct');
    const navigation = transitionQuestion(outcomeKey, 'navigate');
    if (navigation.effect === 'navigate') {
      await navigateNext({
        questionKey: outcomeKey,
        handle: pendingOutcome?.handle || captureHandle,
      });
    }
    return;
  }
  let phase = getQuestionPhase(automationLifecycle, questionKey);
  if (phase === AUTOMATION_PHASE.ANSWERING && !controller) {
    transitionQuestion(questionKey, 'answer-failed');
    phase = AUTOMATION_PHASE.NEW;
  }
  if (elements.directMode.checked && phase !== AUTOMATION_PHASE.NEW) {
    setStatus(statusForPhase(phase));
    return;
  }
  if (!result.canInsert) {
    setStatus('Question detected, but no unanswered text field, choice group, or dropdown was found.', 'warn');
    return;
  }
  if (result.targetAmbiguous) {
    setStatus('Question detected, but multiple answer fields look equally likely. Focus the intended field and refresh.', 'warn');
    return;
  }

  const bridgeNote = sharedWithClaude ? ' Context shared with Claude.' : '';
  if (!elements.directMode.checked) {
    setStatus(`Question and answer field detected.${bridgeNote}`);
    return;
  }
  if (!relayConfigured) {
    setStatus(`Question and answer field detected.${bridgeNote} Start the local relay with a server-side key to answer automatically.`, 'warn');
    return;
  }
  if (!result.canAutoFill) {
    setStatus('The detected field is not empty, so Direct mode left it unchanged.', 'warn');
    return;
  }

  const reservation = transitionQuestion(questionKey, 'answer');
  if (reservation.effect !== 'answer') {
    setStatus('This question was already handled. Nothing was repeated.');
    return;
  }
  await answerQuestion({ autoFill: true, questionKey });
}

async function shareContextWithClaude(context) {
  try {
    const response = await fetch(`${relayUrl}/api/context`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Laya-Extension-Id': chrome.runtime.id,
      },
      body: JSON.stringify({ context }),
      signal: AbortSignal.timeout(2_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function answerQuestion({ autoFill = false, questionKey = '' } = {}) {
  const question = elements.question.value.trim();
  if (!question) {
    setStatus('No question was detected. Select or enter one first.', 'error');
    elements.question.focus();
    return;
  }
  if (!pageContext) {
    await readPage({ preserveQuestion: true });
    if (!pageContext) return;
  }
  const resolvedQuestionKey = questionKey || stableQuestionKey(captureHandle);
  if (autoFill) {
    const phase = getQuestionPhase(automationLifecycle, resolvedQuestionKey);
    if (phase === AUTOMATION_PHASE.NEW) transitionQuestion(resolvedQuestionKey, 'answer');
    else if (phase !== AUTOMATION_PHASE.ANSWERING) {
      setStatus(statusForPhase(phase));
      return;
    }
  }

  const runId = ++activeRunId;
  const runHandle = captureHandle ? { ...captureHandle } : null;
  answerText = '';
  fillText = '';
  answerOptionId = '';
  answerConfidence = null;
  answerComplete = false;
  elements.answer.textContent = '';
  elements.answer.classList.remove('empty');
  elements.copy.disabled = true;
  elements.insert.disabled = true;
  elements.routeNote.textContent = 'Routing…';
  elements.modelLabel.textContent = 'choosing';
  elements.routeStrip.classList.remove('done');
  elements.routeStrip.classList.add('running');
  elements.ask.textContent = 'Stop';
  elements.ask.classList.add('running');
  const runController = new AbortController();
  controller = runController;
  let answerTimedOut = false;
  const answerTimeout = window.setTimeout(() => {
    answerTimedOut = true;
    runController.abort();
  }, ANSWER_TIMEOUT_MS);
  setStatus('Laya is choosing the response lane…');

  try {
    const response = await fetch(`${relayUrl}/api/answer`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Laya-Extension-Id': chrome.runtime.id,
      },
      body: JSON.stringify({
        context: { ...pageContext, question },
        mode: selectedMode(),
      }),
      signal: runController.signal,
    });
    if (!response.ok || !response.body) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || `Relay returned ${response.status}.`);
    }
    await consumeNdjson(response.body, { runId, autoFill, handle: runHandle, questionKey: resolvedQuestionKey });
    if (runId === activeRunId && !answerComplete) {
      throw new Error('The answer stream ended before a complete result arrived.');
    }
  } catch (error) {
    const ownsRun = runId === activeRunId;
    if (autoFill && ownsRun) transitionQuestion(resolvedQuestionKey, 'answer-failed');
    if (ownsRun && autoFill && (answerTimedOut || error.name !== 'AbortError')) {
      if (isRelayConnectionError(error)) {
        markRelayDisconnected();
      } else {
        scheduleAnswerRetry(resolvedQuestionKey, answerTimedOut ? 'The answer timed out.' : error.message || 'The answer failed.');
      }
    } else if (error.name !== 'AbortError' && ownsRun) {
      setStatus(error.message || 'The answer failed.', 'error');
    }
  } finally {
    window.clearTimeout(answerTimeout);
    if (runId !== activeRunId) return;
    if (controller === runController) controller = null;
    elements.ask.textContent = 'Answer this question';
    elements.ask.classList.remove('running');
    elements.routeStrip.classList.remove('running');
    if (answerText && answerComplete) {
      elements.routeStrip.classList.add('done');
      elements.copy.disabled = false;
      elements.insert.disabled = !pageContext?.canInsert || !fillText;
    }
    if (deferredDocumentRead) {
      deferredDocumentRead = false;
      const phase = getQuestionPhase(automationLifecycle, resolvedQuestionKey);
      if (phase === AUTOMATION_PHASE.NEW) scheduleRead(300);
    }
  }
}

async function consumeNdjson(stream, run) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (run.runId !== activeRunId) return;
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      await handleEvent(JSON.parse(line), run);
    }
    if (done) break;
  }
  if (buffer.trim()) await handleEvent(JSON.parse(buffer), run);
}

async function handleEvent(event, run) {
  if (run.runId !== activeRunId) return;
  if (event.type === 'route') {
    elements.modelLabel.textContent = event.model;
    elements.routeNote.textContent = `Route ${Math.round(event.route.confidence * 100)}%`;
    setStatus(`${event.route.reason} Streaming from ${event.model}…`);
  } else if (event.type === 'delta') {
    answerText += event.delta;
    elements.answer.textContent = answerText;
  } else if (event.type === 'result') {
    fillText = typeof event.answer === 'string' ? event.answer.trim() : '';
    answerOptionId = typeof event.optionId === 'string' ? event.optionId : '';
    answerConfidence = Number.isFinite(event.confidence) ? Math.max(0, Math.min(1, event.confidence)) : null;
    const explanation = typeof event.explanation === 'string' ? event.explanation.trim() : '';
    elements.answer.textContent = `${fillText}${explanation ? `\n\n${explanation}` : ''}`;
  } else if (event.type === 'done') {
    answerComplete = true;
    answerRetryCounts.delete(run.questionKey);
    if (!fillText) {
      const parsed = parseLegacyModelAnswer(answerText);
      fillText = parsed.fillText;
      answerConfidence = parsed.confidence;
      if (parsed.displayText) elements.answer.textContent = parsed.displayText;
    }
    elements.routeNote.textContent = answerConfidence === null ? 'Answer confidence unavailable' : `Answer confidence ${Math.round(answerConfidence * 100)}%`;
    if (run.autoFill) await applyAnswer({
      handle: run.handle,
      questionKey: run.questionKey,
      runId: run.runId,
      autoFill: true,
    });
    else setStatus('Answer ready. Nothing was changed on the page.');
  } else if (event.type === 'error') {
    throw new Error(event.message || 'The model stream failed.');
  }
}

function parseLegacyModelAnswer(raw) {
  const finalMatch = raw.match(/^\s*FINAL ANSWER:\s*(.+?)\s*$/im);
  const confidenceMatch = raw.match(/^\s*CONFIDENCE:\s*(\d+(?:\.\d+)?)\s*%?\s*$/im);
  const explanationMatch = raw.match(/^\s*EXPLANATION:\s*([\s\S]*)$/im);
  const exact = finalMatch?.[1]?.trim().replace(/^(["'`])(.*)\1$/, '$2') || '';
  const numericConfidence = confidenceMatch ? Number(confidenceMatch[1]) : NaN;
  const confidence = Number.isFinite(numericConfidence) ? Math.max(0, Math.min(1, numericConfidence / 100)) : null;
  const fillValue = exact && exact.length <= 500 && !exact.includes('\n') ? exact : '';
  const explanation = explanationMatch?.[1]?.trim() || '';
  return {
    fillText: fillValue,
    confidence,
    displayText: fillValue ? `${fillValue}${explanation ? `\n\n${explanation}` : ''}` : raw,
  };
}

function cancelAnswer() {
  const answerWasFilled = Boolean(pendingSubmission) ||
    (activeQuestionKey && getQuestionPhase(automationLifecycle, activeQuestionKey) === AUTOMATION_PHASE.FILLED);
  if (activeQuestionKey && !answerWasFilled) transitionQuestion(activeQuestionKey, 'answer-failed');
  invalidateActiveRun();
  elements.ask.textContent = 'Answer this question';
  elements.ask.classList.remove('running');
  elements.routeStrip.classList.remove('running');
  setStatus(answerWasFilled
    ? 'Stopped. The answer remains filled, but Check answer was not clicked.'
    : 'Stopped. Nothing was inserted or submitted.');
}

async function copyAnswer() {
  await navigator.clipboard.writeText(elements.answer.textContent || answerText);
  setStatus('Copied.');
}

async function applyAnswer({
  handle = captureHandle,
  questionKey = stableQuestionKey(handle),
  runId = activeRunId,
  autoFill = false,
} = {}) {
  if (!fillText) {
    handleFillFailure(questionKey, autoFill, 'The model did not return an exact single-field answer.');
    return;
  }
  if (!handle) {
    handleFillFailure(questionKey, autoFill, 'The captured answer field is no longer available.');
    return;
  }
  const result = await chrome.runtime.sendMessage({
    type: 'apply-answer',
    text: fillText,
    optionId: answerOptionId,
    handle,
  });
  if (result?.error) {
    handleFillFailure(questionKey, autoFill, result.error);
    return;
  }
  transitionQuestion(questionKey, 'filled');

  const shouldSubmit = Boolean(
    elements.autoSubmit.checked &&
    pageContext?.canSubmit &&
    shouldSubmitConfidence(answerConfidence)
  );
  if (shouldSubmit) {
    await queueSubmission({ handle, questionKey, runId });
  } else if (answerConfidence !== null && !shouldSubmitConfidence(answerConfidence) && elements.autoSubmit.checked) {
    setStatus(`Filled for review. Confidence was ${Math.round(answerConfidence * 100)}%; Check requires above 50%.`, 'warn');
  } else {
    setStatus('Answered the detected control for review. Nothing was submitted.');
  }
}

async function queueSubmission({ handle, questionKey, runId }) {
  const seconds = normalizeSubmissionDelaySeconds(elements.submitDelay.value);
  const schedule = createSubmissionDelay({
    seconds,
    onTick: (remaining) => {
      setStatus(remaining > 0
        ? `Answer filled. Checking in ${remaining}s — press Stop to cancel.`
        : 'Answer filled. Revalidating this question before Check answer…');
    },
  });
  pendingSubmission = { schedule, questionKey, handle: { ...handle } };
  elements.ask.textContent = 'Stop';
  elements.ask.classList.add('running');

  const ready = await schedule.promise;
  if (pendingSubmission?.schedule === schedule) pendingSubmission = null;
  if (!ready || runId !== activeRunId) return;
  if (!elements.autoSubmit.checked || !shouldSubmitConfidence(answerConfidence)) {
    setStatus('Auto-submit changed while waiting. The answer remains filled for review.', 'warn');
    return;
  }

  let fresh = null;
  let freshHandle = null;
  for (let attempt = 0; attempt < SUBMISSION_REVALIDATION_DELAYS_MS.length; attempt += 1) {
    const retryDelay = SUBMISSION_REVALIDATION_DELAYS_MS[attempt];
    if (retryDelay) await wait(retryDelay);
    if (runId !== activeRunId) return;

    fresh = await chrome.runtime.sendMessage({ type: 'capture-context', tabId: boundTabId });
    if (runId !== activeRunId) return;
    if (fresh?.error) {
      if (attempt < SUBMISSION_REVALIDATION_DELAYS_MS.length - 1) {
        setStatus('Answer filled. Waiting for Pearson before revalidating Check answer…');
        continue;
      }
      break;
    }

    freshHandle = fresh.captureHandle;
    const currentQuestionMatches = normalizeText(fresh.currentQuestion) &&
      normalizeText(fresh.currentQuestion) === normalizeText(pageContext?.currentQuestion);
    const sameQuestion = fresh.tabId === handle.tabId &&
      freshHandle?.frameId === handle.frameId &&
      freshHandle?.documentToken === handle.documentToken &&
      (freshHandle?.questionFingerprint === handle.questionFingerprint || currentQuestionMatches);
    if (!sameQuestion) {
      setStatus('The page or question changed during the delay. The stale answer was not submitted.', 'warn');
      return;
    }
    if (fresh.canSubmit) break;
    if (attempt < SUBMISSION_REVALIDATION_DELAYS_MS.length - 1) {
      setStatus('Answer filled. Waiting for Pearson to expose Check answer…');
    }
  }
  if (fresh?.error) {
    setStatus(`The answer remains filled, but Jev could not revalidate it: ${fresh.error}`, 'error');
    return;
  }
  if (!fresh?.canSubmit || !freshHandle) {
    setStatus('The answer remains filled, but no current Check answer control was found after three checks.', 'warn');
    return;
  }

  const reservation = transitionQuestion(questionKey, 'submit', { confidence: answerConfidence });
  if (reservation.effect !== 'submit') {
    setStatus(statusForPhase(getQuestionPhase(automationLifecycle, questionKey)));
    return;
  }
  const submission = await chrome.runtime.sendMessage({
    type: 'submit-answer',
    handle: freshHandle,
    confidence: answerConfidence,
  });
  if (submission?.error) {
    transitionQuestion(questionKey, 'submit-failed');
    setStatus(submission.error, 'error');
  } else if (submission?.submitted) {
    transitionQuestion(questionKey, 'await-result');
    pendingOutcome = { questionKey, handle: { ...freshHandle } };
    setStatus(`Answered and clicked Check answer at ${Math.round(answerConfidence * 100)}% answer confidence.`);
    scheduleRead(900);
  } else {
    transitionQuestion(questionKey, 'submit-failed');
    setStatus('Pearson did not confirm the Check answer click. The answer remains filled for review.', 'warn');
  }
}

async function navigateNext({ questionKey = stableQuestionKey(captureHandle), handle = captureHandle } = {}) {
  if (!handle) return;
  setStatus('Correct answer confirmed. Jev is moving to the next question…');
  const result = await chrome.runtime.sendMessage({ type: 'navigate-next', handle });
  if (result?.error) {
    transitionQuestion(questionKey, 'navigate-failed');
    setStatus(result.error, 'error');
    return;
  }
  if (result?.navigated) {
    pendingOutcome = null;
    scheduleRead(900);
  } else {
    transitionQuestion(questionKey, 'navigate-failed');
    setStatus('Pearson did not confirm the Next click. Jev will re-read the current page.', 'warn');
    scheduleRead(900);
  }
}

function handleExtensionMessage(message, sender) {
  if (message?.type === 'laya-active-page-changed') {
    if (boundTabId === null || message.tabId === boundTabId) scheduleRead(350);
  } else if (
    message?.type === 'laya-document-changed' &&
    captureHandle &&
    message.documentToken === captureHandle.documentToken &&
    sender.frameId === captureHandle.frameId
  ) {
    if (pendingSubmission) return false;
    if (controller) {
      deferredDocumentRead = true;
      return false;
    }
    scheduleRead(500);
  }
  return false;
}

function scheduleRead(delay) {
  window.clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(() => void readPage(), delay);
}

function wait(delayMs) {
  return new Promise((resolve) => window.setTimeout(resolve, delayMs));
}

function invalidateActiveRun() {
  activeRunId += 1;
  const wasRunning = Boolean(controller || pendingSubmission);
  controller?.abort();
  controller = null;
  pendingSubmission?.schedule.cancel();
  pendingSubmission = null;
  if (wasRunning) {
    elements.ask.textContent = 'Answer this question';
    elements.ask.classList.remove('running');
    elements.routeStrip.classList.remove('running');
  }
}

function syncDirectControls() {
  elements.autoSubmit.disabled = !elements.directMode.checked;
  elements.submitDelay.disabled = !elements.directMode.checked || !elements.autoSubmit.checked;
}

function cancelPendingSubmission(message = '') {
  if (!pendingSubmission) return false;
  pendingSubmission.schedule.cancel();
  pendingSubmission = null;
  if (!controller) {
    elements.ask.textContent = 'Answer this question';
    elements.ask.classList.remove('running');
  }
  if (message) setStatus(message);
  return true;
}

function cancelActiveWork(message) {
  const hadWork = Boolean(controller || pendingSubmission);
  invalidateActiveRun();
  if (hadWork) setStatus(message);
}

function handleFillFailure(questionKey, autoFill, message) {
  if (autoFill) {
    transitionQuestion(questionKey, 'answer-failed');
    scheduleAnswerRetry(questionKey, message);
  } else {
    setStatus(message, 'error');
  }
}

function scheduleAnswerRetry(questionKey, reason) {
  const attempt = (answerRetryCounts.get(questionKey) || 0) + 1;
  const delay = automaticAnswerRetryDelay(attempt);
  if (delay === null) {
    elements.modelLabel.textContent = 'paused';
    elements.routeNote.textContent = 'Needs review';
    setStatus(`${reason} Jev paused after three automatic retries.`, 'error');
    return false;
  }
  answerRetryCounts.set(questionKey, attempt);
  elements.modelLabel.textContent = 'retrying';
  elements.routeNote.textContent = `Retry ${attempt}/3`;
  setStatus(`${reason} Retrying this question in ${formatRetryDelay(delay)}s…`, 'warn');
  scheduleRead(delay);
  return true;
}

function markRelayDisconnected() {
  relayConfigured = false;
  elements.connection.textContent = 'Relay disconnected · reconnecting…';
  elements.connection.style.color = 'var(--danger)';
  elements.modelLabel.textContent = 'waiting';
  elements.routeNote.textContent = 'Relay offline';
  setStatus('The local relay stopped. Jev will resume this same question automatically when it returns.', 'warn');
  window.clearTimeout(reconnectTimer);
  reconnectTimer = window.setTimeout(() => void reconnectRelay(), RELAY_RECONNECT_MS);
}

async function reconnectRelay() {
  if (await checkRelay()) {
    window.clearTimeout(reconnectTimer);
    reconnectTimer = 0;
    answerRetryCounts.delete(activeQuestionKey);
    setStatus('Relay reconnected. Resuming the current question…');
    scheduleRead(0);
    return;
  }
  reconnectTimer = window.setTimeout(() => void reconnectRelay(), RELAY_RECONNECT_MS);
}

function selectedMode() {
  return document.querySelector('input[name="mode"]:checked')?.value || 'auto';
}

function normalizeText(value) {
  return String(value || '').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
}

function stableQuestionKey(handle) {
  return [
    handle?.tabId ?? 'tab',
    handle?.frameId ?? 'frame',
    handle?.documentToken || 'document',
    handle?.questionFingerprint || 'question',
  ].join(':');
}

function transitionQuestion(questionKey, event, details) {
  const result = reduceAutomationLifecycle(automationLifecycle, questionKey, event, details);
  automationLifecycle = result.lifecycle;
  return result;
}

function statusForPhase(phase) {
  if (phase === AUTOMATION_PHASE.ANSWERING) return 'Jev is already answering this question.';
  if (phase === AUTOMATION_PHASE.FILLED) return 'This question was filled once and will not be answered again.';
  if (phase === AUTOMATION_PHASE.SUBMITTED || phase === AUTOMATION_PHASE.AWAITING_RESULT) {
    return 'Waiting for Pearson to grade this question…';
  }
  if (phase === AUTOMATION_PHASE.CORRECT) return 'Correct answer confirmed. Preparing the next question…';
  if (phase === AUTOMATION_PHASE.INCORRECT) return 'Pearson marked this answer incorrect. Jev stopped.';
  if (phase === AUTOMATION_PHASE.NAVIGATED) return 'Moving to the next question…';
  return 'This question was already handled. Nothing was repeated.';
}

function setStatus(message, kind = '') {
  elements.status.textContent = message;
  elements.status.className = `status ${kind}`.trim();
}
