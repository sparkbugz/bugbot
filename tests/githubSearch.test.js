import test from "node:test";
import assert from "node:assert/strict";
import { formatGitHubItem, GitHubSearchClient } from "../src/githubSearch.js";

test("formatGitHubItem formats issues and pull requests", () => {
    const item = {
        number: 42,
        title: "Fix OAuth callback error",
        html_url: "https://github.com/example/repo/pull/42",
        pull_request: {}
    };

    assert.equal(
        formatGitHubItem(item),
        "PR #42: Fix OAuth callback error\nhttps://github.com/example/repo/pull/42"
    );
});

test("GitHubSearchClient returns the best match above the score threshold", async () => {
    const fetchImpl = async () => ({
        ok: true,
        async json() {
            return {
                items: [
                    {
                        number: 10,
                        title: "Build is stuck in CI after dependency refresh",
                        body: "Pipeline blocks during npm install",
                        html_url: "https://github.com/example/repo/issues/10"
                    },
                    {
                        number: 11,
                        title: "Unrelated UI spacing issue",
                        body: "Padding is off in settings",
                        html_url: "https://github.com/example/repo/issues/11"
                    }
                ]
            };
        }
    });

    const client = new GitHubSearchClient({
        fetchImpl,
        defaultRepos: ["example/repo"],
        cacheTtlMs: 1000
    });

    const result = await client.search({
        query: "build stuck in ci",
        minScore: 0.5
    });

    assert.equal(result?.number, 10);
});

test("GitHubSearchClient limits query size and per-repo result count", async () => {
    let searchUrl = null;
    const fetchImpl = async (url) => {
        searchUrl = url;

        return {
            ok: true,
            async json() {
                return { items: [] };
            }
        };
    };

    const client = new GitHubSearchClient({
        fetchImpl,
        defaultRepos: ["example/repo"],
        maxQueryLength: 12,
        requestTimeoutMs: 1000
    });

    await client.search({
        query: "this is a very long message that should not be sent in full",
        perRepoLimit: 100
    });

    assert.equal(searchUrl.searchParams.get("per_page"), "10");
    assert.ok(searchUrl.searchParams.get("q").startsWith("this is a ve"));
});

test("GitHubSearchClient treats failed repo searches as no match", async () => {
    const fetchImpl = async () => ({
        ok: false,
        status: 403,
        async text() {
            return "rate limited";
        }
    });

    const client = new GitHubSearchClient({
        fetchImpl,
        defaultRepos: ["example/repo"],
        requestTimeoutMs: 1000
    });

    const result = await client.search({
        query: "oauth callback error"
    });

    assert.equal(result, null);
});
