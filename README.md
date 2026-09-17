# mtg-ask-bot

A Discord slash command, `/ask`, that lets people in the playgroup server
ask Magic: The Gathering questions and get an AI-generated answer. No
persistent bot process -- Discord calls a Cloudflare Worker over HTTP
whenever someone uses the command, and the Worker calls Cloudflare Workers
AI directly, so there's no separate LLM API key to manage or pay for.

## How it works

1. Someone types `/ask question: <their question>` in the server.
2. Discord sends that interaction as an HTTP POST to the Worker
   (`src/index.js`).
3. The Worker verifies the request is really signed by Discord (Ed25519,
   via the `discord-interactions` package) before doing anything else.
4. It immediately returns a **deferred** response (Discord shows "Bot is
   thinking..."), because Discord requires an initial response within 3
   seconds and an LLM call is usually slower than that.
5. In the background (`ctx.waitUntil`), it calls Workers AI with the
   question, using a system prompt that frames it as an MTG rules/strategy
   assistant for a playgroup and tells it to say when it's not confident
   rather than guess.
6. It then `PATCH`es the deferred message with the real answer (via
   Discord's follow-up webhook endpoint), truncated to fit Discord's
   2000-character message cap if needed.

## Why a new Discord Application instead of reusing an existing bot

The playgroup's other Discord automation (`fnm-poll`,
`magic-card-of-the-day`) posts entirely through channel **webhooks** --
there's no Discord Application or bot token behind either of them, just a
webhook URL each script `POST`s to. A slash command needs an actual
Application (for its ID/public key, used to verify incoming requests) with
a bot user (for the token used to register the command) and a configured
**Interactions Endpoint URL** that Discord POSTs to -- none of that exists
yet anywhere in the playgroup's setup. So this isn't a case of reusing vs.
recreating an existing bot; it's creating the first one. One new Discord
Application, used only for `/ask`, is the natural choice -- see Setup
below.

## Repo layout

- `src/index.js` -- the Worker: signature verification, PING handling,
  `/ask` command handling, deferred response, Workers AI call, follow-up
  `PATCH`, error handling if the AI call fails.
- `register-commands.js` -- one-off local script (`npm run register`) that
  registers the `/ask` command with Discord. Guild-scoped (instant) if
  `DISCORD_GUILD_ID` is set, global (up to an hour to propagate) if not.
- `wrangler.toml` -- Worker config: the `AI` binding for Workers AI, plus
  `DISCORD_APPLICATION_ID` and `DISCORD_PUBLIC_KEY` as plain vars. Both are
  safe to commit -- the only actually sensitive credential is the bot
  token, and that never goes into the Worker at all, only into
  `register-commands.js`'s local `.env`.

## Setup

### 1. Create the Discord Application

1. [Discord Developer Portal](https://discord.com/developers/applications)
   -> **New Application** -> name it (e.g. "MTG Ask Bot").
2. **General Information** tab -> copy the **Application ID** and
   **Public Key** -- these go into `wrangler.toml`.
3. **Bot** tab -> **Reset Token** -> copy the token -- this goes into
   `.env` (step 3 below), never into `wrangler.toml` or anywhere committed.
   Treat it as a secret: regenerate it immediately if it's ever exposed.
4. **OAuth2 -> URL Generator** -> scopes: `bot` and `applications.commands`
   -> no bot permissions are needed beyond the default (the bot only
   responds to the slash command, it doesn't need to send messages any
   other way) -> open the generated URL and invite it to the playgroup
   server.

### 2. Deploy the Worker

```bash
npm install
npx wrangler login
```

Fill in `wrangler.toml`:

- `account_id` -- Cloudflare dashboard sidebar, or `npx wrangler whoami`.
- `DISCORD_APPLICATION_ID` / `DISCORD_PUBLIC_KEY` -- from step 1.2 above.

```bash
npm run deploy
```

Copy the deployed `*.workers.dev` URL from the output.

### 3. Set the Interactions Endpoint URL

Discord Developer Portal -> your app -> **General Information** ->
**Interactions Endpoint URL** -> paste the Worker URL from step 2 -> Save.
Discord immediately sends a test `PING` to verify it -- if `src/index.js`
is deployed correctly, this succeeds right away.

### 4. Register the `/ask` command

```bash
cp .env.example .env
```

Fill in `.env`:

- `DISCORD_APPLICATION_ID` -- same as `wrangler.toml`.
- `DISCORD_BOT_TOKEN` -- from step 1.3 above.
- `DISCORD_GUILD_ID` (optional) -- the playgroup server's ID (enable
  Developer Mode in Discord settings, then right-click the server icon ->
  Copy Server ID). Set this while testing for instant registration; leave
  it unset once everything works to register the command globally.

```bash
npm run register
```

### 5. Test it

In the playgroup server, type `/ask question: What does deathtouch do?`
and confirm you get a "Bot is thinking..." followed by a real answer.

### Local development

```bash
npm run dev
```

Runs the Worker locally via `wrangler dev`. Testing interactions end to
end still requires a publicly reachable URL for Discord to POST to (e.g. a
temporary tunnel pointed at the local dev server), since Discord doesn't
send interactions to `localhost`.

## Model

Defaults to `@cf/meta/llama-3.3-70b-instruct-fp8-fast` (set in
`AI_MODEL` in `src/index.js`). For faster/cheaper responses at some
quality cost, swap in `@cf/meta/llama-3.1-8b-instruct-fp8`.

This rides entirely on Cloudflare's free tiers -- Workers' free request
allowance plus Workers AI's 10,000 free Neurons/day -- which should
comfortably cover casual playgroup usage without needing a paid plan.

## Explicitly out of scope for this pass

- **Rules-grounding / RAG.** Right now the model answers from its own
  training, with no real card text or comprehensive-rules lookup behind
  it. Pulling live card data from Scryfall, or indexing the comprehensive
  rules via Cloudflare Vectorize, is the natural next step once this base
  version is working -- not built yet.
- **Message-content / mention-based triggering** (e.g. "@bot what's..."
  in a regular message). That needs Discord's privileged Message Content
  intent, which is a separate decision -- for now, `/ask` is the only way
  to reach the bot.
