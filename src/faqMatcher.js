// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SparkBugz

import { normalizeText, overlapRatio, tokenize, uniqueTokens } from "./text.js";
import { asArray, isSafeRegexSource } from "./util.js";

// Common English filler that carries no topic signal. Dropped before token
// overlap so "how do I reset my password" and "password reset broken" line up
// on the words that actually matter (reset, password).
const STOP_WORDS = new Set([
    "a", "an", "and", "are", "can", "do", "does", "for", "how", "i", "in", "is",
    "it", "my", "of", "on", "or", "the", "to", "what", "when", "where", "why", "with"
]);

// A phrase substring hit is treated as a near-certain match; token overlap is
// graded so a strong-but-inexact overlap still clears the default threshold
// while a weak one stays well below it.
const PHRASE_EXACT_SCORE = 0.96;
const PHRASE_STRONG_SCORE = 0.9;
const PHRASE_PARTIAL_SCORE = 0.74;
const STRONG_OVERLAP = 0.8;
const PARTIAL_OVERLAP = 0.55;

function meaningfulTokens(value) {
    return tokenize(value).filter((token) => !STOP_WORDS.has(token));
}

function getFaqQuestions(entry) {
    return [
        ...asArray(entry.question),
        ...asArray(entry.questions),
        ...asArray(entry.title)
    ];
}

// Flattens the several shorthand shapes an entry may use (top-level `triggers`,
// `keywords`, `question`/`questions`, or a nested `match` object) into one
// normalized matcher config.
function getMatchConfig(entry) {
    const match = entry.match ?? {};

    return {
        anyPhrases: [
            ...asArray(match.anyPhrases),
            ...asArray(match.phrases),
            ...asArray(entry.triggers),
            ...asArray(entry.aliases),
            ...getFaqQuestions(entry)
        ],
        allTerms: asArray(match.allTerms),
        anyTerms: [
            ...asArray(match.anyTerms),
            ...asArray(entry.keywords)
        ],
        regex: asArray(match.regex),
        excludeTerms: asArray(match.excludeTerms)
    };
}

function regexMatches(patterns, content) {
    return patterns.some((pattern) => {
        if (!isSafeRegexSource(pattern)) {
            return false;
        }

        return new RegExp(pattern, "i").test(content);
    });
}

function phraseScore(phrases, normalizedMessage, messageTokens) {
    const meaningfulMessageTokens = messageTokens.filter((token) => !STOP_WORDS.has(token));
    let bestOverlap = 0;

    for (const phrase of phrases) {
        const normalizedPhrase = normalizeText(phrase);

        if (!normalizedPhrase) {
            continue;
        }

        if (normalizedMessage.includes(normalizedPhrase)) {
            return PHRASE_EXACT_SCORE;
        }

        const phraseTokens = meaningfulTokens(normalizedPhrase);
        const useMeaningful = phraseTokens.length > 0;
        const sourceTokens = useMeaningful ? phraseTokens : tokenize(normalizedPhrase);
        const targetTokens = useMeaningful ? meaningfulMessageTokens : messageTokens;

        bestOverlap = Math.max(bestOverlap, overlapRatio(sourceTokens, targetTokens));
    }

    if (bestOverlap >= STRONG_OVERLAP) {
        return PHRASE_STRONG_SCORE;
    }

    if (bestOverlap >= PARTIAL_OVERLAP) {
        return PHRASE_PARTIAL_SCORE;
    }

    return 0;
}

function allTermsScore(terms, messageTokenSet) {
    const normalizedTerms = terms.map(normalizeText).filter(Boolean);

    if (normalizedTerms.length === 0) {
        return 0;
    }

    const hitRatio = normalizedTerms.filter((term) => messageTokenSet.has(term)).length
        / normalizedTerms.length;

    if (hitRatio === 1) {
        return 0.84;
    }

    return hitRatio >= 0.8 ? 0.7 : 0;
}

function anyTermsScore(terms, messageTokenSet) {
    const normalizedTerms = terms.map(normalizeText).filter(Boolean);

    if (normalizedTerms.length === 0) {
        return 0;
    }

    const hits = normalizedTerms.filter((term) => messageTokenSet.has(term)).length;

    if (hits === 0) {
        return 0;
    }

    return 0.45 + ((hits / normalizedTerms.length) * 0.25);
}

function hasExcludedTerms(excludeTerms, normalizedMessage) {
    return excludeTerms
        .map(normalizeText)
        .filter(Boolean)
        .some((term) => normalizedMessage.includes(term));
}

export function scoreFaqEntry(entry, messageContent) {
    if (!entry || entry.enabled === false) {
        return 0;
    }

    const normalizedMessage = normalizeText(messageContent);

    if (!normalizedMessage) {
        return 0;
    }

    const match = getMatchConfig(entry);

    if (hasExcludedTerms(match.excludeTerms, normalizedMessage)) {
        return 0;
    }

    if (regexMatches(match.regex, messageContent)) {
        return 1;
    }

    const messageTokens = tokenize(normalizedMessage);
    const messageTokenSet = uniqueTokens(normalizedMessage);

    return Math.max(
        phraseScore(match.anyPhrases, normalizedMessage, messageTokens),
        allTermsScore(match.allTerms, messageTokenSet),
        anyTermsScore(match.anyTerms, messageTokenSet),
        0
    );
}

export function findBestFaqMatch(entries, messageContent, threshold = 0.72) {
    let bestMatch = null;

    for (const entry of entries) {
        const score = scoreFaqEntry(entry, messageContent);

        if (score >= threshold && (!bestMatch || score > bestMatch.score)) {
            bestMatch = { entry, score };
        }
    }

    return bestMatch;
}
