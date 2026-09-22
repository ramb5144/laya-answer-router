import assert from 'node:assert/strict';
import test from 'node:test';
import { parseBrowserAnswer } from '../backend/browser-answer.js';

const textControl = { kind: 'text' as const, options: [] };
const choiceControl = {
  kind: 'single_choice' as const,
  options: [
    { id: 'option-a', label: 'A. Smaller in absolute value.' },
    { id: 'option-b', label: 'B. The demand curve shifted.' },
  ],
};
const selectControl = {
  kind: 'single_select' as const,
  options: [
    { id: 'option-1', label: 'larger' },
    { id: 'option-2', label: 'smaller' },
  ],
};

test('parses an exact answer separately from answer confidence', () => {
  const result = parseBrowserAnswer(JSON.stringify({
    answer: '-1.96',
    optionId: '',
    confidence: 0.91,
    explanation: 'Elasticity is percentage quantity change divided by percentage price change.',
  }), textControl);
  assert.equal(result.answer, '-1.96');
  assert.equal(result.confidence, 0.91);
});

test('rejects malformed, multiline, or out-of-range browser answers', () => {
  assert.throws(() => parseBrowserAnswer('not json', textControl), /structured browser answer/);
  assert.throws(() => parseBrowserAnswer(JSON.stringify({ answer: 'one\ntwo', optionId: '', confidence: 0.8, explanation: '' }), textControl), /one exact field value/);
  assert.throws(() => parseBrowserAnswer(JSON.stringify({ answer: '42', optionId: '', confidence: 1.2, explanation: '' }), textControl), /invalid/);
});

test('canonicalizes a captured multiple-choice option by opaque id', () => {
  const result = parseBrowserAnswer(JSON.stringify({
    answer: 'The second choice',
    optionId: 'option-b',
    confidence: 0.84,
    explanation: 'A demand shift means the observed quantity change is not purely a movement along demand.',
  }), choiceControl);
  assert.equal(result.optionId, 'option-b');
  assert.equal(result.answer, 'B. The demand curve shifted.');
});

test('rejects unknown choice ids and kind mismatches', () => {
  assert.throws(() => parseBrowserAnswer(JSON.stringify({ answer: 'A', optionId: 'missing', confidence: 0.8, explanation: '' }), choiceControl), /unknown answer option/);
  assert.throws(() => parseBrowserAnswer(JSON.stringify({ answer: '42', optionId: 'option-a', confidence: 0.8, explanation: '' }), textControl), /choice for a text field/);
});

test('canonicalizes a captured dropdown option by opaque id', () => {
  const result = parseBrowserAnswer(JSON.stringify({
    answer: 'smaller',
    optionId: 'option-2',
    confidence: 0.99,
    explanation: 'Three is smaller than three million in absolute value.',
  }), selectControl);
  assert.equal(result.optionId, 'option-2');
  assert.equal(result.answer, 'smaller');
});

test('accepts a captured choice label with rendered duplicate lines', () => {
  const duplicatedSelect = {
    kind: 'single_select' as const,
    options: [
      { id: 'option-1', label: 'decrease\ndecrease' },
      { id: 'option-2', label: 'increase\nincrease' },
    ],
  };
  const result = parseBrowserAnswer(JSON.stringify({
    answer: 'increase',
    optionId: 'option-2',
    confidence: 0.99,
    explanation: 'Elastic demand makes revenue rise after a price decrease.',
  }), duplicatedSelect);
  assert.equal(result.optionId, 'option-2');
  assert.equal(result.answer, 'increase\nincrease');
});
