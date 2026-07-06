// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SparkBugz

export function normalizeText(value) {
    return String(value ?? "")
        .toLowerCase()
        .replace(/[`'"!?.,:;()[\]{}<>/@\\|*_#+=-]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

export function tokenize(value) {
    const normalized = normalizeText(value);

    if (!normalized) {
        return [];
    }

    return normalized
        .split(" ")
        .filter((token) => token.length > 1);
}

export function uniqueTokens(value) {
    return new Set(tokenize(value));
}

export function overlapRatio(sourceTokens, targetTokens) {
    if (sourceTokens.length === 0) {
        return 0;
    }

    const targetSet = new Set(targetTokens);
    let overlap = 0;

    for (const token of sourceTokens) {
        if (targetSet.has(token)) {
            overlap += 1;
        }
    }

    return overlap / sourceTokens.length;
}
