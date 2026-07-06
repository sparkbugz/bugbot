// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SparkBugz

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    areaForPath,
    canAccessArea,
    normalizeAreas,
    resolveAccess
} from "./access.js";
import {
    SETTINGS_FIELDS,
    SETTINGS_SECTIONS,
    SETTING_FIELD_DOCS,
    coerceFromForm,
    configKeyOf,
    displayValue,
    serializeSetting,
    validateSettings
} from "./settings.js";
import { findBestFaqMatch } from "./faqMatcher.js";
import { parseDurationMs } from "./moderation.js";
import { lastNDays } from "./util.js";
import {
    normalizeTheme,
    renderAccess,
    renderAccessDenied,
    renderAnalytics,
    renderAuditLog,
    renderCustomCommandEditor,
    renderCustomCommands,
    renderDashboard,
    renderEmbedComposer,
    renderFaqEditor,
    renderFaqList,
    renderGlossary,
    renderLeaderboard,
    renderLicense,
    renderLogin,
    renderModerationLog,
    renderModerationRuleEditor,
    renderModerationRules,
    renderReactionRoles,
    renderScheduled,
    renderSettings
} from "./adminViews.js";

const SNOWFLAKE = /^\d{5,25}$/;

const MODERATION_ACTIONS = new Set(["log", "delete", "warn", "timeout", "kick", "ban"]);

const DISCORD_API_BASE_URL = "https://discord.com/api/v10";
const SESSION_COOKIE = "bugbot_admin";
const THEME_COOKIE = "bugbot_theme";
const SESSION_TTL_MS = 60 * 60 * 1000;
// A live session re-checks the signed-in user against Discord at most this often,
// rather than on every single request — otherwise each page load costs three
// Discord API calls and quickly runs into rate limits.
const PRINCIPAL_REVALIDATE_MS = 60 * 1000;
const MAX_FORM_BYTES = 64 * 1024;
const FONT_WEIGHTS = new Set(["400", "500", "600", "700"]);
const PUBLIC_DIR = fileURLToPath(new URL("../public", import.meta.url));

const FLASH = {
    undone: { message: "Action reversed." },
    undo_failed: { message: "Could not reverse that action.", error: true },
    not_reversible: { message: "That action can no longer be reversed.", error: true },
    faq_saved: { message: "FAQ entry saved." },
    faq_deleted: { message: "FAQ entry deleted." },
    settings_saved: { message: "Settings saved." },
    rule_saved: { message: "Moderation rule saved." },
    rule_deleted: { message: "Moderation rule deleted." },
    detectors_saved: { message: "Scam detectors saved." },
    command_saved: { message: "Custom command saved." },
    command_deleted: { message: "Custom command deleted." },
    embed_sent: { message: "Embed posted." },
    embed_failed: { message: "Could not post the embed — check the channel, my permissions, and that it is not empty.", error: true },
    role_added: { message: "Mapping saved and the reaction was added to the message." },
    role_added_noreact: { message: "Mapping saved, but I could not react to that message — check the IDs and my permissions.", error: true },
    role_added_queued: { message: "Mapping saved. The bot is off, so adding the reaction was queued — it will run automatically when the bot is back online." },
    action_queued: { message: "The bot is off, so this action was queued — it will run automatically when the bot is back online." },
    role_removed: { message: "Reaction-role mapping removed." },
    bot_started: { message: "Discord connection started." },
    bot_stopped: { message: "Discord connection stopped. The dashboard remains online." },
    bot_restarted: { message: "Discord connection reconnected." },
    bot_control_failed: { message: "Could not change the Discord connection state.", error: true },
    restart_disabled: { message: "Process restart is disabled. Use the safe connection controls or enable ALLOW_PROCESS_RESTART under a supervisor.", error: true },
    grant_saved: { message: "Access grant saved." },
    grant_deleted: { message: "Access grant removed." },
    grant_failed: { message: "Could not save that access grant — check the ID and pick at least one area.", error: true },
    no_access: { message: "You do not have access to that area.", error: true },
    admin_revoked: { message: "Administrator access revoked." },
    admin_restored: { message: "Administrator access restored." },
    admin_failed: { message: "Could not update administrator access — check the ID.", error: true }
};

function randomToken(bytes = 32) {
    return crypto.randomBytes(bytes).toString("base64url");
}

function signValue(value, secret) {
    return crypto.createHmac("sha256", secret).update(value).digest("base64url");
}

function safeEqual(left, right) {
    const leftBuffer = Buffer.from(String(left ?? ""));
    const rightBuffer = Buffer.from(String(right ?? ""));

    if (leftBuffer.length !== rightBuffer.length) {
        return false;
    }

    return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function parseCookies(header) {
    const cookies = new Map();

    for (const part of String(header ?? "").split(";")) {
        const [name, ...valueParts] = part.trim().split("=");

        if (name && valueParts.length > 0) {
            cookies.set(name, valueParts.join("="));
        }
    }

    return cookies;
}

function buildCookie(name, value, config, maxAgeSeconds) {
    const parts = [`${name}=${value}`, "HttpOnly", "SameSite=Lax", "Path=/", `Max-Age=${maxAgeSeconds}`];

    if (config.adminWebProtocol === "https") {
        parts.push("Secure");
    }

    return parts.join("; ");
}

function setSecurityHeaders(response) {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader(
        "Content-Security-Policy",
        "default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
    );
}

function sendHtml(response, statusCode, body, headers = {}) {
    setSecurityHeaders(response);
    response.writeHead(statusCode, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        ...headers
    });
    response.end(body);
}

function redirect(response, location, headers = {}) {
    setSecurityHeaders(response);
    response.writeHead(303, { Location: location, "Cache-Control": "no-store", ...headers });
    response.end();
}

async function readForm(request) {
    const chunks = [];
    let size = 0;

    for await (const chunk of request) {
        size += chunk.length;

        if (size > MAX_FORM_BYTES) {
            throw new Error("Request body too large.");
        }

        chunks.push(chunk);
    }

    return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

async function discordFetchJson(fetchImpl, apiPath, options = {}) {
    const response = await fetchImpl(`${DISCORD_API_BASE_URL}${apiPath}`, options);

    if (!response.ok) {
        const body = await response.text();
        throw new Error(`Discord API request failed: ${response.status} ${body}`);
    }

    return response.json();
}

async function exchangeDiscordCode(fetchImpl, config, code) {
    const body = new URLSearchParams({
        client_id: config.discordOAuthClientId,
        client_secret: config.discordOAuthClientSecret,
        grant_type: "authorization_code",
        code,
        redirect_uri: config.discordOAuthRedirectUri
    });

    return discordFetchJson(fetchImpl, "/oauth2/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body
    });
}

// Resolves the signed-in user's identity, guild membership, roles and guild-level
// permissions from Discord. Returns null if the user is not in the control guild
// or any call fails.
async function fetchOAuthPrincipal(fetchImpl, config, accessToken) {
    const headers = { Authorization: `Bearer ${accessToken}` };

    let user;
    let guilds;
    let member;

    try {
        [user, guilds, member] = await Promise.all([
            discordFetchJson(fetchImpl, "/users/@me", { headers }),
            discordFetchJson(fetchImpl, "/users/@me/guilds", { headers }),
            discordFetchJson(fetchImpl, `/users/@me/guilds/${config.controlGuildId}/member`, { headers })
        ]);
    } catch {
        return null;
    }

    const guild = guilds.find((item) => item.id === config.controlGuildId);

    if (!guild) {
        return null;
    }

    return {
        userId: user.id,
        username: user.global_name || user.username || user.id,
        roleIds: Array.isArray(member.roles) ? member.roles : [],
        permissions: guild.permissions ?? "0",
        owner: guild.owner === true
    };
}

function sessionCookieValue(sessionId, config) {
    return `${sessionId}.${signValue(sessionId, config.adminSessionSecret)}`;
}

function readSessionId(request, config) {
    const raw = parseCookies(request.headers.cookie).get(SESSION_COOKIE);

    if (!raw) {
        return null;
    }

    const [sessionId, signature] = raw.split(".");

    if (!sessionId || !signature || !safeEqual(signature, signValue(sessionId, config.adminSessionSecret))) {
        return null;
    }

    return sessionId;
}

function readTheme(request) {
    return normalizeTheme(parseCookies(request.headers.cookie).get(THEME_COOKIE));
}

// Only allow redirects back to our own paths, never an absolute/off-site URL.
function safeReturnPath(value) {
    const target = String(value ?? "/");
    return target.startsWith("/") && !target.startsWith("//") ? target : "/";
}

async function authorizeSession(session, bot, fetchImpl) {
    if (!session || session.expiresAt <= Date.now()) {
        return false;
    }

    // Skip the Discord round-trip if we validated this session very recently.
    if (session.principalCheckedAt && (Date.now() - session.principalCheckedAt) < PRINCIPAL_REVALIDATE_MS) {
        return true;
    }

    const principal = await fetchOAuthPrincipal(fetchImpl, bot.config, session.accessToken);

    if (!principal || principal.userId !== session.userId) {
        return false;
    }

    const access = resolveAccess(principal, bot.config, bot.store);

    if (!access.authorized) {
        return false;
    }

    session.username = principal.username;
    session.roleIds = principal.roleIds;
    session.permissions = principal.permissions;
    session.access = access;
    session.principalCheckedAt = Date.now();
    return true;
}

export async function startAdminServer(bot, { fetchImpl = globalThis.fetch } = {}) {
    const sessions = new Map();
    const oauthStates = new Map();
    const config = bot.config;

    function cleanupExpired() {
        const now = Date.now();

        for (const [sessionId, session] of sessions.entries()) {
            if (session.expiresAt <= now) {
                sessions.delete(sessionId);
            }
        }

        for (const [state, expiresAt] of oauthStates.entries()) {
            if (expiresAt <= now) {
                oauthStates.delete(state);
            }
        }
    }

    function clearSessionCookie(response, sessionId) {
        if (sessionId) {
            sessions.delete(sessionId);
        }

        response.setHeader("Set-Cookie", buildCookie(SESSION_COOKIE, "", config, 0));
    }

    async function getAuthorizedSession(request, response) {
        const sessionId = readSessionId(request, config);
        const session = sessionId ? sessions.get(sessionId) : null;

        if (!session || !(await authorizeSession(session, bot, fetchImpl))) {
            clearSessionCookie(response, sessionId);
            return null;
        }

        // Refresh the cached bot status each request so the header lamp and the
        // "bot off" banner reflect the live state (the bot publishes it to the
        // store), not whatever it was at sign-in.
        session.botStatus = bot.getSafeStatus?.() ?? session.botStatus;
        return { sessionId, session };
    }

    function audit(session, action, detail) {
        bot.store?.recordAudit({
            actorId: session.userId,
            actorName: session.username,
            action,
            detail
        });
    }

    function serveFont(response, fileName) {
        const match = /^fira-sans-(\d{3})\.woff2$/.exec(fileName);

        if (!match || !FONT_WEIGHTS.has(match[1])) {
            sendHtml(response, 404, "Not found");
            return;
        }

        const filePath = path.join(PUBLIC_DIR, "fonts", fileName);

        try {
            const data = fs.readFileSync(filePath);
            setSecurityHeaders(response);
            response.writeHead(200, {
                "Content-Type": "font/woff2",
                "Cache-Control": "public, max-age=31536000, immutable"
            });
            response.end(data);
        } catch {
            sendHtml(response, 404, "Not found");
        }
    }

    function serveAvatar(response) {
        try {
            const data = fs.readFileSync(path.join(PUBLIC_DIR, "avatar.jpg"));
            setSecurityHeaders(response);
            response.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=86400" });
            response.end(data);
        } catch {
            sendHtml(response, 404, "Not found");
        }
    }

    function status() {
        return bot.getSafeStatus();
    }

    // The control guild's channels and roles, for the panel's name pickers. Empty
    // when the bot is offline, which makes the views fall back to plain ID inputs.
    function directory() {
        return bot.guildDirectory ? bot.guildDirectory() : { channels: [], roles: [] };
    }

    // True when a live Discord action can't run right now (bot off or gateway not
    // connected) and will instead be parked in the queue for when the bot is back.
    // The handlers use this to tell the operator the action was queued rather than
    // performed, and to skip side effects that assume it completed.
    function willQueue() {
        return typeof bot.gatewayConnected === "function" && !bot.gatewayConnected();
    }

    // Which optional modules are enabled right now — drives which header links
    // render. Recomputed per request because settings change at runtime.
    function navFlags() {
        return {
            moderation: Boolean(config.enableModeration),
            faq: Boolean(config.enableFaq),
            commands: Boolean(config.enableCustomCommands),
            roles: Boolean(config.reactionRolesEnabled),
            leveling: Boolean(config.levelingEnabled)
        };
    }

    function settingSections() {
        return SETTINGS_SECTIONS.map((section) => ({
            ...section,
            fields: section.fields.map((field) => ({
                ...field,
                docs: SETTING_FIELD_DOCS[field.key] ?? {},
                value: displayValue(field, config)
            }))
        }));
    }

    function moderationView(url, theme, session) {
        const filter = url.searchParams.get("action") ?? "";
        const undoableOnly = url.searchParams.get("undoable") === "1";
        const actions = bot.store
            ? bot.store.listModerationActions({ limit: 200, action: filter || null, undoableOnly })
            : [];

        return renderModerationLog({ theme, session, actions, filter, undoableOnly, nav: navFlags() });
    }

    function dashboardView(theme, session) {
        const summary = bot.store ? bot.store.moderationSummary() : { total: 0, bans: 0, reversible: 0, last24h: 0 };
        const recent = bot.store ? bot.store.listModerationActions({ limit: 8 }) : [];

        return renderDashboard({ theme, session, status: status(), summary, recent, nav: navFlags() });
    }

    // Assembles the analytics page: a trailing window of daily rollups, zero-filled
    // so quiet days still draw a column, plus the "top" lists over the same window.
    function analyticsView(theme, session) {
        const store = bot.store;

        if (!store) {
            return renderAnalytics({ theme, session, enabled: false, nav: navFlags() });
        }

        const windowDays = 14;
        const days = lastNDays(windowDays);
        const sinceDay = days[0];
        const sinceMs = Date.parse(`${sinceDay}T00:00:00.000Z`);

        const fill = (rows) => {
            const totals = new Map(rows.map((row) => [row.day, Number(row.total) || 0]));
            return days.map((day) => ({ day, count: totals.get(day) ?? 0 }));
        };

        const mod = fill(store.moderationDaily(sinceMs));

        return renderAnalytics({
            theme,
            session,
            nav: navFlags(),
            enabled: true,
            windowDays,
            tiles: {
                messages: store.statTotal("messages", sinceDay),
                faqAnswers: store.statTotal("faq_answer", sinceDay),
                modActions: mod.reduce((sum, point) => sum + point.count, 0),
                xp: store.statTotal("xp", sinceDay)
            },
            messages: fill(store.statSeries("messages", sinceDay)),
            mod,
            xp: fill(store.statSeries("xp", sinceDay)),
            faqAnswers: fill(store.statSeries("faq_answer", sinceDay)),
            topFaqs: store.statTopKeys("faq_answer", 8, sinceDay),
            topCommands: store.statTopKeys("command", 8, sinceDay)
        });
    }

    function settingsView(theme, session, error = null) {
        return renderSettings({ theme, session, sections: settingSections(), error, directory: directory(), status: status(), nav: navFlags() });
    }

    async function handleUndo(request, response, session) {
        const form = await readForm(request);

        if (!safeEqual(form.get("csrf"), session.csrf)) {
            sendHtml(response, 403, "Invalid request token.");
            return;
        }

        const action = bot.store?.getModerationAction(Number(form.get("id")));

        if (!action || action.undone_at || action.undoable !== 1) {
            redirect(response, "/moderation?flash=not_reversible");
            return;
        }

        const reason = `Reversed from admin panel by ${session.username}`;
        // With the bot off, the reversal is queued and lifts on Discord once the
        // bot is back; we still record it as reversed so the log matches the
        // intended end state.
        const queued = willQueue();

        try {
            if (action.action === "ban") {
                await bot.unbanUser(action.guild_id, action.target_user_id, reason);
            } else if (action.action === "timeout") {
                await bot.clearMemberTimeout(action.guild_id, action.target_user_id, reason);
            }

            bot.store.markModerationUndone(action.id, { undoneBy: session.userId, note: reason });
            bot.store.recordModerationAction({
                guildId: action.guild_id,
                channelId: action.channel_id,
                targetUserId: action.target_user_id,
                targetTag: action.target_tag,
                moderatorId: session.userId,
                moderatorTag: session.username,
                source: "dashboard",
                action: action.action === "ban" ? "unban" : "untimeout",
                reason,
                dryRun: false
            });
            audit(session, queued ? "moderation.undo.queued" : "moderation.undo", `#${action.id} ${action.action} ${action.target_user_id}`);
            redirect(response, queued ? "/moderation?flash=action_queued" : "/moderation?flash=undone");
        } catch (error) {
            console.error("Undo failed:", error);
            redirect(response, "/moderation?flash=undo_failed");
        }
    }

    function faqEntryFromForm(form) {
        const lines = (name) => String(form.get(name) ?? "")
            .split("\n").map((line) => line.trim()).filter(Boolean);

        const entry = {
            id: String(form.get("id") ?? "").trim(),
            enabled: form.get("enabled") === "1",
            questions: lines("phrases"),
            keywords: lines("keywords"),
            answer: String(form.get("answer") ?? "").trim(),
            response: { links: lines("links") }
        };

        const cooldown = Number(form.get("cooldownSeconds"));

        if (Number.isFinite(cooldown) && cooldown > 0) {
            entry.cooldownSeconds = cooldown;
        }

        const githubText = String(form.get("github") ?? "").trim();

        if (githubText) {
            entry.github = JSON.parse(githubText);
        }

        return entry;
    }

    async function handleFaqSave(request, response, session, theme) {
        const form = await readForm(request);

        if (!safeEqual(form.get("csrf"), session.csrf)) {
            sendHtml(response, 403, "Invalid request token.");
            return;
        }

        let entry;

        try {
            entry = faqEntryFromForm(form);
        } catch {
            sendHtml(response, 400, renderFaqEditor({ theme, session, isNew: true, error: "GitHub config must be valid JSON.", nav: navFlags() }));
            return;
        }

        if (!entry.id || !entry.answer) {
            sendHtml(response, 400, renderFaqEditor({
                theme, session, entry, isNew: !form.get("original_id"),
                error: "An entry ID and an answer are both required.", nav: navFlags()
            }));
            return;
        }

        const originalId = String(form.get("original_id") ?? "").trim();

        if (originalId && originalId !== entry.id) {
            bot.store.deleteFaqEntry(originalId);
        }

        bot.store.saveFaqEntry(entry);
        bot.reloadFaqEntries();
        audit(session, "faq.save", entry.id);
        redirect(response, "/faq?flash=faq_saved");
    }

    async function handleFaqDelete(request, response, session) {
        const form = await readForm(request);

        if (!safeEqual(form.get("csrf"), session.csrf)) {
            sendHtml(response, 403, "Invalid request token.");
            return;
        }

        const id = String(form.get("id") ?? "").trim();
        bot.store.deleteFaqEntry(id);
        bot.reloadFaqEntries();
        audit(session, "faq.delete", id);
        redirect(response, "/faq?flash=faq_deleted");
    }

    function commandFromForm(form) {
        const matchType = ["exact", "starts", "contains"].includes(form.get("matchType")) ? form.get("matchType") : "exact";
        const trigger = String(form.get("trigger") ?? "").trim();
        const explicitId = String(form.get("id") ?? "").trim();
        const id = explicitId
            || trigger.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);

        return {
            id,
            enabled: form.get("enabled") === "1",
            trigger,
            matchType,
            response: String(form.get("response") ?? "").trim()
        };
    }

    async function handleCommandSave(request, response, session, theme) {
        const form = await readForm(request);

        if (!safeEqual(form.get("csrf"), session.csrf)) {
            sendHtml(response, 403, "Invalid request token.");
            return;
        }

        const command = commandFromForm(form);

        if (!command.id || !command.trigger || !command.response) {
            sendHtml(response, 400, renderCustomCommandEditor({
                theme, session, command, isNew: !form.get("original_id"),
                error: "A trigger and a response are both required.", nav: navFlags()
            }));
            return;
        }

        const originalId = String(form.get("original_id") ?? "").trim();

        if (originalId && originalId !== command.id) {
            bot.store.deleteCustomCommand(originalId);
        }

        bot.store.saveCustomCommand(command);
        bot.reloadCustomCommands?.();
        audit(session, "command.save", command.id);
        redirect(response, "/commands?flash=command_saved");
    }

    async function handleCommandDelete(request, response, session) {
        const form = await readForm(request);

        if (!safeEqual(form.get("csrf"), session.csrf)) {
            sendHtml(response, 403, "Invalid request token.");
            return;
        }

        const id = String(form.get("id") ?? "").trim();
        bot.store.deleteCustomCommand(id);
        bot.reloadCustomCommands?.();
        audit(session, "command.delete", id);
        redirect(response, "/commands?flash=command_deleted");
    }

    async function handleEmbedSend(request, response, session) {
        const form = await readForm(request);

        if (!safeEqual(form.get("csrf"), session.csrf)) {
            sendHtml(response, 403, "Invalid request token.");
            return;
        }

        const channelId = String(form.get("channel_id") ?? "").trim();
        const spec = {
            title: form.get("title"),
            description: form.get("description"),
            color: form.get("color"),
            url: form.get("url"),
            imageUrl: form.get("image_url"),
            footer: form.get("footer"),
            fields: [1, 2, 3].map((index) => ({
                name: form.get(`field_name_${index}`),
                value: form.get(`field_value_${index}`),
                inline: form.get(`field_inline_${index}`) === "1"
            }))
        };

        let posted = false;
        const queued = SNOWFLAKE.test(channelId) && willQueue();

        if (SNOWFLAKE.test(channelId)) {
            try {
                posted = await (bot.postEmbed?.(channelId, spec) ?? false);
            } catch (error) {
                console.error("Embed post failed:", error);
            }
        }

        if (queued) {
            audit(session, "embed.queued", channelId);
            redirect(response, "/embed?flash=action_queued");
            return;
        }

        if (posted) {
            audit(session, "embed.send", channelId);
        }

        redirect(response, `/embed?flash=${posted ? "embed_sent" : "embed_failed"}`);
    }

    async function handleSettingsSave(request, response, session, theme) {
        const form = await readForm(request);

        if (!safeEqual(form.get("csrf"), session.csrf)) {
            sendHtml(response, 403, "Invalid request token.");
            return;
        }

        // Coerce everything into a shadow object first, so a single invalid field
        // (or a broken cross-field invariant) leaves the live config untouched.
        const next = {};

        try {
            for (const field of SETTINGS_FIELDS) {
                let raw;

                if (field.type === "boolean") {
                    raw = form.get(field.key) === "1";
                } else if (field.type === "list" && field.source) {
                    // A checklist submits one value per checked box; join them back
                    // into the newline form the list coercer expects. A textarea
                    // fallback yields a single multi-line value, which survives this.
                    raw = form.getAll(field.key).join("\n");
                } else {
                    raw = form.get(field.key);
                }

                next[configKeyOf(field)] = coerceFromForm(field, raw);
            }

            validateSettings({ ...config, ...next });
        } catch (error) {
            sendHtml(response, 400, settingsView(theme, session, error.message));
            return;
        }

        for (const field of SETTINGS_FIELDS) {
            const value = next[configKeyOf(field)];
            config[configKeyOf(field)] = value;
            bot.store?.setSetting(field.key, serializeSetting(field, value));
        }

        bot.applyRuntimeConfig?.();
        audit(session, "settings.save", "updated bot settings");
        redirect(response, "/settings?flash=settings_saved");
    }

    function auditView(theme, session) {
        const entries = bot.store ? bot.store.listAudit({ limit: 200 }) : [];
        return renderAuditLog({ theme, session, entries, nav: navFlags() });
    }

    function scheduledView(theme, session) {
        const tasks = bot.store ? bot.store.listPendingTasks({ limit: 200 }) : [];
        const announcements = bot.store ? bot.store.listAnnouncements() : [];
        return renderScheduled({ theme, session, tasks, announcements, directory: directory(), nav: navFlags() });
    }

    async function handleTaskCancel(request, response, session) {
        const form = await readForm(request);

        if (!safeEqual(form.get("csrf"), session.csrf)) {
            sendHtml(response, 403, "Invalid request token.");
            return;
        }

        const id = Number(form.get("id"));

        if (bot.store?.cancelTask(id)) {
            audit(session, "scheduled.cancel", `#${id}`);
        }

        redirect(response, "/scheduled");
    }

    const ANNOUNCE_INTERVALS = new Set([0, 3600, 86400, 604800]);

    async function handleAnnouncementCreate(request, response, session) {
        const form = await readForm(request);

        if (!safeEqual(form.get("csrf"), session.csrf)) {
            sendHtml(response, 403, "Invalid request token.");
            return;
        }

        const channelId = String(form.get("channel_id") ?? "").trim();
        const message = String(form.get("message") ?? "").trim();
        const repeat = Number(form.get("repeat"));
        const delayText = String(form.get("delay") ?? "").trim();
        const delayMs = delayText ? parseDurationMs(delayText) : 0;

        if (SNOWFLAKE.test(channelId) && message && ANNOUNCE_INTERVALS.has(repeat) && delayMs !== null) {
            bot.store.createAnnouncement({
                channelId,
                message,
                intervalSeconds: repeat,
                nextRun: Date.now() + (delayMs || 0)
            });
            audit(session, "announcement.create", channelId);
        }

        redirect(response, "/scheduled");
    }

    async function handleAnnouncementToggle(request, response, session) {
        const form = await readForm(request);

        if (!safeEqual(form.get("csrf"), session.csrf)) {
            sendHtml(response, 403, "Invalid request token.");
            return;
        }

        bot.store?.setAnnouncementEnabled(Number(form.get("id")), form.get("enabled") === "1");
        redirect(response, "/scheduled");
    }

    async function handleAnnouncementDelete(request, response, session) {
        const form = await readForm(request);

        if (!safeEqual(form.get("csrf"), session.csrf)) {
            sendHtml(response, 403, "Invalid request token.");
            return;
        }

        bot.store?.deleteAnnouncement(Number(form.get("id")));
        audit(session, "announcement.delete", String(form.get("id") ?? ""));
        redirect(response, "/scheduled");
    }

    function reactionRolesView(theme, session, notice = null) {
        const mappings = bot.store ? bot.store.listReactionRoles() : [];
        return renderReactionRoles({ theme, session, mappings, enabled: Boolean(config.reactionRolesEnabled), notice, directory: directory(), nav: navFlags() });
    }

    async function handleRoleSave(request, response, session, theme) {
        const form = await readForm(request);

        if (!safeEqual(form.get("csrf"), session.csrf)) {
            sendHtml(response, 403, "Invalid request token.");
            return;
        }

        const channelId = String(form.get("channel_id") ?? "").trim();
        const messageId = String(form.get("message_id") ?? "").trim();
        const emoji = String(form.get("emoji") ?? "").trim();
        const roleId = String(form.get("role_id") ?? "").trim();

        if (!SNOWFLAKE.test(channelId) || !SNOWFLAKE.test(messageId) || !SNOWFLAKE.test(roleId) || !emoji) {
            sendHtml(response, 400, reactionRolesView(theme, session, {
                text: "Channel, message, and role must be valid IDs, and an emoji is required.", error: true
            }));
            return;
        }

        bot.store.saveReactionRole({ messageId, emoji, roleId, channelId, guildId: config.controlGuildId });
        const queued = willQueue();
        const reacted = await (bot.addReactionOption?.(channelId, messageId, emoji) ?? false);
        audit(session, "roles.save", `${messageId} ${emoji} -> ${roleId}`);
        redirect(response, `/roles?flash=${queued ? "role_added_queued" : (reacted ? "role_added" : "role_added_noreact")}`);
    }

    async function handleRoleDelete(request, response, session) {
        const form = await readForm(request);

        if (!safeEqual(form.get("csrf"), session.csrf)) {
            sendHtml(response, 403, "Invalid request token.");
            return;
        }

        bot.store.deleteReactionRole(String(form.get("message_id") ?? "").trim(), String(form.get("emoji") ?? "").trim());
        audit(session, "roles.delete", `${form.get("message_id")} ${form.get("emoji")}`);
        redirect(response, "/roles?flash=role_removed");
    }

    async function handleFaqTest(request, response, session, theme) {
        const form = await readForm(request);

        if (!safeEqual(form.get("csrf"), session.csrf)) {
            sendHtml(response, 403, "Invalid request token.");
            return;
        }

        const message = String(form.get("message") ?? "");
        const match = findBestFaqMatch(bot.config.faqEntries ?? [], message, bot.config.matchThreshold);
        const entries = bot.store ? bot.store.listFaqEntries() : (bot.config.faqEntries ?? []);
        const testResult = { message, match: match?.entry ?? null, score: match?.score ?? 0 };

        sendHtml(response, 200, renderFaqList({ theme, session, entries, testResult, nav: navFlags() }));
    }

    async function handleRestart(request, response, session) {
        const form = await readForm(request);

        if (!safeEqual(form.get("csrf"), session.csrf)) {
            sendHtml(response, 403, "Invalid request token.");
            return;
        }

        if (!config.allowProcessRestart) {
            audit(session, "bot.process_restart.blocked", "process restart disabled");
            redirect(response, "/settings?flash=restart_disabled");
            return;
        }

        audit(session, "bot.restart", "restart requested from panel");
        sendHtml(response, 200, "<!doctype html><meta http-equiv=\"refresh\" content=\"6; url=/\"><p style=\"font-family:system-ui;margin:60px auto;max-width:340px\">Restarting… this page returns in a moment.</p>");
        bot.restart?.();
    }

    async function handleBotControl(request, response, session) {
        const form = await readForm(request);

        if (!safeEqual(form.get("csrf"), session.csrf)) {
            sendHtml(response, 403, "Invalid request token.");
            return;
        }

        const action = String(form.get("action") ?? "");

        try {
            if (action === "start") {
                await bot.startDiscordConnection?.();
                audit(session, "bot.connection.start", "started from panel");
                redirect(response, "/settings?flash=bot_started");
                return;
            }

            if (action === "stop") {
                await bot.stopDiscordConnection?.();
                audit(session, "bot.connection.stop", "stopped from panel");
                redirect(response, "/settings?flash=bot_stopped");
                return;
            }

            if (action === "restart") {
                await bot.restartDiscordConnection?.();
                audit(session, "bot.connection.restart", "reconnected from panel");
                redirect(response, "/settings?flash=bot_restarted");
                return;
            }
        } catch (error) {
            console.error("Bot control failed:", error);
        }

        redirect(response, "/settings?flash=bot_control_failed");
    }

    function moderationRulesView(theme, session) {
        const globals = bot.store ? bot.store.getModerationGlobals() : {};
        const rules = bot.store ? bot.store.listModerationRules() : [];
        return renderModerationRules({ theme, session, globals, rules, nav: navFlags() });
    }

    // Parses the rule editor form into a rule document, validating any regex so a
    // broken pattern is reported rather than silently ignored at match time.
    function ruleFromForm(form) {
        const lines = (name) => String(form.get(name) ?? "")
            .split("\n").map((line) => line.trim()).filter(Boolean);

        const regex = lines("regex");

        for (const pattern of regex) {
            try {
                // eslint-disable-next-line no-new
                new RegExp(pattern, "i");
            } catch {
                throw new Error(`Invalid regular expression: ${pattern}`);
            }
        }

        const rule = {
            id: String(form.get("id") ?? "").trim(),
            enabled: form.get("enabled") === "1",
            action: MODERATION_ACTIONS.has(form.get("action")) ? form.get("action") : "ban",
            reason: String(form.get("reason") ?? "").trim(),
            deleteMessage: form.get("deleteMessage") === "1",
            match: {
                anyPhrases: lines("phrases"),
                allTerms: lines("allTerms"),
                anyTerms: lines("anyTerms"),
                regex,
                requireUrl: form.get("requireUrl") === "1"
            }
        };

        const timeout = Number(form.get("timeoutSeconds"));
        if (Number.isFinite(timeout) && timeout > 0) {
            rule.timeoutSeconds = timeout;
        }

        return rule;
    }

    async function handleRuleSave(request, response, session, theme) {
        const form = await readForm(request);

        if (!safeEqual(form.get("csrf"), session.csrf)) {
            sendHtml(response, 403, "Invalid request token.");
            return;
        }

        let rule;

        try {
            rule = ruleFromForm(form);
        } catch (error) {
            sendHtml(response, 400, renderModerationRuleEditor({ theme, session, rule: ruleFromFormSafe(form), isNew: !form.get("original_id"), error: error.message, nav: navFlags() }));
            return;
        }

        const hasCriteria = rule.match.anyPhrases.length || rule.match.allTerms.length
            || rule.match.anyTerms.length || rule.match.regex.length;

        if (!rule.id || !hasCriteria) {
            sendHtml(response, 400, renderModerationRuleEditor({
                theme, session, rule, isNew: !form.get("original_id"),
                error: "A rule needs an ID and at least one phrase, term, or pattern to match.", nav: navFlags()
            }));
            return;
        }

        const originalId = String(form.get("original_id") ?? "").trim();
        if (originalId && originalId !== rule.id) {
            bot.store.deleteModerationRule(originalId);
        }

        bot.store.saveModerationRule(rule);
        bot.reloadModerationRules?.();
        audit(session, "moderation.rule.save", rule.id);
        redirect(response, "/moderation/rules?flash=rule_saved");
    }

    // Best-effort re-parse for re-rendering the editor after a validation error,
    // ignoring the very error we are reporting.
    function ruleFromFormSafe(form) {
        try {
            return ruleFromForm(form);
        } catch {
            return { id: form.get("id"), reason: form.get("reason"), action: form.get("action") };
        }
    }

    async function handleRuleDelete(request, response, session) {
        const form = await readForm(request);

        if (!safeEqual(form.get("csrf"), session.csrf)) {
            sendHtml(response, 403, "Invalid request token.");
            return;
        }

        bot.store.deleteModerationRule(String(form.get("id") ?? "").trim());
        bot.reloadModerationRules?.();
        audit(session, "moderation.rule.delete", String(form.get("id") ?? ""));
        redirect(response, "/moderation/rules?flash=rule_deleted");
    }

    async function handleGlobalsSave(request, response, session) {
        const form = await readForm(request);

        if (!safeEqual(form.get("csrf"), session.csrf)) {
            sendHtml(response, 403, "Invalid request token.");
            return;
        }

        const action = (value, fallback) => (MODERATION_ACTIONS.has(value) ? value : fallback);
        const maxMentions = Number(form.get("maxMentions"));

        bot.store.setModerationGlobals({
            blockedDomains: String(form.get("blockedDomains") ?? "").split("\n").map((line) => line.trim()).filter(Boolean),
            maxMentions: Number.isFinite(maxMentions) && maxMentions >= 0 ? maxMentions : 8,
            blockedDomainAction: action(form.get("blockedDomainAction"), "ban"),
            lookalikeDomainAction: action(form.get("lookalikeDomainAction"), "ban"),
            walletScamAction: action(form.get("walletScamAction"), "ban"),
            riskyTldAction: action(form.get("riskyTldAction"), "timeout"),
            mentionSpamAction: action(form.get("mentionSpamAction"), "timeout")
        });

        bot.reloadModerationRules?.();
        audit(session, "moderation.detectors.save", "updated scam detectors");
        redirect(response, "/moderation/rules?flash=detectors_saved");
    }

    function accessView(theme, session, editing = null) {
        const grants = bot.store ? bot.store.listAccessGrants() : [];
        const adminBlocks = bot.store ? bot.store.listAdminBlocks() : [];
        return renderAccess({ theme, session, grants, adminBlocks, editing, directory: directory(), nav: navFlags() });
    }

    async function handleAccessSave(request, response, session) {
        const form = await readForm(request);

        if (!safeEqual(form.get("csrf"), session.csrf)) {
            sendHtml(response, 403, "Invalid request token.");
            return;
        }

        const subjectType = form.get("subject_type") === "user" ? "user" : "role";
        const subjectId = String((subjectType === "user" ? form.get("user_id") : form.get("role_id")) ?? "").trim();
        const areas = normalizeAreas(form.getAll("areas"));
        const label = String(form.get("label") ?? "").trim() || null;

        if (!SNOWFLAKE.test(subjectId) || areas.length === 0) {
            redirect(response, "/access?flash=grant_failed");
            return;
        }

        bot.store.saveAccessGrant({ subjectType, subjectId, areas, label, createdBy: session.userId });
        audit(session, "access.grant.save", `${subjectType} ${subjectId} → ${areas.join(", ")}`);
        redirect(response, "/access?flash=grant_saved");
    }

    async function handleAccessDelete(request, response, session) {
        const form = await readForm(request);

        if (!safeEqual(form.get("csrf"), session.csrf)) {
            sendHtml(response, 403, "Invalid request token.");
            return;
        }

        const subjectType = form.get("subject_type") === "user" ? "user" : "role";
        const subjectId = String(form.get("subject_id") ?? "").trim();

        if (bot.store?.deleteAccessGrant(subjectType, subjectId)) {
            audit(session, "access.grant.delete", `${subjectType} ${subjectId}`);
        }

        redirect(response, "/access?flash=grant_deleted");
    }

    async function handleAdminBlock(request, response, session) {
        const form = await readForm(request);

        if (!safeEqual(form.get("csrf"), session.csrf)) {
            sendHtml(response, 403, "Invalid request token.");
            return;
        }

        // Revoking an administrator is the owner's prerogative alone.
        if (!session.access?.owner) {
            sendHtml(response, 403, "Only the owner can revoke administrators.");
            return;
        }

        const subjectType = form.get("subject_type") === "user" ? "user" : "role";
        const subjectId = String((subjectType === "user" ? form.get("user_id") : form.get("role_id")) ?? "").trim();
        const label = String(form.get("label") ?? "").trim() || null;

        if (!SNOWFLAKE.test(subjectId)) {
            redirect(response, "/access?flash=admin_failed");
            return;
        }

        bot.store.addAdminBlock({ subjectType, subjectId, label, createdBy: session.userId });
        audit(session, "access.admin.revoke", `${subjectType} ${subjectId}`);
        redirect(response, "/access?flash=admin_revoked");
    }

    async function handleAdminUnblock(request, response, session) {
        const form = await readForm(request);

        if (!safeEqual(form.get("csrf"), session.csrf)) {
            sendHtml(response, 403, "Invalid request token.");
            return;
        }

        if (!session.access?.owner) {
            sendHtml(response, 403, "Only the owner can restore administrators.");
            return;
        }

        const subjectType = form.get("subject_type") === "user" ? "user" : "role";
        const subjectId = String(form.get("subject_id") ?? "").trim();

        if (bot.store?.removeAdminBlock(subjectType, subjectId)) {
            audit(session, "access.admin.restore", `${subjectType} ${subjectId}`);
        }

        redirect(response, "/access?flash=admin_restored");
    }

    async function handleRequest(request, response) {
        cleanupExpired();

        const url = new URL(request.url, config.adminWebPublicUrl);
        const { method } = request;
        const theme = readTheme(request);

        try {
            if (method === "GET" && url.pathname.startsWith("/assets/fonts/")) {
                serveFont(response, path.basename(url.pathname));
                return;
            }

            if (method === "GET" && url.pathname === "/assets/avatar.jpg") {
                serveAvatar(response);
                return;
            }

            if (method === "GET" && url.pathname === "/theme") {
                const mode = normalizeTheme(url.searchParams.get("mode"));
                const returnTo = safeReturnPath(url.searchParams.get("return"));
                redirect(response, returnTo, {
                    "Set-Cookie": buildCookie(THEME_COOKIE, mode, config, 365 * 24 * 60 * 60)
                });
                return;
            }

            if (method === "GET" && url.pathname === "/license") {
                sendHtml(response, 200, renderLicense({ theme, session: null, nav: navFlags() }));
                return;
            }

            if (method === "GET" && url.pathname === "/login") {
                const state = randomToken();
                oauthStates.set(state, Date.now() + (5 * 60 * 1000));

                const oauthUrl = new URL("https://discord.com/oauth2/authorize");
                oauthUrl.searchParams.set("client_id", config.discordOAuthClientId);
                oauthUrl.searchParams.set("redirect_uri", config.discordOAuthRedirectUri);
                oauthUrl.searchParams.set("response_type", "code");
                oauthUrl.searchParams.set("scope", "identify guilds guilds.members.read");
                oauthUrl.searchParams.set("state", state);

                redirect(response, oauthUrl.toString());
                return;
            }

            if (method === "GET" && url.pathname === "/oauth/callback") {
                const code = url.searchParams.get("code");
                const state = url.searchParams.get("state");
                const stateExpiresAt = oauthStates.get(state);
                oauthStates.delete(state);

                if (!code || !state || !stateExpiresAt || stateExpiresAt <= Date.now()) {
                    sendHtml(response, 400, renderLogin({ theme, message: { text: "Discord sign-in failed. Please try again.", error: true } }));
                    return;
                }

                const token = await exchangeDiscordCode(fetchImpl, config, code);
                const accessToken = token.access_token;
                const expiresAt = Date.now() + Math.min(Number(token.expires_in ?? 3600) * 1000, SESSION_TTL_MS);
                const principal = await fetchOAuthPrincipal(fetchImpl, config, accessToken);

                if (!principal) {
                    sendHtml(response, 403, renderLogin({ theme, message: { text: "Discord sign-in could not be completed. Please try again.", error: true } }));
                    return;
                }

                const access = resolveAccess(principal, config, bot.store);

                // Authenticated, but not an approved user or role: an explicit
                // access-denied page rather than a silent bounce to the login form.
                if (!access.authorized) {
                    sendHtml(response, 403, renderAccessDenied({ theme, username: principal.username }));
                    return;
                }

                const sessionId = randomToken();
                sessions.set(sessionId, {
                    accessToken,
                    csrf: randomToken(),
                    expiresAt,
                    principalCheckedAt: Date.now(),
                    permissions: principal.permissions,
                    roleIds: principal.roleIds,
                    access,
                    userId: principal.userId,
                    username: principal.username
                });

                redirect(response, "/", {
                    "Set-Cookie": buildCookie(SESSION_COOKIE, sessionCookieValue(sessionId, config), config, Math.floor((expiresAt - Date.now()) / 1000))
                });
                return;
            }

            if (method === "POST" && url.pathname === "/logout") {
                const authorized = await getAuthorizedSession(request, response);
                const form = await readForm(request);

                if (authorized && safeEqual(form.get("csrf"), authorized.session.csrf)) {
                    clearSessionCookie(response, authorized.sessionId);
                }

                redirect(response, "/");
                return;
            }

            // Everything below requires an authorized session.
            const authorized = await getAuthorizedSession(request, response);

            if (!authorized) {
                if (method === "GET") {
                    sendHtml(response, 200, renderLogin({ theme }));
                } else {
                    sendHtml(response, 401, renderLogin({ theme, message: { text: "Please sign in again.", error: true } }));
                }
                return;
            }

            const { session } = authorized;
            const flash = FLASH[url.searchParams.get("flash")] ?? null;

            // Give the page chrome the live connection state (header light) and
            // gate the request on the area its route requires. Baseline routes
            // (dashboard, reference, license) return null and pass for anyone
            // signed in; /access requires an administrator.
            session.botStatus = status();

            if (!canAccessArea(session.access, areaForPath(url.pathname))) {
                if (method === "GET") {
                    redirect(response, "/?flash=no_access");
                } else {
                    sendHtml(response, 403, "You do not have access to that area.");
                }
                return;
            }

            if (method === "GET" && url.pathname === "/") {
                sendHtml(response, 200, withFlash(dashboardView(theme, session), flash));
                return;
            }

            if (method === "GET" && url.pathname === "/analytics") {
                sendHtml(response, 200, analyticsView(theme, session));
                return;
            }

            if (method === "GET" && url.pathname === "/moderation") {
                sendHtml(response, 200, withFlash(moderationView(url, theme, session), flash));
                return;
            }

            if (method === "POST" && url.pathname === "/moderation/undo") {
                await handleUndo(request, response, session);
                return;
            }

            if (method === "GET" && url.pathname === "/faq") {
                const entries = bot.store ? bot.store.listFaqEntries() : (bot.config.faqEntries ?? []);
                sendHtml(response, 200, withFlash(renderFaqList({ theme, session, entries, nav: navFlags() }), flash));
                return;
            }

            if (method === "GET" && url.pathname === "/faq/edit") {
                const id = url.searchParams.get("id");
                const entry = id ? bot.store?.getFaqEntry(id) : null;
                sendHtml(response, 200, renderFaqEditor({ theme, session, entry, isNew: !entry, nav: navFlags() }));
                return;
            }

            if (method === "POST" && url.pathname === "/faq/save") {
                await handleFaqSave(request, response, session, theme);
                return;
            }

            if (method === "POST" && url.pathname === "/faq/delete") {
                await handleFaqDelete(request, response, session);
                return;
            }

            if (method === "GET" && url.pathname === "/settings") {
                sendHtml(response, 200, withFlash(settingsView(theme, session), flash));
                return;
            }

            if (method === "POST" && url.pathname === "/settings") {
                await handleSettingsSave(request, response, session, theme);
                return;
            }

            if (method === "GET" && url.pathname === "/glossary") {
                sendHtml(response, 200, renderGlossary({ theme, session, sections: settingSections(), nav: navFlags() }));
                return;
            }

            if (method === "POST" && url.pathname === "/bot-control") {
                await handleBotControl(request, response, session);
                return;
            }

            if (method === "POST" && url.pathname === "/faq/test") {
                await handleFaqTest(request, response, session, theme);
                return;
            }

            if (method === "GET" && url.pathname === "/commands") {
                const commands = bot.store ? bot.store.listCustomCommands() : [];
                sendHtml(response, 200, withFlash(renderCustomCommands({ theme, session, commands, enabled: Boolean(config.enableCustomCommands), nav: navFlags() }), flash));
                return;
            }

            if (method === "GET" && url.pathname === "/commands/edit") {
                const id = url.searchParams.get("id");
                const command = id ? bot.store?.getCustomCommand(id) : null;
                sendHtml(response, 200, renderCustomCommandEditor({ theme, session, command, isNew: !command, nav: navFlags() }));
                return;
            }

            if (method === "POST" && url.pathname === "/commands/save") {
                await handleCommandSave(request, response, session, theme);
                return;
            }

            if (method === "POST" && url.pathname === "/commands/delete") {
                await handleCommandDelete(request, response, session);
                return;
            }

            if (method === "GET" && url.pathname === "/embed") {
                sendHtml(response, 200, withFlash(renderEmbedComposer({ theme, session, directory: directory(), nav: navFlags() }), flash));
                return;
            }

            if (method === "POST" && url.pathname === "/embed/send") {
                await handleEmbedSend(request, response, session);
                return;
            }

            if (method === "GET" && url.pathname === "/audit") {
                sendHtml(response, 200, auditView(theme, session));
                return;
            }

            if (method === "GET" && url.pathname === "/access") {
                const editParam = String(url.searchParams.get("edit") ?? "");
                const separator = editParam.indexOf(":");
                const editing = separator > 0
                    ? bot.store?.getAccessGrant(
                        editParam.slice(0, separator) === "user" ? "user" : "role",
                        editParam.slice(separator + 1)
                    )
                    : null;
                sendHtml(response, 200, withFlash(accessView(theme, session, editing), flash));
                return;
            }

            if (method === "POST" && url.pathname === "/access/save") {
                await handleAccessSave(request, response, session);
                return;
            }

            if (method === "POST" && url.pathname === "/access/delete") {
                await handleAccessDelete(request, response, session);
                return;
            }

            if (method === "POST" && url.pathname === "/access/admin-block") {
                await handleAdminBlock(request, response, session);
                return;
            }

            if (method === "POST" && url.pathname === "/access/admin-unblock") {
                await handleAdminUnblock(request, response, session);
                return;
            }

            if (method === "GET" && url.pathname === "/scheduled") {
                sendHtml(response, 200, scheduledView(theme, session));
                return;
            }

            if (method === "POST" && url.pathname === "/scheduled/cancel") {
                await handleTaskCancel(request, response, session);
                return;
            }

            if (method === "POST" && url.pathname === "/announcements/create") {
                await handleAnnouncementCreate(request, response, session);
                return;
            }

            if (method === "POST" && url.pathname === "/announcements/toggle") {
                await handleAnnouncementToggle(request, response, session);
                return;
            }

            if (method === "POST" && url.pathname === "/announcements/delete") {
                await handleAnnouncementDelete(request, response, session);
                return;
            }

            if (method === "GET" && url.pathname === "/roles") {
                sendHtml(response, 200, withFlash(reactionRolesView(theme, session), flash));
                return;
            }

            if (method === "POST" && url.pathname === "/roles/save") {
                await handleRoleSave(request, response, session, theme);
                return;
            }

            if (method === "POST" && url.pathname === "/roles/delete") {
                await handleRoleDelete(request, response, session);
                return;
            }

            if (method === "GET" && url.pathname === "/leveling") {
                const rows = (bot.store && config.controlGuildId)
                    ? bot.store.topLevels(config.controlGuildId, 50)
                    : [];
                sendHtml(response, 200, renderLeaderboard({ theme, session, rows, enabled: Boolean(config.levelingEnabled), nav: navFlags() }));
                return;
            }

            if (method === "GET" && url.pathname === "/moderation/rules") {
                sendHtml(response, 200, withFlash(moderationRulesView(theme, session), flash));
                return;
            }

            if (method === "GET" && url.pathname === "/moderation/rules/edit") {
                const id = url.searchParams.get("id");
                const rule = id ? bot.store?.getModerationRule(id) : null;
                sendHtml(response, 200, renderModerationRuleEditor({ theme, session, rule, isNew: !rule, nav: navFlags() }));
                return;
            }

            if (method === "POST" && url.pathname === "/moderation/rules/save") {
                await handleRuleSave(request, response, session, theme);
                return;
            }

            if (method === "POST" && url.pathname === "/moderation/rules/delete") {
                await handleRuleDelete(request, response, session);
                return;
            }

            if (method === "POST" && url.pathname === "/moderation/rules/globals") {
                await handleGlobalsSave(request, response, session);
                return;
            }

            if (method === "POST" && url.pathname === "/restart") {
                await handleRestart(request, response, session);
                return;
            }

            sendHtml(response, 404, renderLogin({ theme, message: { text: "Page not found.", error: true } }));
        } catch (error) {
            console.error("Admin dashboard request failed:", error);
            sendHtml(response, 500, "Request failed.");
        }
    }

    const server = config.adminWebProtocol === "https"
        ? https.createServer({
            cert: fs.readFileSync(config.adminWebTlsCertPath),
            key: fs.readFileSync(config.adminWebTlsKeyPath)
        }, handleRequest)
        : http.createServer(handleRequest);

    await new Promise((resolve) => {
        server.listen(config.adminWebPort, config.adminWebHost, resolve);
    });

    return server;
}

// Flash notices are passed through the redirect query string; splice the notice
// into the already-rendered page just after <main> so the renderers stay pure.
function withFlash(html, flash) {
    if (!flash) {
        return html;
    }

    const notice = `<div class="flash${flash.error ? " error" : ""}">${flash.message.replaceAll("<", "&lt;")}</div>`;
    return html.replace("<main>", `<main>${notice}`);
}
