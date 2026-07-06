// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SparkBugz

// Fills the {placeholder} tokens used in welcome/goodbye messages. Kept tiny and
// pure so it is trivial to test and reuse. Unknown tokens are left untouched so a
// typo is visible rather than silently blanked.

const TOKEN = /\{(\w+)\}/g;

export function renderTemplate(template, values) {
    return String(template ?? "").replace(TOKEN, (whole, key) => (
        Object.prototype.hasOwnProperty.call(values, key) ? String(values[key] ?? "") : whole
    ));
}

// Builds the token values for a guild member join/leave message.
export function memberContext(member) {
    const user = member?.user ?? member ?? {};
    const guild = member?.guild ?? {};

    return {
        user: user.username ?? member?.displayName ?? "someone",
        tag: user.tag ?? user.username ?? "someone",
        mention: user.id ? `<@${user.id}>` : (user.username ?? "someone"),
        server: guild.name ?? "the server",
        count: guild.memberCount ?? "?"
    };
}

export const TEMPLATE_TOKENS = "{user}, {mention}, {tag}, {server}, {count}";
