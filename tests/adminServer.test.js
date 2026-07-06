import test from "node:test";
import assert from "node:assert/strict";
import { PermissionFlagsBits } from "discord.js";
import { startAdminServer } from "../src/adminServer.js";
import { BotStore } from "../src/store.js";

function jsonResponse(payload, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        async json() {
            return payload;
        },
        async text() {
            return JSON.stringify(payload);
        }
    };
}

function makeBot(overrides = {}) {
    const store = new BotStore(":memory:");
    const calls = { unban: [], clearTimeout: [], reloads: 0 };

    const bot = {
        store,
        calls,
        config: {
            adminWebProtocol: "http",
            adminWebHost: "127.0.0.1",
            adminWebPort: 0,
            adminWebPublicUrl: "http://127.0.0.1:0",
            adminSessionSecret: "12345678901234567890123456789012",
            discordOAuthClientId: "oauth-client-id",
            discordOAuthClientSecret: "oauth-client-secret",
            discordOAuthRedirectUri: "http://127.0.0.1:0/oauth/callback",
            controlGuildId: "guild-id",
            botName: "bugbot",
            managementCommandPrefix: "!faqbot",
            adminUserIds: [],
            adminRoleIds: ["mod-role"],
            adminPermissionNames: ["ManageGuild"],
            enableFaq: true,
            enableGitHub: true,
            enableManagementCommands: false,
            enableSupportTriage: false,
            enableModeration: false,
            enableGlobalGitHubSearch: false,
            allowedChannelIds: ["channel-id"],
            ignoredChannelIds: [],
            matchThreshold: 0.72,
            questionOnlyMode: true,
            responseCooldownSeconds: 900,
            userMessageCooldownSeconds: 5,
            maxMessageLength: 1000,
            maxReplyLength: 1900,
            globalGitHubSearchMinScore: 0.63,
            githubDefaultRepos: ["owner/repo"],
            githubQueryMaxLength: 256,
            githubCacheTtlMs: 600000,
            githubRequestTimeoutMs: 8000,
            moderationChannelIds: [],
            moderationDryRun: true,
            moderationDefaultAction: "timeout",
            moderationDefaultTimeoutSeconds: 3600,
            moderationBanDeleteMessageSeconds: 86400,
            moderationExemptUserIds: [],
            moderationExemptRoleIds: [],
            allowProcessRestart: false,
            ...overrides
        },
        getSafeStatus() {
            return {
                connectedAs: "faqbot#0001",
                gatewayStatus: "connected",
                modules: ["faq", "github", "admin-dashboard", "moderation"],
                controlGuildId: "guild-id",
                faqEntries: store.faqCount(),
                allowedChannelIds: ["channel-id"],
                ignoredChannelIds: [],
                enableGlobalGitHubSearch: bot.config.enableGlobalGitHubSearch,
                githubDefaultRepos: ["owner/repo"],
                enableModeration: true,
                moderationDryRun: bot.config.moderationDryRun,
                allowProcessRestart: bot.config.allowProcessRestart
            };
        },
        reloadFaqEntries() {
            calls.reloads += 1;
            return store.faqCount();
        },
        reloadModerationRules() {
            calls.ruleReloads = (calls.ruleReloads ?? 0) + 1;
        },
        restart() {
            calls.restarted = true;
        },
        async startDiscordConnection() {
            calls.started = (calls.started ?? 0) + 1;
        },
        async stopDiscordConnection() {
            calls.stopped = (calls.stopped ?? 0) + 1;
        },
        async restartDiscordConnection() {
            calls.connectionRestarted = (calls.connectionRestarted ?? 0) + 1;
        },
        async unbanUser(guildId, userId, reason) {
            calls.unban.push({ guildId, userId, reason });
        },
        async clearMemberTimeout(guildId, userId, reason) {
            calls.clearTimeout.push({ guildId, userId, reason });
        },
        async addReactionOption(channelId, messageId, emoji) {
            calls.reactions = calls.reactions ?? [];
            calls.reactions.push({ channelId, messageId, emoji });
            return true;
        }
    };

    return bot;
}

function makeDiscordFetch({ permissions = PermissionFlagsBits.ManageGuild, roles = [], owner = false } = {}) {
    return async function fetchImpl(url) {
        const pathname = new URL(url).pathname;

        if (pathname === "/api/v10/oauth2/token") {
            return jsonResponse({ access_token: "discord-access-token", expires_in: 3600 });
        }
        if (pathname === "/api/v10/users/@me") {
            return jsonResponse({ id: "user-id", username: "maintainer" });
        }
        if (pathname === "/api/v10/users/@me/guilds") {
            return jsonResponse([{ id: "guild-id", permissions: permissions.toString(), owner }]);
        }
        if (pathname === "/api/v10/users/@me/guilds/guild-id/member") {
            return jsonResponse({ roles });
        }

        return jsonResponse({ error: "not found" }, 404);
    };
}

async function withServer(bot, fetchImpl, callback) {
    const server = await startAdminServer(bot, { fetchImpl });
    const port = server.address().port;

    try {
        await callback(`http://127.0.0.1:${port}`);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
}

async function signIn(baseUrl) {
    const login = await fetch(`${baseUrl}/login`, { redirect: "manual" });
    const state = new URL(login.headers.get("location")).searchParams.get("state");
    const callback = await fetch(`${baseUrl}/oauth/callback?code=test-code&state=${state}`, { redirect: "manual" });
    const cookie = callback.headers.get("set-cookie");
    const dashboard = await fetch(`${baseUrl}/`, { headers: { Cookie: cookie } });
    const body = await dashboard.text();
    const csrf = body.match(/name="csrf" value="([^"]+)"/)?.[1];

    return { cookie, csrf, callback, dashboard, body };
}

test("admin OAuth flow issues an opaque signed cookie and renders the dashboard", async () => {
    await withServer(makeBot(), makeDiscordFetch(), async (baseUrl) => {
        const login = await fetch(`${baseUrl}/login`, { redirect: "manual" });
        const oauthLocation = new URL(login.headers.get("location"));

        assert.equal(oauthLocation.hostname, "discord.com");
        assert.match(oauthLocation.searchParams.get("scope"), /guilds\.members\.read/);

        const { cookie, csrf, callback, dashboard, body } = await signIn(baseUrl);

        assert.equal(callback.status, 303);
        assert.match(cookie, /HttpOnly/);
        assert.match(cookie, /SameSite=Lax/);
        assert.doesNotMatch(cookie, /discord-access-token/);
        assert.equal(dashboard.status, 200);
        assert.match(body, /maintainer/);
        assert.match(body, /Dashboard/);
        assert.ok(csrf);
    });
});

test("admin dashboard rejects users without allowed roles or permissions", async () => {
    await withServer(makeBot(), makeDiscordFetch({ permissions: 0n, roles: [] }), async (baseUrl) => {
        const login = await fetch(`${baseUrl}/login`, { redirect: "manual" });
        const state = new URL(login.headers.get("location")).searchParams.get("state");
        const callback = await fetch(`${baseUrl}/oauth/callback?code=test-code&state=${state}`, { redirect: "manual" });

        assert.equal(callback.status, 403);
        assert.equal(callback.headers.get("set-cookie"), null);
        assert.match(await callback.text(), /Access denied/);
    });
});

test("self-hosted Fira Sans is served without authentication", async () => {
    await withServer(makeBot(), makeDiscordFetch(), async (baseUrl) => {
        const font = await fetch(`${baseUrl}/assets/fonts/fira-sans-400.woff2`);

        assert.equal(font.status, 200);
        assert.equal(font.headers.get("content-type"), "font/woff2");

        const bogus = await fetch(`${baseUrl}/assets/fonts/fira-sans-123.woff2`);
        assert.equal(bogus.status, 404);

        const avatar = await fetch(`${baseUrl}/assets/avatar.jpg`);
        assert.equal(avatar.status, 200);
        assert.equal(avatar.headers.get("content-type"), "image/jpeg");
    });
});

test("theme preference is stored in a cookie and applied to the document", async () => {
    await withServer(makeBot(), makeDiscordFetch(), async (baseUrl) => {
        const { cookie } = await signIn(baseUrl);
        const themed = await fetch(`${baseUrl}/theme?mode=dark&return=/`, {
            headers: { Cookie: cookie },
            redirect: "manual"
        });
        const themeCookie = themed.headers.get("set-cookie");

        assert.equal(themed.status, 303);
        assert.match(themeCookie, /bugbot_theme=dark/);

        const page = await fetch(`${baseUrl}/`, { headers: { Cookie: `${cookie}; ${themeCookie.split(";")[0]}` } });
        assert.match(await page.text(), /data-theme="dark"/);
    });
});

test("admin can undo a recorded ban, which lifts it and marks the log entry", async () => {
    const bot = makeBot();
    const actionId = bot.store.recordModerationAction({
        action: "ban", targetUserId: "999", targetTag: "spammer", guildId: "guild-id",
        channelId: "chan", source: "auto", reason: "wallet scam"
    });

    await withServer(bot, makeDiscordFetch(), async (baseUrl) => {
        const { cookie, csrf } = await signIn(baseUrl);

        const undo = await fetch(`${baseUrl}/moderation/undo`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
            body: new URLSearchParams({ csrf, id: String(actionId) }),
            redirect: "manual"
        });

        assert.equal(undo.status, 303);
        assert.match(undo.headers.get("location"), /flash=undone/);
        assert.equal(bot.calls.unban.length, 1);
        assert.equal(bot.calls.unban[0].userId, "999");
        assert.ok(bot.store.getModerationAction(actionId).undone_at);
    });
});

test("undo is rejected without a valid CSRF token", async () => {
    const bot = makeBot();
    const actionId = bot.store.recordModerationAction({
        action: "ban", targetUserId: "999", guildId: "guild-id", source: "auto"
    });

    await withServer(bot, makeDiscordFetch(), async (baseUrl) => {
        const { cookie } = await signIn(baseUrl);
        const undo = await fetch(`${baseUrl}/moderation/undo`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
            body: new URLSearchParams({ csrf: "wrong", id: String(actionId) })
        });

        assert.equal(undo.status, 403);
        assert.equal(bot.calls.unban.length, 0);
        assert.equal(bot.store.getModerationAction(actionId).undone_at, null);
    });
});

test("admin can create and delete FAQ entries through the panel", async () => {
    const bot = makeBot();

    await withServer(bot, makeDiscordFetch(), async (baseUrl) => {
        const { cookie, csrf } = await signIn(baseUrl);

        const save = await fetch(`${baseUrl}/faq/save`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
            body: new URLSearchParams({
                csrf, id: "reset-password", enabled: "1",
                phrases: "How do I reset my password?", answer: "Use the reset flow.", links: "", keywords: "", github: ""
            }),
            redirect: "manual"
        });

        assert.equal(save.status, 303);
        assert.match(save.headers.get("location"), /flash=faq_saved/);
        assert.equal(bot.store.faqCount(), 1);
        assert.equal(bot.store.getFaqEntry("reset-password").answer, "Use the reset flow.");
        assert.ok(bot.calls.reloads >= 1);

        const remove = await fetch(`${baseUrl}/faq/delete`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
            body: new URLSearchParams({ csrf, id: "reset-password" }),
            redirect: "manual"
        });

        assert.equal(remove.status, 303);
        assert.equal(bot.store.faqCount(), 0);
    });
});

test("invalid GitHub JSON in the FAQ editor is reported, not saved", async () => {
    const bot = makeBot();

    await withServer(bot, makeDiscordFetch(), async (baseUrl) => {
        const { cookie, csrf } = await signIn(baseUrl);
        const save = await fetch(`${baseUrl}/faq/save`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
            body: new URLSearchParams({ csrf, id: "x", answer: "ok", phrases: "hi", github: "{not json" })
        });

        assert.equal(save.status, 400);
        assert.match(await save.text(), /valid JSON/);
        assert.equal(bot.store.faqCount(), 0);
    });
});

function fullSettingsForm(overrides = {}) {
    // A complete, valid submission for the settings form. The handler validates
    // the whole set together, so a partial post is (correctly) rejected.
    return {
        controlGuildId: "412302030401920123",
        botName: "bugbot",
        managementCommandPrefix: "!faqbot",
        allowedChannelIds: "123456789012345678",
        ignoredChannelIds: "",
        matchThreshold: "0.72",
        responseCooldownSeconds: "900",
        userMessageCooldownSeconds: "5",
        maxMessageLength: "1000",
        maxReplyLength: "1900",
        githubDefaultRepos: "owner/repo",
        globalGitHubSearchMinScore: "0.63",
        githubQueryMaxLength: "256",
        githubCacheTtlSeconds: "600",
        githubRequestTimeoutSeconds: "8",
        moderationChannelIds: "",
        moderationDefaultAction: "timeout",
        moderationDefaultTimeoutSeconds: "3600",
        moderationBanDeleteMessageSeconds: "86400",
        moderationExemptUserIds: "",
        moderationExemptRoleIds: "",
        ...overrides
    };
}

test("settings changes are applied to live config and persisted", async () => {
    const bot = makeBot();

    await withServer(bot, makeDiscordFetch(), async (baseUrl) => {
        const { cookie, csrf } = await signIn(baseUrl);
        const save = await fetch(`${baseUrl}/settings`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
            body: new URLSearchParams(fullSettingsForm({
                csrf,
                matchThreshold: "0.9",
                responseCooldownSeconds: "300",
                githubDefaultRepos: "sparkbugz/phoenix\nsparkbugz/bugbot",
                githubRequestTimeoutSeconds: "12"
                // question-only / fallback / dry-run checkboxes omitted = off
            })),
            redirect: "manual"
        });

        assert.equal(save.status, 303);
        assert.equal(bot.config.matchThreshold, 0.9);
        assert.equal(bot.config.responseCooldownSeconds, 300);
        assert.deepEqual(bot.config.githubDefaultRepos, ["sparkbugz/phoenix", "sparkbugz/bugbot"]);
        assert.equal(bot.config.githubRequestTimeoutMs, 12000); // seconds scaled to ms
        assert.equal(bot.config.moderationDryRun, false);
        assert.equal(bot.config.enableGlobalGitHubSearch, false);
        assert.equal(bot.store.getSetting("githubDefaultRepos"), JSON.stringify(["sparkbugz/phoenix", "sparkbugz/bugbot"]));
    });
});

test("invalid settings are rejected and the live config is untouched", async () => {
    const bot = makeBot();

    await withServer(bot, makeDiscordFetch(), async (baseUrl) => {
        const { cookie, csrf } = await signIn(baseUrl);
        const save = await fetch(`${baseUrl}/settings`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
            body: new URLSearchParams(fullSettingsForm({ csrf, githubDefaultRepos: "not-a-valid-repo" }))
        });

        assert.equal(save.status, 400);
        assert.match(await save.text(), /owner\/repo/);
        assert.deepEqual(bot.config.githubDefaultRepos, ["owner/repo"]);
    });
});

test("enabling moderation without a channel is rejected", async () => {
    const bot = makeBot();

    await withServer(bot, makeDiscordFetch(), async (baseUrl) => {
        const { cookie, csrf } = await signIn(baseUrl);
        const save = await fetch(`${baseUrl}/settings`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
            body: new URLSearchParams(fullSettingsForm({ csrf, enableModeration: "1", moderationChannelIds: "" }))
        });

        assert.equal(save.status, 400);
        assert.match(await save.text(), /moderated channels/);
        assert.equal(bot.config.enableModeration, false);
    });
});

test("the FAQ test tool reports whether a message would match", async () => {
    const bot = makeBot();
    bot.config.faqEntries = [{ id: "reset", answer: "ok", questions: ["how do I reset my password"] }];
    bot.config.matchThreshold = 0.72;

    await withServer(bot, makeDiscordFetch(), async (baseUrl) => {
        const { cookie, csrf } = await signIn(baseUrl);
        const hit = await fetch(`${baseUrl}/faq/test`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
            body: new URLSearchParams({ csrf, message: "how do I reset my password for the portal" })
        });
        assert.match(await hit.text(), /Matches <strong>reset<\/strong>/);

        const miss = await fetch(`${baseUrl}/faq/test`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
            body: new URLSearchParams({ csrf, message: "what is the weather today" })
        });
        assert.match(await miss.text(), /No entry matches/);
    });
});

test("admin actions are written to the audit log and shown", async () => {
    const bot = makeBot();

    await withServer(bot, makeDiscordFetch(), async (baseUrl) => {
        const { cookie, csrf } = await signIn(baseUrl);
        await fetch(`${baseUrl}/faq/save`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
            body: new URLSearchParams({ csrf, id: "x", answer: "hi", phrases: "hi there" }),
            redirect: "manual"
        });

        const audit = await fetch(`${baseUrl}/audit`, { headers: { Cookie: cookie } });
        const body = await audit.text();
        assert.equal(audit.status, 200);
        assert.match(body, /faq\.save/);
        assert.match(body, /maintainer/);
    });
});

test("moderation rules can be created, applied, and deleted", async () => {
    const bot = makeBot();

    await withServer(bot, makeDiscordFetch(), async (baseUrl) => {
        const { cookie, csrf } = await signIn(baseUrl);
        const save = await fetch(`${baseUrl}/moderation/rules/save`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
            body: new URLSearchParams({ csrf, id: "wallet-drainer", action: "ban", reason: "scam", phrases: "connect your wallet to claim", enabled: "1" }),
            redirect: "manual"
        });

        assert.equal(save.status, 303);
        assert.equal(bot.store.moderationRuleCount(), 1);
        assert.equal(bot.store.getModerationRule("wallet-drainer").action, "ban");
        assert.ok(bot.calls.ruleReloads >= 1);

        const del = await fetch(`${baseUrl}/moderation/rules/delete`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
            body: new URLSearchParams({ csrf, id: "wallet-drainer" }),
            redirect: "manual"
        });
        assert.equal(del.status, 303);
        assert.equal(bot.store.moderationRuleCount(), 0);
    });
});

test("a rule with no match criteria is rejected", async () => {
    const bot = makeBot();

    await withServer(bot, makeDiscordFetch(), async (baseUrl) => {
        const { cookie, csrf } = await signIn(baseUrl);
        const save = await fetch(`${baseUrl}/moderation/rules/save`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
            body: new URLSearchParams({ csrf, id: "empty", action: "ban" })
        });

        assert.equal(save.status, 400);
        assert.match(await save.text(), /at least one phrase/);
        assert.equal(bot.store.moderationRuleCount(), 0);
    });
});

test("scam detectors save into moderation globals", async () => {
    const bot = makeBot();

    await withServer(bot, makeDiscordFetch(), async (baseUrl) => {
        const { cookie, csrf } = await signIn(baseUrl);
        const save = await fetch(`${baseUrl}/moderation/rules/globals`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
            body: new URLSearchParams({
                csrf, blockedDomains: "evil.example\nscam.example", maxMentions: "6",
                blockedDomainAction: "ban", lookalikeDomainAction: "ban", walletScamAction: "ban",
                riskyTldAction: "timeout", mentionSpamAction: "timeout"
            }),
            redirect: "manual"
        });

        assert.equal(save.status, 303);
        const globals = bot.store.getModerationGlobals();
        assert.deepEqual(globals.blockedDomains, ["evil.example", "scam.example"]);
        assert.equal(globals.maxMentions, 6);
    });
});

test("reaction-role mappings can be added and removed from the panel", async () => {
    const bot = makeBot({ reactionRolesEnabled: true });

    await withServer(bot, makeDiscordFetch(), async (baseUrl) => {
        const { cookie, csrf } = await signIn(baseUrl);
        const save = await fetch(`${baseUrl}/roles/save`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
            body: new URLSearchParams({
                csrf, channel_id: "123456789012345678", message_id: "223456789012345678",
                emoji: "✅", role_id: "323456789012345678"
            }),
            redirect: "manual"
        });

        assert.equal(save.status, 303);
        assert.match(save.headers.get("location"), /role_added/);
        assert.equal(bot.store.reactionRoleCount(), 1);
        assert.equal(bot.calls.reactions[0].emoji, "✅");

        const del = await fetch(`${baseUrl}/roles/delete`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
            body: new URLSearchParams({ csrf, message_id: "223456789012345678", emoji: "✅" }),
            redirect: "manual"
        });
        assert.equal(del.status, 303);
        assert.equal(bot.store.reactionRoleCount(), 0);
    });
});

test("a reaction-role mapping with bad IDs is rejected", async () => {
    const bot = makeBot({ reactionRolesEnabled: true });

    await withServer(bot, makeDiscordFetch(), async (baseUrl) => {
        const { cookie, csrf } = await signIn(baseUrl);
        const save = await fetch(`${baseUrl}/roles/save`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
            body: new URLSearchParams({ csrf, channel_id: "nope", message_id: "223456789012345678", emoji: "✅", role_id: "323456789012345678" })
        });

        assert.equal(save.status, 400);
        assert.equal(bot.store.reactionRoleCount(), 0);
    });
});

test("bot connection controls require CSRF and call panel-only lifecycle methods", async () => {
    const bot = makeBot();

    await withServer(bot, makeDiscordFetch(), async (baseUrl) => {
        const { cookie, csrf } = await signIn(baseUrl);

        const blocked = await fetch(`${baseUrl}/bot-control`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
            body: new URLSearchParams({ csrf: "wrong", action: "restart" })
        });
        assert.equal(blocked.status, 403);
        assert.equal(bot.calls.connectionRestarted, undefined);

        const ok = await fetch(`${baseUrl}/bot-control`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
            body: new URLSearchParams({ csrf, action: "restart" }),
            redirect: "manual"
        });
        assert.equal(ok.status, 303);
        assert.equal(bot.calls.connectionRestarted, 1);
    });
});

test("process restart is disabled unless explicitly allowed", async () => {
    const bot = makeBot();

    await withServer(bot, makeDiscordFetch(), async (baseUrl) => {
        const { cookie, csrf } = await signIn(baseUrl);

        const blocked = await fetch(`${baseUrl}/restart`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
            body: new URLSearchParams({ csrf }),
            redirect: "manual"
        });

        assert.equal(blocked.status, 303);
        assert.equal(blocked.headers.get("location"), "/settings?flash=restart_disabled");
        assert.notEqual(bot.calls.restarted, true);
    });
});

test("header links hide modules that are switched off but keep their pages reachable", async () => {
    const bot = makeBot({
        enableModeration: false,
        enableCustomCommands: false,
        reactionRolesEnabled: false,
        levelingEnabled: false
    });

    await withServer(bot, makeDiscordFetch(), async (baseUrl) => {
        const { cookie, body } = await signIn(baseUrl);

        assert.match(body, /href="\/faq"/);
        assert.doesNotMatch(body, /href="\/commands"/);
        assert.doesNotMatch(body, /href="\/roles"/);
        assert.doesNotMatch(body, /href="\/leveling"/);
        assert.doesNotMatch(body, /href="\/moderation"/);

        // The page itself stays reachable and explains how to turn the module on.
        const commands = await fetch(`${baseUrl}/commands`, { headers: { Cookie: cookie } });
        assert.equal(commands.status, 200);
        assert.match(await commands.text(), /turned off/);
    });
});

test("the theme toggle offers sun/moon and a way back to auto only when overridden", async () => {
    await withServer(makeBot(), makeDiscordFetch(), async (baseUrl) => {
        const { cookie, body } = await signIn(baseUrl);

        assert.match(body, /\/theme\?mode=dark&amp;return=%2F/);
        assert.match(body, /\/theme\?mode=light&amp;return=%2F/);
        assert.doesNotMatch(body, /\/theme\?mode=auto/);

        const themed = await fetch(`${baseUrl}/theme?mode=dark&return=/`, { headers: { Cookie: cookie }, redirect: "manual" });
        const themeCookie = themed.headers.get("set-cookie").split(";")[0];
        const page = await fetch(`${baseUrl}/`, { headers: { Cookie: `${cookie}; ${themeCookie}` } });
        const dark = await page.text();

        assert.match(dark, /data-theme="dark"/);
        assert.match(dark, /\/theme\?mode=auto/);
    });
});

test("the login page is branded BugBot with a Discord sign-in button", async () => {
    await withServer(makeBot(), makeDiscordFetch(), async (baseUrl) => {
        const page = await fetch(`${baseUrl}/`);
        const body = await page.text();

        assert.equal(page.status, 200);
        assert.match(body, /BugBot/);
        assert.match(body, /Continue with Discord/);
        assert.match(body, /Why sign in with Discord/);
        assert.match(body, /approved/);
        assert.doesNotMatch(body, /bugbot/);
    });
});

test("the reference page renders concepts and the settings reference", async () => {
    await withServer(makeBot(), makeDiscordFetch(), async (baseUrl) => {
        const { cookie } = await signIn(baseUrl);
        const page = await fetch(`${baseUrl}/glossary`, { headers: { Cookie: cookie } });
        const body = await page.text();

        assert.equal(page.status, 200);
        assert.match(body, /Reference — BugBot/);
        assert.match(body, /Settings reference/);
        assert.match(body, /Template tags/);
    });
});

test("the settings page groups sections with a rail and a sticky save bar", async () => {
    await withServer(makeBot(), makeDiscordFetch(), async (baseUrl) => {
        const { cookie } = await signIn(baseUrl);
        const page = await fetch(`${baseUrl}/settings`, { headers: { Cookie: cookie } });
        const body = await page.text();

        assert.equal(page.status, 200);
        assert.match(body, /class="savebar"/);
        assert.match(body, /Save all settings/);
        assert.match(body, /class="field-more"/);
        assert.match(body, /#section-moderation/);
    });
});

test("process restart requires CSRF and enabled supervisor mode", async () => {
    const bot = makeBot({ allowProcessRestart: true });

    await withServer(bot, makeDiscordFetch(), async (baseUrl) => {
        const { cookie, csrf } = await signIn(baseUrl);

        const blocked = await fetch(`${baseUrl}/restart`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
            body: new URLSearchParams({ csrf: "wrong" })
        });
        assert.equal(blocked.status, 403);
        assert.notEqual(bot.calls.restarted, true);

        const ok = await fetch(`${baseUrl}/restart`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
            body: new URLSearchParams({ csrf })
        });
        assert.equal(ok.status, 200);
        assert.equal(bot.calls.restarted, true);
    });
});

test("a scoped grant reaches only its areas and hides the rest of the nav", async () => {
    const bot = makeBot();
    bot.store.saveAccessGrant({ subjectType: "role", subjectId: "support", areas: ["moderation", "faq"] });

    await withServer(bot, makeDiscordFetch({ permissions: 0n, roles: ["support"] }), async (baseUrl) => {
        const { cookie, callback, body } = await signIn(baseUrl);

        // Authorized by the grant, not as an administrator. The FAQ module is on,
        // so its tab shows; settings and access stay hidden.
        assert.equal(callback.status, 303);
        assert.match(body, /href="\/faq"/);
        assert.doesNotMatch(body, /href="\/settings"/);
        assert.doesNotMatch(body, /href="\/access"/);

        const mod = await fetch(`${baseUrl}/moderation`, { headers: { Cookie: cookie } });
        assert.equal(mod.status, 200);

        const settings = await fetch(`${baseUrl}/settings`, { headers: { Cookie: cookie }, redirect: "manual" });
        assert.equal(settings.status, 303);
        assert.match(settings.headers.get("location"), /no_access/);

        const access = await fetch(`${baseUrl}/access`, { headers: { Cookie: cookie }, redirect: "manual" });
        assert.equal(access.status, 303);
        assert.match(access.headers.get("location"), /no_access/);
    });
});

test("administrators manage grants through the access page", async () => {
    const bot = makeBot();

    await withServer(bot, makeDiscordFetch(), async (baseUrl) => {
        const { cookie, csrf } = await signIn(baseUrl);

        const page = await fetch(`${baseUrl}/access`, { headers: { Cookie: cookie } });
        assert.equal(page.status, 200);
        assert.match(await page.text(), /Add a grant/);

        const saved = await fetch(`${baseUrl}/access/save`, {
            method: "POST",
            redirect: "manual",
            headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
            body: new URLSearchParams([
                ["csrf", csrf],
                ["subject_type", "role"],
                ["role_id", "111111111111111111"],
                ["areas", "moderation"],
                ["areas", "faq"],
                ["label", "Support mods"]
            ])
        });
        assert.equal(saved.status, 303);
        assert.match(saved.headers.get("location"), /grant_saved/);
        assert.deepEqual(bot.store.getAccessGrant("role", "111111111111111111").areas, ["moderation", "faq"]);

        const removed = await fetch(`${baseUrl}/access/delete`, {
            method: "POST",
            redirect: "manual",
            headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
            body: new URLSearchParams({ csrf, subject_type: "role", subject_id: "111111111111111111" })
        });
        assert.equal(removed.status, 303);
        assert.equal(bot.store.getAccessGrant("role", "111111111111111111"), null);
    });
});

test("every page carries the header connection light and a licensed footer", async () => {
    await withServer(makeBot(), makeDiscordFetch(), async (baseUrl) => {
        const { body } = await signIn(baseUrl);

        assert.match(body, /class="botstate"/);
        assert.match(body, /class="light on"/);
        assert.match(body, /faqbot#0001/);
        assert.match(body, /id="nav-toggle"/);
        assert.match(body, /class="nav-burger"/);
        assert.match(body, /class="sitefoot"/);
        assert.match(body, /AGPL-3.0-or-later/);
        assert.match(body, /href="\/license"/);
    });
});

test("the owner can revoke and restore an administrator", async () => {
    const bot = makeBot();

    await withServer(bot, makeDiscordFetch({ owner: true }), async (baseUrl) => {
        const { cookie, csrf } = await signIn(baseUrl);

        const page = await fetch(`${baseUrl}/access`, { headers: { Cookie: cookie } });
        assert.match(await page.text(), /Revoke admin/);

        const revoked = await fetch(`${baseUrl}/access/admin-block`, {
            method: "POST",
            redirect: "manual",
            headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
            body: new URLSearchParams({ csrf, subject_type: "role", role_id: "222222222222222222", label: "Stepped down" })
        });
        assert.equal(revoked.status, 303);
        assert.match(revoked.headers.get("location"), /admin_revoked/);
        assert.ok(bot.store.getAdminBlock("role", "222222222222222222"));

        const restored = await fetch(`${baseUrl}/access/admin-unblock`, {
            method: "POST",
            redirect: "manual",
            headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
            body: new URLSearchParams({ csrf, subject_type: "role", subject_id: "222222222222222222" })
        });
        assert.equal(restored.status, 303);
        assert.equal(bot.store.getAdminBlock("role", "222222222222222222"), null);
    });
});

test("a non-owner administrator cannot revoke administrators", async () => {
    const bot = makeBot();

    await withServer(bot, makeDiscordFetch(), async (baseUrl) => {
        const { cookie, csrf, body } = await signIn(baseUrl);

        // The owner-only section is hidden from a plain administrator.
        assert.doesNotMatch(body, /Revoke admin/);

        const blocked = await fetch(`${baseUrl}/access/admin-block`, {
            method: "POST",
            redirect: "manual",
            headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
            body: new URLSearchParams({ csrf, subject_type: "role", role_id: "222222222222222222" })
        });
        assert.equal(blocked.status, 403);
        assert.equal(bot.store.getAdminBlock("role", "222222222222222222"), null);
    });
});

test("the license page is public and states the AGPL and commercial terms", async () => {
    await withServer(makeBot(), makeDiscordFetch(), async (baseUrl) => {
        const page = await fetch(`${baseUrl}/license`);
        const body = await page.text();

        assert.equal(page.status, 200);
        assert.match(body, /GNU Affero General Public License/);
        assert.match(body, /any later version/);
        assert.match(body, /alternative \(non-AGPL\) licensing/);
    });
});
