import test from "node:test";
import assert from "node:assert/strict";
import { DiscordFaqBot } from "../src/bot.js";
import { BotStore } from "../src/store.js";

function engagementConfig(overrides = {}) {
    return {
        discordToken: "token",
        controlGuildId: "g",
        autoRoleIds: [],
        welcomeEnabled: false,
        welcomeChannelId: null,
        welcomeMessage: "Welcome {mention} to {server}! You are member #{count}.",
        goodbyeEnabled: false,
        goodbyeChannelId: null,
        goodbyeMessage: "{user} has left.",
        loggingEnabled: false,
        logChannelId: null,
        logMessageDeletes: true,
        logMessageEdits: true,
        logJoinsLeaves: true,
        maxReplyLength: 1900,
        githubDefaultRepos: [],
        ...overrides
    };
}

function makeChannel() {
    const sent = [];
    return { sent, async send(payload) { sent.push(payload); } };
}

function makeGuild(channels = {}) {
    return { id: "g", name: "Test Guild", memberCount: 42, channels: { cache: new Map(Object.entries(channels)) } };
}

function makeMember(guild, roleAdd) {
    return {
        id: "111",
        guild,
        user: { id: "111", username: "newbie", tag: "newbie#0001" },
        roles: { add: roleAdd ?? (async () => {}) }
    };
}

test("welcome posts a rendered message and pings only the new member", async () => {
    const welcome = makeChannel();
    const bot = new DiscordFaqBot(engagementConfig({ welcomeEnabled: true, welcomeChannelId: "wc" }));

    await bot.handleMemberJoin(makeMember(makeGuild({ wc: welcome })));

    assert.equal(welcome.sent.length, 1);
    assert.equal(welcome.sent[0].content, "Welcome <@111> to Test Guild! You are member #42.");
    assert.deepEqual(welcome.sent[0].allowedMentions, { parse: ["users"] });
});

test("auto-roles are applied on join", async () => {
    const added = [];
    const bot = new DiscordFaqBot(engagementConfig({ autoRoleIds: ["role-a", "role-b"] }));

    await bot.handleMemberJoin(makeMember(makeGuild(), async (roleId) => { added.push(roleId); }));

    assert.deepEqual(added, ["role-a", "role-b"]);
});

test("goodbye posts when a member leaves", async () => {
    const goodbye = makeChannel();
    const bot = new DiscordFaqBot(engagementConfig({ goodbyeEnabled: true, goodbyeChannelId: "gc" }));

    await bot.handleMemberLeave(makeMember(makeGuild({ gc: goodbye })));

    assert.equal(goodbye.sent[0].content, "newbie has left.");
});

test("message deletes are logged when logging is on", async () => {
    const log = makeChannel();
    const bot = new DiscordFaqBot(engagementConfig({ loggingEnabled: true, logChannelId: "lc" }));

    await bot.handleMessageDelete({
        guild: makeGuild({ lc: log }), channelId: "c123",
        author: { tag: "spammer#1", bot: false }, content: "buy my thing"
    });

    assert.equal(log.sent.length, 1);
    assert.match(log.sent[0].content, /Deleted — spammer#1 in <#c123>: buy my thing/);
});

test("logging stays silent when disabled or for bot authors", async () => {
    const log = makeChannel();
    const off = new DiscordFaqBot(engagementConfig({ loggingEnabled: false, logChannelId: "lc" }));
    await off.handleMessageDelete({ guild: makeGuild({ lc: log }), channelId: "c", author: { tag: "x", bot: false }, content: "hi" });
    assert.equal(log.sent.length, 0);

    const on = new DiscordFaqBot(engagementConfig({ loggingEnabled: true, logChannelId: "lc" }));
    await on.handleMessageDelete({ guild: makeGuild({ lc: log }), channelId: "c", author: { tag: "bot", bot: true }, content: "hi" });
    assert.equal(log.sent.length, 0);
});

test("reacting with a mapped emoji grants the role, un-reacting removes it", async () => {
    const store = new BotStore(":memory:");
    store.saveReactionRole({ messageId: "m1", emoji: "✅", roleId: "role-x", guildId: "g" });
    const bot = new DiscordFaqBot(engagementConfig({ reactionRolesEnabled: true }), { store });

    const added = [];
    const removed = [];
    const member = { roles: { add: async (r) => added.push(r), remove: async (r) => removed.push(r) } };
    const reaction = { partial: false, emoji: { name: "✅" }, message: { id: "m1", guild: { id: "g", members: { fetch: async () => member } } } };

    await bot.handleReactionRole(reaction, { id: "u1", bot: false }, true);
    assert.deepEqual(added, ["role-x"]);

    await bot.handleReactionRole(reaction, { id: "u1", bot: false }, false);
    assert.deepEqual(removed, ["role-x"]);

    // An unmapped emoji does nothing.
    const other = { partial: false, emoji: { name: "❌" }, message: reaction.message };
    await bot.handleReactionRole(other, { id: "u1", bot: false }, true);
    assert.deepEqual(added, ["role-x"]);
});
