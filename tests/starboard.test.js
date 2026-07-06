import test from "node:test";
import assert from "node:assert/strict";
import { DiscordFaqBot } from "../src/bot.js";
import { BotStore } from "../src/store.js";

function starboardConfig(overrides = {}) {
    return {
        discordToken: "t",
        controlGuildId: "guild-id",
        starboardEnabled: true,
        starboardChannelId: "star-chan",
        starboardEmoji: "⭐",
        starboardThreshold: 3,
        maxReplyLength: 1900,
        githubDefaultRepos: [],
        ...overrides
    };
}

// Builds a bot whose starboard channel captures posts, and a reaction on a source
// message in the control guild.
function setup(overrides = {}) {
    const store = new BotStore(":memory:");
    const posted = [];
    const starChannel = { async send(payload) { const m = { id: `star-${posted.length + 1}`, ...payload }; posted.push(payload); return m; } };
    const bot = new DiscordFaqBot(starboardConfig(overrides), { store });
    bot.client = {
        guilds: { cache: new Map([["guild-id", { id: "guild-id", channels: { cache: new Map([["star-chan", starChannel]]) } }]]) }
    };
    return { bot, store, posted };
}

function makeReaction({ count = 3, emoji = { name: "⭐" }, channelId = "c1", messageId = "m1" } = {}) {
    return {
        partial: false,
        count,
        emoji,
        message: {
            id: messageId,
            channelId,
            guild: { id: "guild-id" },
            author: { tag: "poster#1" },
            content: "a great message"
        }
    };
}

test("a message that hits the threshold is reposted once", async () => {
    const { bot, store, posted } = setup();

    await bot.handleStarboardReaction(makeReaction({ count: 3 }), { id: "u1", bot: false });
    assert.equal(posted.length, 1);
    assert.match(posted[0].content, /⭐ 3 · <#c1> · poster#1/);
    assert.match(posted[0].content, /a great message/);
    assert.match(posted[0].content, /channels\/guild-id\/c1\/m1/);
    assert.equal(store.getStarboardPost("m1").starboard_message_id, "star-1");

    // A further reaction does not repost.
    await bot.handleStarboardReaction(makeReaction({ count: 5 }), { id: "u2", bot: false });
    assert.equal(posted.length, 1);
});

test("below-threshold reactions do not post", async () => {
    const { bot, posted } = setup();
    await bot.handleStarboardReaction(makeReaction({ count: 2 }), { id: "u1", bot: false });
    assert.equal(posted.length, 0);
});

test("a different emoji is ignored", async () => {
    const { bot, posted } = setup();
    await bot.handleStarboardReaction(makeReaction({ count: 5, emoji: { name: "🔥" } }), { id: "u1", bot: false });
    assert.equal(posted.length, 0);
});

test("reactions in the starboard channel itself are ignored", async () => {
    const { bot, posted } = setup();
    await bot.handleStarboardReaction(makeReaction({ count: 5, channelId: "star-chan" }), { id: "u1", bot: false });
    assert.equal(posted.length, 0);
});

test("starboard stays off when disabled", async () => {
    const { bot, posted } = setup({ starboardEnabled: false });
    await bot.handleStarboardReaction(makeReaction({ count: 9 }), { id: "u1", bot: false });
    assert.equal(posted.length, 0);
});

test("a failed post drops the reservation so it can retry", async () => {
    const store = new BotStore(":memory:");
    const bot = new DiscordFaqBot(starboardConfig(), { store });
    bot.client = {
        guilds: { cache: new Map([["guild-id", { id: "guild-id", channels: { cache: new Map([["star-chan", { async send() { throw new Error("no perms"); } }]]) } }]]) }
    };

    await assert.rejects(() => bot.handleStarboardReaction(makeReaction({ count: 3 }), { id: "u1", bot: false }));
    assert.equal(store.getStarboardPost("m1"), null);
});
