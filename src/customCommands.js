// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SparkBugz

// Custom commands (auto-responders): exact, explicit triggers, distinct from the
// fuzzy FAQ matcher. A member types the trigger and the bot posts the response.
// Kept pure and Discord-free so the matching is easy to test and reason about.
//
// Matching is done on a lightly normalized form — trimmed and lower-cased, but
// punctuation is preserved so a "!rules" style trigger still works. Full FAQ-style
// tokenization would be too loose for something meant to be an exact trigger.

export const MATCH_TYPES = ["exact", "starts", "contains"];

export function normalizeTrigger(value) {
    return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function matchType(command) {
    return MATCH_TYPES.includes(command.matchType) ? command.matchType : "exact";
}

function commandMatches(command, normalizedContent) {
    const trigger = normalizeTrigger(command.trigger);

    if (!trigger) {
        return false;
    }

    switch (matchType(command)) {
        case "starts": return normalizedContent.startsWith(trigger);
        case "contains": return normalizedContent.includes(trigger);
        default: return normalizedContent === trigger;
    }
}

// Returns the first enabled command that matches, preferring the earlier entry
// (they arrive in position order). Exact and starts-with commands are tried
// before contains ones so a broad "contains" rule never shadows a precise trigger.
export function matchCustomCommand(commands, content) {
    const normalizedContent = normalizeTrigger(content);

    if (!normalizedContent) {
        return null;
    }

    const enabled = (commands ?? []).filter((command) => command && command.enabled !== false);
    const precise = enabled.filter((command) => matchType(command) !== "contains");
    const loose = enabled.filter((command) => matchType(command) === "contains");

    for (const command of [...precise, ...loose]) {
        if (commandMatches(command, normalizedContent)) {
            return command;
        }
    }

    return null;
}
