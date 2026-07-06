// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SparkBugz

// Bot process. Runs the Discord gateway, the scheduler and the moderation
// pipeline. It shares the store with the admin panel process (src/panelMain.js)
// but does not serve the panel itself — stopping this process leaves the panel
// running, and vice versa.

import { buildRuntime } from "./bootstrap.js";
import { DiscordFaqBot } from "./bot.js";

const { config, store } = buildRuntime();
const bot = new DiscordFaqBot(config, { store });

bot.start().catch((error) => {
    console.error("Discord FAQ bot failed to start:", error);
    process.exitCode = 1;
});
