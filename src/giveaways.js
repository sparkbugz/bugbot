// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SparkBugz

// Giveaway winner selection, kept pure so the randomness is injectable and the
// draw is testable. The bot passes the list of entrant user ids (everyone who
// reacted, minus bots) and how many winners to pick.

// Clamps a requested winner count to a sane range.
export function normalizeWinnerCount(value) {
    const count = Math.trunc(Number(value));
    return Number.isFinite(count) && count > 0 ? Math.min(count, 20) : 1;
}

// Picks up to `count` distinct winners with a Fisher–Yates shuffle. `random` is
// injectable for deterministic tests; it defaults to Math.random at call time.
export function pickWinners(entrants, count = 1, random = Math.random) {
    const pool = [...new Set(entrants)].filter(Boolean);
    const winners = Math.min(normalizeWinnerCount(count), pool.length);

    for (let index = pool.length - 1; index > 0; index -= 1) {
        const swap = Math.floor(random() * (index + 1));
        [pool[index], pool[swap]] = [pool[swap], pool[index]];
    }

    return pool.slice(0, winners);
}

export function buildGiveawayAnnouncement(prize, durationText, winners) {
    return [
        "🎉 **Giveaway** 🎉",
        `**${prize}**`,
        `React with 🎉 to enter. Ends in ${durationText}. Winners: ${winners}.`
    ].join("\n");
}

export function buildGiveawayResult(prize, winnerIds) {
    if (winnerIds.length === 0) {
        return `🎉 Giveaway ended — **${prize}**\nNo valid entries, so there is no winner.`;
    }

    const mentions = winnerIds.map((id) => `<@${id}>`).join(", ");
    return `🎉 Giveaway ended — **${prize}**\nCongratulations ${mentions}!`;
}
