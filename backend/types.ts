export type RouteMode = 'auto' | 'fast' | 'deep';
export type ModelLane = 'fast' | 'deep';

export type AnswerOption = {
  id: string;
  label: string;
};

export type AnswerControl = {
  kind: 'text' | 'single_choice' | 'single_select';
  options: AnswerOption[];
};

export type PageContext = {
  question: string;
  currentQuestion?: string;
  itemContext?: string;
  selection: string;
  nearbyText: string;
  pageText: string;
  fullPageContext?: string;
  pageTitle: string;
  pageUrl: string;
  answerControl: AnswerControl;
};

export type LayaRoute = {
  lane: ModelLane;
  choice: ModelLane;
  confidence: number;
  probabilities: Record<ModelLane, number>;
  contextChoice: 'question_only' | 'nearby' | 'page';
  contextConfidence: number;
  source: 'laya';
};

export type RouteDecision = {
  lane: ModelLane;
  confidence: number;
  source: 'laya' | 'heuristic' | 'manual';
  reason: string;
};
