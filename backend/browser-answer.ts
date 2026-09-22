import type { AnswerControl } from './types.js';

export type BrowserAnswer = {
  answer: string;
  optionId: string;
  confidence: number;
  explanation: string;
};

export function browserAnswerSchema(control: AnswerControl): Record<string, unknown> {
  const optionIds = control.kind !== 'text' ? control.options.map(({ id }) => id) : [''];
  return {
    type: 'object',
    properties: {
      answer: { type: 'string' },
      optionId: { type: 'string', enum: optionIds.length ? optionIds : [''] },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      explanation: { type: 'string' },
    },
    required: ['answer', 'optionId', 'confidence', 'explanation'],
    additionalProperties: false,
  };
}

export function parseBrowserAnswer(value: string, control: AnswerControl): BrowserAnswer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('The model did not return a structured browser answer. Nothing was inserted.');
  }
  const source = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  if (
    typeof source.answer !== 'string' ||
    typeof source.optionId !== 'string' ||
    typeof source.explanation !== 'string' ||
    typeof source.confidence !== 'number' ||
    !Number.isFinite(source.confidence) ||
    source.confidence < 0 ||
    source.confidence > 1
  ) {
    throw new Error('The structured browser answer was invalid. Nothing was inserted.');
  }
  let answer = source.answer.trim();
  let optionId = '';
  if (control.kind !== 'text') {
    const selected = control.options.find(({ id }) => id === source.optionId);
    if (!selected) throw new Error('The model returned an unknown answer option. Nothing was selected.');
    optionId = selected.id;
    answer = selected.label;
  } else if (source.optionId !== '') {
    throw new Error('The model returned a choice for a text field. Nothing was inserted.');
  }
  if (!answer || answer.length > 500 || (control.kind === 'text' && answer.includes('\n'))) {
    throw new Error('The model did not return one exact field value. Nothing was inserted.');
  }
  return {
    answer,
    optionId,
    confidence: source.confidence,
    explanation: source.explanation.trim().slice(0, 8_000),
  };
}
