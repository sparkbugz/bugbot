// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SparkBugz

import { normalizeText, tokenize } from "./text.js";
import { asArray, isSafeRegexSource } from "./util.js";

const URL_PATTERN = /\b(?:https?:\/\/|hxxps?:\/\/|www\.)[^\s<>()]+|\b[a-z0-9-]+(?:(?:\[[.]\]|\.)[a-z0-9-]+)+(?:\/[^\s<>()]*)?/gi;
const ALLOWED_DISCORD_HOSTS = new Set([
    "discord.com",
    "discord.gg",
    "discordapp.com",
    "cdn.discordapp.com"
]);
const RISKY_TLDS = new Set(["zip", "mov", "click", "top", "xyz", "icu", "quest", "rest"]);
const SCAM_TERMS = [
    "airdrop",
    "claim",
    "connect wallet",
    "free nitro",
    "giveaway",
    "mint",
    "presale",
    "seed phrase",
    "verify wallet"
];
const ACTIONS = new Set(["log", "delete", "warn", "timeout", "kick", "ban"]);

function normalizeHost(host) {
    return String(host ?? "")
        .toLowerCase()
        .replace(/^\.+|\.+$/g, "");
}

export function extractUrls(content) {
    return [...String(content ?? "").matchAll(URL_PATTERN)]
        .map((match) => {
            const raw = match[0].replaceAll("[.]", ".");
            const withScheme = raw.replace(/^hxxp/i, "http").replace(/^www\./i, "https://www.");

            try {
                return new URL(withScheme.includes("://") ? withScheme : `https://${withScheme}`);
            } catch {
                return null;
            }
        })
        .filter(Boolean);
}

function getDomainMatches(urls, blockedDomains) {
    const blocked = asArray(blockedDomains).map(normalizeHost).filter(Boolean);

    return urls
        .map((url) => normalizeHost(url.hostname))
        .filter((host) => blocked.some((domain) => host === domain || host.endsWith(`.${domain}`)));
}

function phraseMatches(phrases, normalizedContent) {
    return asArray(phrases)
        .map(normalizeText)
        .filter(Boolean)
        .some((phrase) => normalizedContent.includes(phrase));
}

function allTermsMatch(terms, tokenSet) {
    const normalizedTerms = asArray(terms).map(normalizeText).filter(Boolean);

    return normalizedTerms.length > 0 && normalizedTerms.every((term) => tokenSet.has(term));
}

function anyTermsMatch(terms, tokenSet) {
    return asArray(terms)
        .map(normalizeText)
        .filter(Boolean)
        .some((term) => tokenSet.has(term));
}

function regexMatches(patterns, content) {
    return asArray(patterns).some((pattern) => {
        if (!isSafeRegexSource(pattern, 300)) {
            return false;
        }

        return new RegExp(pattern, "i").test(content);
    });
}

function ruleMatches(rule, content, normalizedContent, tokenSet, urls) {
    const match = rule.match ?? {};

    if (match.requireUrl && urls.length === 0) {
        return false;
    }

    return (
        phraseMatches(match.anyPhrases ?? match.phrases, normalizedContent) ||
        allTermsMatch(match.allTerms, tokenSet) ||
        anyTermsMatch(match.anyTerms, tokenSet) ||
        regexMatches(match.regex, content)
    );
}

function normalizeAction(value, fallback) {
    const action = String(value || fallback || "log").toLowerCase();

    return ACTIONS.has(action) ? action : "log";
}

function buildFinding({
    action,
    deleteMessage,
    reason,
    ruleId,
    timeoutSeconds,
    findings
}, config) {
    const normalizedAction = normalizeAction(action, config.moderationDefaultAction);

    return {
        action: normalizedAction,
        deleteMessage: Boolean(deleteMessage ?? normalizedAction !== "log"),
        findings,
        reason: ruleId ? `${ruleId}: ${reason}` : reason,
        timeoutMs: Math.max(
            1,
            Number(timeoutSeconds ?? config.moderationDefaultTimeoutSeconds)
        ) * 1000
    };
}

function countMentions(message) {
    const users = message.mentions?.users?.size ?? 0;
    const roles = message.mentions?.roles?.size ?? 0;
    const everyone = message.mentions?.everyone ? 1 : 0;

    return users + roles + everyone;
}

function isDiscordLookalike(host) {
    if (ALLOWED_DISCORD_HOSTS.has(host)) {
        return false;
    }

    return host.includes("discord") || host.includes("nitro");
}

function isRiskyTld(host) {
    const parts = host.split(".");
    const tld = parts[parts.length - 1];

    return RISKY_TLDS.has(tld);
}

export function summarizeFindings(findings) {
    return findings
        .map((finding) => finding.detail ? `${finding.type}: ${finding.detail}` : finding.type)
        .join(", ");
}

export function clampBanDeleteSeconds(value) {
    const seconds = Number(value);

    if (!Number.isFinite(seconds) || seconds < 0) {
        return 0;
    }

    return Math.min(Math.floor(seconds), 7 * 24 * 60 * 60);
}

export function parseUserId(rawUser) {
    return String(rawUser ?? "").match(/\d{5,25}/)?.[0] ?? null;
}

export function parseDurationMs(rawDuration) {
    const match = String(rawDuration ?? "").trim().match(/^(\d+)([smhdw])$/i);

    if (!match) {
        return null;
    }

    const value = Number(match[1]);
    const unit = match[2].toLowerCase();
    const multiplier = {
        s: 1000,
        m: 60 * 1000,
        h: 60 * 60 * 1000,
        d: 24 * 60 * 60 * 1000,
        w: 7 * 24 * 60 * 60 * 1000
    }[unit];
    const duration = value * multiplier;
    const maxTimeout = 28 * 24 * 60 * 60 * 1000;

    if (!Number.isFinite(duration) || duration <= 0 || duration > maxTimeout) {
        return null;
    }

    return duration;
}

export function analyzeModerationMessage(message, config) {
    if (!config.enableModeration) {
        return null;
    }

    const content = String(message.content ?? "").slice(0, config.moderationMaxScanLength);
    const normalizedContent = normalizeText(content);

    if (!normalizedContent) {
        return null;
    }

    const tokenSet = new Set(tokenize(normalizedContent));
    const urls = extractUrls(content);
    const rules = config.moderationRules ?? {};
    const configuredRules = asArray(rules.rules);

    for (const rule of configuredRules) {
        if (!rule || rule.enabled === false) {
            continue;
        }

        if (ruleMatches(rule, content, normalizedContent, tokenSet, urls)) {
            return buildFinding({
                action: rule.action,
                deleteMessage: rule.deleteMessage,
                findings: [{ type: "rule", detail: rule.id || "configured-rule" }],
                reason: rule.reason || "configured moderation rule matched",
                ruleId: rule.id,
                timeoutSeconds: rule.timeoutSeconds
            }, config);
        }
    }

    const blockedDomainMatches = getDomainMatches(urls, rules.blockedDomains);

    if (blockedDomainMatches.length > 0) {
        return buildFinding({
            action: rules.blockedDomainAction || "ban",
            deleteMessage: true,
            findings: [{ type: "blocked-domain", detail: blockedDomainMatches[0] }],
            reason: "blocked domain link"
        }, config);
    }

    const lookalike = urls
        .map((url) => normalizeHost(url.hostname))
        .find((host) => isDiscordLookalike(host));

    if (lookalike && phraseMatches(["free nitro", "claim", "gift", "airdrop"], normalizedContent)) {
        return buildFinding({
            action: rules.lookalikeDomainAction || "ban",
            deleteMessage: true,
            findings: [{ type: "discord-lookalike", detail: lookalike }],
            reason: "Discord/Nitro lookalike scam link"
        }, config);
    }

    if (
        urls.length > 0 &&
        phraseMatches(["connect wallet", "seed phrase", "verify wallet"], normalizedContent) &&
        phraseMatches(["airdrop", "claim", "reward", "mint", "token"], normalizedContent)
    ) {
        return buildFinding({
            action: rules.walletScamAction || "ban",
            deleteMessage: true,
            findings: [{ type: "wallet-scam", detail: urls[0].hostname }],
            reason: "wallet/seed phrase bait with link"
        }, config);
    }

    const riskyHost = urls
        .map((url) => normalizeHost(url.hostname))
        .find((host) => isRiskyTld(host));

    if (riskyHost && phraseMatches(SCAM_TERMS, normalizedContent)) {
        return buildFinding({
            action: rules.riskyTldAction || "timeout",
            deleteMessage: true,
            findings: [{ type: "risky-tld", detail: riskyHost }],
            reason: "risky TLD paired with scam terms"
        }, config);
    }

    const mentionCount = countMentions(message);
    const maxMentions = Number(rules.maxMentions ?? 8);

    if (Number.isFinite(maxMentions) && maxMentions > 0 && mentionCount >= maxMentions) {
        return buildFinding({
            action: rules.mentionSpamAction || "timeout",
            deleteMessage: true,
            findings: [{ type: "mention-spam", detail: String(mentionCount) }],
            reason: "mention spam"
        }, config);
    }

    return null;
}
