import test from "node:test";
import assert from "node:assert/strict";
import { findBestFaqMatch, scoreFaqEntry } from "../src/faqMatcher.js";

test("scoreFaqEntry strongly matches direct phrase hits", () => {
    const entry = {
        enabled: true,
        match: {
            anyPhrases: ["how do i reset my password"]
        }
    };

    const score = scoreFaqEntry(entry, "How do I reset my password for the portal?");
    assert.ok(score >= 0.9);
});

test("scoreFaqEntry matches simple FAQ question fields", () => {
    const entry = {
        question: "How do I reset my password?",
        answer: "Use the account settings reset flow."
    };

    const score = scoreFaqEntry(entry, "Password reset is not working for my account.");
    assert.ok(score >= 0.72);
});

test("scoreFaqEntry matches complete all-terms combinations", () => {
    const entry = {
        enabled: true,
        match: {
            allTerms: ["oauth", "callback", "error"]
        }
    };

    const score = scoreFaqEntry(entry, "I keep seeing an OAuth callback error during login.");
    assert.ok(score >= 0.8);
});

test("findBestFaqMatch returns the highest scoring entry above threshold", () => {
    const entries = [
        {
            id: "build",
            enabled: true,
            match: {
                anyPhrases: ["build is stuck"]
            }
        },
        {
            id: "login",
            enabled: true,
            match: {
                anyPhrases: ["cannot log in"]
            }
        }
    ];

    const match = findBestFaqMatch(entries, "Our build is stuck again in CI.", 0.72);
    assert.equal(match?.entry.id, "build");
});
