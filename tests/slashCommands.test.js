import test from "node:test";
import assert from "node:assert/strict";
import { PermissionFlagsBits } from "discord.js";
import { DiscordFaqBot } from "../src/bot.js";
import { BotStore } from "../src/store.js";
import { buildSlashCommands } from "../src/slashCommands.js";

function slashConfig(overrides = {}) {
    return {
        discordToken: "token",
        controlGuildId: "guild-id",
        faqEntries: [],
        modules: ["faq", "github"],
        enableFaq: true,
        enableGitHub: true,
        enableSupportTriage: false,
        enableManagementCommands: false,
        enableModeration: false,
        enableSlashCommands: true,
        levelingEnabled: false,
        adminUserIds: [],
        adminRoleIds: [],
        adminPermissionNames: ["Administrator", "ManageGuild", "ManageMessages", "ModerateMembers"],
        matchThreshold: 0.72,
        maxReplyLength: 1900,
        githubDefaultRepos: ["owner/repo"],
        enableGlobalGitHubSearch: false,
        globalGitHubSearchMinScore: 0.63,
        moderationBanDeleteMessageSeconds: 86400,
        moderationDefaultTimeoutSeconds: 3600,
        ...overrides
    };
}

// A minimal stand-in for a ChatInputCommandInteraction. It records every reply so
// tests can assert on content and ephemerality, and tracks the deferred/replied
// state the bot switches on.
function makeInteraction(commandName, options = {}) {
    const replies = [];
    let deferred = false;
    let replied = false;
    const values = options.values ?? {};

    const interaction = {
        isChatInputCommand: () => true,
        commandName,
        guildId: options.guildId ?? "guild-id",
        channelId: options.channelId ?? "chan-id",
        user: options.user ?? { id: "mod-id", username: "mod", tag: "mod#0001", async send() {} },
        member: options.member ?? { permissions: { has: () => false }, roles: { cache: new Map() } },
        memberPermissions: options.memberPermissions ?? { has: () => false },
        guild: options.guild ?? {
            name: "Test Guild",
            members: { me: { permissions: { has: () => true } }, cache: new Map(), async fetch() { return null; } },
            bans: { async create() {} }
        },
        channel: options.channel,
        options: {
            getString: (name) => values[name] ?? null,
            getInteger: (name) => (values[name] ?? null),
            getUser: (name) => values[name] ?? null,
            getMember: (name) => options.members?.[name] ?? null
        },
        get deferred() { return deferred; },
        get replied() { return replied; },
        async deferReply() { deferred = true; },
        async reply(payload) { replied = true; replies.push(payload); },
        async editReply(payload) { replies.push(payload); }
    };

    return { interaction, replies };
}

function isEphemeral(payload) {
    return Boolean(payload.flags);
}

test("buildSlashCommands only exposes commands for enabled features", () => {
    const minimal = buildSlashCommands(slashConfig({ enableGitHub: false }));
    const names = minimal.map((command) => command.name);
    assert.deepEqual(names, ["faq"]);

    const full = buildSlashCommands(slashConfig({
        enableSupportTriage: true,
        enableManagementCommands: true,
        enableModeration: true,
        levelingEnabled: true
    }));
    const fullNames = full.map((command) => command.name);
    assert.ok(fullNames.includes("known"));
    assert.ok(fullNames.includes("triage"));
    assert.ok(fullNames.includes("rank"));
    assert.ok(fullNames.includes("leaderboard"));
    assert.ok(fullNames.includes("status"));
    for (const name of ["ban", "kick", "timeout", "untimeout", "warn", "purge"]) {
        assert.ok(fullNames.includes(name), `expected ${name}`);
    }

    const ban = full.find((command) => command.name === "ban");
    assert.equal(ban.default_member_permissions, PermissionFlagsBits.BanMembers.toString());
});

test("known command is hidden when no repos are configured", () => {
    const names = buildSlashCommands(slashConfig({ githubDefaultRepos: [] })).map((c) => c.name);
    assert.ok(!names.includes("known"));
});

test("/faq answers a matching entry ephemerally", async () => {
    const bot = new DiscordFaqBot(slashConfig({
        faqEntries: [{ id: "reset", match: { anyPhrases: ["reset password"] }, response: { message: "Use the reset flow." } }]
    }));
    const { interaction, replies } = makeInteraction("faq", { values: { query: "how do I reset password" } });

    await bot.handleInteraction(interaction);

    assert.equal(replies.length, 1);
    assert.equal(replies[0].content, "Use the reset flow.");
});

test("/faq reports no match without hitting GitHub", async () => {
    const bot = new DiscordFaqBot(slashConfig());
    const { interaction, replies } = makeInteraction("faq", { values: { query: "something unrelated entirely" } });

    await bot.handleInteraction(interaction);

    assert.equal(replies.length, 1);
    assert.ok(isEphemeral(replies[0]));
    assert.match(replies[0].content, /couldn't find a FAQ entry/);
});

test("/rank reports a member's level publicly", async () => {
    const store = new BotStore(":memory:");
    store.addXp("guild-id", "player", 500);
    const bot = new DiscordFaqBot(slashConfig({ levelingEnabled: true }), { store });
    const { interaction, replies } = makeInteraction("rank", {
        values: { user: { id: "player", username: "player" } }
    });

    await bot.handleInteraction(interaction);

    assert.equal(replies.length, 1);
    assert.equal(isEphemeral(replies[0]), false);
    assert.match(replies[0].content, /<@player> — level \d+ \(rank #1\)/);
});

test("/leaderboard lists ranked members", async () => {
    const store = new BotStore(":memory:");
    store.addXp("guild-id", "a", 900);
    store.addXp("guild-id", "b", 100);
    const bot = new DiscordFaqBot(slashConfig({ levelingEnabled: true }), { store });
    const { interaction, replies } = makeInteraction("leaderboard");

    await bot.handleInteraction(interaction);

    assert.match(replies[0].content, /Leaderboard/);
    assert.match(replies[0].content, /1\. <@a>/);
});

test("/ban bans a member and records the action", async () => {
    const store = new BotStore(":memory:");
    const bans = [];
    const targetMember = {
        id: "target",
        permissions: { has: () => false },
        roles: { cache: new Map() },
        async ban(options) { bans.push(options); }
    };
    const bot = new DiscordFaqBot(slashConfig({ enableModeration: true }), { store });
    const { interaction, replies } = makeInteraction("ban", {
        memberPermissions: { has: () => true },
        values: { user: { id: "target", username: "target", tag: "target#1" }, reason: "spam links" },
        members: { user: targetMember },
        guild: {
            name: "Test Guild",
            members: { me: { permissions: { has: (p) => p === PermissionFlagsBits.BanMembers } }, cache: new Map(), async fetch() { return targetMember; } },
            bans: { async create() {} }
        }
    });

    await bot.handleInteraction(interaction);

    assert.equal(bans.length, 1);
    assert.match(bans[0].reason, /spam links/);
    assert.match(replies[0].content, /Banned <@target>/);

    const logged = store.listModerationActions({ limit: 5 });
    assert.equal(logged.length, 1);
    assert.equal(logged[0].action, "ban");
    assert.equal(logged[0].moderator_id, "mod-id");
    assert.equal(logged[0].source, "command");
});

test("/ban refuses when the invoker is not an admin", async () => {
    const bot = new DiscordFaqBot(slashConfig({ enableModeration: true }));
    const { interaction, replies } = makeInteraction("ban", {
        memberPermissions: { has: () => false },
        values: { user: { id: "target" } }
    });

    await bot.handleInteraction(interaction);

    assert.equal(replies.length, 1);
    assert.match(replies[0].content, /not allowed/);
});

test("/ban refuses to touch a protected target", async () => {
    const protectedMember = {
        id: "admin-target",
        permissions: { has: (p) => p === PermissionFlagsBits.Administrator },
        roles: { cache: new Map() },
        async ban() { throw new Error("should not ban"); }
    };
    const bot = new DiscordFaqBot(slashConfig({ enableModeration: true }));
    const { interaction, replies } = makeInteraction("ban", {
        memberPermissions: { has: () => true },
        values: { user: { id: "admin-target" } },
        members: { user: protectedMember }
    });

    await bot.handleInteraction(interaction);

    assert.match(replies[0].content, /admins or managers/);
});

test("/timeout applies a parsed duration", async () => {
    const store = new BotStore(":memory:");
    const timeouts = [];
    const targetMember = {
        id: "noisy",
        permissions: { has: () => false },
        roles: { cache: new Map() },
        async timeout(ms, reason) { timeouts.push({ ms, reason }); }
    };
    const bot = new DiscordFaqBot(slashConfig({ enableModeration: true }), { store });
    const { interaction, replies } = makeInteraction("timeout", {
        memberPermissions: { has: () => true },
        values: { user: { id: "noisy", tag: "noisy#1" }, duration: "10m", reason: "cool off" },
        members: { user: targetMember },
        guild: {
            name: "Test Guild",
            members: { me: { permissions: { has: () => true } }, cache: new Map(), async fetch() { return targetMember; } },
            bans: { async create() {} }
        }
    });

    await bot.handleInteraction(interaction);

    assert.equal(timeouts.length, 1);
    assert.equal(timeouts[0].ms, 10 * 60 * 1000);
    assert.match(replies[0].content, /Timed out <@noisy>/);
});

test("/purge bulk-deletes when permitted", async () => {
    const deletes = [];
    const channel = { async bulkDelete(count, filterOld) { deletes.push({ count, filterOld }); } };
    const bot = new DiscordFaqBot(slashConfig({ enableModeration: true }));
    const { interaction, replies } = makeInteraction("purge", {
        memberPermissions: { has: () => true },
        values: { count: 5 },
        channel,
        guild: { name: "Test Guild", members: { me: { permissions: { has: () => true } } } }
    });

    await bot.handleInteraction(interaction);

    assert.deepEqual(deletes, [{ count: 5, filterOld: true }]);
    assert.match(replies[0].content, /Deleted up to 5/);
});

test("commands from outside the control guild are rejected", async () => {
    const bot = new DiscordFaqBot(slashConfig());
    const { interaction, replies } = makeInteraction("faq", { guildId: "other-guild", values: { query: "x" } });

    await bot.handleInteraction(interaction);

    assert.match(replies[0].content, /only works in its configured server/);
});

test("/status requires management permission", async () => {
    const bot = new DiscordFaqBot(slashConfig({ enableManagementCommands: true }));
    const { interaction, replies } = makeInteraction("status", { memberPermissions: { has: () => false } });

    await bot.handleInteraction(interaction);

    assert.match(replies[0].content, /not allowed/);
});

test("a handler that throws still acknowledges the interaction", async () => {
    const bot = new DiscordFaqBot(slashConfig({ levelingEnabled: true }), {
        store: { getUserLevel() { throw new Error("boom"); } }
    });
    const { interaction, replies } = makeInteraction("rank", { values: { user: { id: "x" } } });

    await bot.handleInteraction(interaction);

    assert.equal(replies.length, 1);
    assert.match(replies[0].content, /Something went wrong/);
});
