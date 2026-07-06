import test from "node:test";
import assert from "node:assert/strict";
import { PermissionFlagsBits } from "discord.js";
import { DiscordFaqBot } from "../src/bot.js";
import { BotStore } from "../src/store.js";
import { renderScheduled } from "../src/adminViews.js";

function schedulerConfig(overrides = {}) {
    return {
        discordToken: "token",
        controlGuildId: "guild-id",
        enableModeration: true,
        enableSlashCommands: true,
        adminUserIds: [],
        adminRoleIds: [],
        adminPermissionNames: ["Administrator"],
        maxReplyLength: 1900,
        moderationBanDeleteMessageSeconds: 86400,
        githubDefaultRepos: [],
        ...overrides
    };
}

function makeInteraction(commandName, options = {}) {
    const replies = [];
    let deferred = false;
    let replied = false;
    const values = options.values ?? {};

    const interaction = {
        isChatInputCommand: () => true,
        commandName,
        guildId: "guild-id",
        channelId: "chan",
        user: { id: "mod-id", username: "mod", tag: "mod#1", async send() {} },
        member: { permissions: { has: () => false }, roles: { cache: new Map() } },
        memberPermissions: { has: () => true },
        guild: options.guild,
        options: {
            getString: (name) => values[name] ?? null,
            getInteger: (name) => values[name] ?? null,
            getUser: (name) => values[name] ?? null,
            getRole: (name) => values[name] ?? null,
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

function guildWithBot(extra = {}) {
    return {
        name: "Test Guild",
        members: { me: { permissions: { has: () => true } }, cache: new Map(), async fetch() { return null; } },
        bans: { async create() {} },
        ...extra
    };
}

test("scheduleTask, dueTasks, completeTask, and cancelTask round-trip", () => {
    const store = new BotStore(":memory:");
    const now = Date.now();
    const past = store.scheduleTask({ type: "unban", runAt: now - 1000, guildId: "g", payload: { userId: "u" }, label: "unban u" });
    const future = store.scheduleTask({ type: "unban", runAt: now + 60000, guildId: "g", payload: { userId: "v" } });

    const due = store.dueTasks(now);
    assert.equal(due.length, 1);
    assert.equal(due[0].id, past);
    assert.deepEqual(due[0].payload, { userId: "u" });

    store.completeTask(past);
    assert.equal(store.dueTasks(now).length, 0);

    assert.equal(store.listPendingTasks().length, 1);
    assert.equal(store.cancelTask(future), true);
    assert.equal(store.listPendingTasks().length, 0);
});

test("/ban with a duration schedules an unban", async () => {
    const store = new BotStore(":memory:");
    const bans = [];
    const targetMember = {
        id: "target",
        permissions: { has: () => false },
        roles: { cache: new Map() },
        async ban(o) { bans.push(o); }
    };
    const bot = new DiscordFaqBot(schedulerConfig(), { store });
    const { interaction, replies } = makeInteraction("ban", {
        guild: guildWithBot(),
        members: { user: targetMember },
        values: { user: { id: "target", tag: "target#1" }, duration: "1h", reason: "spam" }
    });

    await bot.handleInteraction(interaction);

    assert.equal(bans.length, 1);
    assert.match(replies[0].content, /Banned <@target> for 1h/);

    const pending = store.listPendingTasks();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].type, "unban");
    assert.equal(pending[0].payload.userId, "target");
});

test("/temprole grants a role and schedules its removal", async () => {
    const store = new BotStore(":memory:");
    const added = [];
    const targetMember = {
        id: "member",
        permissions: { has: () => false },
        roles: { cache: new Map(), async add(roleId) { added.push(roleId); } }
    };
    const bot = new DiscordFaqBot(schedulerConfig(), { store });
    const { interaction, replies } = makeInteraction("temprole", {
        guild: guildWithBot(),
        members: { user: targetMember },
        values: { user: { id: "member", tag: "m#1" }, role: { id: "role-x", name: "VIP" }, duration: "2h" }
    });

    await bot.handleInteraction(interaction);

    assert.deepEqual(added, ["role-x"]);
    assert.match(replies[0].content, /Gave <@member> the VIP role for 2h/);

    const pending = store.listPendingTasks();
    assert.equal(pending[0].type, "role_remove");
    assert.equal(pending[0].payload.roleId, "role-x");
});

test("runDueTasks lifts an expired temp-ban and records it", async () => {
    const store = new BotStore(":memory:");
    const removed = [];
    const bot = new DiscordFaqBot(schedulerConfig(), { store });
    bot.client = {
        guilds: {
            cache: new Map([["guild-id", { id: "guild-id", bans: { async remove(userId) { removed.push(userId); } } }]])
        }
    };
    store.scheduleTask({ type: "unban", runAt: Date.now() - 1000, guildId: "guild-id", payload: { userId: "banned" } });

    await bot.runDueTasks();

    assert.deepEqual(removed, ["banned"]);
    assert.equal(store.listPendingTasks().length, 0);
    const logged = store.listModerationActions({ limit: 5 });
    assert.equal(logged[0].action, "unban");
    assert.equal(logged[0].source, "schedule");
});

test("a failing task is still marked done so it does not loop forever", async () => {
    const store = new BotStore(":memory:");
    const bot = new DiscordFaqBot(schedulerConfig(), { store });
    bot.client = {
        guilds: { cache: new Map([["guild-id", { id: "guild-id", bans: { async remove() { throw new Error("gone"); } } }]]) }
    };
    store.scheduleTask({ type: "unban", runAt: Date.now() - 1000, guildId: "guild-id", payload: { userId: "x" } });

    await bot.runDueTasks();

    assert.equal(store.listPendingTasks().length, 0);
});

test("renderScheduled lists pending tasks with a cancel control", () => {
    const html = renderScheduled({
        theme: "auto",
        session: { username: "a", csrf: "x" },
        tasks: [{ id: 1, type: "unban", run_at: Date.now() + 3600000, label: "unban bob" }]
    });
    assert.match(html, /Temp-ban expiry/);
    assert.match(html, /unban bob/);
    assert.match(html, /\/scheduled\/cancel/);
});
