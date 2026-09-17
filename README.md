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

## Reusing Tonk Tonk instead of a new Discord Application

The playgroup's other Discord automation (`fnm-poll`,
`magic-card-of-the-day`) posts entirely through channel **webhooks** --
there's no Discord Application behind either of them. But
`archidekt-trading-app` has one: **Tonk Tonk** (Application ID
`1537979428133670962`), which already has a bot user (`DISCORD_BOT_TOKEN`,
used for trade-event DMs and the admin "Post to Discord" tool) and is
already invited to the shared server. `/ask` reuses that same Application
instead of creating a new one -- one less bot in the member list, same
voice/identity.

Two things that setup needs to account for, since Tonk Tonk was never
previously wired for slash commands:

- **It has no Interactions Endpoint URL configured yet.** Tonk Tonk's
  existing features (OAuth login, DMs, channel posts) are all outbound
  REST calls or user-initiated OAuth -- nothing before this needed Discord
  to POST *to* it. Setting the Interactions Endpoint URL (Setup step 2
  below) is additive and doesn't touch any of that.
- **It was invited with only the `bot` scope, not `applications.commands`**
  (see `archidekt-trading-app/cloudflare-worker/README.md`). A slash
  command won't register into a guild the bot doesn't have that scope in,
  so re-inviting with both scopes (Setup step 1 below) is required even
  though the bot is already in the server -- this is additive too, it
  doesn't remove or reset anything about the bot's existing membership or
  permissions.

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

### 1. Re-invite Tonk Tonk with the `applications.commands` scope

[Discord Developer Portal](https://discord.com/developers/applications) ->
Tonk Tonk -> **OAuth2 -> URL Generator** -> scopes: `bot` **and**
`applications.commands` (leave permissions as they already are -- this
doesn't need anything beyond what's already granted) -> open the generated
URL and go through the invite flow again for the same server. This adds
the missing scope without removing or resetting anything about the bot's
existing membership, roles, or permissions there.

### 2. Deploy the Worker

```bash
npm install
npx wrangler login
```

Fill in `wrangler.toml`:

- `account_id` -- Cloudflare dashboard sidebar, or `npx wrangler whoami`.
- `DISCORD_APPLICATION_ID` -- already filled in (`1537979428133670962`,
  Tonk Tonk's Application ID).
- `DISCORD_PUBLIC_KEY` -- Developer Portal -> Tonk Tonk -> **General
  Information** -> **Public Key**. Never generated/copied before now since
  nothing needed it until this.

```bash
npm run deploy
```

Copy the deployed `*.workers.dev` URL from the output.

### 3. Set the Interactions Endpoint URL

Developer Portal -> Tonk Tonk -> **General Information** -> **Interactions
Endpoint URL** -> paste the Worker URL from step 2 -> Save. Discord
immediately sends a test `PING` to verify it -- if `src/index.js` is
deployed correctly and `DISCORD_PUBLIC_KEY` is right, this succeeds right
away. (This field was empty before -- Tonk Tonk never had one set -- so
this doesn't override anything.)

### 4. Register the `/ask` command

```bash
cp .env.example .env
```

Fill in `.env`:

- `DISCORD_APPLICATION_ID` -- same as `wrangler.toml`
  (`1537979428133670962`).
- `DISCORD_BOT_TOKEN` -- Tonk Tonk's existing bot token. If you still have
  the value you set as `archidekt-trading-app`'s `DISCORD_BOT_TOKEN`
  secret, reuse it as-is -- registering a command with it doesn't change
  or invalidate it. If you don't have it saved anywhere (`wrangler secret
  put` doesn't let you read a secret back once set), you'll need to reset
  it (Developer Portal -> Tonk Tonk -> **Bot** -> **Reset Token**) -- but
  that invalidates the old token everywhere, so you'd also need to update
  it via `wrangler secret put DISCORD_BOT_TOKEN` in **both**
  `archidekt-trading-app` (the main Pages project) and its
  `want-match-cron` worker, or Tonk Tonk's DMs/channel-posting there stops
  working until you do.
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
