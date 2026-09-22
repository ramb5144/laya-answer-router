import type { ModelLane, PageContext, RouteDecision, RouteMode } from './types.js';

const DEEP_PATTERNS = [
  /\b(prove|proof|derive|debug|diagnose|analy[sz]e|evaluate|compare|synthesize)\b/i,
  /\b(architecture|trade-?offs?|multi-?step|root cause|counterexample)\b/i,
  /\b(legal|medical|financial|security|privacy)\b/i,
  /\bwhy\b.+\bwhy\b/i,
];

export function fallbackRoute(context: PageContext): RouteDecision {
  const combined = `${context.currentQuestion || context.question}\n${context.itemContext || ''}\n${context.nearbyText}\n${context.fullPageContext || context.pageText}`.slice(0, 12_000);
  const complex = combined.length > 1_200 || DEEP_PATTERNS.some((pattern) => pattern.test(combined));
  return {
    lane: complex ? 'deep' : 'fast',
    confidence: complex ? 0.72 : 0.68,
    source: 'heuristic',
    reason: complex ? 'Complexity guard selected the stronger lane.' : 'Short, direct question selected the fast lane.',
  };
}

export function manualRoute(mode: Exclude<RouteMode, 'auto'>): RouteDecision {
  return {
    lane: mode,
    confidence: 1,
    source: 'manual',
    reason: `The ${mode} lane was selected in the side panel.`,
  };
}

export function chooseLane(choice: ModelLane, probabilities: Record<ModelLane, number>): ModelLane {
  // A near-tie favors the stronger model. This keeps uncertain routing from
  // trading correctness for a small latency win.
  return choice === 'deep' || probabilities.deep >= 0.46 ? 'deep' : 'fast';
}
