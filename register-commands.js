#!/usr/bin/env node
// One-off script: registers (or updates) the /ask slash command with Discord.
// Run manually after deploying the Worker, and again any time the command
// definition below changes.
//
// Usage:
//   node register-commands.js
//
// Reads DISCORD_APPLICATION_ID, DISCORD_BOT_TOKEN, and (optionally)
// DISCORD_GUILD_ID from .env. With DISCORD_GUILD_ID set, the command is
// registered to that one server only -- guild commands update instantly,
// which is what you want while testing. Without it, the command is
// registered globally (all servers the bot is in), which can take up to an
// hour to propagate -- switch to this once things work.

require('dotenv').config();

const APPLICATION_ID = process.env.DISCORD_APPLICATION_ID;
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID = process.env.DISCORD_GUILD_ID;

if (!APPLICATION_ID || !BOT_TOKEN) {
  console.error('Missing DISCORD_APPLICATION_ID or DISCORD_BOT_TOKEN in .env -- see .env.example.');
  process.exit(1);
}

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

async function registerCommands() {
  const url = GUILD_ID
    ? `https://discord.com/api/v10/applications/${APPLICATION_ID}/guilds/${GUILD_ID}/commands`
    : `https://discord.com/api/v10/applications/${APPLICATION_ID}/commands`;

  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bot ${BOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify([ASK_COMMAND]),
  });

  if (!response.ok) {
    console.error(`Command registration failed: ${response.status} ${response.statusText}`);
    console.error(await response.text());
    process.exit(1);
  }

  const scope = GUILD_ID ? `guild ${GUILD_ID}` : 'globally (can take up to an hour to propagate)';
  console.log(`Registered /ask command ${scope}.`);
}

registerCommands();
