import test from "node:test";
import assert from "node:assert/strict";
import { matchCustomCommand, normalizeTrigger } from "../src/customCommands.js";
import { BotStore } from "../src/store.js";
import { DiscordFaqBot } from "../src/bot.js";

test("normalizeTrigger lower-cases, trims, and collapses spaces but keeps punctuation", () => {
    assert.equal(normalizeTrigger("  !Rules   Now "), "!rules now");
});

test("exact match requires the whole message to equal the trigger", () => {
    const commands = [{ id: "rules", trigger: "!rules", matchType: "exact", response: "Read #rules." }];
    assert.equal(matchCustomCommand(commands, "!rules")?.id, "rules");
    assert.equal(matchCustomCommand(commands, "what are the !rules"), null);
});

test("starts and contains matching work", () => {
    const commands = [
        { id: "hi", trigger: "hello", matchType: "starts", response: "Hi!" },
        { id: "ip", trigger: "server ip", matchType: "contains", response: "play.example" }
    ];
    assert.equal(matchCustomCommand(commands, "hello there")?.id, "hi");
    assert.equal(matchCustomCommand(commands, "what is the server ip please")?.id, "ip");
});

test("precise triggers win over a broad contains rule", () => {
    const commands = [
        { id: "broad", trigger: "help", matchType: "contains", response: "generic" },
        { id: "exact", trigger: "help", matchType: "exact", response: "specific" }
    ];
    assert.equal(matchCustomCommand(commands, "help")?.id, "exact");
});

test("disabled commands never match", () => {
    const commands = [{ id: "off", trigger: "!x", matchType: "exact", response: "no", enabled: false }];
    assert.equal(matchCustomCommand(commands, "!x"), null);
});

function botConfig(overrides = {}) {
    return {
        discordToken: "t",
        controlGuildId: "guild-id",
        enableFaq: true,
        enableCustomCommands: true,
        customCommands: [],
        allowedChannelIds: ["chan"],
        ignoredChannelIds: [],
        matchThreshold: 0.72,
        maxMessageLength: 1000,
        maxReplyLength: 1900,
        userMessageCooldownSeconds: 0,
        responseCooldownSeconds: 900,
        questionOnlyMode: false,
        githubDefaultRepos: [],
        faqEntries: [],
        ...overrides
    };
}

function makeMessage(content) {
    const replies = [];
    const message = {
        guild: { id: "guild-id", name: "g" },
        author: { id: "u", bot: false },
        member: { permissions: { has: () => false }, roles: { cache: new Map() } },
        channelId: "chan",
        content,
        async reply(payload) { replies.push(payload); }
    };
    return { message, replies };
}

test("the bot answers a custom command before FAQ and records a stat", async () => {
    const store = new BotStore(":memory:");
    store.saveCustomCommand({ id: "rules", trigger: "!rules", matchType: "exact", response: "See the pinned rules." });
    const bot = new DiscordFaqBot(botConfig({ customCommands: store.listCustomCommands() }), { store });
    const { message, replies } = makeMessage("!rules");

    await bot.handleMessage(message);

    assert.equal(replies.length, 1);
    assert.equal(replies[0].content, "See the pinned rules.");
    assert.equal(store.statTopKeys("custom_command", 5, "2000-01-01")[0].key, "rules");
});

test("reloadCustomCommands refreshes the cached list", () => {
    const store = new BotStore(":memory:");
    const bot = new DiscordFaqBot(botConfig(), { store });
    store.saveCustomCommand({ id: "a", trigger: "a", matchType: "exact", response: "b" });

    assert.equal(bot.reloadCustomCommands(), 1);
    assert.equal(bot.config.customCommands.length, 1);
});
