// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SparkBugz

// Admin panel process. Serves the OAuth-protected web console and nothing else.
// It shares the store with the bot process (src/index.js) and reaches the bot
// only through it, so the panel stays up and reachable even when the bot is
// stopped — you can view and edit every setting and switch the bot back on.
// Actions that need the live gateway (unban, clear-timeout, post embed, add
// reaction) are queued for the bot and only run while it is online.

import { buildRuntime } from "./bootstrap.js";
import { PanelBot } from "./panelBot.js";
import { startAdminServer } from "./adminServer.js";

const { config, store } = buildRuntime();

if (!config.enableAdminDashboard) {
    console.log("Admin dashboard is disabled (enableAdminDashboard=false); nothing to serve.");
    process.exit(0);
}

const panel = new PanelBot(config, store);

startAdminServer(panel)
    .then(() => {
        console.log(`Admin dashboard listening at ${config.adminWebPublicUrl}/`);
    })
    .catch((error) => {
        console.error("Admin panel failed to start:", error);
        process.exitCode = 1;
    });
