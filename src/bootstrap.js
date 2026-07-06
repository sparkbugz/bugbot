// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SparkBugz

import { loadConfig } from "./config.js";
import { BotStore } from "./store.js";
import { applyStoredSettings } from "./settings.js";

// Loads config, opens the shared store and brings the two into a consistent
// state. Both the bot process (src/index.js) and the panel process
// (src/panelMain.js) call this so either can start first; the seeding steps are
// idempotent, so running them from both processes is safe.
export function buildRuntime() {
    const config = loadConfig();
    const store = new BotStore(config.databasePath);

    // First run: import whatever the JSON files provided so an existing
    // deployment keeps its FAQ and moderation rules. After that the store is
    // authoritative and the admin panel edits it directly.
    store.seedFaqEntries(config.faqEntries);
    config.faqEntries = store.listFaqEntries();

    const fileModeration = config.moderationRules ?? {};
    store.seedModerationRules(fileModeration.rules ?? []);

    if (!store.getSetting("moderationGlobals")) {
        const { rules, ...globals } = fileModeration;
        store.setModerationGlobals(globals);
    }

    config.moderationRules = store.assembleModerationRules();

    // Custom commands live only in the store (there is no seed file for them).
    config.customCommands = store.listCustomCommands();

    // Overlay any admin-tuned settings saved in a previous run over the env
    // defaults.
    applyStoredSettings(config, store);

    return { config, store };
}
