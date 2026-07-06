// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SparkBugz

// Poll building, kept pure and Discord-free. A poll is just a message plus the
// reaction emojis to seed on it; votes are counted live from Discord's reaction
// counts, so nothing needs to be stored.

export const NUMBER_EMOJIS = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];

// Options come in as a single string; accept comma- or pipe-separated, trim, drop
// blanks, and cap at ten (the number of keycap emojis available).
export function parsePollOptions(raw) {
    return String(raw ?? "")
        .split(/\s*[|,]\s*/)
        .map((option) => option.trim())
        .filter(Boolean)
        .slice(0, 10);
}

// With no options this is a yes/no poll; otherwise each option gets a numbered
// reaction. Returns the message content and the emojis to react with, in order.
export function buildPoll(question, options) {
    if (options.length === 0) {
        return { content: [`📊 ${question}`, "", "👍 Yes", "👎 No"].join("\n"), emojis: ["👍", "👎"] };
    }

    const emojis = NUMBER_EMOJIS.slice(0, options.length);
    const lines = options.map((option, index) => `${emojis[index]} ${option}`);
    return { content: [`📊 ${question}`, "", ...lines].join("\n"), emojis };
}
