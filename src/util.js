// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SparkBugz

// Small parsing and collection helpers shared by config, matching, and moderation.
// Kept in one place so the same rules apply everywhere (and so env parsing is
// not copy-pasted between the bot and the config-check script).

export function parseCsv(value) {
    return String(value ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
}

export function asArray(value) {
    if (Array.isArray(value)) {
        return value;
    }

    return value === undefined || value === null || value === "" ? [] : [value];
}

export function unique(values) {
    return [...new Set(values)];
}

export function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

export function parseBoolean(value, defaultValue) {
    if (value === undefined || value === null || value === "") {
        return defaultValue;
    }

    return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

export function parseNumber(value, defaultValue) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : defaultValue;
}

export function parseInteger(value, defaultValue) {
    const parsed = Number(value);
    return Number.isInteger(parsed) ? parsed : defaultValue;
}

export function parsePositiveNumber(value, defaultValue) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

// Match thresholds and scores are ratios in (0, 1]. Anything outside that range
// falls back to the default so a stray 0 or negative can never turn a threshold
// into "match everything".
export function parseRatio(value, defaultValue) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 && parsed <= 1 ? parsed : defaultValue;
}

// A UTC calendar-day key (YYYY-MM-DD) for a date. Analytics buckets by UTC day
// so the trend lines up regardless of where the host or the viewer sits.
export function dayKey(date = new Date()) {
    return date.toISOString().slice(0, 10);
}

// The last `n` UTC day keys ending today, oldest first — the x-axis for a trend
// chart, used to zero-fill days with no recorded activity.
export function lastNDays(n, from = new Date()) {
    const days = [];

    for (let offset = n - 1; offset >= 0; offset -= 1) {
        const day = new Date(from);
        day.setUTCDate(day.getUTCDate() - offset);
        days.push(dayKey(day));
    }

    return days;
}

// Rejects regular-expression sources that are cheap to write but can pin the
// event loop through catastrophic backtracking (the classic `(a+)+` shapes).
// FAQ and moderation patterns come from admin-authored config, so this is
// defence in depth rather than a hard security boundary.
export function isSafeRegexSource(source, maxLength = 200) {
    const text = String(source ?? "");

    if (!text || text.length > maxLength) {
        return false;
    }

    // A quantified group whose interior is itself quantified: (…+…)+ / (…*…)* etc.
    if (/\([^)]*[+*{][^)]*\)\s*[+*{]/.test(text)) {
        return false;
    }

    try {
        // eslint-disable-next-line no-new
        new RegExp(text);
        return true;
    } catch {
        return false;
    }
}
