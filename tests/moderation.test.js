import test from "node:test";
import assert from "node:assert/strict";
import {
    analyzeModerationMessage,
    clampBanDeleteSeconds,
    extractUrls,
    parseDurationMs,
    parseUserId
} from "../src/moderation.js";

function baseConfig(overrides = {}) {
    return {
        enableModeration: true,
        moderationRules: { rules: [] },
        moderationDefaultAction: "timeout",
        moderationDefaultTimeoutSeconds: 3600,
        moderationMaxScanLength: 4000,
        ...overrides
    };
}

function makeMessage(content, mentions = {}) {
    return {
        content,
        mentions: {
            users: mentions.users ?? new Map(),
            roles: mentions.roles ?? new Map(),
            everyone: mentions.everyone ?? false
        }
    };
}

test("extractUrls handles normal, bare, and defanged URLs", () => {
    const urls = extractUrls("visit https://one.example/path and bad[.]example and www.three.example");

    assert.deepEqual(urls.map((url) => url.hostname), [
        "one.example",
        "bad.example",
        "www.three.example"
    ]);
});

test("analyzeModerationMessage bans configured wallet copy-paste scams", () => {
    const finding = analyzeModerationMessage(
        makeMessage("Connect your wallet to claim https://drain.example"),
        baseConfig({
            moderationRules: {
                rules: [
                    {
                        id: "wallet-drainer",
                        action: "ban",
                        match: {
                            requireUrl: true,
                            anyPhrases: ["connect your wallet to claim"]
                        }
                    }
                ]
            }
        })
    );

    assert.equal(finding.action, "ban");
    assert.equal(finding.deleteMessage, true);
    assert.match(finding.reason, /wallet-drainer/);
});

test("analyzeModerationMessage flags suspicious Discord lookalike links", () => {
    const finding = analyzeModerationMessage(
        makeMessage("free nitro claim https://discord-gift.example"),
        baseConfig()
    );

    assert.equal(finding.action, "ban");
    assert.equal(finding.findings[0].type, "discord-lookalike");
});

test("analyzeModerationMessage flags explicit blocked domains", () => {
    const finding = analyzeModerationMessage(
        makeMessage("check this https://sub.wallet-drainer.example/path"),
        baseConfig({
            moderationRules: {
                blockedDomains: ["wallet-drainer.example"]
            }
        })
    );

    assert.equal(finding.action, "ban");
    assert.equal(finding.findings[0].type, "blocked-domain");
});

test("analyzeModerationMessage flags mention spam", () => {
    const finding = analyzeModerationMessage(
        makeMessage("hello all", {
            users: new Map(Array.from({ length: 9 }, (_, index) => [String(index), {}]))
        }),
        baseConfig({
            moderationRules: {
                maxMentions: 8
            }
        })
    );

    assert.equal(finding.action, "timeout");
    assert.equal(finding.findings[0].type, "mention-spam");
});

test("parseDurationMs accepts Discord timeout-sized durations", () => {
    assert.equal(parseDurationMs("10m"), 10 * 60 * 1000);
    assert.equal(parseDurationMs("2w"), 14 * 24 * 60 * 60 * 1000);
    assert.equal(parseDurationMs("29d"), null);
});

test("parseUserId accepts mentions and raw IDs", () => {
    assert.equal(parseUserId("<@123456789012345678>"), "123456789012345678");
    assert.equal(parseUserId("123456789012345678"), "123456789012345678");
    assert.equal(parseUserId("nobody"), null);
});

test("clampBanDeleteSeconds caps Discord ban message deletion window", () => {
    assert.equal(clampBanDeleteSeconds(999999999), 7 * 24 * 60 * 60);
    assert.equal(clampBanDeleteSeconds(-1), 0);
});
