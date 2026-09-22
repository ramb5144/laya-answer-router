(() => {
  const agentVersion = '0.6.1';
  if (globalThis.__layaPageAgentVersion === agentVersion) return;
  globalThis.__layaPageAgentVersion = agentVersion;

  const documentToken = crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`;
  const elementIds = new WeakMap();
  const elements = new Map();
  const controls = new Map();
  const customSelectOptionCache = new WeakMap();
  const itemRootIds = new WeakMap();
  const itemContextCache = new Map();
  const observedRoots = new WeakSet();
  const textInputTypes = new Set(['', 'email', 'search', 'tel', 'text', 'url']);
  const autoTextInputTypes = new Set(['', 'text']);
  let nextElementId = 1;
  let nextItemRootId = 1;
  let lastTarget = null;
  let lastStateFingerprint = '';
  let mutationTimer = 0;
  let suppressChangeNotificationsUntil = 0;

  document.addEventListener('focusin', (event) => {
    if (isTextControl(event.target)) lastTarget = event.target;
  }, true);
  if (isTextControl(document.activeElement)) lastTarget = document.activeElement;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'laya-capture-v16') {
      createCapture().then((snapshot) => {
        lastStateFingerprint = snapshot.stateFingerprint;
        sendResponse(withoutInternalState(snapshot));
      }, respondWithError(sendResponse));
      return true;
    }
    if (message?.type === 'laya-apply-answer-v16') {
      applyAnswer(String(message.text || ''), String(message.optionId || ''), message.handle)
        .then(sendResponse, respondWithError(sendResponse));
      return true;
    }
    if (message?.type === 'laya-submit-answer-v16') {
      submitAnswer(message.handle, Number(message.confidence))
        .then(sendResponse, respondWithError(sendResponse));
      return true;
    }
    if (message?.type === 'laya-inspect-outcome-v16') {
      inspectOutcome(message.handle).then(sendResponse, respondWithError(sendResponse));
      return true;
    }
    if (message?.type === 'laya-navigate-next-v16') {
      navigateNext(message.handle).then(sendResponse, respondWithError(sendResponse));
      return true;
    }
    return false;
  });

  const observer = new MutationObserver(() => {
    observeOpenRoots();
    window.clearTimeout(mutationTimer);
    mutationTimer = window.setTimeout(notifyIfDocumentChanged, 500);
  });
  observeOpenRoots();

  async function createCapture() {
    if (isTextControl(document.activeElement)) lastTarget = document.activeElement;
    const selection = clean(window.getSelection()?.toString() || '', 4_000);
    const discovery = await discoverAnswerControl();
    const target = discovery.target;
    if (discovery.kind === 'text' && target) lastTarget = target;
    const questionRoot = findNearbyRoot(target);
    const nearbyRoot = findActionRoot(questionRoot);
    const currentQuestion = clean(inferQuestion(target, questionRoot) || document.title, 8_000);
    const itemContext = rememberItemContext(target, questionRoot);
    const nearbyText = clean(itemContext || nearbyRoot?.innerText || nearbyRoot?.textContent || '', 14_000);
    const question = clean(selection || composeContextualQuestion(itemContext, currentQuestion), 14_000);
    const targetId = target ? rememberElement(target) : '';
    const options = discovery.options || [];
    const answerControl = { kind: discovery.kind || 'text', options };
    const questionFingerprint = makeQuestionFingerprint(currentQuestion, target, answerControl);
    if (targetId) controls.set(targetId, {
      kind: answerControl.kind,
      target,
      questionFingerprint,
      options,
      pageFeedback: feedbackSnapshot(document.body),
    });

    const submitTarget = target ? findSubmitControl(nearbyRoot) : null;
    const nextTarget = findNextControl();
    const pageText = visiblePageText();
    const stateFingerprint = makeStateFingerprint(questionFingerprint, discovery, nearbyRoot);

    const scopedCorrect = hasPositiveFeedback(nearbyRoot) && !hasNegativeFeedback(nearbyRoot);
    const completedCorrect = !discovery.hasUnansweredControl && !submitTarget && Boolean(nextTarget) &&
      hasPositiveFeedback(document.body) && !hasNegativeFeedback(document.body);

    return {
      question,
      currentQuestion,
      itemContext,
      selection,
      nearbyText,
      pageText,
      pageTitle: clean(document.title, 500),
      pageUrl: location.href.slice(0, 2_000),
      answerControl,
      documentToken,
      targetId,
      submitTargetId: submitTarget ? rememberElement(submitTarget) : '',
      nextTargetId: nextTarget ? rememberElement(nextTarget) : '',
      questionFingerprint,
      canInsert: Boolean(target && discovery.actionable),
      canAutoFill: Boolean(target && discovery.actionable && !discovery.ambiguous),
      canSubmit: Boolean(submitTarget),
      canNavigateNext: Boolean(nextTarget) && !hasLockedRemainingParts(),
      hasUnansweredControl: discovery.hasUnansweredControl,
      isCorrect: scopedCorrect || completedCorrect,
      isIncorrect: hasNegativeFeedback(nearbyRoot),
      targetAmbiguous: discovery.ambiguous,
      targetEmpty: discovery.empty,
      targetFocused: discovery.containsActiveElement,
      targetVisible: Boolean(target && isVisible(target)),
      documentHasFocus: document.hasFocus(),
      documentVisible: document.visibilityState !== 'hidden',
      stateFingerprint,
    };
  }

  async function discoverAnswerControl() {
    const candidates = [];
    for (const element of collectElements('textarea, input, [contenteditable="true"], [contenteditable="plaintext-only"]')) {
      if (!isTextControl(element) || !isVisible(element) || !isAutoTextControl(element)) continue;
      const empty = isTextEmpty(element);
      const actionable = empty && !isDisabled(element) && !element.readOnly;
      candidates.push({
        kind: 'text',
        target: element,
        options: [],
        empty,
        actionable,
        containsActiveElement: element === document.activeElement,
        score: scoreTextControl(element, empty, actionable),
      });
    }
    for (const group of findRadioGroups()) {
      const optionElements = radioOptions(group);
      const empty = !optionElements.some(isRadioChecked);
      const actionable = empty && optionElements.some((option) => !isDisabled(option));
      candidates.push({
        kind: 'single_choice',
        target: group,
        options: optionElements.map((option) => ({ id: rememberElement(option), label: accessibleText(option) })),
        empty,
        actionable,
        containsActiveElement: optionElements.includes(document.activeElement),
        score: scoreChoiceControl(group, optionElements, empty, actionable),
      });
    }
    for (const select of collectElements('select')) {
      if (!isVisible(select)) continue;
      const optionElements = Array.from(select.options);
      const options = describeSelectOptions(optionElements);
      const empty = isSelectEmpty(select);
      const actionable = empty && !isDisabled(select) && options.length >= 2;
      candidates.push({
        kind: 'single_select',
        target: select,
        options,
        empty,
        actionable,
        containsActiveElement: select === document.activeElement,
        score: scoreSelectControl(select, options, empty, actionable),
      });
    }
    for (const select of collectElements('[role="combobox"][aria-haspopup="listbox"]')) {
      if (!isVisible(select) || select instanceof HTMLSelectElement) continue;
      const empty = isSelectEmpty(select);
      const actionable = empty && !isDisabled(select);
      candidates.push({
        kind: 'single_select',
        target: select,
        options: customSelectOptionCache.get(select) || [],
        empty,
        actionable,
        customSelect: true,
        containsActiveElement: select === document.activeElement,
        score: scoreSelectControl(select, customSelectOptionCache.get(select) || [], empty, actionable),
      });
    }
    candidates.sort((left, right) => right.score - left.score);
    let best = candidates[0];
    if (!best) {
      return {
        kind: 'text', target: null, options: [], empty: false, actionable: false,
        ambiguous: false, containsActiveElement: false, hasUnansweredControl: false,
      };
    }
    if (best.kind === 'single_select' && best.customSelect && best.actionable && best.options.length < 2) {
      const options = await captureCustomSelectOptions(best.target);
      best = {
        ...best,
        options,
        actionable: best.actionable && options.length >= 2,
        score: scoreSelectControl(best.target, options, best.empty, best.actionable && options.length >= 2),
      };
      candidates[0] = best;
    }
    const runnerUp = candidates[1];
    const ambiguous = Boolean(best.actionable && runnerUp?.actionable && best.score - runnerUp.score < 18);
    return { ...best, ambiguous, hasUnansweredControl: candidates.some(({ actionable }) => actionable) };
  }

  function scoreTextControl(target, empty, actionable) {
    let score = actionable ? 260 : empty ? 80 : -80;
    const prompt = accessibleText(target);
    const root = findNearbyRoot(target);
    if (target === document.activeElement) score += 180;
    if (target === lastTarget && actionable) score += 90;
    if (target instanceof HTMLTextAreaElement) score += 25;
    if (prompt.length >= 20) score += 70;
    if (findSubmitControl(root)) score += 45;
    score += verticalPriority(target);
    return score;
  }

  function scoreChoiceControl(group, options, empty, actionable) {
    let score = actionable ? 330 : empty ? 110 : 20;
    const root = findNearbyRoot(group);
    const prompt = inferQuestion(group, root);
    if (options.includes(document.activeElement)) score += 180;
    if (prompt.length >= 20) score += 80;
    if (options.length >= 2 && options.length <= 10) score += 45;
    if (findSubmitControl(root)) score += 55;
    score += verticalPriority(group);
    return score;
  }

  function scoreSelectControl(target, options, empty, actionable) {
    let score = actionable ? 345 : empty ? 105 : 15;
    const prompt = inferQuestion(target, findNearbyRoot(target));
    if (target === document.activeElement) score += 180;
    if (prompt.length >= 20) score += 80;
    if (options.length >= 2 && options.length <= 20) score += 55;
    if (findSubmitControl(findNearbyRoot(target))) score += 55;
    score += verticalPriority(target);
    return score;
  }

  function findRadioGroups() {
    const groups = [];
    const claimed = new Set();
    for (const group of collectElements('[role="radiogroup"]')) {
      const options = radioOptions(group);
      if (!isVisible(group) || options.length < 2) continue;
      groups.push(group);
      options.forEach((option) => claimed.add(option));
    }
    for (const fieldset of collectElements('fieldset')) {
      const options = radioOptions(fieldset).filter((option) => !claimed.has(option));
      if (!isVisible(fieldset) || options.length < 2) continue;
      groups.push(fieldset);
      options.forEach((option) => claimed.add(option));
    }
    const named = new Map();
    for (const option of collectElements('input[type="radio"]')) {
      if (claimed.has(option) || !isVisible(option)) continue;
      const key = `${option.form?.id || ''}\n${option.name || rememberElement(option.parentElement || option)}`;
      const entry = named.get(key) || [];
      entry.push(option);
      named.set(key, entry);
    }
    for (const options of named.values()) {
      if (options.length < 2) continue;
      groups.push(options[0].closest('fieldset, [role="group"], form, section, article, div') || options[0].parentElement);
    }
    return [...new Set(groups.filter(Boolean))];
  }

  function radioOptions(root) {
    return collectElements('input[type="radio"], [role="radio"]', root)
      .filter((option) => isVisible(option));
  }

  function describeSelectOptions(optionElements) {
    return optionElements.flatMap((option, index) => {
      const label = collapseRepeatedLabel(option.innerText || option.textContent || option.getAttribute?.('aria-label') || '');
      const placeholder = option instanceof HTMLOptionElement
        ? !option.value || option.disabled && option.selected
        : /^(?:select|choose)(?:\s+an?\s+option)?$/i.test(label);
      if (!label || placeholder || isDisabled(option)) return [];
      return [{ id: `option-${index + 1}`, label }];
    });
  }

  function collapseRepeatedLabel(value) {
    const label = clean(value, 1_000);
    const lines = label.split('\n').map((line) => clean(line, 1_000)).filter(Boolean);
    if (lines.length > 1 && lines.every((line) => normalize(line) === normalize(lines[0]))) return lines[0];
    return label;
  }

  async function captureCustomSelectOptions(select) {
    const cached = customSelectOptionCache.get(select);
    if (cached?.length >= 2) return cached;
    suppressChangeNotificationsUntil = Date.now() + 1_200;
    const wasExpanded = select.getAttribute('aria-expanded') === 'true';
    if (!wasExpanded) {
      if (visibleOptionsForSelect(select).length) await closeCustomSelect(select);
      activateCustomControl(select);
    }
    const optionElements = await waitForVisibleOptions(select, 1_000);
    const options = describeSelectOptions(optionElements);
    if (options.length >= 2) customSelectOptionCache.set(select, options);
    if (!wasExpanded) await closeCustomSelect(select);
    return options;
  }

  async function waitForVisibleOptions(select, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
      const visible = visibleOptionsForSelect(select);
      if (visible.length >= 2) return visible;
      await delay(50);
    }
    return [];
  }

  async function closeCustomSelect(select) {
    if (select.getAttribute('aria-expanded') === 'true') {
      select.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
      await delay(100);
    }
    if (visibleOptionsForSelect(select).length) {
      activateCustomControl(select);
      await delay(100);
    }
  }

  function visibleOptionsForSelect(select) {
    const ownedIds = `${select.getAttribute('aria-controls') || ''} ${select.getAttribute('aria-owns') || ''}`
      .split(/\s+/)
      .filter(Boolean);
    const ownedRoots = ownedIds.map((id) => document.getElementById(id)).filter(Boolean);
    const scoped = ownedRoots.flatMap((root) => Array.from(root.querySelectorAll('[role="option"]')));
    const global = Array.from(document.querySelectorAll('[role="listbox"] [role="option"], [role="option"]'));
    return [...new Set([...scoped, ...global])].filter(isVisible);
  }

  function activateCustomControl(element) {
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      const EventConstructor = type.startsWith('pointer') && typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
      element.dispatchEvent(new EventConstructor(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        button: 0,
        buttons: type.endsWith('down') ? 1 : 0,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
      }));
    }
  }

  function findSubmitControl(nearbyRoot) {
    const actionRoot = findActionRoot(nearbyRoot);
    if (!actionRoot) return null;
    const candidates = collectElements('button, input[type="button"], input[type="submit"], [role="button"]', actionRoot)
      .filter((element) => isVisible(element) && /^check answer$/i.test(accessibleText(element)));
    return candidates.length === 1 ? candidates[0] : null;
  }

  function findActionRoot(root) {
    let current = root;
    while (current) {
      const candidates = collectElements('button, input[type="button"], input[type="submit"], [role="button"]', current)
        .filter((element) => isVisible(element) && /^check answer$/i.test(accessibleText(element)));
      if (candidates.length === 1) return current;
      current = current.parentElement;
    }
    return root;
  }

  function findNextControl() {
    const candidates = collectElements('button, input[type="button"], input[type="submit"], [role="button"]')
      .filter((element) => isVisible(element) && !isDisabled(element) && /^(?:next|continue)$/i.test(accessibleText(element)));
    return candidates.length === 1 ? candidates[0] : null;
  }

  function findNearbyRoot(target) {
    if (target) {
      const pearsonPart = target.closest('.acs-partContainer, [role="region"][aria-label^="Part "]');
      if (pearsonPart) return pearsonPart;
      const semantic = target.closest('fieldset, [role="group"], form, article, section, main');
      if (semantic) return semantic;
      let ancestor = target.parentElement;
      while (ancestor && ancestor !== document.body) {
        const text = clean(ancestor.innerText || ancestor.textContent || '', 8_000);
        if (text.length >= 80) return ancestor;
        ancestor = ancestor.parentElement;
      }
    }
    return findQuestionBlock();
  }

  function inferQuestion(target, root) {
    const legend = root?.matches?.('fieldset') ? root.querySelector(':scope > legend')?.innerText : '';
    const rootQuestion = extractQuestion(root, target);
    const targetPrompt = accessibleText(target);
    return clean(composePrompt(legend || rootQuestion, targetPrompt), 8_000);
  }

  function composePrompt(stem, localPrompt) {
    const cleanStem = clean(stem || '', 8_000);
    const cleanLocal = clean(localPrompt || '', 8_000);
    if (!cleanStem) return cleanLocal;
    if (!cleanLocal) return cleanStem;
    const normalizedStem = normalize(cleanStem);
    const normalizedLocal = normalize(cleanLocal);
    if (normalizedStem.includes(normalizedLocal)) return cleanStem;
    if (normalizedLocal.includes(normalizedStem)) return cleanLocal;
    return `${cleanStem}\n${cleanLocal}`;
  }

  function composeContextualQuestion(itemContext, currentQuestion) {
    const context = clean(itemContext || '', 14_000);
    const current = clean(currentQuestion || '', 8_000);
    if (!context) return current;
    if (!current || normalize(context) === normalize(current)) return context;
    return `${context}\n\nCURRENT QUESTION\n${current}`;
  }

  function rememberItemContext(target, questionRoot) {
    const itemRoot = findItemRoot(target, questionRoot);
    if (!itemRoot) return '';
    let rootId = itemRootIds.get(itemRoot);
    if (!rootId) {
      rootId = `item-${nextItemRootId++}`;
      itemRootIds.set(itemRoot, rootId);
    }
    const title = itemTitle(itemRoot);
    const key = `${rootId}:${normalize(title)}`;
    const snapshot = cleanItemContext(itemRoot);
    const merged = mergeItemContext(itemContextCache.get(key) || '', snapshot, 14_000);
    itemContextCache.set(key, merged);
    return merged;
  }

  function findItemRoot(target, questionRoot) {
    return target?.closest?.('.parts, .assessmentItem, .AssessmentItemLauncher, [data-assessment-item-id], [data-question-id]') ||
      questionRoot?.closest?.('.parts, .assessmentItem, .AssessmentItemLauncher, [data-assessment-item-id], [data-question-id]') ||
      questionRoot || null;
  }

  function itemTitle(root) {
    const lines = clean(root?.innerText || root?.textContent || '', 2_000).split('\n').map((line) => line.trim()).filter(Boolean);
    return lines[0] || root?.getAttribute?.('aria-label') || document.title;
  }

  function cleanItemContext(root) {
    const ignored = /^(?:clear all|check answer|help me solve this|etext pages|next|continue|\d+ tries? left|\d+ parts? remaining|your answer is correct|good job!?|nice work!?|great work!?|excellent!?|fantastic!?|well done!?)$/i;
    const actionLabels = new Set(collectElements('button, input[type="button"], input[type="submit"], [role="button"]', root)
      .map((element) => normalize(accessibleText(element)))
      .filter(Boolean));
    return clean(root?.innerText || root?.textContent || '', 20_000)
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !ignored.test(line) && !actionLabels.has(normalize(line)))
      .join('\n');
  }

  function mergeItemContext(previous, current, maxLength) {
    const seen = new Set();
    const lines = [];
    for (const line of `${previous}\n${current}`.split('\n')) {
      const value = line.trim();
      const identity = normalize(value);
      if (!value || seen.has(identity)) continue;
      seen.add(identity);
      lines.push(value);
    }
    return clean(lines.join('\n'), maxLength);
  }

  function extractQuestion(root, target) {
    const clone = root?.cloneNode?.(true);
    if (!clone) return '';
    for (const control of clone.querySelectorAll(
      'input, textarea, select, button, [role="button"], [role="combobox"], [role="listbox"], [contenteditable="true"], [contenteditable="plaintext-only"], [role="status"], [aria-live]'
    )) control.remove();
    for (const dynamic of clone.querySelectorAll(
      '.eqEditor, .eqAccessibleLabel, .eqDocument, .feedback, [class*="feedback" i], [class*="correct" i], [class*="incorrect" i]'
    )) dynamic.remove();
    const text = clean(clone.innerText || clone.textContent || '', 8_000);
    if (!text) return '';
    const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
    const ending = lines.findIndex((line) => line.includes('?'));
    if (ending >= 0) return lines.slice(0, ending + 1).join(' ');
    const targetPrompt = accessibleText(target);
    if (targetPrompt.length >= 20) {
      const targetLine = lines.find((line) => normalize(line).includes(normalize(targetPrompt)));
      if (targetLine) return targetLine;
    }
    return lines.slice(-12).join('\n');
  }

  function findQuestionBlock() {
    const roots = collectElements('fieldset, [role="group"], form, article, section, main')
      .filter((element) => isVisible(element) && /\?/.test(element.innerText || element.textContent || ''));
    roots.sort((left, right) => {
      const leftHasCheck = findSubmitControl(left) ? 1 : 0;
      const rightHasCheck = findSubmitControl(right) ? 1 : 0;
      if (rightHasCheck !== leftHasCheck) return rightHasCheck - leftHasCheck;
      return right.getBoundingClientRect().top - left.getBoundingClientRect().top;
    });
    return roots[0] || document.querySelector('main') || document.body;
  }

  function visiblePageText() {
    const root = document.querySelector('main, [role="main"], article') || document.body;
    return clean(root?.innerText || '', 18_000);
  }

  async function applyAnswer(text, optionId, handle) {
    const current = resolveCurrentControl(handle);
    if (current.error) return current;
    const { control } = current;
    if (!control.empty || !control.actionable) return { error: 'The answer control is no longer empty, so Jev did not overwrite it.' };

    if (control.kind === 'single_choice') {
      const option = radioOptions(control.target).find((candidate) => rememberElement(candidate) === optionId);
      if (!option || isDisabled(option)) return { error: 'The selected option no longer belongs to this question.' };
      suppressChangeNotificationsUntil = Date.now() + 1_200;
      if (option instanceof HTMLInputElement) {
        // Use the browser's activation behavior so React/Pearson receives the
        // click as well as the checked state. Setting `checked` directly only
        // changes the DOM and can leave Check answer disabled.
        option.click();
      } else {
        activateCustomControl(option);
      }
      await delay(100);
      if (!isRadioChecked(option)) return { error: 'The page did not accept the selected option.' };
      const submitTarget = elements.get(handle.submitTargetId);
      if (submitTarget?.isConnected && !await waitUntilEnabled(submitTarget, 700)) {
        return { error: 'The option appeared selected, but the page did not enable Check answer.' };
      }
      return { ok: true, selectedLabel: accessibleText(option) };
    }

    if (control.kind === 'single_select') {
      const descriptor = control.options.find((candidate) => candidate.id === optionId);
      if (!descriptor) return { error: 'The selected dropdown option no longer belongs to this question.' };
      suppressChangeNotificationsUntil = Date.now() + 1_200;
      if (control.target instanceof HTMLSelectElement) {
        const optionElements = Array.from(control.target.options);
        const currentOptions = describeSelectOptions(optionElements);
        const currentDescriptor = currentOptions.find(({ id }) => id === descriptor.id);
        if (!currentDescriptor || normalize(currentDescriptor.label) !== normalize(descriptor.label)) {
          return { error: 'The dropdown options changed before Jev could select one.' };
        }
        const optionIndex = Number(descriptor.id.replace('option-', '')) - 1;
        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'selectedIndex')?.set;
        if (setter) setter.call(control.target, optionIndex);
        else control.target.selectedIndex = optionIndex;
        control.target.dispatchEvent(new Event('input', { bubbles: true }));
        control.target.dispatchEvent(new Event('change', { bubbles: true }));
        if (normalize(control.target.selectedOptions[0]?.textContent || '') !== normalize(descriptor.label)) {
          return { error: 'The page did not accept the selected dropdown option.' };
        }
      } else {
        const wasExpanded = control.target.getAttribute('aria-expanded') === 'true';
        if (!wasExpanded) {
          if (visibleOptionsForSelect(control.target).length) await closeCustomSelect(control.target);
          activateCustomControl(control.target);
        }
        const optionElements = await waitForVisibleOptions(control.target, 1_000);
        const currentOptions = describeSelectOptions(optionElements);
        const currentDescriptor = currentOptions.find(({ id }) => id === descriptor.id);
        if (!currentDescriptor || normalize(currentDescriptor.label) !== normalize(descriptor.label)) {
          if (!wasExpanded) await closeCustomSelect(control.target);
          return { error: 'The dropdown options changed before Jev could select one.' };
        }
        const optionIndex = Number(descriptor.id.replace('option-', '')) - 1;
        const option = optionElements[optionIndex];
        if (!option || isDisabled(option)) return { error: 'The selected dropdown option is no longer available.' };
        activateCustomControl(option);
        await delay(100);
        const selectedText = clean(control.target.innerText || control.target.textContent || '', 1_000);
        if (normalize(selectedText) !== normalize(descriptor.label)) {
          return { error: 'The page did not accept the selected dropdown option.' };
        }
      }
      return { ok: true, selectedLabel: descriptor.label };
    }

    const target = control.target;
    if (target.isContentEditable) {
      target.textContent = text;
      if (target.textContent !== text) return { error: 'The page did not accept the full answer.' };
    } else if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) {
      const prototype = target instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
      if (setter) setter.call(target, text);
      else target.value = text;
      if (target.value !== text) return { error: 'This field did not accept the exact answer.' };
    } else {
      return { error: 'The captured element is not editable.' };
    }
    target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    suppressChangeNotificationsUntil = Date.now() + 1_000;
    await delay(200);
    if (isTextEmpty(target)) return { error: 'The page did not keep the inserted answer.' };
    return { ok: true };
  }

  async function submitAnswer(handle, confidence) {
    if (!Number.isFinite(confidence) || confidence <= 0.5) return { error: 'Answer confidence must be above the 50% submission threshold.' };
    const current = resolveCurrentControl(handle);
    if (current.error) return current;
    if (current.control.empty) return { error: 'The captured answer has not been filled or selected.' };
    const submitTarget = elements.get(handle.submitTargetId);
    if (!submitTarget?.isConnected || !isVisible(submitTarget) || !/^check answer$/i.test(accessibleText(submitTarget))) {
      return { error: 'The captured Check answer control changed. Nothing was submitted.' };
    }
    const enabled = await waitUntilEnabled(submitTarget, 1_500);
    if (!enabled) return { error: 'The Check answer control stayed disabled. Nothing was submitted.' };
    submitTarget.click();
    return { ok: true, submitted: true };
  }

  async function navigateNext(handle) {
    const outcome = await inspectOutcome(handle);
    if (outcome.error) return outcome;
    if (!outcome.isCorrect || outcome.isIncorrect) {
      return { error: 'Jev did not find a correct result for the current question, so it did not navigate.' };
    }
    if (outcome.hasLockedRemainingParts) {
      return { error: 'This multi-part question still has a locked remaining part, so Jev did not leave it.' };
    }
    // Pearson replaces the Next button when grading completes. Reacquire the
    // one current, uniquely-labelled target after verifying the answer outcome.
    const nextTarget = findNextControl();
    if (!nextTarget?.isConnected || !isVisible(nextTarget) || isDisabled(nextTarget) || !/^(?:next|continue)$/i.test(accessibleText(nextTarget))) {
      return { error: 'Jev could not find one enabled Next control, so it stopped.' };
    }
    nextTarget.click();
    return { ok: true, navigated: true };
  }

  async function inspectOutcome(handle) {
    if (!handle || handle.documentToken !== documentToken) {
      return { error: 'The question changed before Jev could verify the result.' };
    }
    const stored = controls.get(handle.targetId);
    if (!stored && handle.observedCorrect !== true) {
      return { error: 'The submitted question is no longer available for result verification.' };
    }
    const currentFeedback = feedbackSnapshot(document.body);
    const currentPositiveFeedback = hasPositiveFeedback(document.body);
    const currentNegativeFeedback = hasNegativeFeedback(document.body);
    const nextTarget = findNextControl();
    if (!stored) {
      const discovery = await discoverAnswerControl();
      const actionRoot = findActionRoot(findNearbyRoot(discovery.target));
      const submitTarget = discovery.target ? findSubmitControl(actionRoot) : null;
      return {
        ok: true,
        isCorrect: !discovery.hasUnansweredControl && !submitTarget &&
          currentPositiveFeedback && !currentNegativeFeedback,
        isIncorrect: currentNegativeFeedback,
        canNavigateNext: Boolean(nextTarget) && !isDisabled(nextTarget),
        hasLockedRemainingParts: hasLockedRemainingParts(),
      };
    }
    if (stored.questionFingerprint !== handle.questionFingerprint) {
      return { error: 'The submitted question changed before Jev could verify the result.' };
    }

    const newPositiveFeedback = currentFeedback.positiveCount > stored.pageFeedback.positiveCount ||
      currentFeedback.positiveSignature !== stored.pageFeedback.positiveSignature;
    const newNegativeFeedback = currentFeedback.negativeCount > stored.pageFeedback.negativeCount ||
      currentFeedback.negativeSignature !== stored.pageFeedback.negativeSignature;
    const capturedCompletedAnswer = handle.observedCorrect === true &&
      currentPositiveFeedback && !currentNegativeFeedback;

    return {
      ok: true,
      isCorrect: (newPositiveFeedback && !newNegativeFeedback) || capturedCompletedAnswer,
      isIncorrect: newNegativeFeedback || (handle.observedIncorrect === true && currentNegativeFeedback),
      canNavigateNext: Boolean(nextTarget) && !isDisabled(nextTarget),
      hasLockedRemainingParts: hasLockedRemainingParts(),
    };
  }

  function resolveCurrentControl(handle) {
    if (!handle || handle.documentToken !== documentToken) return { error: 'The question changed before the answer was ready. Nothing was changed.' };
    const stored = controls.get(handle.targetId);
    if (!stored?.target?.isConnected || !isVisible(stored.target)) return { error: 'The captured answer control is no longer available.' };
    const current = describeStoredControl(stored);
    const root = findNearbyRoot(current.target);
    const question = clean(inferQuestion(current.target, root) || document.title, 8_000);
    const targetId = rememberElement(current.target);
    const options = current.options;
    const fingerprint = makeQuestionFingerprint(question, current.target, { kind: current.kind, options });
    if (fingerprint !== handle.questionFingerprint || fingerprint !== stored.questionFingerprint) {
      return { error: 'The page reused this control for a new question. The stale answer was discarded.' };
    }
    return { control: current };
  }

  function describeStoredControl(stored) {
    if (stored.kind === 'single_choice') {
      const options = radioOptions(stored.target);
      const empty = !options.some(isRadioChecked);
      return {
        kind: 'single_choice', target: stored.target,
        options: options.map((option) => ({ id: rememberElement(option), label: accessibleText(option) })),
        empty,
        actionable: empty && options.some((option) => !isDisabled(option)),
      };
    }
    if (stored.kind === 'single_select') {
      const options = stored.target instanceof HTMLSelectElement
        ? describeSelectOptions(Array.from(stored.target.options))
        : customSelectOptionCache.get(stored.target) || stored.options;
      const empty = isSelectEmpty(stored.target);
      return {
        kind: 'single_select', target: stored.target, options, empty,
        actionable: empty && !isDisabled(stored.target) && options.length >= 2,
      };
    }
    const empty = isTextEmpty(stored.target);
    return {
      kind: 'text', target: stored.target, options: [], empty,
      actionable: empty && !isDisabled(stored.target) && !stored.target.readOnly,
    };
  }

  async function waitUntilEnabled(element, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
      if (!isDisabled(element)) return true;
      await new Promise((resolve) => setTimeout(resolve, 75));
    }
    return false;
  }

  function rememberElement(element) {
    let id = elementIds.get(element);
    if (!id) {
      id = `target-${nextElementId++}`;
      elementIds.set(element, id);
      elements.set(id, element);
    }
    return id;
  }

  function accessibleText(element) {
    if (!element) return '';
    const labelledBy = element.getAttribute?.('aria-labelledby') || '';
    const valueRoot = findRenderedValueRoot(element);
    const references = labelledBy
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => document.getElementById(id))
      .filter((reference) => reference && (!valueRoot || !valueRoot.contains(reference)))
      .map((reference) => reference.getAttribute?.('aria-label') || reference.textContent || '');
    const labels = element.labels ? Array.from(element.labels).map((label) => label.innerText || label.textContent || '') : [];
    const explicit = clean([
      ...labels,
      ...references,
      element.getAttribute?.('aria-label') || '',
      element.getAttribute?.('placeholder') || '',
    ].filter(Boolean).join(' '), 2_000);
    if (explicit) return explicit;
    const inputValue = element instanceof HTMLInputElement && ['button', 'submit', 'reset'].includes(element.type)
      ? element.value
      : '';
    return clean([inputValue, element.innerText || element.textContent || ''].filter(Boolean).join(' '), 2_000);
  }

  function findRenderedValueRoot(element) {
    return element?.closest?.('.eqEditor, [assessmentscomponentid^="assessmentComponents_EqEditor"], math-field, [data-math-editor]') || null;
  }

  function collectElements(selector, root = document) {
    const found = [];
    const visit = (searchRoot) => {
      found.push(...searchRoot.querySelectorAll(selector));
      for (const element of searchRoot.querySelectorAll('*')) {
        if (element.shadowRoot) visit(element.shadowRoot);
      }
    };
    visit(root);
    return found;
  }

  function observeOpenRoots() {
    const roots = [document];
    for (const element of document.querySelectorAll('*')) if (element.shadowRoot) roots.push(element.shadowRoot);
    for (const root of roots) {
      if (observedRoots.has(root)) continue;
      observer.observe(root, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['checked', 'disabled', 'aria-checked', 'aria-disabled'],
      });
      observedRoots.add(root);
    }
  }

  function isTextControl(value) {
    if (value instanceof HTMLTextAreaElement) return true;
    if (value instanceof HTMLInputElement) return textInputTypes.has(value.type);
    return value instanceof HTMLElement && value.isContentEditable;
  }

  function isAutoTextControl(value) {
    if (value instanceof HTMLInputElement) return autoTextInputTypes.has(value.type);
    return value instanceof HTMLTextAreaElement || value instanceof HTMLElement && value.isContentEditable;
  }

  function isTextEmpty(value) {
    const renderedValueRoot = findRenderedValueRoot(value);
    if (renderedValueRoot) {
      const documentView = renderedValueRoot.querySelector('.eqDocument');
      if (documentView?.classList.contains('empty')) return true;
      const accessibleValue = renderedValueRoot.querySelector('.eqAccessibleLabel')?.textContent || '';
      const visualClone = documentView?.cloneNode(true);
      visualClone?.querySelectorAll?.('.eqCaret, [aria-hidden="false"]').forEach((node) => node.remove());
      const visualValue = visualClone?.textContent || '';
      const rendered = clean(visualValue, 1_000);
      const accessible = clean(accessibleValue, 1_000);
      if (!rendered && /^(?:enter (?:your )?response here|enter (?:your )?answer|answer here|blank)$/i.test(accessible)) {
        return true;
      }
      return !clean(`${accessible} ${rendered}`, 1_000);
    }
    if (value instanceof HTMLInputElement || value instanceof HTMLTextAreaElement) return !value.value.trim();
    return !clean(value.textContent || '', 10).length;
  }

  function isSelectEmpty(value) {
    if (value instanceof HTMLSelectElement) {
      const selected = value.selectedOptions[0];
      return !selected || !selected.value || /^(?:select|choose)(?:\s+an?\s+option)?$/i.test(clean(selected.textContent || '', 200));
    }
    const current = clean(value.getAttribute?.('aria-valuetext') || value.innerText || value.textContent || '', 200);
    return !current || /^(?:select|choose)(?:\s+an?\s+option)?$/i.test(current);
  }

  function isRadioChecked(option) {
    return option instanceof HTMLInputElement ? option.checked : option.getAttribute?.('aria-checked') === 'true';
  }

  function isDisabled(element) {
    return Boolean(element.disabled || element.getAttribute?.('aria-disabled') === 'true');
  }

  function isVisible(element) {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  }

  function verticalPriority(element) {
    const top = element.getBoundingClientRect().top;
    return Math.max(-40, Math.min(70, Math.round((top / Math.max(innerHeight, 1)) * 70)));
  }

  function hasPositiveFeedback(root) {
    const text = clean(root?.innerText || root?.textContent || '', 8_000);
    return !/\bincorrect\b/i.test(text) && /\b(?:good job|nice work|great work|that's correct|that's right|correct answer|excellent|fantastic|well done)\b/i.test(text);
  }

  function hasNegativeFeedback(root) {
    return /\b(?:incorrect|not correct|try again)\b/i.test(clean(root?.innerText || root?.textContent || '', 8_000));
  }

  function feedbackSnapshot(root) {
    const text = normalize(root?.innerText || root?.textContent || '');
    const positives = text.match(/\b(?:good job|nice work|great work|that's correct|that's right|correct answer|excellent|fantastic|well done)\b/g) || [];
    const negatives = text.match(/\b(?:incorrect|not correct|try again)\b/g) || [];
    return {
      positiveCount: positives.length,
      positiveSignature: stableHash(positives.join('|')),
      negativeCount: negatives.length,
      negativeSignature: stableHash(negatives.join('|')),
    };
  }

  function hasLockedRemainingParts() {
    const text = clean(document.body?.innerText || document.body?.textContent || '', 20_000);
    return /\b\d+\s+parts?\s+remaining\b/i.test(text);
  }

  function makeQuestionFingerprint(question, target, answerControl) {
    const options = answerControl.options.map(({ id, label }) => `${id}:${normalize(label)}`).join('|');
    return stableHash(`${normalize(question)}\n${semanticControlIdentity(target)}\n${answerControl.kind}\n${options}\n${location.href}`);
  }

  function semanticControlIdentity(target) {
    if (!target) return '';
    const component = target.closest?.('[assessmentscomponentid]');
    return clean([
      target.id || '',
      target.getAttribute?.('name') || '',
      target.getAttribute?.('data-testid') || '',
      component?.getAttribute?.('assessmentscomponentid') || '',
    ].filter(Boolean).join(':'), 500);
  }

  function makeStateFingerprint(questionFingerprint, discovery, root) {
    const selected = discovery.empty ? 'empty' : 'filled';
    return `${questionFingerprint}:${selected}:${hasPositiveFeedback(root)}:${hasNegativeFeedback(root)}`;
  }

  function stableHash(value) {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function normalize(value) {
    return clean(value, 8_000).toLocaleLowerCase().replace(/\s+/g, ' ');
  }

  async function notifyIfDocumentChanged() {
    if (Date.now() < suppressChangeNotificationsUntil) return;
    const snapshot = await createCapture();
    if (!lastStateFingerprint) {
      lastStateFingerprint = snapshot.stateFingerprint;
      return;
    }
    if (snapshot.stateFingerprint === lastStateFingerprint) return;
    lastStateFingerprint = snapshot.stateFingerprint;
    void chrome.runtime.sendMessage({ type: 'laya-document-changed', documentToken }).catch(() => {});
  }

  function withoutInternalState(snapshot) {
    const { stateFingerprint: _stateFingerprint, ...publicSnapshot } = snapshot;
    return publicSnapshot;
  }

  function respondWithError(sendResponse) {
    return (error) => sendResponse({ error: error instanceof Error ? error.message : String(error) });
  }

  function clean(value, max) {
    return String(value).replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
  }

  function delay(milliseconds) {
    return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
  }
})();
