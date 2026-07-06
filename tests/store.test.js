import test from "node:test";
import assert from "node:assert/strict";
import { BotStore } from "../src/store.js";

function store() {
    return new BotStore(":memory:");
}

test("records a ban as reversible and flips it on undo", () => {
    const db = store();
    const id = db.recordModerationAction({
        action: "ban", targetUserId: "42", guildId: "g", channelId: "c",
        source: "auto", reason: "scam", matched: "wallet-scam"
    });

    assert.equal(db.listModerationActions({ undoableOnly: true }).length, 1);

    db.markModerationUndone(id, { undoneBy: "admin", note: "appeal upheld" });
    const row = db.getModerationAction(id);

    assert.ok(row.undone_at);
    assert.equal(row.undone_by, "admin");
    assert.equal(db.listModerationActions({ undoableOnly: true }).length, 0);
});

test("kicks and dry-run matches are not reversible", () => {
    const db = store();
    db.recordModerationAction({ action: "kick", targetUserId: "1", source: "command" });
    db.recordModerationAction({ action: "ban", targetUserId: "2", source: "auto", dryRun: true });

    assert.equal(db.listModerationActions({ undoableOnly: true }).length, 0);
});

test("moderation summary counts totals, bans, and reversible actions", () => {
    const db = store();
    db.recordModerationAction({ action: "ban", targetUserId: "1", source: "auto" });
    db.recordModerationAction({ action: "ban", targetUserId: "2", source: "auto" });
    db.recordModerationAction({ action: "warn", targetUserId: "3", source: "command" });

    const summary = db.moderationSummary();
    assert.equal(summary.total, 3);
    assert.equal(summary.bans, 2);
    assert.equal(summary.reversible, 2);
});

test("filters the moderation log by action", () => {
    const db = store();
    db.recordModerationAction({ action: "ban", targetUserId: "1", source: "auto" });
    db.recordModerationAction({ action: "kick", targetUserId: "2", source: "command" });

    const bans = db.listModerationActions({ action: "ban" });
    assert.equal(bans.length, 1);
    assert.equal(bans[0].target_user_id, "1");
});

test("FAQ entries round-trip with enabled state and ordering", () => {
    const db = store();
    db.saveFaqEntry({ id: "b", answer: "second", position: 2 });
    db.saveFaqEntry({ id: "a", answer: "first", position: 1, enabled: false });

    const entries = db.listFaqEntries();
    assert.deepEqual(entries.map((entry) => entry.id), ["a", "b"]);
    assert.equal(entries[0].enabled, false);
    assert.equal(db.getFaqEntry("b").answer, "second");

    assert.equal(db.deleteFaqEntry("a"), true);
    assert.equal(db.faqCount(), 1);
});

test("seeds FAQ entries only when the table is empty", () => {
    const db = store();
    const seeded = db.seedFaqEntries([
        { question: "How do I reset?", answer: "Do the thing." },
        { id: "explicit", answer: "Already has an id." }
    ]);

    assert.equal(seeded, 2);
    assert.equal(db.faqCount(), 2);
    // A second seed is a no-op because the table is no longer empty.
    assert.equal(db.seedFaqEntries([{ id: "z", answer: "nope" }]), 0);
    assert.equal(db.faqCount(), 2);
});

test("settings persist and read back", () => {
    const db = store();
    db.setSetting("matchThreshold", "0.85");
    assert.equal(db.getSetting("matchThreshold"), "0.85");
    assert.deepEqual(db.allSettings(), { matchThreshold: "0.85" });
});

test("moderation rules round-trip and seed only once", () => {
    const db = store();
    const seeded = db.seedModerationRules([
        { id: "a", action: "ban", match: { anyPhrases: ["free nitro"] } },
        { action: "timeout", match: { anyTerms: ["airdrop"] } }
    ]);

    assert.equal(seeded, 2);
    assert.equal(db.moderationRuleCount(), 2);
    assert.equal(db.getModerationRule("a").action, "ban");
    // Second seed is a no-op.
    assert.equal(db.seedModerationRules([{ id: "z", action: "kick" }]), 0);

    db.saveModerationRule({ id: "a", action: "kick", match: { anyPhrases: ["free nitro"] } });
    assert.equal(db.getModerationRule("a").action, "kick");
    assert.equal(db.deleteModerationRule("a"), true);
    assert.equal(db.moderationRuleCount(), 1);
});

test("reaction-role mappings round-trip and upsert", () => {
    const db = store();
    db.saveReactionRole({ messageId: "m1", emoji: "✅", roleId: "r1", channelId: "c1", guildId: "g" });
    assert.equal(db.reactionRoleCount(), 1);
    assert.equal(db.getReactionRole("m1", "✅").role_id, "r1");

    db.saveReactionRole({ messageId: "m1", emoji: "✅", roleId: "r2" });
    assert.equal(db.getReactionRole("m1", "✅").role_id, "r2");

    assert.equal(db.deleteReactionRole("m1", "✅"), true);
    assert.equal(db.reactionRoleCount(), 0);
});

test("moderation globals assemble with the rules list", () => {
    const db = store();
    db.setModerationGlobals({ blockedDomains: ["evil.example"], maxMentions: 6 });
    db.saveModerationRule({ id: "r", action: "ban", position: 0, match: { anyPhrases: ["scam"] } });

    const assembled = db.assembleModerationRules({ blockedDomainAction: "ban" });
    assert.deepEqual(assembled.blockedDomains, ["evil.example"]);
    assert.equal(assembled.maxMentions, 6);
    assert.equal(assembled.blockedDomainAction, "ban");
    assert.equal(assembled.rules.length, 1);
    assert.equal(assembled.rules[0].id, "r");
});
