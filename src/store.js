// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SparkBugz

import { DatabaseSync } from "node:sqlite";
import { levelFromXp } from "./leveling.js";

// Durable state for the bot, backed by the built-in node:sqlite engine (no
// native dependency to build or ship). Three things live here that must survive
// a restart: the moderation audit log (with undo state), the editable FAQ list,
// and admin-tunable settings. Everything the admin panel reads or writes goes
// through this class so there is a single source of truth.

const SCHEMA = `
CREATE TABLE IF NOT EXISTS moderation_actions (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at        INTEGER NOT NULL,
    guild_id          TEXT,
    channel_id        TEXT,
    target_user_id    TEXT,
    target_tag        TEXT,
    moderator_id      TEXT,
    moderator_tag     TEXT,
    source            TEXT NOT NULL,
    action            TEXT NOT NULL,
    reason            TEXT,
    rule_id           TEXT,
    matched           TEXT,
    message_excerpt   TEXT,
    dry_run           INTEGER NOT NULL DEFAULT 0,
    success           INTEGER NOT NULL DEFAULT 1,
    undoable          INTEGER NOT NULL DEFAULT 0,
    undone_at         INTEGER,
    undone_by         TEXT,
    undo_note         TEXT
);
CREATE INDEX IF NOT EXISTS idx_mod_created ON moderation_actions (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mod_target ON moderation_actions (target_user_id);

CREATE TABLE IF NOT EXISTS faq_entries (
    id          TEXT PRIMARY KEY,
    enabled     INTEGER NOT NULL DEFAULT 1,
    position    INTEGER NOT NULL DEFAULT 0,
    data        TEXT NOT NULL,
    updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS moderation_rules (
    id          TEXT PRIMARY KEY,
    enabled     INTEGER NOT NULL DEFAULT 1,
    position    INTEGER NOT NULL DEFAULT 0,
    data        TEXT NOT NULL,
    updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS custom_commands (
    id          TEXT PRIMARY KEY,
    enabled     INTEGER NOT NULL DEFAULT 1,
    position    INTEGER NOT NULL DEFAULT 0,
    data        TEXT NOT NULL,
    updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
    key         TEXT PRIMARY KEY,
    value       TEXT,
    updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS reaction_roles (
    message_id  TEXT NOT NULL,
    emoji       TEXT NOT NULL,
    role_id     TEXT NOT NULL,
    channel_id  TEXT,
    guild_id    TEXT,
    updated_at  INTEGER NOT NULL,
    PRIMARY KEY (message_id, emoji)
);

CREATE TABLE IF NOT EXISTS starboard_posts (
    source_message_id     TEXT PRIMARY KEY,
    starboard_message_id  TEXT,
    created_at            INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS user_levels (
    guild_id    TEXT NOT NULL,
    user_id     TEXT NOT NULL,
    xp          INTEGER NOT NULL DEFAULT 0,
    messages    INTEGER NOT NULL DEFAULT 0,
    updated_at  INTEGER NOT NULL,
    PRIMARY KEY (guild_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_levels_guild_xp ON user_levels (guild_id, xp DESC);

CREATE TABLE IF NOT EXISTS audit_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at  INTEGER NOT NULL,
    actor_id    TEXT,
    actor_name  TEXT,
    action      TEXT NOT NULL,
    detail      TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log (created_at DESC);

CREATE TABLE IF NOT EXISTS stats_daily (
    day         TEXT NOT NULL,
    metric      TEXT NOT NULL,
    key         TEXT NOT NULL DEFAULT '',
    count       INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, metric, key)
);
CREATE INDEX IF NOT EXISTS idx_stats_metric ON stats_daily (metric, day);

CREATE TABLE IF NOT EXISTS scheduled_tasks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    type        TEXT NOT NULL,
    run_at      INTEGER NOT NULL,
    guild_id    TEXT,
    payload     TEXT,
    label       TEXT,
    created_at  INTEGER NOT NULL,
    done_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tasks_due ON scheduled_tasks (done_at, run_at);

CREATE TABLE IF NOT EXISTS announcements (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id        TEXT NOT NULL,
    message           TEXT NOT NULL,
    interval_seconds  INTEGER NOT NULL DEFAULT 0,
    next_run          INTEGER NOT NULL,
    enabled           INTEGER NOT NULL DEFAULT 1,
    created_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ann_due ON announcements (enabled, next_run);

CREATE TABLE IF NOT EXISTS access_grants (
    subject_type  TEXT NOT NULL,
    subject_id    TEXT NOT NULL,
    areas         TEXT NOT NULL,
    label         TEXT,
    created_by    TEXT,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    PRIMARY KEY (subject_type, subject_id)
);

CREATE TABLE IF NOT EXISTS admin_blocks (
    subject_type  TEXT NOT NULL,
    subject_id    TEXT NOT NULL,
    label         TEXT,
    created_by    TEXT,
    created_at    INTEGER NOT NULL,
    PRIMARY KEY (subject_type, subject_id)
);

-- Control channel between the panel process and the bot process. The panel
-- enqueues an action it cannot perform itself (it holds no Discord gateway);
-- the bot drains the queue, runs it against its live client, and writes the
-- result back for the panel's request to pick up.
CREATE TABLE IF NOT EXISTS bot_commands (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    kind        TEXT NOT NULL,
    payload     TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending',
    result      TEXT,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);
`;

// A UTC calendar day key (YYYY-MM-DD) for a timestamp, so rollups line up with
// the day boundaries the analytics page draws.
function dayKeyOf(at) {
    return new Date(at).toISOString().slice(0, 10);
}

// Bans and timeouts can be lifted again; kicks, warns, deletes and log-only
// entries have nothing to reverse.
const UNDOABLE_ACTIONS = new Set(["ban", "timeout"]);

// Reads a settings value that holds a JSON document, tolerating an absent or
// corrupt value by returning null rather than throwing.
function parseJsonSetting(value) {
    if (value === null || value === undefined) {
        return null;
    }

    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}

export class BotStore {
    constructor(databasePath) {
        this.db = new DatabaseSync(databasePath);
        this.db.exec("PRAGMA journal_mode = WAL;");
        this.db.exec("PRAGMA foreign_keys = ON;");
        this.db.exec(SCHEMA);
    }

    close() {
        this.db.close();
    }

    // --- Moderation log -----------------------------------------------------

    recordModerationAction(entry) {
        const statement = this.db.prepare(`
            INSERT INTO moderation_actions (
                created_at, guild_id, channel_id, target_user_id, target_tag,
                moderator_id, moderator_tag, source, action, reason, rule_id,
                matched, message_excerpt, dry_run, success, undoable
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const result = statement.run(
            Date.now(),
            entry.guildId ?? null,
            entry.channelId ?? null,
            entry.targetUserId ?? null,
            entry.targetTag ?? null,
            entry.moderatorId ?? null,
            entry.moderatorTag ?? null,
            entry.source ?? "auto",
            entry.action,
            entry.reason ?? null,
            entry.ruleId ?? null,
            entry.matched ?? null,
            entry.messageExcerpt ?? null,
            entry.dryRun ? 1 : 0,
            entry.success === false ? 0 : 1,
            UNDOABLE_ACTIONS.has(entry.action) && entry.success !== false && !entry.dryRun ? 1 : 0
        );

        return Number(result.lastInsertRowid);
    }

    listModerationActions({ limit = 100, offset = 0, action = null, undoableOnly = false } = {}) {
        const clauses = [];
        const params = [];

        if (action) {
            clauses.push("action = ?");
            params.push(action);
        }

        if (undoableOnly) {
            clauses.push("undoable = 1 AND undone_at IS NULL");
        }

        const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
        params.push(limit, offset);

        return this.db.prepare(`
            SELECT * FROM moderation_actions
            ${where}
            ORDER BY created_at DESC
            LIMIT ? OFFSET ?
        `).all(...params);
    }

    getModerationAction(id) {
        return this.db.prepare("SELECT * FROM moderation_actions WHERE id = ?").get(id) ?? null;
    }

    markModerationUndone(id, { undoneBy = null, note = null } = {}) {
        this.db.prepare(`
            UPDATE moderation_actions
            SET undone_at = ?, undone_by = ?, undo_note = ?, undoable = 0
            WHERE id = ? AND undone_at IS NULL
        `).run(Date.now(), undoneBy, note, id);
    }

    moderationSummary() {
        const row = this.db.prepare(`
            SELECT
                COUNT(*) AS total,
                SUM(CASE WHEN action = 'ban' THEN 1 ELSE 0 END) AS bans,
                SUM(CASE WHEN undoable = 1 AND undone_at IS NULL THEN 1 ELSE 0 END) AS reversible,
                SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS last24h
            FROM moderation_actions
        `).get(Date.now() - (24 * 60 * 60 * 1000));

        return {
            total: row.total ?? 0,
            bans: row.bans ?? 0,
            reversible: row.reversible ?? 0,
            last24h: row.last24h ?? 0
        };
    }

    // --- FAQ entries --------------------------------------------------------

    // FAQ entries and moderation rules are both ordered, id-keyed collections of
    // JSON documents, so they share these helpers. `enabled` and `position` are
    // mirrored into columns for filtering and ordering; the full document lives
    // in `data`.
    #listDocs(table) {
        return this.db.prepare(`SELECT id, enabled, data FROM ${table} ORDER BY position ASC, id ASC`)
            .all()
            .map((row) => ({ ...JSON.parse(row.data), id: row.id, enabled: row.enabled === 1 }));
    }

    #getDoc(table, id) {
        const row = this.db.prepare(`SELECT id, enabled, data FROM ${table} WHERE id = ?`).get(id);
        return row ? { ...JSON.parse(row.data), id: row.id, enabled: row.enabled === 1 } : null;
    }

    #saveDoc(table, entry) {
        const id = String(entry.id ?? "").trim();

        if (!id) {
            throw new Error(`${table} document requires an id.`);
        }

        const enabled = entry.enabled === false ? 0 : 1;
        const position = Number.isFinite(entry.position)
            ? entry.position
            : (this.db.prepare(`SELECT MAX(position) AS max FROM ${table}`).get().max ?? -1) + 1;
        const data = JSON.stringify({ ...entry, id, enabled: enabled === 1 });

        this.db.prepare(`
            INSERT INTO ${table} (id, enabled, position, data, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                enabled = excluded.enabled, position = excluded.position,
                data = excluded.data, updated_at = excluded.updated_at
        `).run(id, enabled, position, data, Date.now());

        return id;
    }

    #deleteDoc(table, id) {
        return this.db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id).changes > 0;
    }

    #countDocs(table) {
        return this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
    }

    // Imports a JSON array into an empty collection so an existing data file keeps
    // working without a manual step. `idOf` derives an id when a document lacks one.
    #seedDocs(table, items, idOf) {
        if (this.#countDocs(table) > 0 || !Array.isArray(items)) {
            return 0;
        }

        items.forEach((item, index) => {
            this.#saveDoc(table, { ...item, id: idOf(item, index), position: index });
        });

        return items.length;
    }

    listFaqEntries() {
        return this.#listDocs("faq_entries");
    }

    getFaqEntry(id) {
        return this.#getDoc("faq_entries", id);
    }

    saveFaqEntry(entry) {
        return this.#saveDoc("faq_entries", entry);
    }

    deleteFaqEntry(id) {
        return this.#deleteDoc("faq_entries", id);
    }

    faqCount() {
        return this.#countDocs("faq_entries");
    }

    seedFaqEntries(entries) {
        return this.#seedDocs("faq_entries", entries, (entry, index) =>
            String(entry.id ?? entry.question ?? entry.title ?? "").trim() || `faq-${index + 1}`);
    }

    // --- Moderation rules ---------------------------------------------------

    listModerationRules() {
        return this.#listDocs("moderation_rules");
    }

    getModerationRule(id) {
        return this.#getDoc("moderation_rules", id);
    }

    saveModerationRule(rule) {
        return this.#saveDoc("moderation_rules", rule);
    }

    deleteModerationRule(id) {
        return this.#deleteDoc("moderation_rules", id);
    }

    moderationRuleCount() {
        return this.#countDocs("moderation_rules");
    }

    seedModerationRules(rules) {
        return this.#seedDocs("moderation_rules", rules, (rule, index) =>
            String(rule.id ?? "").trim() || `rule-${index + 1}`);
    }

    // --- Custom commands / auto-responders ----------------------------------

    listCustomCommands() {
        return this.#listDocs("custom_commands");
    }

    getCustomCommand(id) {
        return this.#getDoc("custom_commands", id);
    }

    saveCustomCommand(command) {
        return this.#saveDoc("custom_commands", command);
    }

    deleteCustomCommand(id) {
        return this.#deleteDoc("custom_commands", id);
    }

    customCommandCount() {
        return this.#countDocs("custom_commands");
    }

    // The non-rule scam heuristics (blocked domains, per-category actions, mention
    // cap) are stored as one JSON blob and merged with the rules list to rebuild
    // the object the analyzer consumes.
    getModerationGlobals() {
        const raw = this.getSetting("moderationGlobals");

        if (!raw) {
            return {};
        }

        try {
            return JSON.parse(raw);
        } catch {
            return {};
        }
    }

    setModerationGlobals(globals) {
        this.setSetting("moderationGlobals", JSON.stringify(globals ?? {}));
    }

    assembleModerationRules(fallback = {}) {
        return { ...fallback, ...this.getModerationGlobals(), rules: this.listModerationRules() };
    }

    // --- Settings -----------------------------------------------------------

    getSetting(key) {
        return this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key)?.value ?? null;
    }

    setSetting(key, value) {
        this.db.prepare(`
            INSERT INTO settings (key, value, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        `).run(key, value === null || value === undefined ? null : String(value), Date.now());
    }

    allSettings() {
        const rows = this.db.prepare("SELECT key, value FROM settings").all();
        return Object.fromEntries(rows.map((row) => [row.key, row.value]));
    }

    // --- Control channel (panel process <-> bot process) --------------------
    //
    // The admin panel and the Discord bot run as two independent processes that
    // share this SQLite database. Settings rows carry the low-frequency control
    // signals; the bot_commands table carries one-off actions that need the live
    // gateway. Everything here is plain reads/writes so either side can restart
    // without a handshake.

    // A monotonic counter the panel bumps whenever it edits configuration. The
    // bot compares it each control tick and re-reads its config from the store
    // when it changes, so panel edits reach the running bot without a restart.
    getControlEpoch() {
        return Number(this.getSetting("controlEpoch") ?? 0);
    }

    bumpControlEpoch() {
        const next = this.getControlEpoch() + 1;
        this.setSetting("controlEpoch", next);
        return next;
    }

    // The desired gateway state ("on"/"off"). Defaults to "on" so a fresh
    // deployment connects; persists across a bot restart, so a bot the admin
    // switched off stays off until switched back on from the panel.
    getGatewayDesired() {
        return this.getSetting("gatewayDesired") ?? "on";
    }

    setGatewayDesired(state) {
        this.setSetting("gatewayDesired", state === "off" ? "off" : "on");
    }

    // Bumped to force the bot to drop and re-establish the gateway even when the
    // desired state is unchanged (the panel's "reconnect" button).
    getGatewayNonce() {
        return Number(this.getSetting("gatewayNonce") ?? 0);
    }

    bumpGatewayNonce() {
        const next = this.getGatewayNonce() + 1;
        this.setSetting("gatewayNonce", next);
        return next;
    }

    // A heartbeat the bot writes every control tick. The panel reads it to show
    // live gateway state and, from its freshness, whether the bot process itself
    // is up.
    setBotHeartbeat(heartbeat) {
        this.setSetting("botHeartbeat", JSON.stringify({ ...heartbeat, updatedAt: Date.now() }));
    }

    getBotHeartbeat() {
        return parseJsonSetting(this.getSetting("botHeartbeat"));
    }

    // A snapshot of the control guild's channels and roles, refreshed by the bot
    // from its gateway cache. The panel reads it to offer name pickers; an empty
    // or stale snapshot makes the panel fall back to plain ID inputs.
    setGuildDirectory(directory) {
        this.setSetting("guildDirectory", JSON.stringify(directory ?? { channels: [], roles: [] }));
    }

    getGuildDirectory() {
        return parseJsonSetting(this.getSetting("guildDirectory"));
    }

    enqueueCommand(kind, payload = {}) {
        const now = Date.now();
        return Number(this.db.prepare(`
            INSERT INTO bot_commands (kind, payload, status, created_at, updated_at)
            VALUES (?, ?, 'pending', ?, ?)
        `).run(kind, JSON.stringify(payload ?? {}), now, now).lastInsertRowid);
    }

    listPendingCommands() {
        return this.db.prepare("SELECT * FROM bot_commands WHERE status = 'pending' ORDER BY id ASC").all();
    }

    completeCommand(id, result) {
        this.db.prepare(`
            UPDATE bot_commands
            SET status = ?, result = ?, updated_at = ?
            WHERE id = ?
        `).run(result?.ok ? "done" : "error", JSON.stringify(result ?? { ok: false }), Date.now(), id);
    }

    getCommand(id) {
        return this.db.prepare("SELECT * FROM bot_commands WHERE id = ?").get(id) ?? null;
    }

    commandResult(row) {
        return parseJsonSetting(row?.result);
    }

    // Housekeeping: drop finished commands older than the given age so the queue
    // does not grow without bound.
    pruneCommands(olderThanMs) {
        this.db.prepare("DELETE FROM bot_commands WHERE status != 'pending' AND updated_at < ?")
            .run(Date.now() - olderThanMs);
    }

    // --- Reaction roles -----------------------------------------------------

    listReactionRoles() {
        return this.db.prepare("SELECT * FROM reaction_roles ORDER BY updated_at DESC").all();
    }

    getReactionRole(messageId, emoji) {
        return this.db.prepare("SELECT * FROM reaction_roles WHERE message_id = ? AND emoji = ?")
            .get(messageId, emoji) ?? null;
    }

    saveReactionRole({ messageId, emoji, roleId, channelId = null, guildId = null }) {
        this.db.prepare(`
            INSERT INTO reaction_roles (message_id, emoji, role_id, channel_id, guild_id, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(message_id, emoji) DO UPDATE SET
                role_id = excluded.role_id, channel_id = excluded.channel_id,
                guild_id = excluded.guild_id, updated_at = excluded.updated_at
        `).run(messageId, emoji, roleId, channelId, guildId, Date.now());
    }

    deleteReactionRole(messageId, emoji) {
        return this.db.prepare("DELETE FROM reaction_roles WHERE message_id = ? AND emoji = ?")
            .run(messageId, emoji).changes > 0;
    }

    reactionRoleCount() {
        return this.db.prepare("SELECT COUNT(*) AS count FROM reaction_roles").get().count;
    }

    // --- Starboard ----------------------------------------------------------

    getStarboardPost(sourceMessageId) {
        return this.db.prepare("SELECT * FROM starboard_posts WHERE source_message_id = ?")
            .get(sourceMessageId) ?? null;
    }

    saveStarboardPost(sourceMessageId, starboardMessageId) {
        this.db.prepare(`
            INSERT INTO starboard_posts (source_message_id, starboard_message_id, created_at)
            VALUES (?, ?, ?)
            ON CONFLICT(source_message_id) DO UPDATE SET starboard_message_id = excluded.starboard_message_id
        `).run(sourceMessageId, starboardMessageId, Date.now());
    }

    deleteStarboardPost(sourceMessageId) {
        this.db.prepare("DELETE FROM starboard_posts WHERE source_message_id = ?").run(sourceMessageId);
    }

    // --- Leveling / XP ------------------------------------------------------

    getUserLevel(guildId, userId) {
        const row = this.db.prepare("SELECT xp, messages FROM user_levels WHERE guild_id = ? AND user_id = ?")
            .get(guildId, userId);
        const xp = row?.xp ?? 0;

        return { xp, messages: row?.messages ?? 0, level: levelFromXp(xp) };
    }

    addXp(guildId, userId, amount) {
        this.db.prepare(`
            INSERT INTO user_levels (guild_id, user_id, xp, messages, updated_at)
            VALUES (?, ?, ?, 1, ?)
            ON CONFLICT(guild_id, user_id) DO UPDATE SET
                xp = xp + excluded.xp, messages = messages + 1, updated_at = excluded.updated_at
        `).run(guildId, userId, amount, Date.now());

        return this.getUserLevel(guildId, userId);
    }

    topLevels(guildId, limit = 10) {
        return this.db.prepare("SELECT user_id, xp, messages FROM user_levels WHERE guild_id = ? ORDER BY xp DESC LIMIT ?")
            .all(guildId, limit)
            .map((row, index) => ({ ...row, rank: index + 1, level: levelFromXp(row.xp) }));
    }

    userRank(guildId, userId) {
        const row = this.db.prepare(`
            SELECT COUNT(*) AS higher FROM user_levels
            WHERE guild_id = ? AND xp > (SELECT xp FROM user_levels WHERE guild_id = ? AND user_id = ?)
        `).get(guildId, guildId, userId);

        return (row?.higher ?? 0) + 1;
    }

    // --- Admin audit log ----------------------------------------------------

    recordAudit({ actorId = null, actorName = null, action, detail = null }) {
        this.db.prepare(`
            INSERT INTO audit_log (created_at, actor_id, actor_name, action, detail)
            VALUES (?, ?, ?, ?, ?)
        `).run(Date.now(), actorId, actorName, action, detail);
    }

    listAudit({ limit = 50 } = {}) {
        return this.db.prepare(`
            SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ?
        `).all(limit);
    }

    // --- Usage stats (daily rollups) ----------------------------------------

    // Increments a daily counter. `key` optionally sub-buckets a metric (a FAQ
    // entry id, a command name) so the same table backs both the per-day trend
    // and the "top FAQs / top commands" lists.
    bumpStat(metric, key = "", amount = 1, at = Date.now()) {
        this.db.prepare(`
            INSERT INTO stats_daily (day, metric, key, count)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(day, metric, key) DO UPDATE SET count = count + excluded.count
        `).run(dayKeyOf(at), metric, key, amount);
    }

    // Per-day totals for a metric on or after `sinceDay` (a YYYY-MM-DD string),
    // summed across sub-keys. Missing days are absent; the caller zero-fills.
    statSeries(metric, sinceDay) {
        return this.db.prepare(`
            SELECT day, SUM(count) AS total FROM stats_daily
            WHERE metric = ? AND day >= ?
            GROUP BY day ORDER BY day ASC
        `).all(metric, sinceDay);
    }

    statTopKeys(metric, limit, sinceDay) {
        return this.db.prepare(`
            SELECT key, SUM(count) AS total FROM stats_daily
            WHERE metric = ? AND day >= ? AND key <> ''
            GROUP BY key ORDER BY total DESC LIMIT ?
        `).all(metric, sinceDay, limit);
    }

    statTotal(metric, sinceDay) {
        return this.db.prepare(`
            SELECT SUM(count) AS total FROM stats_daily WHERE metric = ? AND day >= ?
        `).get(metric, sinceDay).total ?? 0;
    }

    // Per-day count of enforced (non-dry-run) moderation actions, taken straight
    // from the moderation log so the trend never drifts from the record.
    moderationDaily(sinceMs) {
        return this.db.prepare(`
            SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') AS day, COUNT(*) AS total
            FROM moderation_actions
            WHERE dry_run = 0 AND created_at >= ?
            GROUP BY day ORDER BY day ASC
        `).all(sinceMs);
    }

    // --- Scheduled tasks ----------------------------------------------------

    // A single durable to-do the bot runs at run_at: a temp-ban expiry, a temp-role
    // removal, a giveaway draw. Kept generic so one sweep drains them all.
    scheduleTask({ type, runAt, guildId = null, payload = {}, label = null }) {
        const result = this.db.prepare(`
            INSERT INTO scheduled_tasks (type, run_at, guild_id, payload, label, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(type, runAt, guildId, JSON.stringify(payload ?? {}), label, Date.now());

        return Number(result.lastInsertRowid);
    }

    dueTasks(now = Date.now(), limit = 50) {
        return this.db.prepare(`
            SELECT * FROM scheduled_tasks
            WHERE done_at IS NULL AND run_at <= ?
            ORDER BY run_at ASC LIMIT ?
        `).all(now, limit).map((row) => ({ ...row, payload: parseJson(row.payload) }));
    }

    completeTask(id) {
        this.db.prepare("UPDATE scheduled_tasks SET done_at = ? WHERE id = ? AND done_at IS NULL")
            .run(Date.now(), id);
    }

    cancelTask(id) {
        return this.db.prepare("DELETE FROM scheduled_tasks WHERE id = ? AND done_at IS NULL")
            .run(id).changes > 0;
    }

    listPendingTasks({ type = null, limit = 200 } = {}) {
        const where = type ? "done_at IS NULL AND type = ?" : "done_at IS NULL";
        const params = type ? [type, limit] : [limit];

        return this.db.prepare(`
            SELECT * FROM scheduled_tasks WHERE ${where} ORDER BY run_at ASC LIMIT ?
        `).all(...params).map((row) => ({ ...row, payload: parseJson(row.payload) }));
    }

    // --- Announcements ------------------------------------------------------

    // A message posted to a channel at next_run. interval_seconds > 0 makes it
    // recur; 0 is a one-shot that disables itself after firing.
    createAnnouncement({ channelId, message, intervalSeconds = 0, nextRun }) {
        const result = this.db.prepare(`
            INSERT INTO announcements (channel_id, message, interval_seconds, next_run, enabled, created_at)
            VALUES (?, ?, ?, ?, 1, ?)
        `).run(channelId, message, intervalSeconds, nextRun, Date.now());

        return Number(result.lastInsertRowid);
    }

    listAnnouncements() {
        return this.db.prepare("SELECT * FROM announcements ORDER BY next_run ASC").all();
    }

    dueAnnouncements(now = Date.now()) {
        return this.db.prepare("SELECT * FROM announcements WHERE enabled = 1 AND next_run <= ? ORDER BY next_run ASC").all(now);
    }

    // Advances a recurring announcement to its next run, or disables a one-shot
    // once it has fired.
    markAnnouncementRan(id, nextRun) {
        if (nextRun) {
            this.db.prepare("UPDATE announcements SET next_run = ? WHERE id = ?").run(nextRun, id);
        } else {
            this.db.prepare("UPDATE announcements SET enabled = 0 WHERE id = ?").run(id);
        }
    }

    setAnnouncementEnabled(id, enabled) {
        this.db.prepare("UPDATE announcements SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id);
    }

    deleteAnnouncement(id) {
        return this.db.prepare("DELETE FROM announcements WHERE id = ?").run(id).changes > 0;
    }

    // --- Access grants ------------------------------------------------------

    // A scoped grant: a role or user allowed a fixed set of panel/command areas.
    // Administrators are never stored here — they are resolved live from Discord
    // permissions and DISCORD_ADMIN_* (see auth.js / access.js). `areas` is a JSON
    // array of area keys.

    #rowToGrant(row) {
        return {
            subjectType: row.subject_type,
            subjectId: row.subject_id,
            areas: parseJsonArray(row.areas),
            label: row.label ?? null,
            createdBy: row.created_by ?? null,
            createdAt: row.created_at,
            updatedAt: row.updated_at
        };
    }

    listAccessGrants() {
        return this.db.prepare("SELECT * FROM access_grants ORDER BY subject_type ASC, created_at ASC")
            .all()
            .map((row) => this.#rowToGrant(row));
    }

    getAccessGrant(subjectType, subjectId) {
        const row = this.db.prepare("SELECT * FROM access_grants WHERE subject_type = ? AND subject_id = ?")
            .get(subjectType, subjectId);
        return row ? this.#rowToGrant(row) : null;
    }

    saveAccessGrant({ subjectType, subjectId, areas, label = null, createdBy = null }) {
        const type = subjectType === "user" ? "user" : "role";
        const id = String(subjectId ?? "").trim();

        if (!id) {
            throw new Error("An access grant requires a subject id.");
        }

        const areaList = Array.isArray(areas) ? areas : [];
        const now = Date.now();

        this.db.prepare(`
            INSERT INTO access_grants (subject_type, subject_id, areas, label, created_by, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(subject_type, subject_id) DO UPDATE SET
                areas = excluded.areas, label = excluded.label, updated_at = excluded.updated_at
        `).run(type, id, JSON.stringify(areaList), label, createdBy, now, now);

        return { subjectType: type, subjectId: id };
    }

    deleteAccessGrant(subjectType, subjectId) {
        return this.db.prepare("DELETE FROM access_grants WHERE subject_type = ? AND subject_id = ?")
            .run(subjectType, subjectId).changes > 0;
    }

    // --- Admin revocations --------------------------------------------------

    // The owner can revoke a role or member's administrator access. A block is a
    // deny entry keyed on identity: whoever it matches is not an administrator,
    // no matter which permission would otherwise grant it. The owner is never
    // subject to blocks.

    listAdminBlocks() {
        return this.db.prepare("SELECT * FROM admin_blocks ORDER BY created_at ASC")
            .all()
            .map((row) => ({
                subjectType: row.subject_type,
                subjectId: row.subject_id,
                label: row.label ?? null,
                createdBy: row.created_by ?? null,
                createdAt: row.created_at
            }));
    }

    getAdminBlock(subjectType, subjectId) {
        return this.db.prepare("SELECT 1 FROM admin_blocks WHERE subject_type = ? AND subject_id = ?")
            .get(subjectType, subjectId) ? { subjectType, subjectId } : null;
    }

    addAdminBlock({ subjectType, subjectId, label = null, createdBy = null }) {
        const type = subjectType === "user" ? "user" : "role";
        const id = String(subjectId ?? "").trim();

        if (!id) {
            throw new Error("An admin block requires a subject id.");
        }

        this.db.prepare(`
            INSERT INTO admin_blocks (subject_type, subject_id, label, created_by, created_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(subject_type, subject_id) DO UPDATE SET label = excluded.label
        `).run(type, id, label, createdBy, Date.now());

        return { subjectType: type, subjectId: id };
    }

    removeAdminBlock(subjectType, subjectId) {
        return this.db.prepare("DELETE FROM admin_blocks WHERE subject_type = ? AND subject_id = ?")
            .run(subjectType, subjectId).changes > 0;
    }

    // Whether a principal's user id or any of its role ids is revoked from admin.
    isAdminBlocked({ userId = null, roleIds = [] } = {}) {
        if (userId && this.getAdminBlock("user", userId)) {
            return true;
        }

        return (roleIds ?? []).some((roleId) => this.getAdminBlock("role", roleId));
    }

    // Every grant that applies to a principal: the grant for their user id plus
    // one for each of their role ids. The caller unions the areas.
    grantsForPrincipal({ userId = null, roleIds = [] } = {}) {
        const grants = [];

        if (userId) {
            const row = this.db.prepare("SELECT * FROM access_grants WHERE subject_type = 'user' AND subject_id = ?")
                .get(userId);
            if (row) {
                grants.push(this.#rowToGrant(row));
            }
        }

        for (const roleId of roleIds ?? []) {
            const row = this.db.prepare("SELECT * FROM access_grants WHERE subject_type = 'role' AND subject_id = ?")
                .get(roleId);
            if (row) {
                grants.push(this.#rowToGrant(row));
            }
        }

        return grants;
    }
}

function parseJson(raw) {
    try {
        return raw ? JSON.parse(raw) : {};
    } catch {
        return {};
    }
}

function parseJsonArray(raw) {
    try {
        const value = raw ? JSON.parse(raw) : [];
        return Array.isArray(value) ? value : [];
    } catch {
        return [];
    }
}
