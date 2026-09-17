/**
 * mtg-ask-bot Worker: handles Discord's /ask slash command, and a one-time
 * /register route for registering that command with Discord.
 *
 * No persistent bot process -- Discord calls this Worker over HTTP for
 * every interaction, and it answers questions itself via Workers AI
 * (Cloudflare's own model hosting), so there's no separate LLM API key to
 * manage. Every interaction request is a signed Discord payload (Ed25519),
 * verified below before anything else runs.
 *
 * Deliberately zero npm dependencies (Ed25519 verification and command
 * registration are both done with plain fetch/Web Crypto below) so the
 * whole file can be pasted directly into the Cloudflare dashboard's Worker
 * editor -- same deploy method as this repo's sibling project's
 * cloudflare-worker/relay.js -- with no `npm install` or `wrangler` CLI
 * needed.
 */

const AI_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

// Tonk Tonk's voice, matching the goblin-merchant persona already used
// for trade messages in archidekt-trading-app: broken/pidgin English,
// third-person self-reference, "yes?" tags, "quick quick" urgency,
// exclamation-heavy, occasional emoji. The persona is flavor only -- the
// MTG content underneath still has to be correct, so the "say when
// unsure" instruction is unconditional, not something the voice softens.
const SYSTEM_PROMPT = `You are Tonk Tonk, a goblin merchant character in \
this Magic: The Gathering playgroup's Discord server. Every response you \
write must be written ENTIRELY in Tonk Tonk's voice, from the very first \
word to the very last -- not a plain, neutral explanation with a bit of \
character sprinkled on top. If a sentence reads like it could've come \
from any generic assistant, rewrite it in voice before answering.

Tonk Tonk's voice: playful broken English, refers to himself in the \
third person ("Tonk Tonk think...", "Tonk Tonk say..."), upbeat merchant \
energy, "yes?" tags, "quick quick" for emphasis, occasional emoji, short \
punchy sentences with lots of exclamation points.

Example of the voice (match this style, don't reuse this exact wording):
"Ooh, good question! Deathtouch mean tiny scratch, big trouble, yes? Any \
damage from that creature enough to send other creature bye-bye -- don't \
need to hit hard, just need to touch! Tonk Tonk see many goblins forget \
that one."

The character is just flavor -- the Magic information itself must still \
be accurate. If you are not confident in an answer -- especially for a \
rules interaction you aren't sure about -- say so plainly, still fully in \
voice, rather than guessing, and suggest checking the Gatherer rulings or \
asking a judge. Never let the persona replace a real answer or make up a \
ruling to sound more colorful. Keep answers focused and readable in a \
Discord message.`;

// Discord's hard cap per message. Leave a little room for the "(truncated)" suffix.
const DISCORD_MESSAGE_LIMIT = 2000;

const INTERACTION_TYPE_PING = 1;
const INTERACTION_TYPE_APPLICATION_COMMAND = 2;
const RESPONSE_TYPE_PONG = 1;
const RESPONSE_TYPE_CHANNEL_MESSAGE_WITH_SOURCE = 4;
const RESPONSE_TYPE_DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE = 5;

const ASK_COMMAND = {
  name: 'ask',
  description: 'Ask a Magic: The Gathering rules or strategy question',
  options: [
    {
      type: 3, // STRING
      name: 'question',
      description: 'Your MTG question',
      required: true,
    },
  ],
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function truncateForDiscord(text) {
  if (text.length <= DISCORD_MESSAGE_LIMIT) return text;
  const suffix = '\n\n*(truncated)*';
  return text.slice(0, DISCORD_MESSAGE_LIMIT - suffix.length) + suffix;
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

// Discord signs every interaction request with the Application's Ed25519
// key (timestamp + raw body -> signature). Verifying this ourselves via
// Web Crypto (supported natively in the Workers runtime) avoids needing
// the `discord-interactions` npm package, which would require bundling.
async function verifyDiscordRequest(rawBody, signature, timestamp, publicKeyHex) {
  try {
    const publicKey = await crypto.subtle.importKey(
      'raw',
      hexToBytes(publicKeyHex),
      { name: 'ed25519', namedCurve: 'ed25519' },
      false,
      ['verify'],
    );
    const message = new TextEncoder().encode(timestamp + rawBody);
    return await crypto.subtle.verify('ed25519', publicKey, hexToBytes(signature), message);
  } catch (err) {
    console.error('Signature verification error:', err);
    return false;
  }
}

// Runs after the deferred response is already sent, so nothing here can
// affect Discord's initial 3-second budget. Always resolves -- an AI or
// network failure still gets turned into a follow-up message rather than
// leaving the interaction stuck on "Bot is thinking...".
async function answerAndFollowUp(interaction, question, env) {
  const followUpUrl = `https://discord.com/api/v10/webhooks/${env.DISCORD_APPLICATION_ID}/${interaction.token}/messages/@original`;

  let content;
  try {
    const aiResponse = await env.MTGAI.run(AI_MODEL, {
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

function handleAskCommand(interaction, env, ctx) {
  const question = interaction.data.options?.find((opt) => opt.name === 'question')?.value;
  if (!question) {
    return jsonResponse({
      type: RESPONSE_TYPE_CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: 'You need to ask a question! Try `/ask question: <your question>`.' },
    });
  }

  // Discord requires an initial response within 3 seconds; an LLM call
  // usually takes longer, so defer now and PATCH in the real answer once
  // Workers AI responds (ctx.waitUntil keeps the Worker alive for that).
  ctx.waitUntil(answerAndFollowUp(interaction, question, env));

  return jsonResponse({
    type: RESPONSE_TYPE_DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
  });
}

async function handleInteraction(request, env, ctx) {
  const signature = request.headers.get('x-signature-ed25519');
  const timestamp = request.headers.get('x-signature-timestamp');
  const body = await request.text();

  const isValidRequest = signature && timestamp && (await verifyDiscordRequest(body, signature, timestamp, env.DISCORD_PUBLIC_KEY));
  if (!isValidRequest) {
    return new Response('Bad request signature', { status: 401 });
  }

  const interaction = JSON.parse(body);

  if (interaction.type === INTERACTION_TYPE_PING) {
    return jsonResponse({ type: RESPONSE_TYPE_PONG });
  }

  if (interaction.type === INTERACTION_TYPE_APPLICATION_COMMAND) {
    if (interaction.data.name === 'ask') {
      return handleAskCommand(interaction, env, ctx);
    }
    return jsonResponse({
      type: RESPONSE_TYPE_CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: `Unknown command: ${interaction.data.name}` },
    });
  }

  return new Response('Unhandled interaction type', { status: 400 });
}

// One-time setup route: visit this URL in a browser (with the correct
// ?key=) to register the /ask command with Discord. Meant to replace
// running a local script, since deploying this Worker doesn't require a
// terminal at all -- see README.md.
async function handleRegister(request, env) {
  const url = new URL(request.url);
  if (!env.REGISTER_SECRET || url.searchParams.get('key') !== env.REGISTER_SECRET) {
    return new Response('Not authorized', { status: 401 });
  }
  if (!env.DISCORD_BOT_TOKEN) {
    return new Response('DISCORD_BOT_TOKEN is not set (Settings -> Variables and Secrets).', { status: 500 });
  }

  const registerUrl = env.DISCORD_GUILD_ID
    ? `https://discord.com/api/v10/applications/${env.DISCORD_APPLICATION_ID}/guilds/${env.DISCORD_GUILD_ID}/commands`
    : `https://discord.com/api/v10/applications/${env.DISCORD_APPLICATION_ID}/commands`;

  const discordResponse = await fetch(registerUrl, {
    method: 'PUT',
    headers: {
      Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify([ASK_COMMAND]),
  });

  const responseBody = await discordResponse.text();
  const scope = env.DISCORD_GUILD_ID ? `guild ${env.DISCORD_GUILD_ID}` : 'globally (can take up to an hour to propagate)';
  const message = discordResponse.ok
    ? `Registered /ask command ${scope}.\n\n${responseBody}`
    : `Registration failed (${discordResponse.status}):\n${responseBody}`;
  return new Response(message, { status: discordResponse.ok ? 200 : discordResponse.status });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/register') {
      return handleRegister(request, env);
    }

    if (request.method !== 'POST') {
      return new Response('Expected POST', { status: 405 });
    }

    return handleInteraction(request, env, ctx);
  },
};
