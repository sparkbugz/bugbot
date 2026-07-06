import test from "node:test";
import assert from "node:assert/strict";
import { xpForNextLevel, totalXpForLevel, levelFromXp, levelProgress, parseLevelRoles } from "../src/leveling.js";
import { BotStore } from "../src/store.js";
import { DiscordFaqBot } from "../src/bot.js";

test("level curve is cumulative and monotonic", () => {
    assert.equal(xpForNextLevel(0), 100);
    assert.equal(totalXpForLevel(1), 100);
    assert.equal(levelFromXp(0), 0);
    assert.equal(levelFromXp(99), 0);
    assert.equal(levelFromXp(100), 1);
    assert.ok(totalXpForLevel(5) > totalXpForLevel(4));
});

test("levelProgress reports position within the level", () => {
    const progress = levelProgress(100);
    assert.equal(progress.level, 1);
    assert.equal(progress.into, 0);
    assert.equal(progress.needed, xpForNextLevel(1));
});

test("parseLevelRoles keeps valid level:roleId pairs only", () => {
    const map = parseLevelRoles(["5:123456789012345", "garbage", "10:987654321098765"]);
    assert.equal(map.size, 2);
    assert.equal(map.get(5), "123456789012345");
    assert.equal(map.get(10), "987654321098765");
});

test("store accumulates XP, levels up, ranks, and orders the leaderboard", () => {
    const db = new BotStore(":memory:");
    db.addXp("g", "u1", 100);
    const u1 = db.getUserLevel("g", "u1");
    assert.equal(u1.level, 1);
    assert.equal(u1.messages, 1);

    db.addXp("g", "u2", 400);
    const top = db.topLevels("g", 10);
    assert.equal(top[0].user_id, "u2");
    assert.equal(top[0].rank, 1);
    assert.equal(db.userRank("g", "u1"), 2);
});

function levelingConfig(overrides = {}) {
    return {
        discordToken: "t", controlGuildId: "g", managementCommandPrefix: "!faqbot",
        levelingEnabled: true, xpPerMessage: 100, xpCooldownSeconds: 60,
        levelUpEnabled: true, levelUpChannelId: null, levelUpMessage: "GG {mention}, level {level}!",
        levelRoles: [], maxReplyLength: 1900, githubDefaultRepos: [], ...overrides
    };
}

function makeMessage(content, replies, channelSent) {
    return {
        guild: { id: "g" },
        author: { id: "u1", bot: false },
        member: { roles: { add: async () => {} } },
        channel: { async send(payload) { channelSent.push(payload); } },
        content,
        async reply(payload) { replies.push(payload); }
    };
}

test("awarding XP levels a member up and announces it once", async () => {
    const store = new BotStore(":memory:");
    const bot = new DiscordFaqBot(levelingConfig(), { store });
    const channelSent = [];

    await bot.awardXpForMessage(makeMessage("hello", [], channelSent));

    assert.equal(store.getUserLevel("g", "u1").level, 1);
    assert.equal(channelSent.length, 1);
    assert.match(channelSent[0].content, /GG <@u1>, level 1!/);

    // Same user again within the cooldown earns nothing more.
    await bot.awardXpForMessage(makeMessage("hi again", [], channelSent));
    assert.equal(store.getUserLevel("g", "u1").xp, 100);
});

test("rank and leaderboard commands report standings", async () => {
    const store = new BotStore(":memory:");
    store.addXp("g", "u1", 250);
    const bot = new DiscordFaqBot(levelingConfig(), { store });
    const replies = [];

    assert.equal(await bot.handleLevelingCommand(makeMessage("!faqbot rank", replies, [])), true);
    assert.match(replies[0].content, /level 1 \(rank #1\)/);

    assert.equal(await bot.handleLevelingCommand(makeMessage("!faqbot leaderboard", replies, [])), true);
    assert.match(replies[1].content, /Leaderboard/);
    assert.match(replies[1].content, /<@u1>/);
});
