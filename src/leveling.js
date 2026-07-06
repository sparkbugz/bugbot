// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SparkBugz

// XP / level maths, kept pure and separate from Discord so it is easy to test.
// The curve matches the familiar MEE6/ProBot shape: each level costs a bit more
// than the last, so early levels come quickly and later ones are a grind.

// XP to go from `level` to the next one.
export function xpForNextLevel(level) {
    return (5 * level * level) + (50 * level) + 100;
}

// Total XP accumulated to sit exactly at `level`.
export function totalXpForLevel(level) {
    let total = 0;

    for (let current = 0; current < level; current += 1) {
        total += xpForNextLevel(current);
    }

    return total;
}

export function levelFromXp(xp) {
    let level = 0;

    while (totalXpForLevel(level + 1) <= xp) {
        level += 1;
    }

    return level;
}

// Everything the UI needs to draw a progress bar: current level, XP into the
// level, and XP the level spans.
export function levelProgress(xp) {
    const level = levelFromXp(xp);
    const base = totalXpForLevel(level);
    const next = totalXpForLevel(level + 1);

    return { level, xp, into: xp - base, needed: next - base };
}

// Parses the admin "level:roleId" reward lines into a lookup, keeping the
// highest role for a given level if duplicated.
export function parseLevelRoles(pairs) {
    const map = new Map();

    for (const pair of pairs ?? []) {
        const [level, roleId] = String(pair).split(":");

        if (/^\d+$/.test(level) && /^\d{5,25}$/.test(roleId ?? "")) {
            map.set(Number(level), roleId);
        }
    }

    return map;
}
