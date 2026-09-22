import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeFramePageContext, selectFrameCandidate } from '../extension/lib/frame-selection.js';

const base = {
  selection: '',
  canAutoFill: false,
  canInsert: false,
  targetFocused: false,
  documentHasFocus: false,
  targetVisible: false,
  targetEmpty: false,
  targetAmbiguous: false,
  documentVisible: true,
  question: '',
  nearbyText: '',
  pageText: '',
  pageUrl: 'https://example.test',
};

test('selects a cross-origin question frame over the outer page shell', () => {
  const selected = selectFrameCandidate([
    { ...base, frameId: 0, question: 'Course home', pageText: 'Navigation and course controls' },
    {
      ...base,
      frameId: 7,
      question: 'What is the elasticity of demand?',
      nearbyText: 'A complete economics question with an answer field.',
      pageUrl: 'https://tdx.acs.pearson.com/assignment/assignmentplayer.aspx',
      canAutoFill: true,
      canInsert: true,
      targetVisible: true,
      targetEmpty: true,
    },
  ]);
  assert.equal(selected?.frameId, 7);
});

test('penalizes ambiguous or hidden answer frames', () => {
  const selected = selectFrameCandidate([
    { ...base, frameId: 3, question: 'Visible question?', canInsert: true, targetVisible: true },
    { ...base, frameId: 4, question: 'Hidden question?', canAutoFill: true, documentVisible: false, targetAmbiguous: true },
  ]);
  assert.equal(selected?.frameId, 3);
});

test('breaks equal scores deterministically in favor of the top frame', () => {
  const selected = selectFrameCandidate([
    { ...base, frameId: 8, question: 'Same question?' },
    { ...base, frameId: 0, question: 'Same question?' },
  ]);
  assert.equal(selected?.frameId, 0);
});

test('selects a newly inserted multiple-choice group over completed text content', () => {
  const selected = selectFrameCandidate([
    {
      ...base,
      frameId: 0,
      question: 'Homework',
      pageText: 'Course shell',
    },
    {
      ...base,
      frameId: 12,
      question: 'Does this information affect your answer to part (a)?',
      nearbyText: 'A current question followed by four choices.',
      answerControl: { kind: 'single_choice' },
      canAutoFill: true,
      canInsert: true,
      targetVisible: true,
      targetEmpty: true,
    },
  ]);
  assert.equal(selected?.frameId, 12);
});

test('merges every useful bound-tab frame with the selected answer frame first', () => {
  const shell = { ...base, frameId: 0, pageTitle: 'Course shell', pageText: 'Course directions and reference table.' };
  const question = {
    ...base,
    frameId: 7,
    pageTitle: 'Assignment Viewer',
    pageText: 'Current question and all answer choices.',
    pageUrl: 'https://tdx.pearson.test/player',
  };
  const merged = mergeFramePageContext([shell, question], question);
  assert.match(merged, /^FRAME: Assignment Viewer/);
  assert.match(merged, /Current question and all answer choices/);
  assert.match(merged, /Course directions and reference table/);
});

test('deduplicates frame text and excludes login or advertising frames', () => {
  const selected = { ...base, frameId: 4, pageTitle: 'Question', pageText: 'Same useful text' };
  const merged = mergeFramePageContext([
    selected,
    { ...base, frameId: 5, pageTitle: 'Duplicate', pageText: '  SAME   useful text ' },
    { ...base, frameId: 6, pageTitle: 'Ad', pageText: 'Buy now', pageUrl: 'https://doubleclick.test/ad' },
  ], selected);
  assert.equal((merged.match(/Same useful text/gi) || []).length, 1);
  assert.doesNotMatch(merged, /Buy now/);
});

test('bounds merged frame context', () => {
  const selected = { ...base, frameId: 1, pageTitle: 'Question', pageText: 'x'.repeat(100) };
  assert.equal(mergeFramePageContext([selected], selected, 60).length, 60);
});
