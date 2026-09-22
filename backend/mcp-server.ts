import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';
import { McpRelayClient, type RelayAnswer } from './mcp-relay-client.js';
import type { PageContext, RouteMode } from './types.js';

const server = new McpServer({ name: 'laya-answer-router', version: '0.4.0' });

server.registerTool(
  'laya_get_current_page',
  {
    description: 'Read the latest page context captured by the Laya Chrome side panel. Use this instead of browser automation when the user refers to the current website.',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async () => runTool(async (client) => {
    const snapshot = await client.getCurrentPage();
    return JSON.stringify(snapshot, null, 2);
  }),
);

server.registerTool(
  'laya_answer_current_page',
  {
    description: 'Answer a question from the latest page captured by the Laya Chrome side panel. Laya chooses the fast or deep model unless mode is overridden. This does not click, type, or submit anything on the website.',
    inputSchema: {
      question: z.string().max(8_000).optional().describe('Question to answer. If omitted, use the question detected on the page.'),
      mode: z.enum(['auto', 'fast', 'deep']).default('auto').describe('Auto lets Laya route the question.'),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ question, mode }) => runTool(async (client) => {
    const snapshot = await client.getCurrentPage();
    const resolvedQuestion = question?.trim() || snapshot.context.question.trim();
    if (!resolvedQuestion) throw new Error('No question was captured. Pass the question explicitly or refresh the Laya Chrome side panel.');
    return formatAnswer(await client.answer({ ...snapshot.context, question: resolvedQuestion }, mode));
  }),
);

server.registerTool(
  'laya_answer_question',
  {
    description: 'Route and answer a question through local Laya, optionally with website text supplied by Claude. Use this when no current Chrome page snapshot is needed.',
    inputSchema: {
      question: z.string().min(1).max(8_000).describe('Question to route and answer.'),
      websiteContext: z.string().max(26_000).optional().describe('Relevant website text, if available.'),
      pageTitle: z.string().max(500).optional(),
      pageUrl: z.string().max(2_000).optional(),
      mode: z.enum(['auto', 'fast', 'deep']).default('auto').describe('Auto lets Laya route the question.'),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ question, websiteContext, pageTitle, pageUrl, mode }) => runTool(async (client) => {
    const context: PageContext = {
      question,
      selection: '',
      nearbyText: websiteContext || '',
      pageText: '',
      pageTitle: pageTitle || 'Context supplied by Claude',
      pageUrl: pageUrl || '',
      answerControl: { kind: 'text', options: [] },
    };
    return formatAnswer(await client.answer(context, mode as RouteMode));
  }),
);

async function runTool(operation: (client: McpRelayClient) => Promise<string>) {
  try {
    const text = await operation(new McpRelayClient());
    return { content: [{ type: 'text' as const, text }] };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The Laya relay request failed.';
    return { isError: true, content: [{ type: 'text' as const, text: message }] };
  }
}

function formatAnswer(result: RelayAnswer): string {
  return [
    result.answer,
    '',
    `Route: ${result.route.lane} via ${result.route.source} (${Math.round(result.route.confidence * 100)}%)`,
    `Model: ${result.model}`,
  ].join('\n');
}

const transport = new StdioServerTransport();
await server.connect(transport);
