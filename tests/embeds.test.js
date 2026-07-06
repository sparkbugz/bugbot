import test from "node:test";
import assert from "node:assert/strict";
import { buildEmbed, parseColor, isEmptyEmbed } from "../src/embeds.js";
import { renderEmbedComposer } from "../src/adminViews.js";
import { DiscordFaqBot } from "../src/bot.js";

test("parseColor accepts hex with or without a hash and rejects junk", () => {
    assert.equal(parseColor("#5865F2"), 0x5865F2);
    assert.equal(parseColor("5865f2"), 0x5865F2);
    assert.equal(parseColor("blue"), null);
    assert.equal(parseColor(""), null);
});

test("buildEmbed keeps only valid parts and caps lengths", () => {
    const embed = buildEmbed({
        title: "Hi",
        description: "Body",
        color: "#010203",
        url: "https://example.com",
        imageUrl: "not-a-url",
        footer: "  ",
        fields: [
            { name: "A", value: "1", inline: true },
            { name: "", value: "skip" },
            { name: "B", value: "2" }
        ]
    });

    assert.equal(embed.title, "Hi");
    assert.equal(embed.color, 0x010203);
    assert.equal(embed.url, "https://example.com");
    assert.ok(!("image" in embed)); // invalid image url dropped
    assert.ok(!("footer" in embed)); // blank footer dropped
    assert.deepEqual(embed.fields, [
        { name: "A", value: "1", inline: true },
        { name: "B", value: "2", inline: false }
    ]);
});

test("buildEmbed truncates an over-long title", () => {
    const embed = buildEmbed({ title: "x".repeat(300) });
    assert.equal(embed.title.length, 256);
});

test("isEmptyEmbed flags an embed with no title, description, or fields", () => {
    assert.equal(isEmptyEmbed(buildEmbed({ color: "#fff000" })), true);
    assert.equal(isEmptyEmbed(buildEmbed({ description: "hello" })), false);
});

test("postEmbed sends the built embed to the channel", async () => {
    const sent = [];
    const channel = { async send(payload) { sent.push(payload); } };
    const bot = new DiscordFaqBot({ discordToken: "t", controlGuildId: "guild-id", githubDefaultRepos: [] });
    bot.client = { guilds: { cache: new Map([["guild-id", { id: "guild-id", channels: { cache: new Map([["c1", channel]]) } }]]) } };

    const ok = await bot.postEmbed("c1", { title: "Release", description: "v2 is out" });
    assert.equal(ok, true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].embeds[0].title, "Release");
});

test("postEmbed refuses an empty embed", async () => {
    const bot = new DiscordFaqBot({ discordToken: "t", controlGuildId: "guild-id", githubDefaultRepos: [] });
    bot.client = { guilds: { cache: new Map([["guild-id", { id: "guild-id", channels: { cache: new Map() } }]]) } };
    assert.equal(await bot.postEmbed("c1", { color: "#fff000" }), false);
});

test("renderEmbedComposer renders the form with a channel picker", () => {
    const html = renderEmbedComposer({
        theme: "auto",
        session: { username: "a", csrf: "x" },
        directory: { channels: [{ id: "c1", name: "general" }], roles: [] }
    });
    assert.match(html, /Embed builder/);
    assert.match(html, /<select name="channel_id" required>/);
    assert.match(html, /field_name_1/);
    assert.match(html, /\/embed\/send/);
});
