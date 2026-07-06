// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SparkBugz

import { normalizeText, overlapRatio, tokenize } from "./text.js";
import { clamp } from "./util.js";

const GITHUB_SEARCH_URL = "https://api.github.com/search/issues";

function buildHeaders(token) {
    const headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": "discord-bugbot"
    };

    if (token) {
        headers["Authorization"] = `Bearer ${token}`;
    }

    return headers;
}

function classifyItem(item) {
    return item.pull_request ? "PR" : "Issue";
}

// Title is the strong relevance signal for an issue/PR; the body only nudges the
// score upward for a title that already half-matches, and can never drag it down.
// Keeping it monotonic means "more overlap is never worse", which is easy to reason
// about when tuning the match threshold.
function scoreGitHubItem(item, queryTokens) {
    const titleScore = overlapRatio(queryTokens, tokenize(item.title));
    const bodyScore = overlapRatio(queryTokens, tokenize(item.body ?? ""));

    return titleScore + (bodyScore * (1 - titleScore) * 0.25);
}

export function formatGitHubItem(item) {
    return `${classifyItem(item)} #${item.number}: ${item.title}\n${item.html_url}`;
}

function normalizeSearchType(type) {
    return ["issues", "prs", "both"].includes(type) ? type : "both";
}

function buildSearchUrl(repo, searchType, query, perPage) {
    const url = new URL(GITHUB_SEARCH_URL);
    const qualifiers = [`repo:${repo}`];

    if (searchType === "issues") {
        qualifiers.push("is:issue");
    } else if (searchType === "prs") {
        qualifiers.push("is:pr");
    }

    url.searchParams.set("q", `${query} ${qualifiers.join(" ")}`.trim());
    url.searchParams.set("per_page", String(perPage));
    url.searchParams.set("sort", "updated");
    url.searchParams.set("order", "desc");

    return url;
}

async function fetchRepoSearchResults(fetchImpl, headers, repo, searchType, query, perPage, timeoutMs) {
    const url = buildSearchUrl(repo, searchType, query, perPage);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetchImpl(url, { headers, signal: controller.signal });

        if (!response.ok) {
            const body = await response.text();
            throw new Error(`GitHub search failed for ${repo}: ${response.status} ${body}`);
        }

        const payload = await response.json();
        return payload.items ?? [];
    } finally {
        clearTimeout(timeout);
    }
}

// Bounded, TTL'd result cache. GitHub's search API is rate limited, so repeated
// questions in a busy channel should not each cost a round trip — but the cache
// must not grow without bound either, so it evicts the oldest entry once full
// (a simple LRU: reading or writing a key moves it to the most-recent position).
class SearchCache {
    constructor(ttlMs, maxEntries) {
        this.ttlMs = ttlMs;
        this.maxEntries = maxEntries;
        this.entries = new Map();
    }

    get(key) {
        const entry = this.entries.get(key);

        if (!entry) {
            return undefined;
        }

        if (entry.expiresAt <= Date.now()) {
            this.entries.delete(key);
            return undefined;
        }

        this.entries.delete(key);
        this.entries.set(key, entry);
        return entry.value;
    }

    set(key, value) {
        this.entries.delete(key);

        if (this.entries.size >= this.maxEntries) {
            const oldestKey = this.entries.keys().next().value;
            this.entries.delete(oldestKey);
        }

        this.entries.set(key, { value, expiresAt: Date.now() + this.ttlMs });
    }
}

export class GitHubSearchClient {
    constructor({
        token,
        defaultRepos = [],
        cacheTtlMs = 10 * 60 * 1000,
        cacheMaxEntries = 500,
        fetchImpl = globalThis.fetch,
        maxQueryLength = 256,
        requestTimeoutMs = 8000
    } = {}) {
        this.token = token;
        this.defaultRepos = defaultRepos;
        this.fetchImpl = fetchImpl;
        this.maxQueryLength = maxQueryLength;
        this.requestTimeoutMs = requestTimeoutMs;
        this.cache = new SearchCache(cacheTtlMs, cacheMaxEntries);
    }

    async search({
        query,
        repos = this.defaultRepos,
        type = "both",
        minScore = 0.63,
        perRepoLimit = 5
    }) {
        const normalizedQuery = normalizeText(query).slice(0, this.maxQueryLength).trim();
        const perRepo = clamp(Math.trunc(Number(perRepoLimit) || 5), 1, 10);

        if (!normalizedQuery || repos.length === 0) {
            return null;
        }

        const searchType = normalizeSearchType(type);
        const cacheKey = JSON.stringify({ normalizedQuery, repos, searchType, perRepo });
        const cached = this.cache.get(cacheKey);

        if (cached !== undefined) {
            return cached;
        }

        const headers = buildHeaders(this.token);
        const queryTokens = tokenize(normalizedQuery);

        // Repos are searched in parallel — one slow or rate-limited repo should not
        // serialize the others and blow past the per-question latency budget.
        const perRepoResults = await Promise.all(
            repos.map((repo) => fetchRepoSearchResults(
                this.fetchImpl, headers, repo, searchType, normalizedQuery, perRepo, this.requestTimeoutMs
            ).catch((error) => {
                console.warn(`GitHub search skipped for ${repo}: ${error.message}`);
                return [];
            }))
        );

        let bestMatch = null;

        for (let index = 0; index < repos.length; index += 1) {
            for (const item of perRepoResults[index]) {
                const matchScore = scoreGitHubItem(item, queryTokens);

                if (matchScore >= minScore && (!bestMatch || matchScore > bestMatch.matchScore)) {
                    bestMatch = { ...item, repo: repos[index], matchScore };
                }
            }
        }

        this.cache.set(cacheKey, bestMatch);
        return bestMatch;
    }
}
