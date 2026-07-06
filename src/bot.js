// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SparkBugz

import { Client, GatewayIntentBits, PermissionFlagsBits, Partials, MessageFlags } from "discord.js";
import { loadConfig, loadFaqEntries } from "./config.js";
import { canManageDiscordMessage, getRoleIds, isAuthorizedPrincipal } from "./auth.js";
import { AREAS, AREA_KEYS, areaLabel, canAccessArea, normalizeAreas, resolveAccess } from "./access.js";
import { buildSlashCommands } from "./slashCommands.js";
import { findBestFaqMatch } from "./faqMatcher.js";
import { matchCustomCommand } from "./customCommands.js";
import { parsePollOptions, buildPoll } from "./polls.js";
import { pickWinners, normalizeWinnerCount, buildGiveawayAnnouncement, buildGiveawayResult } from "./giveaways.js";
import { buildEmbed, isEmptyEmbed } from "./embeds.js";
import { GitHubSearchClient, formatGitHubItem } from "./githubSearch.js";
import { isLikelyQuestion } from "./questionHeuristics.js";
import { normalizeText, tokenize } from "./text.js";
import { renderTemplate, memberContext } from "./templates.js";
import { levelProgress, parseLevelRoles } from "./leveling.js";
import { applyStoredSettings } from "./settings.js";
import {
    analyzeModerationMessage,
    clampBanDeleteSeconds,
    parseDurationMs,
    parseUserId,
    summarizeFindings
} from "./moderation.js";

// Which access area each management text command belongs to. Commands not listed
// (status) are open to any authorized principal; `access` is handled separately
// as admin-only.
const MANAGEMENT_COMMAND_AREAS = {
    reload: "faq",
    known: "faq",
    issue: "faq",
    triage: "faq",
    ban: "moderation",
    kick: "moderation",
    timeout: "moderation",
    mute: "moderation",
    unmute: "moderation",
    warn: "moderation",
    purge: "moderation"
};

// Parses the subject of an access command: a role or user mention, an explicit
// role:/user: prefix, or a bare snowflake (treated as a role). Returns null when
// the token is not a recognizable subject.
function parseAccessSubject(token) {
    const raw = String(token ?? "").trim();
    let match;

    if ((match = /^<@&(\d{5,25})>$/.exec(raw))) {
        return { subjectType: "role", subjectId: match[1] };
    }

    if ((match = /^<@!?(\d{5,25})>$/.exec(raw))) {
        return { subjectType: "user", subjectId: match[1] };
    }

    if ((match = /^role:(\d{5,25})$/i.exec(raw))) {
        return { subjectType: "role", subjectId: match[1] };
    }

    if ((match = /^user:(\d{5,25})$/i.exec(raw))) {
        return { subjectType: "user", subjectId: match[1] };
    }

    if (/^\d{5,25}$/.test(raw)) {
        return { subjectType: "role", subjectId: raw };
    }

    return null;
}

function buildInviteUrl(clientId) {
    if (!clientId) {
        return null;
    }

    // applications.commands is required so the bot may register slash commands in
    // the guilds it is invited to.
    return `https://discord.com/oauth2/authorize?client_id=${clientId}&scope=bot+applications.commands`;
}

function getEntryRepos(entry, fallbackRepos) {
    return entry.github?.repos?.length ? entry.github.repos : fallbackRepos;
}

function getCooldownSeconds(entry, defaultCooldownSeconds) {
    const configured = Number(entry.cooldownSeconds);
    return Number.isFinite(configured) && configured > 0 ? configured : defaultCooldownSeconds;
}

function getEntryId(entry) {
    return entry.id || entry.question || entry.title || "faq-entry";
}

function getEntryMessage(entry) {
    return entry.response?.message || entry.answer || null;
}

function truncateForDiscord(content, maxLength) {
    const text = String(content ?? "").trim();

    if (text.length <= maxLength) {
        return text;
    }

    return `${text.slice(0, Math.max(0, maxLength - 15)).trimEnd()}\n[truncated]`;
}

function truncateReason(content) {
    return truncateForDiscord(content, 500).replace(/\s+/g, " ");
}

function formatUserReference(userId) {
    return `<@${userId}>`;
}

// The starboard repost: a header with the emoji and count, the original text, and
// a jump link back to the source message.
function buildStarboardContent(message, count, emoji) {
    const author = message.author?.tag ?? message.author?.username ?? "someone";
    const jump = `https://discord.com/channels/${message.guild?.id}/${message.channelId}/${message.id}`;
    const excerpt = message.content ? String(message.content) : "(no text)";

    return [`${emoji} ${count} · <#${message.channelId}> · ${author}`, excerpt, jump].join("\n");
}

// GuildMembers is a privileged intent needed only for join/leave events, so we
// request it only when a feature that uses it is on. An untouched FAQ/GitHub
// deployment therefore never has to enable a privileged intent in the portal.
function needsMemberEvents(config) {
    return Boolean(
        config.welcomeEnabled || config.goodbyeEnabled
        || config.autoRoleIds?.length || (config.loggingEnabled && config.logJoinsLeaves)
    );
}

// Reaction events power both reaction roles and the starboard, so either feature
// being on requires the reactions intent and message/reaction partials.
function needsReactionEvents(config) {
    return Boolean(config.reactionRolesEnabled || config.starboardEnabled);
}

function buildIntents(config) {
    const intents = [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ];

    if (needsMemberEvents(config)) {
        intents.push(GatewayIntentBits.GuildMembers);
    }

    if (needsReactionEvents(config)) {
        intents.push(GatewayIntentBits.GuildMessageReactions);
    }

    return intents;
}

const COOLDOWN_SWEEP_INTERVAL_MS = 10 * 60 * 1000;
// How often the scheduler drains due tasks (temp-ban expiry, temp-role removal,
// giveaway draws). Minute-granularity durations don't need a tighter tick.
const SCHEDULER_TICK_INTERVAL_MS = 30 * 1000;
// How often the bot reconciles with the panel process over the shared store:
// applies config edits, honours gateway on/off, drains queued actions and
// republishes its heartbeat. Fast enough that panel actions feel immediate.
const CONTROL_TICK_INTERVAL_MS = 2 * 1000;
// Finished queue entries are pruned once they age past this.
const COMMAND_RETENTION_MS = 5 * 60 * 1000;
// Two categories are stripped before a message becomes a GitHub query. Grammar
// words carry no topic signal; conversational scaffolding ("anyone having issues
// with…") is how people phrase a request but never appears in an issue title.
// Both matter because the match score divides by query length (see overlapRatio):
// every filler token left in drags a genuine title match below the threshold, so
// "anyone having issues with deduplicate savings metrics" must reduce to just
// "deduplicate savings metrics" or an exact-title issue can never clear the bar.
// Note these still *trigger* a search via questionHeuristics' HELP_TERMS — we only
// keep them out of the query text, so the two lists are deliberately separate.
const FALLBACK_GITHUB_STOP_WORDS = new Set([
    // Grammar / function words.
    "a", "an", "and", "are", "can", "could", "did", "do", "does", "for", "how",
    "i", "is", "it", "me", "my", "of", "on", "please", "should", "the", "to",
    "was", "were", "what", "when", "where", "which", "who", "why", "will",
    "with", "would",
    // Conversational scaffolding around a request for help.
    "anybody", "anyone", "everybody", "everyone", "somebody", "someone",
    "they", "we", "you", "your", "get", "getting", "got", "have", "having",
    "see", "seeing", "try", "trying", "help", "hey", "hi", "hello", "im", "ive",
    "issue", "issues", "just", "problem", "problems", "so", "still", "stuck",
    "trouble"
]);

function buildFallbackGitHubQuery(messageContent) {
    const tokens = tokenize(normalizeText(messageContent))
        .filter((token) => !FALLBACK_GITHUB_STOP_WORDS.has(token));

    return tokens.join(" ").trim();
}

export class DiscordFaqBot {
    constructor(config = loadConfig(), { store = null } = {}) {
        this.config = config;
        this.store = store;
        this.cooldowns = new Map();
        this.cooldownSweep = null;
        this.schedulerTimer = null;
        this.githubClient = new GitHubSearchClient({
            token: config.githubToken,
            defaultRepos: config.githubDefaultRepos,
            cacheTtlMs: config.githubCacheTtlMs,
            maxQueryLength: config.githubQueryMaxLength,
            requestTimeoutMs: config.githubRequestTimeoutMs
        });
        this.client = this.createClient();
        this.eventsRegistered = false;
        this.connectionPromise = null;
        this.controlTimer = null;
        this.controlBusy = false;
        this.lastControlEpoch = null;
        this.lastGatewayNonce = null;
    }

    createClient() {
        return new Client({
            intents: buildIntents(this.config),
            // Reactions on messages sent before the bot started arrive as partials;
            // fetch-on-demand needs these enabled.
            partials: needsReactionEvents(this.config)
                ? [Partials.Message, Partials.Reaction, Partials.User]
                : []
        });
    }

    // Cooldown keys are keyed by user/channel/entry and would otherwise pile up
    // forever (they are only pruned when the same key is checked again). A slow
    // periodic sweep keeps the map bounded on a busy server. unref() so this
    // timer never holds the process open on its own.
    startCooldownSweep() {
        if (this.cooldownSweep) {
            return;
        }

        this.cooldownSweep = setInterval(() => this.sweepCooldowns(), COOLDOWN_SWEEP_INTERVAL_MS);
        this.cooldownSweep.unref?.();
    }

    sweepCooldowns() {
        const now = Date.now();

        for (const [key, expiresAt] of this.cooldowns.entries()) {
            if (expiresAt <= now) {
                this.cooldowns.delete(key);
            }
        }
    }

    // Re-applies settings that were changed at runtime from the admin panel onto
    // the pieces that cached them at construction (the GitHub client, the bot's
    // Discord identity). Fields the bot reads straight off config each message
    // need nothing here.
    applyRuntimeConfig() {
        const client = this.githubClient;

        if (client) {
            client.defaultRepos = this.config.githubDefaultRepos;
            client.maxQueryLength = this.config.githubQueryMaxLength;
            client.requestTimeoutMs = this.config.githubRequestTimeoutMs;

            if (client.cache) {
                client.cache.ttlMs = this.config.githubCacheTtlMs;
            }
        }

        this.applyBotIdentity();
    }

    // Best-effort: present the configured bot name as a Discord presence and as
    // the nickname in the control guild. Never throws — the admin page branding
    // stays "bugbot" regardless of this.
    applyBotIdentity() {
        const name = this.config.botName;

        if (!name || !this.client?.user) {
            return;
        }

        try {
            this.client.user.setActivity?.(`${name} · watching for questions`);
        } catch {
            // Presence is cosmetic; ignore failures.
        }

        this.getGuild(this.config.controlGuildId)?.members?.me?.setNickname?.(name).catch(() => {});
    }

    // Drains due scheduled tasks on a slow tick. unref() so it never keeps the
    // process alive by itself. Runs once immediately so a task whose time passed
    // while the bot was down fires on the next start.
    startScheduler() {
        if (this.schedulerTimer || !this.store) {
            return;
        }

        this.runDueTasks().catch((error) => console.error("scheduler tick failed:", error));
        this.schedulerTimer = setInterval(() => {
            this.runDueTasks().catch((error) => console.error("scheduler tick failed:", error));
        }, SCHEDULER_TICK_INTERVAL_MS);
        this.schedulerTimer.unref?.();
    }

    async runDueTasks() {
        if (!this.store) {
            return;
        }

        for (const task of this.store.dueTasks()) {
            try {
                await this.dispatchTask(task);
            } catch (error) {
                console.error(`Scheduled task #${task.id} (${task.type}) failed:`, error);
            } finally {
                // Mark done regardless: a task that throws (member gone, already
                // unbanned) should not spin forever on every tick.
                this.store.completeTask(task.id);
            }
        }

        await this.runDueAnnouncements();
    }

    async runDueAnnouncements() {
        const now = Date.now();
        const guild = this.getGuild(this.config.controlGuildId);

        for (const announcement of this.store.dueAnnouncements(now)) {
            try {
                await this.sendToChannelId(guild, announcement.channel_id, announcement.message);
                this.bumpStat("announcement", String(announcement.id));
            } catch (error) {
                console.error(`Announcement #${announcement.id} failed:`, error);
            } finally {
                // Recurring: advance from now (not the missed slot) so a downtime
                // gap never fires a burst of catch-up posts. One-shot: disable.
                const nextRun = announcement.interval_seconds > 0
                    ? now + (announcement.interval_seconds * 1000)
                    : null;
                this.store.markAnnouncementRan(announcement.id, nextRun);
            }
        }
    }

    async dispatchTask(task) {
        const payload = task.payload ?? {};

        if (task.type === "unban") {
            await this.unbanUser(task.guild_id, payload.userId, "Temporary ban expired.");
            this.recordModeration({
                guildId: task.guild_id,
                targetUserId: payload.userId,
                targetTag: payload.targetTag ?? null,
                source: "schedule",
                action: "unban",
                reason: "Temporary ban expired.",
                dryRun: false,
                success: true
            });
            return;
        }

        if (task.type === "role_remove") {
            const guild = this.getGuild(task.guild_id);
            const member = await this.resolveGuildMember(guild, payload.userId);
            await member?.roles?.remove?.(payload.roleId, "Temporary role expired.");
            return;
        }

        if (task.type === "giveaway_end") {
            await this.drawGiveaway(task);
        }
    }

    registerClientEvents() {
        if (this.eventsRegistered) {
            return;
        }

        this.client.on("ready", () => {
            console.log(`Discord FAQ bot connected as ${this.client.user.tag}.`);
            this.applyBotIdentity();

            const inviteUrl = buildInviteUrl(this.config.discordClientId);
            if (inviteUrl) {
                console.log(`Invite URL: ${inviteUrl}`);
            }

            this.registerSlashCommands().catch((error) => {
                console.error("Failed to register slash commands:", error);
            });
        });

        this.client.on("messageCreate", async (message) => {
            try {
                await this.handleMessage(message);
            } catch (error) {
                console.error("Failed to handle Discord message:", error);
            }
        });

        this.client.on("guildMemberAdd", (member) => {
            this.handleMemberJoin(member).catch((error) => console.error("member join failed:", error));
        });
        this.client.on("guildMemberRemove", (member) => {
            this.handleMemberLeave(member).catch((error) => console.error("member leave failed:", error));
        });
        this.client.on("messageDelete", (message) => {
            this.handleMessageDelete(message).catch((error) => console.error("delete log failed:", error));
        });
        this.client.on("messageUpdate", (oldMessage, newMessage) => {
            this.handleMessageEdit(oldMessage, newMessage).catch((error) => console.error("edit log failed:", error));
        });
        this.client.on("messageReactionAdd", (reaction, user) => {
            this.handleReactionRole(reaction, user, true).catch((error) => console.error("reaction add failed:", error));
            this.handleStarboardReaction(reaction, user).catch((error) => console.error("starboard failed:", error));
        });
        this.client.on("messageReactionRemove", (reaction, user) => {
            this.handleReactionRole(reaction, user, false).catch((error) => console.error("reaction remove failed:", error));
        });
        this.client.on("interactionCreate", (interaction) => {
            this.handleInteraction(interaction).catch((error) => console.error("interaction failed:", error));
        });

        this.eventsRegistered = true;
    }

    async startDiscordConnection() {
        this.registerClientEvents();

        if (this.client.isReady?.() || this.connectionPromise) {
            return;
        }

        this.connectionPromise = this.client.login(this.config.discordToken);

        try {
            await this.connectionPromise;
        } finally {
            this.connectionPromise = null;
        }
    }

    async stopDiscordConnection() {
        if (this.connectionPromise) {
            await this.connectionPromise.catch(() => {});
        }

        this.client.destroy?.();
        this.client = this.createClient();
        this.eventsRegistered = false;
        this.connectionPromise = null;
    }

    async restartDiscordConnection() {
        await this.stopDiscordConnection();
        await this.startDiscordConnection();
    }

    async start() {
        this.startCooldownSweep();
        this.startScheduler();
        // The admin panel runs as its own process now (src/panelMain.js); the
        // bot reaches it only through the shared store. The first control tick
        // reconciles the gateway to the stored desired state, so a bot the admin
        // switched off stays off across a restart instead of blindly connecting.
        await this.startControlLoop();
    }

    // Reconciles with the panel process on a slow tick and runs it once up front.
    // unref() so it never keeps the process alive on its own.
    async startControlLoop() {
        if (this.controlTimer || !this.store) {
            // No store means a file-only deployment with no panel; just connect.
            await this.startDiscordConnection();
            return;
        }

        this.lastControlEpoch = this.store.getControlEpoch();
        await this.runControlTick();
        // Deliberately NOT unref()'d: this loop is what keeps the bot process
        // alive. When the admin switches the gateway off from the panel the
        // Discord socket is gone, and this timer is the only thing left holding
        // the process up so it can see the "switch back on" signal.
        this.controlTimer = setInterval(() => {
            this.runControlTick().catch((error) => console.error("control tick failed:", error));
        }, CONTROL_TICK_INTERVAL_MS);
    }

    stopControlLoop() {
        if (this.controlTimer) {
            clearInterval(this.controlTimer);
            this.controlTimer = null;
        }
    }

    // One reconciliation pass. Guarded against re-entry so a slow Discord call in
    // one tick cannot overlap the next.
    async runControlTick() {
        if (this.controlBusy) {
            return;
        }

        this.controlBusy = true;

        try {
            this.applyConfigEpoch();

            // A gateway hiccup (bad login, transient Discord outage) must not
            // abort the tick: we still want to publish a heartbeat and drain the
            // queue, and the next tick retries the connection.
            try {
                await this.reconcileGateway();
            } catch (error) {
                console.error("gateway reconcile failed:", error);
            }

            await this.drainCommands();
            this.publishHeartbeat();
            this.store.pruneCommands(COMMAND_RETENTION_MS);
        } finally {
            this.controlBusy = false;
        }
    }

    // Re-reads config from the store when the panel signals an edit.
    applyConfigEpoch() {
        const epoch = this.store.getControlEpoch();

        if (epoch !== this.lastControlEpoch) {
            this.reloadFromStore();
            this.lastControlEpoch = epoch;
        }
    }

    // Rebuilds the whole live config from the store after a panel edit: overlaid
    // settings, FAQ entries, custom commands and moderation rules, then pushes
    // the derived values (GitHub client, presence) into place.
    reloadFromStore() {
        applyStoredSettings(this.config, this.store);
        this.reloadFaqEntries();
        this.reloadCustomCommands();
        this.reloadModerationRules();
        this.applyRuntimeConfig();
    }

    // Brings the gateway into line with the panel's desired state. A changed
    // reconnect nonce forces a drop-and-reconnect even when the state is "on".
    async reconcileGateway() {
        const desired = this.store.getGatewayDesired();
        const nonce = this.store.getGatewayNonce();
        const connected = Boolean(this.client.isReady?.());

        if (desired === "off") {
            this.lastGatewayNonce = nonce;

            if (connected || this.connectionPromise) {
                await this.stopDiscordConnection();
            }

            return;
        }

        if (this.lastGatewayNonce === null) {
            this.lastGatewayNonce = nonce;
        }

        if (nonce !== this.lastGatewayNonce) {
            this.lastGatewayNonce = nonce;
            await this.restartDiscordConnection();
            return;
        }

        if (!connected && !this.connectionPromise) {
            await this.startDiscordConnection();
        }
    }

    // Runs any actions the panel queued (it holds no gateway of its own), writing
    // each result back for the panel's waiting request to read.
    async drainCommands() {
        for (const command of this.store.listPendingCommands()) {
            let result;

            try {
                const payload = JSON.parse(command.payload);
                result = { ok: true, value: await this.runQueuedCommand(command.kind, payload) };
            } catch (error) {
                result = { ok: false, error: String(error?.message ?? error) };
            }

            this.store.completeCommand(command.id, result);
        }
    }

    runQueuedCommand(kind, args) {
        switch (kind) {
            case "unbanUser":
                return this.unbanUser(args.guildId, args.userId, args.reason);
            case "clearMemberTimeout":
                return this.clearMemberTimeout(args.guildId, args.userId, args.reason);
            case "postEmbed":
                return this.postEmbed(args.channelId, args.spec);
            case "addReactionOption":
                return this.addReactionOption(args.channelId, args.messageId, args.emoji);
            case "restart":
                this.restart();
                return true;
            default:
                throw new Error(`Unknown control command: ${kind}`);
        }
    }

    // Publishes live gateway state plus a fresh guild-directory snapshot for the
    // panel to read.
    publishHeartbeat() {
        this.store.setBotHeartbeat({
            connectedAs: this.client.user?.tag ?? null,
            gatewayStatus: this.client.isReady?.()
                ? "connected"
                : (this.connectionPromise ? "connecting" : "disconnected"),
            guilds: this.client.guilds?.cache?.size ?? 0
        });
        this.store.setGuildDirectory(this.guildDirectory());
    }

    shouldObserveMessage(message) {
        if (!message.guild || message.author.bot) {
            return false;
        }

        if (this.config.controlGuildId && message.guild.id !== this.config.controlGuildId) {
            return false;
        }

        if (this.config.ignoredChannelIds.includes(message.channelId)) {
            return false;
        }

        return true;
    }

    shouldHandleMessage(message) {
        return (
            this.shouldObserveMessage(message) &&
            this.config.allowedChannelIds.includes(message.channelId)
        );
    }

    shouldModerateMessage(message) {
        if (!this.config.enableModeration || !this.shouldObserveMessage(message)) {
            return false;
        }

        if (
            !this.config.moderationChannelIds.includes("*") &&
            !this.config.moderationChannelIds.includes(message.channelId)
        ) {
            return false;
        }

        return !this.isModerationExempt(message);
    }

    canManageBot(message) {
        return canManageDiscordMessage(message, this.config);
    }

    // Effective access (admin flag + granted areas) for the author of a message
    // or the invoker of an interaction, resolved live against DISCORD_ADMIN_*,
    // Discord permissions, and the scoped grants in the store.
    messageAccess(message) {
        return resolveAccess({
            userId: message.author?.id,
            roleIds: getRoleIds(message.member),
            permissions: message.member?.permissions,
            owner: message.guild?.ownerId === message.author?.id
        }, this.config, this.store);
    }

    interactionAccess(interaction) {
        return resolveAccess({
            userId: interaction.user?.id,
            roleIds: getRoleIds(interaction.member),
            permissions: interaction.memberPermissions ?? interaction.member?.permissions,
            owner: interaction.guild?.ownerId === interaction.user?.id
        }, this.config, this.store);
    }

    isModerationExempt(message) {
        if ((this.config.moderationExemptUserIds ?? []).includes(message.author.id)) {
            return true;
        }

        const roleIds = getRoleIds(message.member);

        if (roleIds.some((roleId) => (this.config.moderationExemptRoleIds ?? []).includes(roleId))) {
            return true;
        }

        return this.canManageBot(message);
    }

    guildBotHasPermission(guild, permission) {
        return Boolean(guild?.members?.me?.permissions?.has?.(permission));
    }

    botHasPermission(message, permission) {
        return this.guildBotHasPermission(message.guild, permission);
    }

    async requireBotPermission(message, permission, label) {
        if (this.botHasPermission(message, permission)) {
            return true;
        }

        await this.reply(message, `I need the ${label} permission for that action.`);
        return false;
    }

    isOnCooldown(entryId, channelId) {
        const cooldownKey = `${entryId}:${channelId}`;
        const expiresAt = this.cooldowns.get(cooldownKey);

        if (!expiresAt) {
            return false;
        }

        if (expiresAt <= Date.now()) {
            this.cooldowns.delete(cooldownKey);
            return false;
        }

        return true;
    }

    markCooldown(entryId, channelId, cooldownSeconds) {
        const cooldownKey = `${entryId}:${channelId}`;
        this.cooldowns.set(cooldownKey, Date.now() + (cooldownSeconds * 1000));
    }

    isUserOnCooldown(message) {
        const cooldownKey = `user:${message.guild.id}:${message.channelId}:${message.author.id}`;
        const expiresAt = this.cooldowns.get(cooldownKey);

        if (!expiresAt) {
            return false;
        }

        if (expiresAt <= Date.now()) {
            this.cooldowns.delete(cooldownKey);
            return false;
        }

        return true;
    }

    markUserCooldown(message) {
        const cooldownKey = `user:${message.guild.id}:${message.channelId}:${message.author.id}`;
        this.cooldowns.set(
            cooldownKey,
            Date.now() + (this.config.userMessageCooldownSeconds * 1000)
        );
    }

    isRawCooldown(key) {
        const expiresAt = this.cooldowns.get(key);

        if (!expiresAt) {
            return false;
        }

        if (expiresAt <= Date.now()) {
            this.cooldowns.delete(key);
            return false;
        }

        return true;
    }

    setRawCooldown(key, seconds) {
        this.cooldowns.set(key, Date.now() + (seconds * 1000));
    }

    // Records a usage metric for the analytics page. Never lets a stats failure
    // interfere with actually handling the message or command.
    bumpStat(metric, key = "", amount = 1) {
        try {
            this.store?.bumpStat(metric, key, amount);
        } catch (error) {
            console.error("Failed to record stat:", error);
        }
    }

    // Grants XP for a normal chat message, throttled per user so it cannot be
    // farmed by spamming. Announces and rewards on level-up.
    async awardXpForMessage(message) {
        if (!this.config.levelingEnabled || !this.store) {
            return;
        }

        const key = `xp:${message.guild.id}:${message.author.id}`;

        if (this.isRawCooldown(key)) {
            return;
        }

        this.setRawCooldown(key, this.config.xpCooldownSeconds);

        const before = this.store.getUserLevel(message.guild.id, message.author.id).level;
        const after = this.store.addXp(message.guild.id, message.author.id, this.config.xpPerMessage);
        this.bumpStat("xp", "", this.config.xpPerMessage);

        if (after.level > before) {
            await this.handleLevelUp(message, after.level);
        }
    }

    levelRoleFor(level) {
        return parseLevelRoles(this.config.levelRoles).get(level) ?? null;
    }

    async handleLevelUp(message, level) {
        const roleId = this.levelRoleFor(level);

        if (roleId) {
            await message.member?.roles?.add?.(roleId).catch(() => {});
        }

        if (!this.config.levelUpEnabled) {
            return;
        }

        const content = renderTemplate(this.config.levelUpMessage, {
            ...memberContext({ user: message.author, guild: message.guild }),
            level
        });

        if (this.config.levelUpChannelId) {
            await this.sendToChannelId(message.guild, this.config.levelUpChannelId, content, { parse: ["users"] });
        } else {
            await this.sendChannelMessage(message.channel, content, { parse: ["users"] });
        }
    }

    // Public leveling commands (rank, leaderboard) — available to everyone, not
    // just admins, so they run before the admin-gated management commands.
    async handleLevelingCommand(message) {
        if (!this.config.levelingEnabled || !this.store) {
            return false;
        }

        const prefix = this.config.managementCommandPrefix;

        if (!message.content.startsWith(prefix)) {
            return false;
        }

        const [raw = "", ...rest] = message.content.slice(prefix.length).trim().split(/\s+/);
        const command = raw.toLowerCase();

        if (command === "rank" || command === "level") {
            const targetId = parseUserId(rest[0]) || message.author.id;
            const stats = this.store.getUserLevel(message.guild.id, targetId);
            const progress = levelProgress(stats.xp);
            const rank = this.store.userRank(message.guild.id, targetId);
            await this.reply(
                message,
                `${formatUserReference(targetId)} — level ${progress.level} (rank #${rank}), ${progress.into}/${progress.needed} XP to next level.`
            );
            return true;
        }

        if (command === "leaderboard" || command === "top" || command === "levels") {
            const top = this.store.topLevels(message.guild.id, 10);

            if (top.length === 0) {
                await this.reply(message, "No one has earned XP yet.");
                return true;
            }

            const lines = top.map((row) => `${row.rank}. ${formatUserReference(row.user_id)} — level ${row.level} (${row.xp} XP)`);
            await this.reply(message, ["Leaderboard", ...lines].join("\n"));
            return true;
        }

        return false;
    }

    async reply(message, content) {
        const safeContent = truncateForDiscord(content, this.config.maxReplyLength);

        if (!safeContent) {
            return;
        }

        await message.reply({
            content: safeContent,
            allowedMentions: { parse: [], repliedUser: false }
        });
    }

    reloadFaqEntries() {
        // Once a store is attached it is the source of truth for FAQ entries
        // (that is what the admin panel edits); the JSON file remains the
        // fallback for a file-only deployment with no dashboard.
        this.config.faqEntries = this.store
            ? this.store.listFaqEntries()
            : loadFaqEntries(this.config.faqPath);
        return this.config.faqEntries.length;
    }

    // Refreshes the cached custom-command list after the panel edits it, so the
    // hot message path never queries the store per message.
    reloadCustomCommands() {
        if (this.store) {
            this.config.customCommands = this.store.listCustomCommands();
        }

        return this.config.customCommands?.length ?? 0;
    }

    // Rebuilds the live moderation rule set from the store after the panel edits
    // a rule or the scam heuristics.
    reloadModerationRules() {
        if (this.store) {
            this.config.moderationRules = this.store.assembleModerationRules();
        }

        return this.config.moderationRules?.rules?.length ?? 0;
    }

    // Exit cleanly and let the process manager (systemd/Docker) bring the bot
    // back up. Overridable so tests do not tear down the runner.
    restart() {
        console.log("Restart requested from the admin panel.");
        this.githubClient?.cache?.entries?.clear?.();
        process.exit(0);
    }

    getSafeStatus() {
        return {
            connectedAs: this.client.user?.tag ?? null,
            gatewayStatus: this.client.isReady?.() ? "connected" : (this.connectionPromise ? "connecting" : "disconnected"),
            guilds: this.client.guilds?.cache?.size ?? 0,
            modules: this.config.modules,
            controlGuildId: this.config.controlGuildId,
            faqEntries: this.config.faqEntries.length,
            allowedChannelIds: this.config.allowedChannelIds,
            ignoredChannelIds: this.config.ignoredChannelIds,
            enableGlobalGitHubSearch: this.config.enableGlobalGitHubSearch,
            githubDefaultRepos: this.config.githubDefaultRepos,
            enableModeration: this.config.enableModeration,
            moderationDryRun: this.config.moderationDryRun,
            moderationRules: this.config.moderationRules.rules?.length ?? 0,
            moderationChannelIds: this.config.moderationChannelIds,
            moderationLogChannelId: this.config.moderationLogChannelId,
            managementCommandPrefix: this.config.managementCommandPrefix,
            allowProcessRestart: Boolean(this.config.allowProcessRestart)
        };
    }

    buildTriageTemplate(topic) {
        const label = topic ? ` for ${topic}` : "";

        return [
            `Support triage${label}:`,
            "- What command or action failed?",
            "- What exact error text did you get?",
            "- What OS, runtime versions, and package manager are you using?",
            "- What changed right before this started?",
            "- Is there a public issue, PR, or docs link that looks related?",
            "",
            "Redact tokens, cookies, private URLs, and personal data before posting logs."
        ].join("\n");
    }

    async buildKnownIssueReply(query) {
        if (!this.config.enableGitHub || this.config.githubDefaultRepos.length === 0) {
            return "GitHub lookup is not enabled for this bot.";
        }

        const githubMatch = await this.githubClient.search({
            query,
            repos: this.config.githubDefaultRepos,
            type: "both",
            minScore: this.config.globalGitHubSearchMinScore
        });

        if (!githubMatch) {
            return "No close GitHub issue or PR match found.";
        }

        return `Closest GitHub match:\n${formatGitHubItem(githubMatch)}`;
    }

    async resolveGuildMember(guild, userId) {
        if (!userId || !guild?.members) {
            return null;
        }

        const cachedMember = guild.members.cache?.get?.(userId);

        if (cachedMember) {
            return cachedMember;
        }

        if (!guild.members.fetch) {
            return null;
        }

        try {
            return await guild.members.fetch(userId);
        } catch {
            return null;
        }
    }

    async resolveMember(message, rawUser) {
        return this.resolveGuildMember(message.guild, parseUserId(rawUser));
    }

    isSelfTarget(userId) {
        return userId === this.client.user?.id;
    }

    isProtectedTarget(member) {
        const permissions = member?.permissions;

        return Boolean(
            permissions?.has?.(PermissionFlagsBits.Administrator) ||
            permissions?.has?.(PermissionFlagsBits.ManageGuild)
        );
    }

    buildActorReason(actorId, reason) {
        const detail = reason || "No reason provided.";
        return truncateReason(`${detail} Moderator: ${actorId}`);
    }

    buildModeratorReason(message, reason) {
        return this.buildActorReason(message.author.id, reason);
    }

    async sendChannelMessage(channel, content, allowedMentions = { parse: [] }) {
        const safeContent = truncateForDiscord(content, this.config.maxReplyLength);

        if (!safeContent || !channel?.send) {
            return;
        }

        await channel.send({ content: safeContent, allowedMentions });
    }

    async resolveChannel(guild, channelId) {
        if (!channelId || !guild?.channels) {
            return null;
        }

        let channel = guild.channels.cache?.get?.(channelId);

        if (!channel && guild.channels.fetch) {
            try {
                channel = await guild.channels.fetch(channelId);
            } catch {
                return null;
            }
        }

        return channel ?? null;
    }

    async sendToChannelId(guild, channelId, content, allowedMentions) {
        const channel = await this.resolveChannel(guild, channelId);
        await this.sendChannelMessage(channel, content, allowedMentions);
    }

    inControlGuild(guild) {
        return !this.config.controlGuildId || guild?.id === this.config.controlGuildId;
    }

    // Sends an admin-composed embed to a control-guild channel. Returns false when
    // the embed is empty or the channel cannot be posted to, so the panel can say so.
    async postEmbed(channelId, spec) {
        const embed = buildEmbed(spec);

        if (isEmptyEmbed(embed)) {
            return false;
        }

        const channel = await this.resolveChannel(this.getGuild(this.config.controlGuildId), channelId);

        if (!channel?.send) {
            return false;
        }

        await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
        this.bumpStat("embed");
        return true;
    }

    async logEvent(guild, content) {
        if (this.config.loggingEnabled && this.config.logChannelId && this.inControlGuild(guild)) {
            await this.sendToChannelId(guild, this.config.logChannelId, content);
        }
    }

    async handleMemberJoin(member) {
        if (!this.inControlGuild(member.guild)) {
            return;
        }

        for (const roleId of this.config.autoRoleIds ?? []) {
            await member.roles?.add?.(roleId).catch(() => {});
        }

        if (this.config.welcomeEnabled && this.config.welcomeChannelId) {
            const content = renderTemplate(this.config.welcomeMessage, memberContext(member));
            // Welcomes intentionally allow the new member's ping, nothing else.
            await this.sendToChannelId(member.guild, this.config.welcomeChannelId, content, { parse: ["users"] });
        }

        if (this.config.logJoinsLeaves) {
            const ctx = memberContext(member);
            await this.logEvent(member.guild, `Joined: ${ctx.tag} (${member.id}). Members: ${ctx.count}`);
        }
    }

    async handleMemberLeave(member) {
        if (!this.inControlGuild(member.guild)) {
            return;
        }

        if (this.config.goodbyeEnabled && this.config.goodbyeChannelId) {
            const content = renderTemplate(this.config.goodbyeMessage, memberContext(member));
            await this.sendToChannelId(member.guild, this.config.goodbyeChannelId, content);
        }

        if (this.config.logJoinsLeaves) {
            await this.logEvent(member.guild, `Left: ${memberContext(member).tag} (${member.id}).`);
        }
    }

    async handleMessageDelete(message) {
        if (!this.config.logMessageDeletes || !message.guild || message.author?.bot) {
            return;
        }

        const who = message.author?.tag ?? message.author?.username ?? "unknown";
        const content = message.content ? truncateReason(message.content) : "(content not cached)";
        await this.logEvent(message.guild, `Deleted — ${who} in <#${message.channelId}>: ${content}`);
    }

    async handleMessageEdit(oldMessage, newMessage) {
        if (!this.config.logMessageEdits || !newMessage.guild || newMessage.author?.bot) {
            return;
        }

        if (oldMessage.content === newMessage.content) {
            return;
        }

        const who = newMessage.author?.tag ?? newMessage.author?.username ?? "unknown";
        const before = oldMessage.content ? truncateReason(oldMessage.content) : "(not cached)";
        const after = truncateReason(newMessage.content);
        await this.logEvent(newMessage.guild, `Edited — ${who} in <#${newMessage.channelId}>:\nBefore: ${before}\nAfter: ${after}`);
    }

    // Grants or removes the mapped role when a member toggles a reaction on a
    // configured message. Unicode reactions are keyed by name, custom ones by id.
    async handleReactionRole(reaction, user, add) {
        if (!this.config.reactionRolesEnabled || !this.store || user?.bot) {
            return;
        }

        try {
            if (reaction.partial) {
                await reaction.fetch();
            }
        } catch {
            return;
        }

        const message = reaction.message;

        if (!message?.guild || !this.inControlGuild(message.guild)) {
            return;
        }

        const mapping = this.store.getReactionRole(message.id, reaction.emoji?.id ?? reaction.emoji?.name);

        if (!mapping) {
            return;
        }

        const member = await message.guild.members?.fetch?.(user.id).catch(() => null);

        if (!member?.roles) {
            return;
        }

        if (add) {
            await member.roles.add(mapping.role_id).catch(() => {});
        } else {
            await member.roles.remove(mapping.role_id).catch(() => {});
        }
    }

    // Reposts a message to the starboard channel once it collects enough of the
    // configured emoji. Reserves the source id before posting so two reactions
    // arriving together cannot double-post; the reservation is dropped if the post
    // fails so it can be retried.
    async handleStarboardReaction(reaction, user) {
        if (!this.config.starboardEnabled || !this.store || !this.config.starboardChannelId || user?.bot) {
            return;
        }

        try {
            if (reaction.partial) {
                await reaction.fetch();
            }
        } catch {
            return;
        }

        const message = reaction.message;

        if (!message?.guild || !this.inControlGuild(message.guild) || message.channelId === this.config.starboardChannelId) {
            return;
        }

        const target = this.config.starboardEmoji;
        const emojiName = reaction.emoji?.name ?? null;

        if (target && target !== emojiName && target !== reaction.emoji?.id) {
            return;
        }

        const count = Number(reaction.count) || 0;

        if (count < this.config.starboardThreshold || this.store.getStarboardPost(message.id)) {
            return;
        }

        this.store.saveStarboardPost(message.id, "");

        try {
            const channel = await this.resolveChannel(this.getGuild(this.config.controlGuildId), this.config.starboardChannelId);

            if (!channel?.send) {
                this.store.deleteStarboardPost(message.id);
                return;
            }

            const sent = await channel.send({
                content: truncateForDiscord(buildStarboardContent(message, count, emojiName ?? target), this.config.maxReplyLength),
                allowedMentions: { parse: [] }
            });
            this.store.saveStarboardPost(message.id, sent?.id ?? "");
            this.bumpStat("starboard");
        } catch (error) {
            this.store.deleteStarboardPost(message.id);
            throw error;
        }
    }

    // Places the emoji on the target message so members have something to click.
    // Used when the panel adds a reaction-role mapping.
    async addReactionOption(channelId, messageId, emoji) {
        const channel = await this.resolveChannel(this.getGuild(this.config.controlGuildId), channelId);

        if (!channel?.messages?.fetch) {
            return false;
        }

        try {
            const message = await channel.messages.fetch(messageId);
            await message.react(emoji);
            return true;
        } catch {
            return false;
        }
    }

    async sendModerationLog(message, content) {
        const channelId = this.config.moderationLogChannelId;

        if (!channelId || !message.guild?.channels) {
            return;
        }

        let channel = message.guild.channels.cache?.get?.(channelId);

        if (!channel && message.guild.channels.fetch) {
            try {
                channel = await message.guild.channels.fetch(channelId);
            } catch {
                return;
            }
        }

        await this.sendChannelMessage(channel, content);
    }

    // Writes one row to the durable moderation log so the admin panel can show
    // it, attribute it, and (for bans/timeouts) offer an undo. Failures here must
    // never abort the moderation action itself.
    recordModeration(entry) {
        if (!this.store) {
            return null;
        }

        try {
            return this.store.recordModerationAction(entry);
        } catch (error) {
            console.error("Failed to record moderation action:", error);
            return null;
        }
    }

    getGuild(guildId) {
        return this.client.guilds?.cache?.get?.(guildId || this.config.controlGuildId) ?? null;
    }

    // The control guild's text channels and assignable roles, read from the
    // gateway cache the Guilds intent already populates (no extra API calls). The
    // admin panel uses this to offer name pickers instead of raw ID fields; an
    // empty result (bot offline, or not in the guild) makes the panel fall back to
    // plain text inputs.
    guildDirectory() {
        const guild = this.getGuild(this.config.controlGuildId);

        if (!guild) {
            return { channels: [], roles: [] };
        }

        // Text-capable channels members actually post in: text, announcement, forum.
        const textChannelTypes = new Set([0, 5, 15]);
        const channels = [...(guild.channels?.cache?.values?.() ?? [])]
            .filter((channel) => textChannelTypes.has(channel.type))
            .map((channel) => ({ id: channel.id, name: channel.name ?? channel.id }))
            .sort((left, right) => left.name.localeCompare(right.name));

        const roles = [...(guild.roles?.cache?.values?.() ?? [])]
            .filter((role) => role.id !== guild.id) // drop @everyone
            .map((role) => ({ id: role.id, name: role.name ?? role.id, position: role.position ?? 0 }))
            .sort((left, right) => right.position - left.position);

        return { channels, roles };
    }

    // Lifts a ban previously recorded in the log. Used by the "undo" button in
    // the admin panel.
    async unbanUser(guildId, userId, reason) {
        const guild = this.getGuild(guildId);

        if (!guild?.bans?.remove) {
            throw new Error("That guild is not available to lift the ban.");
        }

        await guild.bans.remove(userId, reason);
    }

    async clearMemberTimeout(guildId, userId, reason) {
        const guild = this.getGuild(guildId);

        if (!guild?.members?.fetch) {
            throw new Error("That guild is not available to lift the timeout.");
        }

        const member = await guild.members.fetch(userId);
        await member.timeout(null, reason);
    }

    async deleteModeratedMessage(message) {
        if (!message.delete) {
            return false;
        }

        if (!this.botHasPermission(message, PermissionFlagsBits.ManageMessages)) {
            await this.sendModerationLog(
                message,
                `Moderation matched in <#${message.channelId}> but I lack Manage Messages.`
            );
            return false;
        }

        try {
            await message.delete();
            return true;
        } catch (error) {
            console.error("Failed to delete moderated message:", error);
            return false;
        }
    }

    moderationLogBase(message, finding, summary) {
        return {
            guildId: message.guild?.id ?? null,
            channelId: message.channelId,
            targetUserId: message.author.id,
            targetTag: message.author.tag ?? message.author.username ?? null,
            moderatorId: null,
            moderatorTag: null,
            source: "auto",
            action: finding.action,
            reason: finding.reason,
            ruleId: finding.findings?.[0]?.detail ?? null,
            matched: summary,
            messageExcerpt: truncateReason(message.content)
        };
    }

    recordManualModeration(message, { action, target, targetUserId, reason }) {
        this.recordModeration({
            guildId: message.guild?.id ?? null,
            channelId: message.channelId,
            targetUserId: targetUserId || target?.id || null,
            targetTag: target?.user?.tag ?? target?.user?.username ?? target?.displayName ?? null,
            moderatorId: message.author.id,
            moderatorTag: message.author.tag ?? message.author.username ?? null,
            source: "command",
            action,
            reason: truncateReason(reason || "No reason provided."),
            matched: null,
            messageExcerpt: truncateReason(message.content),
            dryRun: false,
            success: true
        });
    }

    async applyModerationFinding(message, finding) {
        const reason = truncateReason(`Auto moderation: ${finding.reason}`);
        const summary = summarizeFindings(finding.findings);
        let actionSucceeded = true;

        if (this.config.moderationDryRun) {
            await this.sendModerationLog(
                message,
                `Dry-run moderation match: ${finding.action} for ${message.author.id} in <#${message.channelId}>: ${summary}`
            );
            this.recordModeration({ ...this.moderationLogBase(message, finding, summary), dryRun: true });
            return finding.action !== "log";
        }

        if (finding.deleteMessage) {
            await this.deleteModeratedMessage(message);
        }

        try {
            if (finding.action === "warn") {
                await message.author.send?.(`Moderation warning in ${message.guild.name}: ${summary}`);
            }

            if (finding.action === "timeout") {
                if (!this.botHasPermission(message, PermissionFlagsBits.ModerateMembers)) {
                    throw new Error("Missing Moderate Members permission.");
                }

                await message.member.timeout(finding.timeoutMs, reason);
            }

            if (finding.action === "kick") {
                if (!this.botHasPermission(message, PermissionFlagsBits.KickMembers)) {
                    throw new Error("Missing Kick Members permission.");
                }

                await message.member.kick(reason);
            }

            if (finding.action === "ban") {
                if (!this.botHasPermission(message, PermissionFlagsBits.BanMembers)) {
                    throw new Error("Missing Ban Members permission.");
                }

                const deleteMessageSeconds = clampBanDeleteSeconds(
                    this.config.moderationBanDeleteMessageSeconds
                );

                if (message.member?.ban) {
                    await message.member.ban({ deleteMessageSeconds, reason });
                } else {
                    await message.guild.bans.create(message.author.id, {
                        deleteMessageSeconds,
                        reason
                    });
                }
            }
        } catch (error) {
            actionSucceeded = false;
            console.error("Failed to apply moderation action:", error);
        }

        await this.sendModerationLog(
            message,
            [
                `Moderation ${actionSucceeded ? "applied" : "failed"}: ${finding.action}`,
                `User: ${message.author.id}`,
                `Channel: <#${message.channelId}>`,
                `Matches: ${summary}`
            ].join("\n")
        );

        this.recordModeration({
            ...this.moderationLogBase(message, finding, summary),
            dryRun: false,
            success: actionSucceeded
        });

        return finding.action !== "log";
    }

    async handleAutoModeration(message) {
        if (!this.shouldModerateMessage(message)) {
            return false;
        }

        const finding = analyzeModerationMessage(message, this.config);

        if (!finding) {
            return false;
        }

        return this.applyModerationFinding(message, finding);
    }

    async handleModerationCommand(message, command, argsText) {
        if (!["ban", "kick", "timeout", "mute", "unmute", "warn", "purge"].includes(command)) {
            return false;
        }

        if (!this.config.enableModeration) {
            await this.reply(message, "Moderation module is not enabled.");
            return true;
        }

        const parts = argsText.split(/\s+/).filter(Boolean);

        if (command === "purge") {
            if (!(await this.requireBotPermission(message, PermissionFlagsBits.ManageMessages, "Manage Messages"))) {
                return true;
            }

            const count = Number(parts[0]);

            if (!Number.isInteger(count) || count < 1 || count > 100) {
                await this.reply(message, "Usage: purge <1-100>");
                return true;
            }

            await message.channel.bulkDelete(Math.min(count + 1, 100), true);
            await this.reply(message, `Deleted up to ${count} recent messages.`);
            return true;
        }

        const target = await this.resolveMember(message, parts[0]);
        const targetUserId = parseUserId(parts[0]);

        if (!target && !targetUserId) {
            await this.reply(message, `Usage: ${command} <@user|user-id> ${command === "timeout" || command === "mute" ? "<duration> " : ""}[reason]`);
            return true;
        }

        if (this.isSelfTarget(targetUserId || target?.id)) {
            await this.reply(message, "I will not moderate myself.");
            return true;
        }

        if (target && this.isProtectedTarget(target)) {
            await this.reply(message, "I will not moderate server admins or managers.");
            return true;
        }

        if (command === "warn") {
            const reason = parts.slice(1).join(" ") || "No reason provided.";
            await target?.send?.(`Moderator warning in ${message.guild.name}: ${reason}`);
            this.recordManualModeration(message, { action: "warn", target, targetUserId, reason });
            await this.reply(message, `Warned ${formatUserReference(targetUserId || target.id)}.`);
            return true;
        }

        if (command === "timeout" || command === "mute") {
            if (!(await this.requireBotPermission(message, PermissionFlagsBits.ModerateMembers, "Moderate Members"))) {
                return true;
            }

            const durationMs = parseDurationMs(parts[1]);

            if (!durationMs || !target?.timeout) {
                await this.reply(message, `Usage: ${command} <@user|user-id> <duration> [reason]`);
                return true;
            }

            const reason = this.buildModeratorReason(message, parts.slice(2).join(" "));
            await target.timeout(durationMs, reason);
            this.recordManualModeration(message, { action: "timeout", target, targetUserId, reason });
            await this.reply(message, `Timed out ${formatUserReference(target.id)}.`);
            return true;
        }

        if (command === "unmute") {
            if (!(await this.requireBotPermission(message, PermissionFlagsBits.ModerateMembers, "Moderate Members"))) {
                return true;
            }

            if (!target?.timeout) {
                await this.reply(message, "Could not resolve that member.");
                return true;
            }

            await target.timeout(null, this.buildModeratorReason(message, parts.slice(1).join(" ")));
            await this.reply(message, `Removed timeout from ${formatUserReference(target.id)}.`);
            return true;
        }

        if (command === "kick") {
            if (!(await this.requireBotPermission(message, PermissionFlagsBits.KickMembers, "Kick Members"))) {
                return true;
            }

            if (!target?.kick) {
                await this.reply(message, "Could not resolve that member.");
                return true;
            }

            const reason = this.buildModeratorReason(message, parts.slice(1).join(" "));
            await target.kick(reason);
            this.recordManualModeration(message, { action: "kick", target, targetUserId, reason });
            await this.reply(message, `Kicked ${formatUserReference(target.id)}.`);
            return true;
        }

        if (command === "ban") {
            if (!(await this.requireBotPermission(message, PermissionFlagsBits.BanMembers, "Ban Members"))) {
                return true;
            }

            const reason = this.buildModeratorReason(message, parts.slice(1).join(" "));
            const deleteMessageSeconds = clampBanDeleteSeconds(
                this.config.moderationBanDeleteMessageSeconds
            );

            if (target?.ban) {
                await target.ban({ deleteMessageSeconds, reason });
            } else {
                await message.guild.bans.create(targetUserId, { deleteMessageSeconds, reason });
            }

            this.recordManualModeration(message, { action: "ban", target, targetUserId, reason });
            await this.reply(message, `Banned ${formatUserReference(targetUserId || target.id)}.`);
            return true;
        }

        return false;
    }

    async handleManagementCommand(message) {
        if (!this.config.enableManagementCommands) {
            return false;
        }

        const prefix = this.config.managementCommandPrefix;

        if (!message.content.startsWith(prefix)) {
            return false;
        }

        const access = this.messageAccess(message);

        if (!access.authorized) {
            return true;
        }

        const commandText = message.content.slice(prefix.length).trim();
        const [rawCommand = "", ...rest] = commandText.split(/\s+/);
        const command = rawCommand.toLowerCase();
        const argsText = rest.join(" ").trim();

        if (command === "access") {
            if (!access.admin) {
                await this.reply(message, "Only administrators can manage access.");
                return true;
            }

            await this.handleAccessCommand(message, argsText, access);
            return true;
        }

        // Every remaining command belongs to an area; a scoped principal without
        // that area is told so rather than silently ignored.
        const requiredArea = MANAGEMENT_COMMAND_AREAS[command];

        if (requiredArea && !canAccessArea(access, requiredArea)) {
            await this.reply(message, `You do not have access to the ${areaLabel(requiredArea)} commands.`);
            return true;
        }

        if (command === "status") {
            const status = this.getSafeStatus();
            await this.reply(
                message,
                [
                    "FAQ bot status:",
                    `Modules: ${status.modules.join(", ")}`,
                    `FAQ entries: ${status.faqEntries}`,
                    `Allowed channels: ${status.allowedChannelIds.length}`,
                    `Global GitHub search: ${status.enableGlobalGitHubSearch ? "on" : "off"}`
                ].join("\n")
            );
            return true;
        }

        if (command === "reload") {
            if (!this.config.enableFaq) {
                await this.reply(message, "FAQ module is not enabled.");
                return true;
            }

            try {
                const count = this.reloadFaqEntries();
                await this.reply(message, `Reloaded ${count} FAQ entries.`);
            } catch {
                await this.reply(message, "FAQ reload failed. Check the FAQ JSON file.");
            }

            return true;
        }

        if (command === "known" || command === "issue") {
            if (!argsText) {
                await this.reply(message, `Usage: ${prefix} known <search text>`);
                return true;
            }

            await this.reply(message, await this.buildKnownIssueReply(argsText));
            return true;
        }

        if (command === "triage") {
            if (!this.config.enableSupportTriage) {
                await this.reply(message, "Support triage module is not enabled.");
                return true;
            }

            await this.reply(message, this.buildTriageTemplate(argsText));
            return true;
        }

        if (await this.handleModerationCommand(message, command, argsText)) {
            return true;
        }

        await this.reply(
            message,
            [
                `Available commands: ${prefix} status, ${prefix} reload`,
                this.config.enableGitHub ? `${prefix} known <search text>` : null,
                this.config.enableSupportTriage ? `${prefix} triage [topic]` : null,
                this.config.enableModeration ? `${prefix} ban|kick|timeout|unmute|warn|purge ...` : null,
                access.owner ? `${prefix} access list|add|remove|block|unblock ...` : (access.admin ? `${prefix} access list|add|remove ...` : null)
            ].filter(Boolean).join("\n")
        );
        return true;
    }

    // Manages access from Discord. Admin-only (the caller checks that); revoking
    // administrators additionally requires the owner.
    async handleAccessCommand(message, argsText, access) {
        if (!this.store) {
            await this.reply(message, "Access management needs the database, which is not available.");
            return;
        }

        const prefix = this.config.managementCommandPrefix;
        const [sub = "", subjectToken = "", areasToken = "", ...labelParts] = argsText.split(/\s+/);
        const action = sub.toLowerCase();

        if (action === "block" || action === "unblock") {
            if (!access.owner) {
                await this.reply(message, "Only the owner can revoke administrators.");
                return;
            }

            const target = parseAccessSubject(subjectToken);

            if (!target) {
                await this.reply(message, `Usage: ${prefix} access block <@role|@user|role:ID|user:ID> · ${prefix} access unblock <subject>`);
                return;
            }

            if (action === "block") {
                this.store.addAdminBlock({ ...target, createdBy: message.author.id });
                this.store.recordAudit({
                    actorId: message.author.id,
                    actorName: message.author.username ?? message.author.tag ?? message.author.id,
                    action: "access.admin.revoke",
                    detail: `${target.subjectType} ${target.subjectId}`
                });
                await this.reply(message, `Revoked administrator access for ${target.subjectType} ${target.subjectId}.`);
            } else {
                const removed = this.store.removeAdminBlock(target.subjectType, target.subjectId);
                await this.reply(message, removed
                    ? `Restored administrator access for ${target.subjectType} ${target.subjectId}.`
                    : "No matching revocation.");
            }

            return;
        }

        if (action === "" || action === "list") {
            const grants = this.store.listAccessGrants();
            const blocks = this.store.listAdminBlocks();

            if (grants.length === 0 && blocks.length === 0) {
                await this.reply(message, "No scoped access grants or admin revocations. Administrators have full access.");
                return;
            }

            const sections = [];

            if (grants.length > 0) {
                sections.push("Access grants:", ...grants.map((grant) => {
                    const areas = grant.areas.length >= AREAS.length ? "all areas" : grant.areas.map(areaLabel).join(", ");
                    return `• ${grant.subjectType} ${grant.subjectId}: ${areas}${grant.label ? ` (${grant.label})` : ""}`;
                }));
            }

            if (blocks.length > 0) {
                sections.push("Revoked administrators:", ...blocks.map((block) =>
                    `• ${block.subjectType} ${block.subjectId}${block.label ? ` (${block.label})` : ""}`));
            }

            await this.reply(message, sections.join("\n"));
            return;
        }

        const subject = parseAccessSubject(subjectToken);

        if (!subject) {
            await this.reply(message, `Usage: ${prefix} access add <@role|@user|role:ID|user:ID> <area,area|all> [label] · ${prefix} access remove <subject> · ${prefix} access list`);
            return;
        }

        if (action === "remove" || action === "delete") {
            const removed = this.store.deleteAccessGrant(subject.subjectType, subject.subjectId);
            await this.reply(message, removed
                ? `Removed access for ${subject.subjectType} ${subject.subjectId}.`
                : "No matching grant to remove.");
            return;
        }

        if (action === "add" || action === "set") {
            const areas = areasToken.toLowerCase() === "all" ? [...AREA_KEYS] : normalizeAreas(areasToken);

            if (areas.length === 0) {
                await this.reply(message, `No valid areas. Choose from: ${AREA_KEYS.join(", ")} — or "all".`);
                return;
            }

            const label = labelParts.join(" ").trim() || null;
            this.store.saveAccessGrant({
                subjectType: subject.subjectType,
                subjectId: subject.subjectId,
                areas,
                label,
                createdBy: message.author.id
            });
            this.store.recordAudit({
                actorId: message.author.id,
                actorName: message.author.username ?? message.author.tag ?? message.author.id,
                action: "access.grant.save",
                detail: `${subject.subjectType} ${subject.subjectId} → ${areas.join(", ")}`
            });
            await this.reply(message, `Granted ${subject.subjectType} ${subject.subjectId} access to: ${areas.map(areaLabel).join(", ")}.`);
            return;
        }

        await this.reply(message, `Usage: ${prefix} access list | add <subject> <areas|all> [label] | remove <subject>`);
    }

    async buildFaqReply(entry, messageContent) {
        const sections = [];
        const entryMessage = getEntryMessage(entry);

        if (entryMessage) {
            sections.push(String(entryMessage).trim());
        }

        if (Array.isArray(entry.response?.links) && entry.response.links.length > 0) {
            sections.push(entry.response.links.slice(0, 5).join("\n"));
        }

        if (entry.github?.mode === "fixed" && entry.github.url) {
            sections.push(entry.github.url);
        }

        if (this.config.enableGitHub && entry.github?.mode === "search") {
            const githubMatch = await this.githubClient.search({
                query: entry.github.query || messageContent,
                repos: getEntryRepos(entry, this.config.githubDefaultRepos),
                type: entry.github.type || "both",
                minScore: Number(entry.github.minScore) || this.config.globalGitHubSearchMinScore
            });

            if (githubMatch) {
                sections.push(formatGitHubItem(githubMatch));
            }
        }

        return sections
            .map((section) => section.trim())
            .filter(Boolean)
            .join("\n\n");
    }

    async buildFallbackGitHubReply(messageContent) {
        if (!this.config.enableGlobalGitHubSearch) {
            return null;
        }

        const query = buildFallbackGitHubQuery(messageContent);

        if (!query) {
            return null;
        }

        const githubMatch = await this.githubClient.search({
            query,
            minScore: this.config.globalGitHubSearchMinScore
        });

        if (!githubMatch) {
            return null;
        }

        return `Closest GitHub match:\n${formatGitHubItem(githubMatch)}`;
    }

    // --- Slash commands -----------------------------------------------------

    // Registers the guild-scoped command set on startup. Guild commands appear
    // immediately (global ones can take an hour), so the bot only manages its
    // control guild. The set is derived from the enabled features so members are
    // never shown a command that just replies "that module is off".
    async registerSlashCommands() {
        if (!this.config.enableSlashCommands) {
            return;
        }

        const guildId = this.config.controlGuildId;

        if (!guildId) {
            console.warn("Slash commands need a control guild ID; skipping registration.");
            return;
        }

        const commands = buildSlashCommands(this.config);
        await this.client.application?.commands?.set(commands, guildId);
        console.log(`Registered ${commands.length} slash commands in guild ${guildId}.`);
    }

    // Sends (or, after a defer, edits) the reply to a slash command. Replies are
    // ephemeral by default so lookups and moderation confirmations do not clutter
    // the channel; callers pass { ephemeral: false } for things the room should see.
    async replyInteraction(interaction, content, { ephemeral = true } = {}) {
        const safeContent = truncateForDiscord(content, this.config.maxReplyLength) || "Done.";
        const payload = { content: safeContent, allowedMentions: { parse: [] } };

        if (interaction.deferred || interaction.replied) {
            await interaction.editReply(payload);
            return;
        }

        await interaction.reply(ephemeral ? { ...payload, flags: MessageFlags.Ephemeral } : payload);
    }

    // Last-resort acknowledgement so a thrown handler never leaves the user staring
    // at "the application did not respond".
    async safeInteractionError(interaction) {
        try {
            if (interaction.deferred || interaction.replied) {
                await interaction.editReply({ content: "Something went wrong running that command." });
            } else {
                await interaction.reply({ content: "Something went wrong running that command.", flags: MessageFlags.Ephemeral });
            }
        } catch {
            // The interaction may already be gone; nothing more we can do.
        }
    }

    canManageInteraction(interaction) {
        if (this.config.controlGuildId && interaction.guildId !== this.config.controlGuildId) {
            return false;
        }

        return isAuthorizedPrincipal({
            userId: interaction.user?.id,
            roleIds: getRoleIds(interaction.member),
            permissions: interaction.memberPermissions ?? interaction.member?.permissions,
            owner: interaction.guild?.ownerId === interaction.user?.id
        }, this.config);
    }

    // Whether an interaction's invoker may use a given area's commands. Applies
    // the control-guild guard, then the same admin/grant resolution as the panel.
    canUseInteractionArea(interaction, area) {
        if (this.config.controlGuildId && interaction.guildId !== this.config.controlGuildId) {
            return false;
        }

        return canAccessArea(this.interactionAccess(interaction), area);
    }

    async handleInteraction(interaction) {
        if (!interaction.isChatInputCommand?.()) {
            return;
        }

        if (!interaction.guildId || (this.config.controlGuildId && interaction.guildId !== this.config.controlGuildId)) {
            await this.replyInteraction(interaction, "This bot only works in its configured server.");
            return;
        }

        this.bumpStat("command", interaction.commandName);

        try {
            switch (interaction.commandName) {
                case "faq": await this.slashFaq(interaction); break;
                case "known": await this.slashKnown(interaction); break;
                case "triage": await this.slashTriage(interaction); break;
                case "rank": await this.slashRank(interaction); break;
                case "leaderboard": await this.slashLeaderboard(interaction); break;
                case "status": await this.slashStatus(interaction); break;
                case "poll": await this.slashPoll(interaction); break;
                case "giveaway": await this.slashGiveaway(interaction); break;
                case "ban":
                case "kick":
                case "timeout":
                case "untimeout":
                case "warn":
                case "purge":
                case "temprole":
                    await this.slashModeration(interaction); break;
                default: await this.replyInteraction(interaction, "Unknown command."); break;
            }
        } catch (error) {
            console.error(`Slash command /${interaction.commandName} failed:`, error);
            await this.safeInteractionError(interaction);
        }
    }

    async slashFaq(interaction) {
        if (!this.config.enableFaq) {
            await this.replyInteraction(interaction, "The FAQ module is turned off.");
            return;
        }

        const query = interaction.options.getString("query") ?? "";
        const match = findBestFaqMatch(this.config.faqEntries, query, this.config.matchThreshold);

        if (!match) {
            await this.replyInteraction(
                interaction,
                this.config.enableGitHub
                    ? "I couldn't find a FAQ entry for that. Try /known to search GitHub, or reword your question."
                    : "I couldn't find a FAQ entry for that. Try rewording your question."
            );
            return;
        }

        // buildFaqReply may hit the GitHub API, so acknowledge first to stay inside
        // Discord's three-second window.
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const reply = await this.buildFaqReply(match.entry, query);
        this.bumpStat("faq_answer", getEntryId(match.entry));
        await this.replyInteraction(interaction, reply || "That FAQ entry has no answer configured.");
    }

    async slashKnown(interaction) {
        if (!this.config.enableGitHub) {
            await this.replyInteraction(interaction, "GitHub lookups are turned off.");
            return;
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const query = interaction.options.getString("query") ?? "";
        await this.replyInteraction(interaction, await this.buildKnownIssueReply(query));
    }

    async slashTriage(interaction) {
        if (!this.config.enableSupportTriage) {
            await this.replyInteraction(interaction, "The support-triage module is turned off.");
            return;
        }

        const topic = interaction.options.getString("topic") ?? "";
        // The checklist is meant to be seen by whoever asked for help, so post it publicly.
        await this.replyInteraction(interaction, this.buildTriageTemplate(topic), { ephemeral: false });
    }

    async slashRank(interaction) {
        if (!this.config.levelingEnabled || !this.store) {
            await this.replyInteraction(interaction, "Leveling is turned off.");
            return;
        }

        const target = interaction.options.getUser("user") ?? interaction.user;
        const progress = levelProgress(this.store.getUserLevel(interaction.guildId, target.id).xp);
        const rank = this.store.userRank(interaction.guildId, target.id);

        await this.replyInteraction(
            interaction,
            `${formatUserReference(target.id)} — level ${progress.level} (rank #${rank}), ${progress.into}/${progress.needed} XP to next level.`,
            { ephemeral: false }
        );
    }

    async slashLeaderboard(interaction) {
        if (!this.config.levelingEnabled || !this.store) {
            await this.replyInteraction(interaction, "Leveling is turned off.");
            return;
        }

        const top = this.store.topLevels(interaction.guildId, 10);

        if (top.length === 0) {
            await this.replyInteraction(interaction, "No one has earned XP yet.", { ephemeral: false });
            return;
        }

        const lines = top.map((row) => `${row.rank}. ${formatUserReference(row.user_id)} — level ${row.level} (${row.xp} XP)`);
        await this.replyInteraction(interaction, ["Leaderboard", ...lines].join("\n"), { ephemeral: false });
    }

    async slashStatus(interaction) {
        if (!this.interactionAccess(interaction).authorized) {
            await this.replyInteraction(interaction, "You are not allowed to do that.");
            return;
        }

        const status = this.getSafeStatus();
        await this.replyInteraction(interaction, [
            "FAQ bot status:",
            `Modules: ${status.modules.join(", ")}`,
            `FAQ entries: ${status.faqEntries}`,
            `Allowed channels: ${status.allowedChannelIds.length}`,
            `Global GitHub search: ${status.enableGlobalGitHubSearch ? "on" : "off"}`
        ].join("\n"));
    }

    async slashPoll(interaction) {
        if (!this.config.enablePolls) {
            await this.replyInteraction(interaction, "Polls are turned off.");
            return;
        }

        const question = interaction.options.getString("question") ?? "";
        const options = parsePollOptions(interaction.options.getString("options"));
        const poll = buildPoll(question, options);

        // The poll must be public so members can react to it, so reply then react to
        // the reply itself.
        await interaction.reply({
            content: truncateForDiscord(poll.content, this.config.maxReplyLength),
            allowedMentions: { parse: [] }
        });

        const message = await interaction.fetchReply?.();

        for (const emoji of poll.emojis) {
            await message?.react?.(emoji).catch(() => {});
        }

        this.bumpStat("poll");
    }

    async slashGiveaway(interaction) {
        if (!this.config.enableGiveaways) {
            await this.replyInteraction(interaction, "Giveaways are turned off.");
            return;
        }

        if (!this.canUseInteractionArea(interaction, "scheduler")) {
            await this.replyInteraction(interaction, "You are not allowed to do that.");
            return;
        }

        if (!this.store) {
            await this.replyInteraction(interaction, "Giveaways need the database, which is not available.");
            return;
        }

        const durationRaw = interaction.options.getString("duration");
        const durationMs = parseDurationMs(durationRaw);

        if (!durationMs) {
            await this.replyInteraction(interaction, "Give a valid duration like 1h, 6h, or 1d.");
            return;
        }

        const prize = interaction.options.getString("prize") ?? "a prize";
        const winners = normalizeWinnerCount(interaction.options.getInteger("winners"));

        await interaction.reply({
            content: truncateForDiscord(buildGiveawayAnnouncement(prize, durationRaw, winners), this.config.maxReplyLength),
            allowedMentions: { parse: [] }
        });

        const message = await interaction.fetchReply?.();
        await message?.react?.("🎉").catch(() => {});

        this.store.scheduleTask({
            type: "giveaway_end",
            runAt: Date.now() + durationMs,
            guildId: interaction.guildId,
            payload: { channelId: interaction.channelId, messageId: message?.id, prize, winners },
            label: `giveaway: ${prize}`
        });
        this.bumpStat("giveaway");
    }

    // Draws a finished giveaway: gathers everyone who reacted with 🎉 (excluding
    // bots), picks the winners, and announces them in the channel.
    async drawGiveaway(task) {
        const payload = task.payload ?? {};
        const guild = this.getGuild(task.guild_id);
        const channel = await this.resolveChannel(guild, payload.channelId);
        const message = payload.messageId ? await channel?.messages?.fetch?.(payload.messageId).catch(() => null) : null;

        let entrants = [];

        if (message) {
            const reaction = message.reactions?.cache?.get?.("🎉");
            const users = reaction ? await reaction.users.fetch().catch(() => null) : null;
            entrants = users ? [...users.values()].filter((user) => !user.bot).map((user) => user.id) : [];
        }

        const winnerIds = pickWinners(entrants, payload.winners);
        await this.sendChannelMessage(channel, buildGiveawayResult(payload.prize, winnerIds), { parse: ["users"] });
    }

    // Writes a slash-driven moderation action to the same durable log the chat
    // commands and auto-moderation use, attributed to the invoking moderator.
    recordSlashModeration(interaction, { action, targetUserId, targetTag, reason }) {
        this.recordModeration({
            guildId: interaction.guildId,
            channelId: interaction.channelId,
            targetUserId,
            targetTag,
            moderatorId: interaction.user?.id ?? null,
            moderatorTag: interaction.user?.tag ?? interaction.user?.username ?? null,
            source: "command",
            action,
            reason: truncateReason(reason || "No reason provided."),
            matched: null,
            messageExcerpt: null,
            dryRun: false,
            success: true
        });
    }

    async slashModeration(interaction) {
        if (!this.config.enableModeration) {
            await this.replyInteraction(interaction, "The moderation module is turned off.");
            return;
        }

        if (!this.canUseInteractionArea(interaction, "moderation")) {
            await this.replyInteraction(interaction, "You are not allowed to do that.");
            return;
        }

        const command = interaction.commandName;

        if (command === "purge") {
            await this.slashPurge(interaction);
            return;
        }

        const targetUser = interaction.options.getUser("user");

        if (!targetUser) {
            await this.replyInteraction(interaction, "Please choose a member.");
            return;
        }

        if (this.isSelfTarget(targetUser.id)) {
            await this.replyInteraction(interaction, "I will not moderate myself.");
            return;
        }

        const member = interaction.options.getMember?.("user")
            ?? await this.resolveGuildMember(interaction.guild, targetUser.id);

        // The protected-target guard is about punishment; granting a temporary role
        // is additive, so it is exempt.
        if (command !== "temprole" && member && this.isProtectedTarget(member)) {
            await this.replyInteraction(interaction, "I will not moderate server admins or managers.");
            return;
        }

        const rawReason = interaction.options.getString("reason");
        const targetTag = targetUser.tag ?? targetUser.username ?? null;

        if (command === "temprole") {
            if (!this.guildBotHasPermission(interaction.guild, PermissionFlagsBits.ManageRoles)) {
                await this.replyInteraction(interaction, "I need the Manage Roles permission for that.");
                return;
            }

            const role = interaction.options.getRole("role");
            const durationMs = parseDurationMs(interaction.options.getString("duration"));

            if (!role) {
                await this.replyInteraction(interaction, "Choose a role to grant.");
                return;
            }

            if (!durationMs) {
                await this.replyInteraction(interaction, "Give a valid duration like 30m, 2h, or 1d.");
                return;
            }

            if (!member?.roles?.add) {
                await this.replyInteraction(interaction, "Could not resolve that member.");
                return;
            }

            await member.roles.add(role.id, this.buildActorReason(interaction.user.id, rawReason));
            this.store?.scheduleTask({
                type: "role_remove",
                runAt: Date.now() + durationMs,
                guildId: interaction.guildId,
                payload: { userId: targetUser.id, roleId: role.id },
                label: `remove ${role.name ?? role.id} from ${targetTag ?? targetUser.id}`
            });
            await this.replyInteraction(interaction, `Gave ${formatUserReference(targetUser.id)} the ${role.name ?? "requested"} role for ${interaction.options.getString("duration")}.`);
            return;
        }

        if (command === "warn") {
            const reason = rawReason || "No reason provided.";
            await targetUser.send?.(`Moderator warning in ${interaction.guild?.name ?? "the server"}: ${reason}`).catch(() => {});
            this.recordSlashModeration(interaction, { action: "warn", targetUserId: targetUser.id, targetTag, reason });
            await this.replyInteraction(interaction, `Warned ${formatUserReference(targetUser.id)}.`);
            return;
        }

        if (command === "timeout") {
            if (!this.guildBotHasPermission(interaction.guild, PermissionFlagsBits.ModerateMembers)) {
                await this.replyInteraction(interaction, "I need the Moderate Members permission for that.");
                return;
            }

            const durationMs = parseDurationMs(interaction.options.getString("duration"));

            if (!durationMs || !member?.timeout) {
                await this.replyInteraction(interaction, "Give a valid duration like 10m, 1h, or 1d, and make sure the member is in the server.");
                return;
            }

            const reason = this.buildActorReason(interaction.user.id, rawReason);
            await member.timeout(durationMs, reason);
            this.recordSlashModeration(interaction, { action: "timeout", targetUserId: targetUser.id, targetTag, reason });
            await this.replyInteraction(interaction, `Timed out ${formatUserReference(targetUser.id)}.`);
            return;
        }

        if (command === "untimeout") {
            if (!this.guildBotHasPermission(interaction.guild, PermissionFlagsBits.ModerateMembers)) {
                await this.replyInteraction(interaction, "I need the Moderate Members permission for that.");
                return;
            }

            if (!member?.timeout) {
                await this.replyInteraction(interaction, "Could not resolve that member.");
                return;
            }

            await member.timeout(null, this.buildActorReason(interaction.user.id, rawReason));
            await this.replyInteraction(interaction, `Removed the timeout from ${formatUserReference(targetUser.id)}.`);
            return;
        }

        if (command === "kick") {
            if (!this.guildBotHasPermission(interaction.guild, PermissionFlagsBits.KickMembers)) {
                await this.replyInteraction(interaction, "I need the Kick Members permission for that.");
                return;
            }

            if (!member?.kick) {
                await this.replyInteraction(interaction, "Could not resolve that member.");
                return;
            }

            const reason = this.buildActorReason(interaction.user.id, rawReason);
            await member.kick(reason);
            this.recordSlashModeration(interaction, { action: "kick", targetUserId: targetUser.id, targetTag, reason });
            await this.replyInteraction(interaction, `Kicked ${formatUserReference(targetUser.id)}.`);
            return;
        }

        if (command === "ban") {
            if (!this.guildBotHasPermission(interaction.guild, PermissionFlagsBits.BanMembers)) {
                await this.replyInteraction(interaction, "I need the Ban Members permission for that.");
                return;
            }

            const durationRaw = interaction.options.getString("duration");
            const durationMs = durationRaw ? parseDurationMs(durationRaw) : null;

            if (durationRaw && !durationMs) {
                await this.replyInteraction(interaction, "Give a valid ban length like 1h, 1d, or 1w — or leave it out for a permanent ban.");
                return;
            }

            const reason = this.buildActorReason(interaction.user.id, rawReason);
            const deleteMessageSeconds = clampBanDeleteSeconds(this.config.moderationBanDeleteMessageSeconds);

            if (member?.ban) {
                await member.ban({ deleteMessageSeconds, reason });
            } else {
                await interaction.guild.bans.create(targetUser.id, { deleteMessageSeconds, reason });
            }

            this.recordSlashModeration(interaction, { action: "ban", targetUserId: targetUser.id, targetTag, reason });

            if (durationMs) {
                this.store?.scheduleTask({
                    type: "unban",
                    runAt: Date.now() + durationMs,
                    guildId: interaction.guildId,
                    payload: { userId: targetUser.id, targetTag },
                    label: `unban ${targetTag ?? targetUser.id}`
                });
                await this.replyInteraction(interaction, `Banned ${formatUserReference(targetUser.id)} for ${durationRaw}.`);
            } else {
                await this.replyInteraction(interaction, `Banned ${formatUserReference(targetUser.id)}.`);
            }
        }
    }

    async slashPurge(interaction) {
        if (!this.guildBotHasPermission(interaction.guild, PermissionFlagsBits.ManageMessages)) {
            await this.replyInteraction(interaction, "I need the Manage Messages permission for that.");
            return;
        }

        const count = interaction.options.getInteger("count");

        if (!Number.isInteger(count) || count < 1 || count > 100) {
            await this.replyInteraction(interaction, "Choose a count between 1 and 100.");
            return;
        }

        const channel = interaction.channel ?? await this.resolveChannel(interaction.guild, interaction.channelId);

        if (!channel?.bulkDelete) {
            await this.replyInteraction(interaction, "I can't purge this channel.");
            return;
        }

        await channel.bulkDelete(count, true);
        await this.replyInteraction(interaction, `Deleted up to ${count} recent messages.`);
    }

    async handleMessage(message) {
        if (!this.shouldObserveMessage(message)) {
            return;
        }

        this.bumpStat("messages");

        if (await this.handleLevelingCommand(message)) {
            return;
        }

        if (await this.handleManagementCommand(message)) {
            return;
        }

        if (await this.handleAutoModeration(message)) {
            return;
        }

        // Normal chatter earns XP (throttled) once it has cleared moderation.
        await this.awardXpForMessage(message);

        if (!this.shouldHandleMessage(message)) {
            return;
        }

        if (message.content.length > this.config.maxMessageLength) {
            return;
        }

        if (this.isUserOnCooldown(message)) {
            return;
        }

        // Custom commands are exact, explicit triggers, so they take precedence
        // over the fuzzy FAQ matcher.
        if (this.config.enableCustomCommands) {
            const custom = matchCustomCommand(this.config.customCommands, message.content);

            if (custom) {
                await this.reply(message, custom.response);
                this.markUserCooldown(message);
                this.bumpStat("custom_command", custom.id);
                return;
            }
        }

        const faqMatch = this.config.enableFaq
            ? findBestFaqMatch(
                this.config.faqEntries,
                message.content,
                this.config.matchThreshold
            )
            : null;

        if (faqMatch) {
            const cooldownSeconds = getCooldownSeconds(
                faqMatch.entry,
                this.config.responseCooldownSeconds
            );

            const entryId = getEntryId(faqMatch.entry);

            if (this.isOnCooldown(entryId, message.channelId)) {
                return;
            }

            const reply = await this.buildFaqReply(faqMatch.entry, message.content);

            if (!reply) {
                return;
            }

            await this.reply(message, reply);
            this.markCooldown(entryId, message.channelId, cooldownSeconds);
            this.markUserCooldown(message);
            this.bumpStat("faq_answer", entryId);
            return;
        }

        if (this.config.questionOnlyMode && !isLikelyQuestion(message.content)) {
            return;
        }

        const fallbackCooldownId = "global-github-search";

        if (this.isOnCooldown(fallbackCooldownId, message.channelId)) {
            return;
        }

        const fallbackReply = await this.buildFallbackGitHubReply(message.content);

        if (!fallbackReply) {
            return;
        }

        await this.reply(message, fallbackReply);
        this.markCooldown(
            fallbackCooldownId,
            message.channelId,
            this.config.responseCooldownSeconds
        );
        this.markUserCooldown(message);
        this.bumpStat("github_fallback");
    }
}
