import test from "node:test";
import assert from "node:assert/strict";
import { BotStore } from "../src/store.js";
import { dayKey, lastNDays } from "../src/util.js";
import { renderAnalytics } from "../src/adminViews.js";

const DAY = 24 * 60 * 60 * 1000;

test("dayKey and lastNDays produce ordered UTC day keys", () => {
    const from = new Date("2026-03-10T12:00:00.000Z");
    assert.equal(dayKey(from), "2026-03-10");

    const days = lastNDays(3, from);
    assert.deepEqual(days, ["2026-03-08", "2026-03-09", "2026-03-10"]);
});

test("bumpStat accumulates per day and buckets by key", () => {
    const store = new BotStore(":memory:");
    const t0 = Date.parse("2026-03-10T08:00:00.000Z");

    store.bumpStat("messages", "", 1, t0);
    store.bumpStat("messages", "", 2, t0);
    store.bumpStat("messages", "", 5, t0 - DAY);
    store.bumpStat("faq_answer", "reset", 1, t0);
    store.bumpStat("faq_answer", "reset", 1, t0);
    store.bumpStat("faq_answer", "install", 1, t0);

    const series = store.statSeries("messages", "2026-03-09").map((row) => [row.day, row.total]);
    assert.deepEqual(series, [["2026-03-09", 5], ["2026-03-10", 3]]);

    assert.equal(store.statTotal("messages", "2026-03-09"), 8);
    assert.equal(store.statTotal("messages", "2026-03-10"), 3);

    const top = store.statTopKeys("faq_answer", 5, "2026-03-01").map((row) => [row.key, row.total]);
    assert.deepEqual(top, [["reset", 2], ["install", 1]]);
});

test("moderationDaily counts enforced actions by UTC day", () => {
    const store = new BotStore(":memory:");
    const base = { guildId: "g", channelId: "c", targetUserId: "u", action: "ban", source: "auto" };

    // Two enforced bans and one dry-run; only the enforced ones count.
    store.recordModerationAction({ ...base });
    store.recordModerationAction({ ...base });
    store.recordModerationAction({ ...base, dryRun: true });

    const rows = store.moderationDaily(Date.now() - (2 * DAY));
    const total = rows.reduce((sum, row) => sum + row.total, 0);
    assert.equal(total, 2);
    assert.equal(rows[0].day, dayKey(new Date()));
});

test("renderAnalytics shows tiles, bars, and top lists", () => {
    const html = renderAnalytics({
        theme: "auto",
        session: { username: "admin", csrf: "x" },
        enabled: true,
        windowDays: 14,
        tiles: { messages: 42, faqAnswers: 7, modActions: 3, xp: 1500 },
        messages: [{ day: "2026-03-09", count: 10 }, { day: "2026-03-10", count: 20 }],
        mod: [{ day: "2026-03-09", count: 1 }, { day: "2026-03-10", count: 2 }],
        xp: [{ day: "2026-03-09", count: 100 }, { day: "2026-03-10", count: 200 }],
        faqAnswers: [{ day: "2026-03-09", count: 3 }, { day: "2026-03-10", count: 4 }],
        topFaqs: [{ key: "reset", total: 5 }],
        topCommands: [{ key: "rank", total: 9 }]
    });

    assert.match(html, /Messages seen/);
    assert.match(html, /42/);
    assert.match(html, /class="bar/);
    assert.match(html, /reset/);
    assert.match(html, /rank/);
    // The busiest messages day sets the peak label.
    assert.match(html, /peak 20/);
});

test("renderAnalytics degrades gracefully without a store", () => {
    const html = renderAnalytics({ theme: "auto", session: { username: "a", csrf: "x" }, enabled: false });
    assert.match(html, /No stats store is available/);
});
