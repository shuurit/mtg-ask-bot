/**
 * mtg-ask-bot Worker: handles Discord's /ask slash command.
 *
 * No persistent bot process -- Discord calls this Worker over HTTP for
 * every interaction, and it answers questions itself via Workers AI
 * (Cloudflare's own model hosting), so there's no separate LLM API key to
 * manage. Every request is a signed Discord interaction (Ed25519), verified
 * below before anything else runs.
 */
const { verifyKey, InteractionType, InteractionResponseType } = require('discord-interactions');

const AI_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

const SYSTEM_PROMPT = `You are a Magic: The Gathering rules and strategy \
assistant for a casual Commander/EDH playgroup. Answer questions about \
card interactions, rules, and strategy clearly and concisely. If you are \
not confident in an answer -- especially for a rules interaction you \
aren't sure about -- say so explicitly rather than guessing, and suggest \
checking the Gatherer rulings or asking a judge. Keep answers focused and \
readable in a Discord message.`;

// Discord's hard cap per message. Leave a little room for the "(truncated)" suffix.
const DISCORD_MESSAGE_LIMIT = 2000;

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
  });
}

function truncateForDiscord(text) {
  if (text.length <= DISCORD_MESSAGE_LIMIT) return text;
  const suffix = '\n\n*(truncated)*';
  return text.slice(0, DISCORD_MESSAGE_LIMIT - suffix.length) + suffix;
}

// Runs after the deferred response is already sent, so nothing here can
// affect Discord's initial 3-second budget. Always resolves -- an AI or
// network failure still gets turned into a follow-up message rather than
// leaving the interaction stuck on "Bot is thinking...".
async function answerAndFollowUp(interaction, question, env) {
  const followUpUrl = `https://discord.com/api/v10/webhooks/${env.DISCORD_APPLICATION_ID}/${interaction.token}/messages/@original`;

  let content;
  try {
    const aiResponse = await env.AI.run(AI_MODEL, {
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: question },
      ],
    });
    const answer = aiResponse.response?.trim();
    content = answer ? truncateForDiscord(answer) : "I didn't get a usable answer back -- try rephrasing the question.";
  } catch (err) {
    console.error('Workers AI call failed:', err);
    content = 'Something went wrong answering that -- try again in a bit.';
  }

  const patchResponse = await fetch(followUpUrl, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  if (!patchResponse.ok) {
    console.error('Follow-up PATCH failed:', patchResponse.status, await patchResponse.text());
  }
}

async function handleAskCommand(interaction, env, ctx) {
  const question = interaction.data.options?.find((opt) => opt.name === 'question')?.value;
  if (!question) {
    return jsonResponse({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: 'You need to ask a question! Try `/ask question: <your question>`.' },
    });
  }

  // Discord requires an initial response within 3 seconds; an LLM call
  // usually takes longer, so defer now and PATCH in the real answer once
  // Workers AI responds (ctx.waitUntil keeps the Worker alive for that).
  ctx.waitUntil(answerAndFollowUp(interaction, question, env));

  return jsonResponse({
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
  });
}

module.exports = {
  async fetch(request, env, ctx) {
    if (request.method !== 'POST') {
      return new Response('Expected POST', { status: 405 });
    }

    const signature = request.headers.get('x-signature-ed25519');
    const timestamp = request.headers.get('x-signature-timestamp');
    const body = await request.text();

    const isValidRequest = signature && timestamp && (await verifyKey(body, signature, timestamp, env.DISCORD_PUBLIC_KEY));
    if (!isValidRequest) {
      return new Response('Bad request signature', { status: 401 });
    }

    const interaction = JSON.parse(body);

    if (interaction.type === InteractionType.PING) {
      return jsonResponse({ type: InteractionResponseType.PONG });
    }

    if (interaction.type === InteractionType.APPLICATION_COMMAND) {
      if (interaction.data.name === 'ask') {
        return handleAskCommand(interaction, env, ctx);
      }
      return jsonResponse({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: `Unknown command: ${interaction.data.name}` },
      });
    }

    return new Response('Unhandled interaction type', { status: 400 });
  },
};
