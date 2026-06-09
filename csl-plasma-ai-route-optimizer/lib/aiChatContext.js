import { buildAiChatContext, deterministicAnswer, suggestedFollowups } from './aiChatTools.js';

export function buildContextForAiChat(input = {}) {
  const messages = Array.isArray(input.messages) ? input.messages : [];
  const latestUserMessage = messages.filter((message) => message?.role === 'user').at(-1)?.content || '';
  return buildAiChatContext({
    question: latestUserMessage,
    routeName: input.routeName || '',
    mode: input.mode || ''
  });
}

export function buildFallbackChatResponse(context, extraWarning = '') {
  return {
    answer: deterministicAnswer(context),
    dataUsed: context.dataUsed || [],
    warnings: [...(context.warnings || []), extraWarning].filter(Boolean),
    suggestedFollowups: suggestedFollowups(context)
  };
}
