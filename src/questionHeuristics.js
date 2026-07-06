// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SparkBugz

import { normalizeText, tokenize } from "./text.js";

// Gate for the "no FAQ matched, should I bother searching GitHub?" path. The
// goal is to answer genuine asks for help without jumping in every time someone
// merely name-drops an issue or pastes a link, which gets annoying fast.

const LEADING_QUESTION_PATTERNS = [
    /^(how|what|why|where|when|who|which)\b/,
    /^(can|could|would|should|do|does|did|is|are|was|were|will)\b/,
    /^(any(one|body) know|does any(one|body) know)\b/,
    /^(help|please help|need help|stuck)\b/
];

// Words that signal someone is actually blocked, not just chatting.
const HELP_TERMS = new Set([
    "help", "issue", "issues", "error", "errors", "problem", "problems", "stuck",
    "broken", "failing", "failed", "fails", "crash", "crashing", "cannot", "unable",
    "wrong", "bug", "doesnt", "wont", "cant"
]);

// Phrases that mark a message as a passing reference rather than a request. If
// one of these appears without a real question signal, we stay quiet.
const REFERENCE_PHRASES = [
    "see ", "related to", "similar to", "like the", "same as", "reminds me",
    "fyi", "for reference", "as mentioned", "already reported", "duplicate of"
];

function looksLikeReferenceOnly(normalized) {
    return REFERENCE_PHRASES.some((phrase) => normalized.includes(phrase));
}

// True when the message reads like a real request for help. A trailing `?`,
// an interrogative opener, or an explicit trouble word all count — but a bare
// reference to something (with no question and no trouble word) does not.
export function isLikelyQuestion(content) {
    const raw = String(content ?? "").trim();

    if (!raw) {
        return false;
    }

    const normalized = normalizeText(raw);
    const tokens = tokenize(normalized);

    // Too short to carry a searchable question ("ok?", "why", a lone link).
    if (tokens.length < 3) {
        return false;
    }

    const hasQuestionMark = raw.includes("?");
    const hasInterrogativeOpener = LEADING_QUESTION_PATTERNS.some((pattern) => pattern.test(normalized));
    const hasHelpTerm = tokens.some((token) => HELP_TERMS.has(token));

    if (!hasQuestionMark && !hasInterrogativeOpener && !hasHelpTerm) {
        return false;
    }

    // A reference-flavoured statement only counts if it is explicitly phrased as
    // a question; otherwise treat it as someone pointing at prior work.
    if (looksLikeReferenceOnly(normalized) && !hasQuestionMark && !hasInterrogativeOpener) {
        return false;
    }

    return true;
}
