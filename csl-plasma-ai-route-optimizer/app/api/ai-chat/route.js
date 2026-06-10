import { buildContextForAiChat, buildFallbackChatResponse } from '../../../lib/aiChatContext.js';
import { buildAiChatSystemPrompt, buildAiChatUserPrompt } from '../../../lib/aiChatPrompts.js';
import { suggestedFollowups } from '../../../lib/aiChatTools.js';

function safeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((message) => ['user', 'assistant', 'system'].includes(message?.role) && typeof message.content === 'string')
    .slice(-12)
    .map((message) => ({ role: message.role, content: message.content.slice(0, 4000) }));
}

function extractText(data) {
  return data.output_text || data.output?.flatMap((item) => item.content || []).map((content) => content.text || '').join('') || '';
}

function fallbackWarningForOpenAiError(err) {
  const message = String(err?.message || '');
  if (/unsupported parameter|unsupported.*parameter|does not support/i.test(message)) {
    return 'AI model request failed because the configured model does not support one of the request parameters. The app returned a deterministic data-grounded fallback answer.';
  }
  return `AI request failed; returned deterministic app-data answer. ${message}`;
}

export async function GET() {
  const configured = Boolean(process.env.OPENAI_API_KEY);
  return Response.json({
    configured,
    model: configured ? (process.env.OPENAI_MODEL || 'gpt-5.5') : '',
    message: configured ? 'AI assistant is configured' : 'OPENAI_API_KEY is missing'
  });
}

export async function POST(req) {
  try {
    const body = await req.json();
    const messages = safeMessages(body.messages);
    const context = buildContextForAiChat({ ...body, messages });

    if (!process.env.OPENAI_API_KEY) {
      return Response.json(
        buildFallbackChatResponse(context, 'OPENAI_API_KEY is not configured. Add OPENAI_API_KEY and OPENAI_MODEL on the server to enable AI-authored answers.'),
        { status: 503 }
      );
    }

    try {
      const res = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
        },
        body: JSON.stringify({
          model: process.env.OPENAI_MODEL || 'gpt-5.5',
          input: [
            { role: 'system', content: buildAiChatSystemPrompt() },
            { role: 'user', content: buildAiChatUserPrompt({ messages, context }) }
          ]
        })
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || `OpenAI request failed with ${res.status}`);
      const answer = extractText(data).trim();
      if (!answer) throw new Error('OpenAI returned an empty answer.');

      return Response.json({
        answer,
        dataUsed: context.dataUsed || [],
        warnings: context.warnings || [],
        suggestedFollowups: suggestedFollowups(context),
        source: 'openai'
      });
    } catch (err) {
      return Response.json(buildFallbackChatResponse(context, fallbackWarningForOpenAiError(err)));
    }
  } catch (err) {
    return Response.json({
      answer: 'The AI Assistant could not process that request. Please try again with a route, invoice, fuel audit, KPI, or optimization question.',
      dataUsed: [],
      warnings: [err.message],
      suggestedFollowups: ['Summarize the invoice audit findings.', 'Explain PHILLY.', 'What does the fuel surcharge audit show?'],
      source: 'deterministic-fallback'
    }, { status: 400 });
  }
}
