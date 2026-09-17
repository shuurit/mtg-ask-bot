# mtg-ask-bot

A Discord slash command, `/ask`, that lets people in the playgroup server
ask Magic: The Gathering questions and get an AI-generated answer. No
persistent bot process -- Discord calls a Cloudflare Worker over HTTP
whenever someone uses the command, and the Worker calls Cloudflare Workers
AI directly, so there's no separate LLM API key to manage or pay for.

## How it works

1. Someone types `/ask question: <their question>` in the server.
2. Discord sends that interaction as an HTTP POST to the Worker
   (`worker.js`).
3. The Worker verifies the request is really signed by Discord (Ed25519,
   via the Workers runtime's built-in Web Crypto -- no npm package needed)
   before doing anything else.
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

- `worker.js` -- the whole Worker, one file, zero npm dependencies:
  signature verification, PING handling, `/ask` command handling, deferred
  response, Workers AI call, follow-up `PATCH`, error handling if the AI
  call fails, and a `GET /register` route for the one-time command
  registration step (see Setup). No dependencies means the whole file can
  be pasted straight into the Cloudflare dashboard's Worker editor --
  same deploy method `archidekt-trading-app`'s Cloudflare Worker and
  `mtg-pod-validator`'s `cloudflare-worker/relay.js` both use.
- `wrangler.toml` -- Worker config, only needed if you deploy with the
  `wrangler` CLI instead of the dashboard (see Setup below for both
  paths). `DISCORD_APPLICATION_ID` and `DISCORD_PUBLIC_KEY` are plain vars,
  safe to commit -- the sensitive credentials (`DISCORD_BOT_TOKEN`,
  `REGISTER_SECRET`) are never in this file, only set as Worker secrets.

## Setup

Everything below is doable from a browser -- Cloudflare dashboard and
Discord Developer Portal -- no terminal, no `npm`/`wrangler` CLI required.
(If you do have a terminal later, `wrangler.toml` plus `npm run deploy` /
`wrangler secret put` is a drop-in alternative to steps 2-3 below.)

### 1. Re-invite Tonk Tonk with the `applications.commands` scope

[Discord Developer Portal](https://discord.com/developers/applications) ->
Tonk Tonk -> **OAuth2 -> URL Generator** -> scopes: `bot` **and**
`applications.commands` (leave permissions as they already are -- this
doesn't need anything beyond what's already granted) -> open the generated
URL and go through the invite flow again for the same server. This adds
the missing scope without removing or resetting anything about the bot's
existing membership, roles, or permissions there.

### 2. Create the Worker in the Cloudflare dashboard

1. [dash.cloudflare.com](https://dash.cloudflare.com) -> **Workers &
   Pages** -> **Create** -> **Worker** -> name it (e.g. `mtg-ask-bot`) ->
   **Deploy** (this creates a placeholder "Hello World" Worker).
2. **Edit code** -> select everything in the editor, delete it, paste in
   the full contents of `worker.js` from this repo -> **Save and Deploy**.
3. **Settings -> Variables and Secrets** -> add these as **Text**
   variables:
   - `DISCORD_APPLICATION_ID` = `1537979428133670962` (Tonk Tonk's
     Application ID)
   - `DISCORD_PUBLIC_KEY` = Developer Portal -> Tonk Tonk -> **General
     Information** -> **Public Key** (never generated/copied before now,
     since nothing needed it until this)
   - `DISCORD_GUILD_ID` (optional) = the playgroup server's ID (enable
     Developer Mode in Discord's settings, then right-click the server
     icon -> Copy Server ID). Set this while testing, for instant
     registration; remove it later to register the command globally
     instead (takes up to an hour to propagate).

   Add these as **Secret** variables (Cloudflare encrypts these; they're
   never visible again after saving, only replaceable):
   - `DISCORD_BOT_TOKEN` = Tonk Tonk's existing bot token. If you still
     have the value you set as `archidekt-trading-app`'s
     `DISCORD_BOT_TOKEN` secret, reuse it as-is -- using it here doesn't
     change or invalidate it. If you don't have it saved anywhere
     (Cloudflare doesn't let you read a secret back once set, in the
     dashboard or via the CLI), you'll need to reset it (Developer Portal
     -> Tonk Tonk -> **Bot** -> **Reset Token**) -- but that invalidates
     the old token everywhere, so you'd also need to update it in
     `archidekt-trading-app`'s own dashboard secrets (both the main Pages
     project and its `want-match-cron` worker), or Tonk Tonk's
     DMs/channel-posting there stops working until you do.
   - `REGISTER_SECRET` = any password you make up yourself (e.g. generate
     one at [1Password](https://1password.com/password-generator) or
     similar). This just gates the registration step below so a stranger
     who finds the Worker's URL can't re-register a different command.
4. **Save and Deploy** to apply the variables.
5. **Settings -> Bindings** -> **Add** -> **Workers AI** -> variable name
   exactly `MTGAI` -> **Save and Deploy**.
6. Copy the Worker's `*.workers.dev` URL, shown at the top of the Worker's
   dashboard page.

### 3. Set the Interactions Endpoint URL

Developer Portal -> Tonk Tonk -> **General Information** -> **Interactions
Endpoint URL** -> paste the Worker URL from step 2.6 -> Save. Discord
immediately sends a test `PING` to verify it -- if `worker.js` is deployed
correctly and `DISCORD_PUBLIC_KEY` is right, this succeeds right away.
(This field was empty before -- Tonk Tonk never had one set -- so this
doesn't override anything.)

### 4. Register the `/ask` command

Visit this URL in your browser once (substitute your actual Worker URL
and the `REGISTER_SECRET` you picked in step 2.3):

```
https://mtg-ask-bot.<your-subdomain>.workers.dev/register?key=<REGISTER_SECRET>
```

You should see a page starting with "Registered /ask command...". That's
it -- no need to visit it again unless the command definition in
`worker.js` (`ASK_COMMAND`) changes later.

### 5. Test it

In the playgroup server, type `/ask question: What does deathtouch do?`
and confirm you get a "Bot is thinking..." followed by a real answer.

## Model

Defaults to `@cf/meta/llama-3.3-70b-instruct-fp8-fast` (set in `AI_MODEL`
in `worker.js`). For faster/cheaper responses at some quality cost, swap
in `@cf/meta/llama-3.1-8b-instruct-fp8` (edit `worker.js` in the dashboard
-> Save and Deploy).

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
