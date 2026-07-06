import test from "node:test";
import assert from "node:assert/strict";
import { DiscordFaqBot } from "../src/bot.js";
import { BotStore } from "../src/store.js";
import { renderScheduled } from "../src/adminViews.js";

function announceConfig() {
    return { discordToken: "t", controlGuildId: "guild-id", githubDefaultRepos: [], maxReplyLength: 1900 };
}

function makeChannel() {
    const sent = [];
    return { sent, async send(payload) { sent.push(payload); } };
}

test("announcement create, list, toggle, and delete round-trip", () => {
    const store = new BotStore(":memory:");
    const id = store.createAnnouncement({ channelId: "c1", message: "hi", intervalSeconds: 86400, nextRun: Date.now() + 1000 });

    let all = store.listAnnouncements();
    assert.equal(all.length, 1);
    assert.equal(all[0].interval_seconds, 86400);

    store.setAnnouncementEnabled(id, false);
    assert.equal(store.listAnnouncements()[0].enabled, 0);
    assert.equal(store.dueAnnouncements(Date.now() + 5000).length, 0); // disabled → not due

    store.setAnnouncementEnabled(id, true);
    assert.equal(store.dueAnnouncements(Date.now() + 5000).length, 1);

    assert.equal(store.deleteAnnouncement(id), true);
    assert.equal(store.listAnnouncements().length, 0);
});

test("a recurring announcement posts and advances its next run", async () => {
    const store = new BotStore(":memory:");
    const channel = makeChannel();
    const bot = new DiscordFaqBot(announceConfig(), { store });
    bot.client = {
        guilds: { cache: new Map([["guild-id", { id: "guild-id", channels: { cache: new Map([["c1", channel]]) } }]]) }
    };

    const id = store.createAnnouncement({ channelId: "c1", message: "daily notice", intervalSeconds: 3600, nextRun: Date.now() - 1000 });

    await bot.runDueAnnouncements();

    assert.equal(channel.sent.length, 1);
    assert.equal(channel.sent[0].content, "daily notice");
    const row = store.listAnnouncements()[0];
    assert.equal(row.enabled, 1); // still recurring
    assert.ok(row.next_run > Date.now()); // advanced into the future
});

test("a one-shot announcement disables itself after firing", async () => {
    const store = new BotStore(":memory:");
    const channel = makeChannel();
    const bot = new DiscordFaqBot(announceConfig(), { store });
    bot.client = {
        guilds: { cache: new Map([["guild-id", { id: "guild-id", channels: { cache: new Map([["c1", channel]]) } }]]) }
    };
    store.createAnnouncement({ channelId: "c1", message: "one time", intervalSeconds: 0, nextRun: Date.now() - 1000 });

    await bot.runDueAnnouncements();
    await bot.runDueAnnouncements(); // second sweep must not repost

    assert.equal(channel.sent.length, 1);
    assert.equal(store.listAnnouncements()[0].enabled, 0);
});

test("renderScheduled shows the announcement form and rows", () => {
    const html = renderScheduled({
        theme: "auto",
        session: { username: "a", csrf: "x" },
        tasks: [],
        announcements: [{ id: 1, channel_id: "c1", message: "notice", interval_seconds: 86400, next_run: Date.now() + 3600000, enabled: 1 }],
        directory: { channels: [{ id: "c1", name: "general" }], roles: [] }
    });
    assert.match(html, /New announcement/);
    assert.match(html, /Daily/);
    assert.match(html, /general/);
    assert.match(html, /\/announcements\/create/);
});
