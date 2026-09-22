import { mergeFramePageContext, selectFrameCandidate } from './lib/frame-selection.js';
import { shouldSubmit } from './lib/automation-lifecycle.js';

const MENU_ID = 'ask-laya-selection';

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: 'Ask Laya about “%s”',
      contexts: ['selection'],
    });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab?.id) return;
  await chrome.storage.session.set({
    pendingQuestion: typeof info.selectionText === 'string' ? info.selectionText.slice(0, 8_000) : '',
  });
  await chrome.sidePanel.open({ tabId: tab.id });
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  void notifyPanel({ type: 'laya-active-page-changed', tabId, reason: 'tab' });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'complete' || changeInfo.url) {
    void notifyPanel({ type: 'laya-active-page-changed', tabId, reason: 'navigation' });
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'capture-context') {
    captureContext(message.tabId).then(sendResponse, (error) => sendResponse({ error: friendlyError(error) }));
    return true;
  }
  if (message?.type === 'apply-answer') {
    sendToCapturedFrame(message.handle, {
      type: 'laya-apply-answer-v16',
      text: String(message.text || ''),
      optionId: String(message.optionId || ''),
      handle: message.handle,
    }).then(
      sendResponse,
      (error) => sendResponse({ error: friendlyError(error) }),
    );
    return true;
  }
  if (message?.type === 'submit-answer') {
    const confidence = Number(message.confidence);
    if (!shouldSubmit(confidence)) {
      sendResponse({ error: 'Answer confidence must be above the 50% submission threshold.' });
      return false;
    }
    sendToCapturedFrame(message.handle, {
      type: 'laya-submit-answer-v16',
      confidence,
      handle: message.handle,
    }).then(sendResponse, (error) => sendResponse({ error: friendlyError(error) }));
    return true;
  }
  if (message?.type === 'navigate-next') {
    sendToCapturedFrame(message.handle, {
      type: 'laya-navigate-next-v16',
      handle: message.handle,
    }).then(sendResponse, (error) => sendResponse({ error: friendlyError(error) }));
    return true;
  }
  if (message?.type === 'inspect-outcome') {
    sendToCapturedFrame(message.handle, {
      type: 'laya-inspect-outcome-v16',
      handle: message.handle,
    }).then(sendResponse, (error) => sendResponse({ error: friendlyError(error) }));
    return true;
  }
  return false;
});

async function captureContext(tabId) {
  const tab = await resolveTab(tabId);
  const injections = await ensurePageAgents(tab.id);
  const frameIds = [...new Set(injections.map((entry) => entry.frameId))];
  const captures = await Promise.all(frameIds.map(async (frameId) => {
    try {
      const capture = await chrome.tabs.sendMessage(tab.id, { type: 'laya-capture-v16' }, { frameId });
      return capture ? { ...capture, frameId } : null;
    } catch {
      return null;
    }
  }));
  const readableCaptures = captures.filter(Boolean);
  const selected = selectFrameCandidate(readableCaptures);
  if (!selected) throw new Error('No readable page frame was found. Reload the page and try again.');
  const fullPageContext = mergeFramePageContext(readableCaptures, selected);

  return {
    ...selected,
    fullPageContext,
    pageTitle: selected.pageTitle || tab.title || 'Untitled page',
    tabId: tab.id,
    captureHandle: {
      tabId: tab.id,
      frameId: selected.frameId,
      documentToken: selected.documentToken,
      targetId: selected.targetId || '',
      submitTargetId: selected.submitTargetId || '',
      nextTargetId: selected.nextTargetId || '',
      questionFingerprint: selected.questionFingerprint || '',
      controlKind: selected.answerControl?.kind || 'text',
      capturedUrl: selected.pageUrl,
      observedCorrect: selected.isCorrect === true,
      observedIncorrect: selected.isIncorrect === true,
    },
  };
}

async function sendToCapturedFrame(handle, message) {
  if (!isCaptureHandle(handle)) return { error: 'The captured answer field is no longer available. Read the page again.' };
  const tab = await resolveTab(handle.tabId);
  await ensurePageAgents(tab.id);
  return await chrome.tabs.sendMessage(
    tab.id,
    message,
    { frameId: handle.frameId },
  );
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('No active webpage is available.');
  if (!/^https?:|^file:/.test(tab.url || '')) throw new Error('Chrome does not allow page access here. Open a normal webpage.');
  return tab;
}

async function resolveTab(tabId) {
  if (!Number.isInteger(tabId)) return await activeTab();
  const tab = await chrome.tabs.get(tabId);
  if (!tab?.id) throw new Error('The tab where Jev started is no longer available.');
  if (!/^https?:|^file:/.test(tab.url || '')) throw new Error('Chrome does not allow page access in the bound tab.');
  return tab;
}

async function ensurePageAgents(tabId) {
  return await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: ['content/page-agent.js'],
  });
}

function isCaptureHandle(value) {
  return Boolean(
    value &&
    Number.isInteger(value.tabId) &&
    Number.isInteger(value.frameId) &&
    typeof value.documentToken === 'string' &&
    typeof value.targetId === 'string' &&
    typeof value.questionFingerprint === 'string'
  );
}

async function notifyPanel(message) {
  try {
    await chrome.runtime.sendMessage(message);
  } catch {
    // The side panel is closed.
  }
}

function friendlyError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('Cannot access contents')) return 'Chrome blocked this page. Try a normal http(s) webpage.';
  if (message.includes('No frame with id')) return 'The question frame changed. Read the page again.';
  return message || 'The page could not be read.';
}
