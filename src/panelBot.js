// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SparkBugz

// The admin server was written to talk to a live DiscordFaqBot instance. Now
// that the panel runs as its own process it has no gateway of its own, so this
// facade presents the same surface the server uses while routing everything
// through the shared store: config edits become a control-epoch bump, gateway
// buttons set a desired state, live Discord actions are queued for the bot to
// run, and status/directory reads come from what the bot last published.
//
// Keeping the shape identical means adminServer.js needs no changes — it is
// handed a PanelBot where it used to be handed the bot.

// A heartbeat older than this means the bot process is not currently running.
const HEARTBEAT_STALE_MS = 12 * 1000;
// How long a queued action waits for the bot to run it before the panel gives
// up and reports a timeout to the operator.
const COMMAND_TIMEOUT_MS = 8 * 1000;
// How often the panel re-reads the queue row while waiting for a result.
const COMMAND_POLL_MS = 120;

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export class PanelBot {
    constructor(config, store) {
        this.config = config;
        this.store = store;
    }

    // --- Config edits: refresh this process's copy, signal the bot -----------
    //
    // The panel's request handlers have already written the change to the store
    // and, for plain settings, mutated this.config in place. These methods keep
    // the panel's cached lists in step so its next render is correct, then bump
    // the control epoch so the running bot re-reads everything.

    reloadFaqEntries() {
        this.config.faqEntries = this.store.listFaqEntries();
        this.store.bumpControlEpoch();
        return this.config.faqEntries.length;
    }

    reloadCustomCommands() {
        this.config.customCommands = this.store.listCustomCommands();
        this.store.bumpControlEpoch();
        return this.config.customCommands?.length ?? 0;
    }

    reloadModerationRules() {
        this.config.moderationRules = this.store.assembleModerationRules();
        this.store.bumpControlEpoch();
        return this.config.moderationRules?.rules?.length ?? 0;
    }

    applyRuntimeConfig() {
        this.store.bumpControlEpoch();
    }

    // --- Status and directory: read what the bot last published -------------

    // True while the bot process is running (its heartbeat is fresh). Distinct
    // from the gateway being connected — the bot can be up with the gateway off.
    botOnline() {
        const heartbeat = this.store.getBotHeartbeat();
        return Boolean(heartbeat) && (Date.now() - heartbeat.updatedAt) < HEARTBEAT_STALE_MS;
    }

    // True only when the bot is running AND its Discord gateway is connected —
    // i.e. a queued action can actually run right now. When this is false a live
    // action is parked in the queue and runs once the bot is back online (the
    // bot has restarted, or the admin has switched it back on).
    gatewayConnected() {
        const heartbeat = this.store.getBotHeartbeat();
        return Boolean(heartbeat)
            && (Date.now() - heartbeat.updatedAt) < HEARTBEAT_STALE_MS
            && heartbeat.gatewayStatus === "connected";
    }

    getSafeStatus() {
        const heartbeat = this.store.getBotHeartbeat();
        const live = Boolean(heartbeat) && (Date.now() - heartbeat.updatedAt) < HEARTBEAT_STALE_MS;

        return {
            connectedAs: live ? heartbeat.connectedAs : null,
            gatewayStatus: live ? heartbeat.gatewayStatus : "disconnected",
            botProcess: live ? "up" : "down",
            guilds: live ? (heartbeat.guilds ?? 0) : 0,
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

    guildDirectory() {
        return this.store.getGuildDirectory() ?? { channels: [], roles: [] };
    }

    // --- Gateway lifecycle: set the desired state, the bot reconciles -------

    async startDiscordConnection() {
        this.store.setGatewayDesired("on");
    }

    async stopDiscordConnection() {
        this.store.setGatewayDesired("off");
    }

    async restartDiscordConnection() {
        this.store.setGatewayDesired("on");
        this.store.bumpGatewayNonce();
    }

    // Exit the bot process (it restarts under its process manager). The bot runs
    // this from the queue; the panel process is untouched and stays reachable.
    restart() {
        this.store.enqueueCommand("restart", {});
    }

    // --- Live Discord actions: queue for the bot, await the result ----------

    unbanUser(guildId, userId, reason) {
        return this.dispatch("unbanUser", { guildId, userId, reason });
    }

    clearMemberTimeout(guildId, userId, reason) {
        return this.dispatch("clearMemberTimeout", { guildId, userId, reason });
    }

    postEmbed(channelId, spec) {
        return this.dispatch("postEmbed", { channelId, spec });
    }

    addReactionOption(channelId, messageId, emoji) {
        return this.dispatch("addReactionOption", { channelId, messageId, emoji });
    }

    // Always enqueues the action. If the gateway is connected we wait for the
    // bot to run it and return the real result. If it is not — the bot is off or
    // still connecting — we leave the command parked and return undefined; the
    // caller has already told the operator it was queued, and the bot drains it
    // the moment it is back online. A command that does not finish inside the
    // wait window is treated the same way (it stays queued).
    async dispatch(kind, args) {
        const id = this.store.enqueueCommand(kind, args);

        if (!this.gatewayConnected()) {
            return undefined;
        }

        const result = await this.waitForCommand(id);

        if (!result) {
            return undefined;
        }

        if (!result.ok) {
            throw new Error(result.error || "The bot couldn't complete that action.");
        }

        return result.value;
    }

    async waitForCommand(id) {
        const deadline = Date.now() + COMMAND_TIMEOUT_MS;

        while (Date.now() < deadline) {
            const row = this.store.getCommand(id);

            if (row && row.status !== "pending") {
                return this.store.commandResult(row);
            }

            await delay(COMMAND_POLL_MS);
        }

        return null;
    }
}
