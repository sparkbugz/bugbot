import test from "node:test";
import assert from "node:assert/strict";
import { parsePollOptions, buildPoll, NUMBER_EMOJIS } from "../src/polls.js";
import { pickWinners, normalizeWinnerCount, buildGiveawayResult } from "../src/giveaways.js";
import { DiscordFaqBot } from "../src/bot.js";
import { BotStore } from "../src/store.js";

test("parsePollOptions splits, trims, and caps at ten", () => {
    assert.deepEqual(parsePollOptions("a, b | c"), ["a", "b", "c"]);
    assert.equal(parsePollOptions("").length, 0);
    assert.equal(parsePollOptions(Array.from({ length: 15 }, (_, i) => `o${i}`).join(",")).length, 10);
});

test("buildPoll makes a yes/no poll with no options and numbered otherwise", () => {
    const yesNo = buildPoll("Pizza?", []);
    assert.deepEqual(yesNo.emojis, ["👍", "👎"]);

    const numbered = buildPoll("Best?", ["x", "y"]);
    assert.deepEqual(numbered.emojis, NUMBER_EMOJIS.slice(0, 2));
    assert.match(numbered.content, /1️⃣ x/);
    assert.match(numbered.content, /2️⃣ y/);
});

test("normalizeWinnerCount clamps to a sane range", () => {
    assert.equal(normalizeWinnerCount(0), 1);
    assert.equal(normalizeWinnerCount(3), 3);
    assert.equal(normalizeWinnerCount(999), 20);
    assert.equal(normalizeWinnerCount("nope"), 1);
});

test("pickWinners returns distinct winners and never more than the pool", () => {
    const seq = [0, 0, 0];
    const random = () => seq.shift() ?? 0;
    const winners = pickWinners(["a", "b", "c"], 2, random);
    assert.equal(winners.length, 2);
    assert.equal(new Set(winners).size, 2);

    assert.deepEqual(pickWinners(["only"], 5), ["only"]);
    assert.deepEqual(pickWinners([], 3), []);
});

test("buildGiveawayResult handles winners and empty entries", () => {
    assert.match(buildGiveawayResult("Steam key", ["u1", "u2"]), /<@u1>, <@u2>/);
    assert.match(buildGiveawayResult("Steam key", []), /no winner/);
});

function config(overrides = {}) {
    return {
        discordToken: "t",
        controlGuildId: "guild-id",
        enablePolls: true,
        enableGiveaways: true,
        adminUserIds: [],
        adminRoleIds: [],
        adminPermissionNames: ["Administrator"],
        maxReplyLength: 1900,
        githubDefaultRepos: [],
        ...overrides
    };
}

function makeInteraction(commandName, values = {}) {
    const replies = [];
    const reactions = [];
    const message = { id: "poll-msg", async react(e) { reactions.push(e); } };
    return {
        reactions,
        replies,
        interaction: {
            isChatInputCommand: () => true,
            commandName,
            guildId: "guild-id",
            channelId: "chan",
            user: { id: "mod", username: "mod", tag: "mod#1" },
            member: { permissions: { has: () => false }, roles: { cache: new Map() } },
            memberPermissions: { has: () => true },
            options: {
                getString: (n) => values[n] ?? null,
                getInteger: (n) => values[n] ?? null,
                getUser: () => null,
                getRole: () => null,
                getMember: () => null
            },
            deferred: false,
            replied: false,
            async reply(payload) { replies.push(payload); },
            async fetchReply() { return message; },
            async editReply(payload) { replies.push(payload); }
        }
    };
}

test("/poll posts the poll and seeds the reactions", async () => {
    const bot = new DiscordFaqBot(config());
    const { interaction, replies, reactions } = makeInteraction("poll", { question: "Deploy today?", options: "yes, no, maybe" });

    await bot.handleInteraction(interaction);

    assert.match(replies[0].content, /📊 Deploy today\?/);
    assert.deepEqual(reactions, NUMBER_EMOJIS.slice(0, 3));
});

test("/giveaway announces, reacts, and schedules the draw", async () => {
    const store = new BotStore(":memory:");
    const bot = new DiscordFaqBot(config(), { store });
    const { interaction, replies, reactions } = makeInteraction("giveaway", { duration: "1h", prize: "a mug", winners: 2 });

    await bot.handleInteraction(interaction);

    assert.match(replies[0].content, /Giveaway/);
    assert.deepEqual(reactions, ["🎉"]);

    const pending = store.listPendingTasks();
    assert.equal(pending[0].type, "giveaway_end");
    assert.equal(pending[0].payload.prize, "a mug");
    assert.equal(pending[0].payload.winners, 2);
});

test("drawGiveaway picks from the reactors and announces", async () => {
    const store = new BotStore(":memory:");
    const bot = new DiscordFaqBot(config(), { store });
    const sent = [];
    const giveawayMessage = {
        id: "g1",
        reactions: {
            cache: new Map([["🎉", {
                users: { async fetch() { return new Map([["a", { id: "a", bot: false }], ["b", { id: "b", bot: false }], ["bot", { id: "bot", bot: true }]]); } }
            }]])
        }
    };
    const channel = { messages: { async fetch() { return giveawayMessage; } }, async send(p) { sent.push(p); } };
    bot.client = { guilds: { cache: new Map([["guild-id", { id: "guild-id", channels: { cache: new Map([["chan", channel]]) } }]]) } };

    await bot.drawGiveaway({ guild_id: "guild-id", payload: { channelId: "chan", messageId: "g1", prize: "a mug", winners: 1 } });

    assert.equal(sent.length, 1);
    assert.match(sent[0].content, /Giveaway ended — \*\*a mug\*\*/);
    // The winner is one of the two non-bot reactors.
    assert.match(sent[0].content, /<@(a|b)>/);
});
