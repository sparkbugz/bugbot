import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PermissionFlagsBits } from "discord.js";
import { DiscordFaqBot } from "../src/bot.js";
import { GitHubSearchClient } from "../src/githubSearch.js";

function baseConfig(overrides = {}) {
    return {
        discordToken: "test-token",
        discordClientId: null,
        controlGuildId: "guild-id",
        faqPath: "test",
        faqEntries: [],
        modules: ["faq", "github"],
        enableFaq: true,
        enableGitHub: true,
        allowedChannelIds: ["configured-channel"],
        ignoredChannelIds: [],
        adminUserIds: [],
        adminRoleIds: [],
        adminPermissionNames: ["Administrator", "ManageGuild", "ManageMessages", "ModerateMembers"],
        enableManagementCommands: false,
        enableSupportTriage: false,
        enableAdminDashboard: false,
        enableModeration: false,
        managementCommandPrefix: "!faqbot",
        questionOnlyMode: true,
        matchThreshold: 0.72,
        responseCooldownSeconds: 900,
        userMessageCooldownSeconds: 5,
        maxMessageLength: 1000,
        maxReplyLength: 1900,
        githubToken: null,
        githubDefaultRepos: ["owner/default-repo"],
        enableGlobalGitHubSearch: false,
        globalGitHubSearchMinScore: 0.63,
        githubCacheTtlMs: 600000,
        githubQueryMaxLength: 256,
        githubRequestTimeoutMs: 8000,
        moderationRulesPath: "test-moderation",
        moderationRules: { rules: [] },
        moderationChannelIds: [],
        moderationLogChannelId: null,
        moderationExemptUserIds: [],
        moderationExemptRoleIds: [],
        moderationDefaultAction: "timeout",
        moderationDefaultTimeoutSeconds: 3600,
        moderationBanDeleteMessageSeconds: 86400,
        moderationMaxScanLength: 4000,
        moderationDryRun: true,
        ...overrides
    };
}

function makeMessage(content, options = {}) {
    const replies = [];
    const message = {
        guild: options.guild ?? {
            id: "guild-id",
            name: "Test Guild",
            bans: {
                async create(userId, banOptions) {
                    options.onBan?.(userId, banOptions);
                }
            },
            members: {
                me: {
                    permissions: {
                        has: options.botHasPermission ?? (() => false)
                    }
                },
                cache: new Map(),
                async fetch() {
                    return null;
                }
            }
        },
        author: {
            id: options.authorId ?? "user-id",
            bot: options.authorIsBot ?? false,
            async send(payload) {
                options.onDm?.(payload);
            }
        },
        member: options.member ?? {
            permissions: {
                has: () => false
            },
            roles: {
                cache: new Map()
            }
        },
        channelId: options.channelId ?? "configured-channel",
        channel: options.channel ?? {
            async bulkDelete(count) {
                options.onBulkDelete?.(count);
            },
            async send(payload) {
                replies.push(payload);
            }
        },
        content,
        mentions: options.mentions ?? {
            users: new Map(),
            roles: new Map(),
            everyone: false
        },
        async delete() {
            options.onDelete?.();
        },
        async reply(payload) {
            replies.push(payload);
        }
    };

    return { message, replies };
}

test("handleMessage ignores channels that are not explicitly configured", async () => {
    const bot = new DiscordFaqBot(baseConfig({
        faqEntries: [
            {
                id: "install-deps",
                enabled: true,
                match: {
                    anyPhrases: ["composer install failed"]
                },
                response: {
                    message: "Run composer install with the repo PHP version."
                }
            }
        ]
    }));
    const { message, replies } = makeMessage("composer install failed", {
        channelId: "other-channel"
    });

    await bot.handleMessage(message);

    assert.equal(replies.length, 0);
});

test("handleMessage replies to FAQ key phrases even when question-only mode is enabled", async () => {
    const bot = new DiscordFaqBot(baseConfig({
        faqEntries: [
            {
                id: "install-deps",
                enabled: true,
                match: {
                    anyPhrases: ["composer install failed"]
                },
                response: {
                    message: "Run composer install with the repo PHP version."
                }
            }
        ]
    }));
    const { message, replies } = makeMessage("composer install failed");

    await bot.handleMessage(message);

    assert.equal(replies.length, 1);
    assert.equal(replies[0].content, "Run composer install with the repo PHP version.");
    assert.deepEqual(replies[0].allowedMentions, { parse: [], repliedUser: false });
});

test("handleMessage replies from simple FAQ question and answer entries", async () => {
    const bot = new DiscordFaqBot(baseConfig({
        faqEntries: [
            {
                question: "How do I reset my password?",
                answer: "Use the account settings reset flow."
            }
        ]
    }));
    const { message, replies } = makeMessage("password reset is not working");

    await bot.handleMessage(message);

    assert.equal(replies.length, 1);
    assert.equal(replies[0].content, "Use the account settings reset flow.");
});

test("handleMessage searches configured GitHub repos for key phrase matches and cools down", async () => {
    const searchCalls = [];
    const bot = new DiscordFaqBot(baseConfig({
        faqEntries: [
            {
                id: "ci-red",
                enabled: true,
                cooldownSeconds: 60,
                match: {
                    anyPhrases: ["pipeline is red"]
                },
                response: {
                    message: "Closest related GitHub thread:"
                },
                github: {
                    mode: "search",
                    repos: ["owner/repo"],
                    type: "both",
                    minScore: 0.4
                }
            }
        ]
    }));
    bot.githubClient = {
        async search(args) {
            searchCalls.push(args);
            return {
                number: 77,
                title: "Pipeline is red after dependency update",
                html_url: "https://github.com/owner/repo/pull/77",
                pull_request: {}
            };
        }
    };
    const { message, replies } = makeMessage("pipeline is red again");

    await bot.handleMessage(message);
    await bot.handleMessage(message);

    assert.equal(searchCalls.length, 1);
    assert.equal(searchCalls[0].query, "pipeline is red again");
    assert.deepEqual(searchCalls[0].repos, ["owner/repo"]);
    assert.equal(searchCalls[0].type, "both");
    assert.equal(searchCalls[0].minScore, 0.4);
    assert.equal(replies.length, 1);
    assert.match(replies[0].content, /Closest related GitHub thread:/);
    assert.match(replies[0].content, /PR #77: Pipeline is red after dependency update/);
});

test("handleMessage applies cooldown to global GitHub fallback replies", async () => {
    let searchCount = 0;
    const searchCalls = [];
    const bot = new DiscordFaqBot(baseConfig({
        enableGlobalGitHubSearch: true,
        githubDefaultRepos: ["owner/repo"],
        responseCooldownSeconds: 60
    }));
    bot.githubClient = {
        async search(args) {
            searchCalls.push(args);
            searchCount += 1;
            return {
                number: 12,
                title: "Login fails with OAuth callback error",
                html_url: "https://github.com/owner/repo/issues/12"
            };
        }
    };
    const { message, replies } = makeMessage("Why does login fail with oauth callback?");

    await bot.handleMessage(message);
    await bot.handleMessage(message);

    assert.equal(searchCount, 1);
    assert.equal(searchCalls[0].query, "login fail oauth callback");
    assert.equal(replies.length, 1);
    assert.match(replies[0].content, /Closest GitHub match:/);
});

test("handleMessage strips conversational scaffolding so an exact GitHub issue clears the score threshold", async () => {
    const requestedUrls = [];
    const bot = new DiscordFaqBot(baseConfig({
        enableGlobalGitHubSearch: true,
        githubDefaultRepos: ["owner/repo"]
    }));
    // Use the real search client (real query build + real scoring) with only the
    // network faked, so this pins the whole path, not just the reply plumbing.
    bot.githubClient = new GitHubSearchClient({
        defaultRepos: ["owner/repo"],
        fetchImpl: async (url) => {
            requestedUrls.push(url.toString());
            return {
                ok: true,
                async json() {
                    return {
                        items: [{
                            number: 88,
                            title: "Deduplicate savings metrics",
                            body: "",
                            html_url: "https://github.com/owner/repo/issues/88"
                        }]
                    };
                }
            };
        }
    });
    const { message, replies } = makeMessage("Anyone having issues with deduplicate savings metrics?");

    await bot.handleMessage(message);

    // The exact-title issue previously scored 0.5 (3 topic tokens / 6 query tokens)
    // and fell below the 0.63 threshold; with the filler stripped it scores 1.0.
    assert.equal(replies.length, 1);
    assert.match(replies[0].content, /Issue #88: Deduplicate savings metrics/);
    // The filler words never reach GitHub either — only the topic is queried.
    const sentQuery = new URL(requestedUrls[0]).searchParams.get("q");
    assert.match(sentQuery, /deduplicate savings metrics/);
    assert.doesNotMatch(sentQuery, /anyone|having|issues/);
});

test("handleMessage fires the GitHub fallback for a help question with no punctuation", async () => {
    const searchCalls = [];
    const bot = new DiscordFaqBot(baseConfig({
        enableGlobalGitHubSearch: true,
        githubDefaultRepos: ["owner/repo"]
    }));
    bot.githubClient = {
        async search(args) {
            searchCalls.push(args);
            return {
                number: 88,
                title: "Deduplicate savings metrics",
                html_url: "https://github.com/owner/repo/issues/88"
            };
        }
    };
    // No trailing "?": the "issues" help term still qualifies it as a question.
    const { message, replies } = makeMessage("Anyone having issues with deduplicate savings metrics");

    await bot.handleMessage(message);

    assert.equal(searchCalls.length, 1);
    assert.equal(searchCalls[0].query, "deduplicate savings metrics");
    assert.equal(replies.length, 1);
    assert.match(replies[0].content, /Closest GitHub match:/);
});

test("handleMessage does not spend fallback cooldowns when GitHub finds no match", async () => {
    let searchCount = 0;
    const bot = new DiscordFaqBot(baseConfig({
        enableGlobalGitHubSearch: true,
        githubDefaultRepos: ["owner/repo"],
        responseCooldownSeconds: 60,
        userMessageCooldownSeconds: 60
    }));
    bot.githubClient = {
        async search() {
            searchCount += 1;
            return searchCount === 1
                ? null
                : {
                    number: 12,
                    title: "Login fails with OAuth callback error",
                    html_url: "https://github.com/owner/repo/issues/12"
                };
        }
    };
    const { message, replies } = makeMessage("Why does login fail with oauth callback?");

    await bot.handleMessage(message);
    await bot.handleMessage(message);

    assert.equal(searchCount, 2);
    assert.equal(replies.length, 1);
    assert.match(replies[0].content, /Closest GitHub match:/);
});

test("handleMessage does not spend user cooldown on ignored non-question messages", async () => {
    const bot = new DiscordFaqBot(baseConfig({
        enableGlobalGitHubSearch: true,
        githubDefaultRepos: ["owner/repo"],
        userMessageCooldownSeconds: 60
    }));
    bot.githubClient = {
        async search() {
            return {
                number: 12,
                title: "Login fails with OAuth callback error",
                html_url: "https://github.com/owner/repo/issues/12"
            };
        }
    };
    const first = makeMessage("login oauth callback discussion");
    const second = makeMessage("Why does login fail with oauth callback?");

    await bot.handleMessage(first.message);
    await bot.handleMessage(second.message);

    assert.equal(first.replies.length, 0);
    assert.equal(second.replies.length, 1);
});

test("handleMessage ignores oversized messages before matching or searching", async () => {
    const bot = new DiscordFaqBot(baseConfig({
        maxMessageLength: 10,
        faqEntries: [
            {
                question: "How do I reset my password?",
                answer: "Use the account settings reset flow."
            }
        ]
    }));
    const { message, replies } = makeMessage("password reset is not working");

    await bot.handleMessage(message);

    assert.equal(replies.length, 0);
});

test("handleMessage rate limits repeated messages from the same user", async () => {
    const bot = new DiscordFaqBot(baseConfig({
        userMessageCooldownSeconds: 60,
        faqEntries: [
            {
                question: "How do I reset my password?",
                answer: "Use the account settings reset flow."
            }
        ]
    }));
    const { message, replies } = makeMessage("password reset is not working");

    await bot.handleMessage(message);
    await bot.handleMessage(message);

    assert.equal(replies.length, 1);
});

test("handleMessage blocks management commands from normal users", async () => {
    const faqPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "faq-bot-")), "faq.json");
    fs.writeFileSync(faqPath, JSON.stringify({
        entries: [
            {
                question: "How do I reset my password?",
                answer: "Use the account settings reset flow."
            }
        ]
    }));
    const bot = new DiscordFaqBot(baseConfig({
        enableManagementCommands: true,
        faqPath
    }));
    const { message, replies } = makeMessage("!faqbot reload");

    await bot.handleMessage(message);

    assert.equal(bot.config.faqEntries.length, 0);
    assert.equal(replies.length, 0);
});

test("handleMessage blocks management commands outside the control guild", async () => {
    const bot = new DiscordFaqBot(baseConfig({
        enableManagementCommands: true
    }));
    const { message, replies } = makeMessage("!faqbot status", {
        guild: { id: "other-guild" },
        member: {
            permissions: {
                has: () => true
            },
            roles: {
                cache: new Map()
            }
        }
    });

    await bot.handleMessage(message);

    assert.equal(replies.length, 0);
});

test("handleMessage allows server managers to reload FAQ entries", async () => {
    const faqPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "faq-bot-")), "faq.json");
    fs.writeFileSync(faqPath, JSON.stringify({
        entries: [
            {
                question: "How do I reset my password?",
                answer: "Use the account settings reset flow."
            }
        ]
    }));
    const bot = new DiscordFaqBot(baseConfig({
        enableManagementCommands: true,
        faqPath
    }));
    const { message, replies } = makeMessage("!faqbot reload", {
        member: {
            permissions: {
                has: () => true
            },
            roles: {
                cache: new Map()
            }
        }
    });

    await bot.handleMessage(message);

    assert.equal(bot.config.faqEntries.length, 1);
    assert.equal(replies.length, 1);
    assert.equal(replies[0].content, "Reloaded 1 FAQ entries.");
});

test("handleMessage allows configured admin roles to run known issue lookup", async () => {
    const searchCalls = [];
    const bot = new DiscordFaqBot(baseConfig({
        enableManagementCommands: true,
        adminRoleIds: ["mod-role"],
        githubDefaultRepos: ["owner/repo"]
    }));
    bot.githubClient = {
        async search(args) {
            searchCalls.push(args);
            return {
                number: 42,
                title: "Install fails on Windows",
                html_url: "https://github.com/owner/repo/issues/42"
            };
        }
    };
    const { message, replies } = makeMessage("!faqbot known install fails on windows", {
        member: {
            permissions: {
                has: () => false
            },
            roles: {
                cache: new Map([["mod-role", {}]])
            }
        }
    });

    await bot.handleMessage(message);

    assert.equal(searchCalls.length, 1);
    assert.equal(searchCalls[0].query, "install fails on windows");
    assert.equal(replies.length, 1);
    assert.match(replies[0].content, /Issue #42: Install fails on Windows/);
});

test("handleMessage emits support triage template only when module is enabled", async () => {
    const bot = new DiscordFaqBot(baseConfig({
        enableManagementCommands: true,
        enableSupportTriage: true
    }));
    const { message, replies } = makeMessage("!faqbot triage install error", {
        member: {
            permissions: {
                has: () => true
            },
            roles: {
                cache: new Map()
            }
        }
    });

    await bot.handleMessage(message);

    assert.equal(replies.length, 1);
    assert.match(replies[0].content, /Support triage for install error/);
    assert.match(replies[0].content, /Redact tokens/);
});

test("handleMessage automatically bans configured wallet scams before FAQ matching", async () => {
    const bans = [];
    let deleted = false;
    const bot = new DiscordFaqBot(baseConfig({
        enableModeration: true,
        moderationDryRun: false,
        moderationChannelIds: ["configured-channel"],
        moderationRules: {
            rules: [
                {
                    id: "wallet-drainer",
                    action: "ban",
                    deleteMessage: true,
                    match: {
                        requireUrl: true,
                        anyPhrases: ["connect your wallet to claim"]
                    }
                }
            ]
        },
        faqEntries: [
            {
                question: "How do I claim rewards?",
                answer: "Use the official rewards page."
            }
        ]
    }));
    const { message, replies } = makeMessage("Connect your wallet to claim https://drain.example", {
        botHasPermission: (permission) => (
            permission === PermissionFlagsBits.ManageMessages ||
            permission === PermissionFlagsBits.BanMembers
        ),
        onBan(userId, options) {
            bans.push({ userId, options });
        },
        onDelete() {
            deleted = true;
        }
    });

    await bot.handleMessage(message);

    assert.equal(deleted, true);
    assert.equal(bans.length, 1);
    assert.equal(bans[0].userId, "user-id");
    assert.match(bans[0].options.reason, /wallet-drainer/);
    assert.equal(replies.length, 0);
});

test("handleMessage ignores moderation outside configured moderation channels", async () => {
    const bans = [];
    const bot = new DiscordFaqBot(baseConfig({
        enableModeration: true,
        moderationDryRun: false,
        moderationChannelIds: ["moderated-channel"],
        moderationRules: {
            rules: [
                {
                    id: "wallet-drainer",
                    action: "ban",
                    match: {
                        anyPhrases: ["connect your wallet to claim"]
                    }
                }
            ]
        }
    }));
    const { message } = makeMessage("Connect your wallet to claim https://drain.example", {
        botHasPermission: () => true,
        onBan(userId, options) {
            bans.push({ userId, options });
        }
    });

    await bot.handleMessage(message);

    assert.equal(bans.length, 0);
});

test("handleMessage allows managers to ban members manually", async () => {
    const bans = [];
    const targetMember = {
        id: "222222222222222222",
        permissions: {
            has: () => false
        },
        roles: {
            cache: new Map()
        },
        async ban(options) {
            bans.push(options);
        }
    };
    const bot = new DiscordFaqBot(baseConfig({
        enableManagementCommands: true,
        enableModeration: true,
        moderationDryRun: false
    }));
    const { message, replies } = makeMessage("!faqbot ban <@222222222222222222> scam links", {
        botHasPermission: (permission) => permission === PermissionFlagsBits.BanMembers,
        member: {
            permissions: {
                has: () => true
            },
            roles: {
                cache: new Map()
            }
        },
        guild: {
            id: "guild-id",
            name: "Test Guild",
            members: {
                me: {
                    permissions: {
                        has: (permission) => permission === PermissionFlagsBits.BanMembers
                    }
                },
                cache: new Map([["222222222222222222", targetMember]]),
                async fetch() {
                    return targetMember;
                }
            }
        }
    });

    await bot.handleMessage(message);

    assert.equal(bans.length, 1);
    assert.match(bans[0].reason, /scam links/);
    assert.equal(replies.length, 1);
    assert.equal(replies[0].content, "Banned <@222222222222222222>.");
});

test("handleMessage refuses to ban protected admin targets", async () => {
    const targetMember = {
        id: "222222222222222222",
        permissions: {
            has: (permission) => permission === PermissionFlagsBits.Administrator
        },
        roles: {
            cache: new Map()
        },
        async ban() {
            throw new Error("should not ban protected target");
        }
    };
    const bot = new DiscordFaqBot(baseConfig({
        enableManagementCommands: true,
        enableModeration: true
    }));
    const { message, replies } = makeMessage("!faqbot ban <@222222222222222222> no", {
        member: {
            permissions: {
                has: () => true
            },
            roles: {
                cache: new Map()
            }
        },
        guild: {
            id: "guild-id",
            name: "Test Guild",
            members: {
                me: {
                    permissions: {
                        has: () => true
                    }
                },
                cache: new Map([["222222222222222222", targetMember]]),
                async fetch() {
                    return targetMember;
                }
            }
        }
    });

    await bot.handleMessage(message);

    assert.equal(replies.length, 1);
    assert.equal(replies[0].content, "I will not moderate server admins or managers.");
});
