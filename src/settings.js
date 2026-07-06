// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SparkBugz

// The config an admin can change from the panel at runtime. Each field maps onto
// a property of the live config object, so saving takes effect immediately (no
// restart) and is persisted to the store so it survives one.
//
// Field types:
//   text     free string (optionally validated by `pattern`)
//   number   numeric, clamped to [min, max]; `scale` converts display units to
//            config units (e.g. seconds shown, milliseconds stored)
//   boolean  checkbox
//   list     one value per line; each validated by `itemPattern`, stored as JSON
//   select   one of `options`
//
// `key` is the form field name; `configKey` (default: key) is the config
// property it writes. `restart` marks a field that only fully applies on the
// next start, so the UI can say so.
//
// Sections are grouped by module: a module's on/off switch sits at the top of
// its own section, next to the knobs it controls, so the settings page reads as
// one card per feature instead of a separate wall of toggles.

const SNOWFLAKE = /^\d{5,25}$/;
const SNOWFLAKE_OR_STAR = /^(\*|\d{5,25})$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export const SETTING_FIELD_DOCS = {
    controlGuildId: {
        default: "Empty unless commands, dashboard, or moderation are enabled.",
        format: "Discord server ID, also called a guild snowflake. It is 5-25 digits.",
        example: "123456789012345678"
    },
    botName: {
        default: "BugBot",
        format: "Short display name used for the Discord nickname and presence."
    },
    managementCommandPrefix: {
        default: "!faqbot",
        format: "Text prefix typed before chat admin commands.",
        example: "!faqbot"
    },
    enableFaq: {
        default: "On when the faq module is enabled; the default module set includes faq.",
        format: "On replies from the FAQ matcher; off disables automatic FAQ answers."
    },
    enableGitHub: {
        default: "On when the github module is enabled; the default module set includes github.",
        format: "On allows FAQ-attached and fallback GitHub issue/PR searches."
    },
    enableGlobalGitHubSearch: {
        default: "Off.",
        format: "On lets the bot search GitHub only after no FAQ entry matched."
    },
    enableManagementCommands: {
        default: "Off unless the commands module is enabled.",
        format: "On allows authorized admins to run prefixed Discord chat commands."
    },
    enableSupportTriage: {
        default: "Off.",
        format: "On adds the support triage command for authorized admins."
    },
    enableCustomCommands: {
        default: "Off.",
        format: "On enables exact custom trigger/reply commands managed on the Custom commands page."
    },
    enablePolls: {
        default: "Off.",
        format: "On registers /poll after the bot reconnects with slash commands enabled."
    },
    enableGiveaways: {
        default: "Off.",
        format: "On registers /giveaway after the bot reconnects with slash commands enabled."
    },
    enableModeration: {
        default: "Off.",
        format: "On enables automatic moderation and moderation commands. Moderated channels must also be set."
    },
    reactionRolesEnabled: {
        default: "Off.",
        format: "On enables reaction-role events and requires the bot to reconnect with reaction intents."
    },
    enableSlashCommands: {
        default: "On.",
        format: "On registers slash commands in the control server for enabled features."
    },
    allowedChannelIds: {
        default: "Required from DISCORD_ALLOWED_CHANNEL_IDS; no built-in default.",
        format: "One Discord text channel ID per line. The bot ignores every channel not listed.",
        example: "123456789012345678\n234567890123456789"
    },
    ignoredChannelIds: {
        default: "Empty.",
        format: "One Discord channel ID per line. These override watched channels.",
        example: "345678901234567890"
    },
    matchThreshold: {
        default: "0.72.",
        format: "0-1 confidence ratio. Lower answers more often; higher answers only close matches."
    },
    questionOnlyMode: {
        default: "On.",
        format: "On gates the global GitHub fallback to likely help questions. Explicit FAQ matches still work."
    },
    responseCooldownSeconds: {
        default: "60 seconds.",
        format: "Seconds before the same FAQ entry or GitHub fallback can reply again in one channel."
    },
    userMessageCooldownSeconds: {
        default: "5 seconds.",
        format: "Seconds after a successful bot reply before the same user can trigger another automatic reply in that channel."
    },
    maxMessageLength: {
        default: "1000 characters.",
        format: "Messages longer than this are ignored by FAQ/GitHub matching."
    },
    maxReplyLength: {
        default: "1900 characters.",
        format: "Discord messages cannot exceed 2000 characters; the bot truncates above this cap."
    },
    githubDefaultRepos: {
        default: "Empty unless GITHUB_DEFAULT_REPOS is set.",
        format: "One repository per line in owner/repo format. Do not include https://github.com/.",
        example: "sparkbugz/bugbot\nsparkbugz/phoenix"
    },
    globalGitHubSearchMinScore: {
        default: "0.63.",
        format: "0-1 relevance ratio. Lower returns looser matches; higher only posts very close matches."
    },
    githubQueryMaxLength: {
        default: "256 characters.",
        format: "Maximum normalized query text sent to GitHub."
    },
    githubCacheTtlSeconds: {
        default: "600 seconds.",
        format: "0 disables useful cache lifetime; higher values reduce GitHub API calls but keep older results longer."
    },
    githubRequestTimeoutSeconds: {
        default: "8 seconds.",
        format: "Seconds to wait before aborting a GitHub API request."
    },
    moderationChannelIds: {
        default: "Empty.",
        format: "One channel ID per line, or a single * to scan the whole control server.",
        example: "*"
    },
    moderationDryRun: {
        default: "On.",
        format: "On logs what would happen without deleting, warning, timing out, kicking, or banning."
    },
    moderationDefaultAction: {
        default: "timeout.",
        format: "Used when a moderation rule does not set its own action.",
        options: "log records only; delete removes the message; warn replies/DMs; timeout temporarily mutes; kick removes; ban removes and blocks rejoin."
    },
    moderationDefaultTimeoutSeconds: {
        default: "3600 seconds.",
        format: "Timeout duration used by timeout rules without their own duration."
    },
    moderationBanDeleteMessageSeconds: {
        default: "86400 seconds.",
        format: "0-604800 seconds. Discord does not allow deleting more than 7 days of history during a ban."
    },
    moderationExemptUserIds: {
        default: "Empty.",
        format: "One Discord user ID per line. Automatic moderation never acts on these users."
    },
    moderationExemptRoleIds: {
        default: "Empty.",
        format: "One Discord role ID per line. Automatic moderation never acts on members with these roles."
    },
    welcomeEnabled: {
        default: "Off.",
        format: "On posts the welcome message when a member joins."
    },
    welcomeChannelId: {
        default: "Empty.",
        format: "Discord channel ID that receives welcome messages."
    },
    welcomeMessage: {
        default: "Welcome to {server}, {mention}! You are member #{count}.",
        format: "Text template. Usable tags: {user}, {mention}, {tag}, {server}, {count}.",
        example: "Welcome {mention}! Read #rules first."
    },
    goodbyeEnabled: {
        default: "Off.",
        format: "On posts the goodbye message when a member leaves."
    },
    goodbyeChannelId: {
        default: "Empty.",
        format: "Discord channel ID that receives goodbye messages."
    },
    goodbyeMessage: {
        default: "{user} has left the server.",
        format: "Text template. Usable tags: {user}, {mention}, {tag}, {server}, {count}.",
        example: "{user} left {server}."
    },
    autoRoleIds: {
        default: "Empty.",
        format: "One role ID per line. The bot grants these roles to new members on join."
    },
    loggingEnabled: {
        default: "Off.",
        format: "On records selected server events in the log channel."
    },
    logChannelId: {
        default: "Empty.",
        format: "Discord channel ID that receives log events."
    },
    logMessageDeletes: {
        default: "On.",
        format: "On records deleted messages when server logging is enabled."
    },
    logMessageEdits: {
        default: "On.",
        format: "On records edited messages when server logging is enabled."
    },
    logJoinsLeaves: {
        default: "On.",
        format: "On records joins and leaves when server logging is enabled."
    },
    starboardEnabled: {
        default: "Off.",
        format: "On reposts messages once they collect enough matching reactions."
    },
    starboardChannelId: {
        default: "Empty.",
        format: "Discord channel ID where highlighted messages are reposted."
    },
    starboardEmoji: {
        default: "⭐.",
        format: "Standard emoji, custom emoji name, or custom emoji ID."
    },
    starboardThreshold: {
        default: "3 reactions.",
        format: "Number of matching reactions required before a message is reposted."
    },
    levelingEnabled: {
        default: "Off.",
        format: "On awards XP for qualifying chat messages."
    },
    xpPerMessage: {
        default: "15 XP.",
        format: "XP granted for each qualifying message."
    },
    xpCooldownSeconds: {
        default: "60 seconds.",
        format: "Seconds before one user can earn XP again."
    },
    levelUpEnabled: {
        default: "On.",
        format: "On posts a message when a user reaches a new level."
    },
    levelUpChannelId: {
        default: "Empty.",
        format: "Discord channel ID for level-up messages. Empty posts in the channel where the user leveled."
    },
    levelUpMessage: {
        default: "GG {mention}, you reached level {level}!",
        format: "Text template. Usable tags: {mention}, {user}, {tag}, {level}.",
        example: "{mention} reached level {level}!"
    },
    levelRoles: {
        default: "Empty.",
        format: "One reward per line in level:roleId format.",
        example: "5:123456789012345678\n10:234567890123456789"
    }
};

export const SETTINGS_SECTIONS = [
    {
        title: "General",
        description: "Which server the bot manages and how it presents itself.",
        fields: [
            { key: "controlGuildId", label: "Discord server ID", type: "text", pattern: SNOWFLAKE, allowEmpty: true, restart: true,
                hint: "The guild the bot manages. Commands and the dashboard are scoped to it. Changing this can sign you out if you are not in the new server." },
            { key: "botName", label: "Bot name", type: "text", allowEmpty: true,
                hint: "What the bot calls itself in Discord (nickname and presence). The admin console stays branded BugBot." }
        ]
    },
    {
        title: "Channels",
        description: "Where the bot listens. Pick from the live channel list when the bot is connected.",
        fields: [
            { key: "allowedChannelIds", label: "Watched channels", type: "list", itemPattern: SNOWFLAKE, itemLabel: "channel ID", source: "channels",
                hint: "Channels the bot reads for questions. It ignores every channel not listed here." },
            { key: "ignoredChannelIds", label: "Ignored channels", type: "list", itemPattern: SNOWFLAKE, itemLabel: "channel ID", allowEmpty: true, source: "channels",
                hint: "Channels to skip entirely, even if watched above." }
        ]
    },
    {
        title: "FAQ & matching",
        description: "Automatic answers from your FAQ entries, and how eagerly the bot replies.",
        fields: [
            { key: "enableFaq", label: "FAQ auto-replies", type: "boolean", hint: "Answer questions that match your FAQ entries. Manage the entries on the FAQ page." },
            { key: "matchThreshold", label: "FAQ match threshold", type: "number", min: 0, max: 1, step: "0.01",
                hint: "How close a message must be to a FAQ entry to answer (0–1). Higher is stricter." },
            { key: "questionOnlyMode", label: "Only answer genuine questions", type: "boolean",
                hint: "Ignore statements and passing references; only reply to real asks." },
            { key: "responseCooldownSeconds", label: "Reply cooldown (seconds)", type: "number", min: 1,
                hint: "Minimum seconds before the same answer repeats in a channel." },
            { key: "userMessageCooldownSeconds", label: "Per-user cooldown (seconds)", type: "number", min: 1,
                hint: "Minimum seconds between replies to the same person." },
            { key: "maxMessageLength", label: "Max message length", type: "number", min: 1,
                hint: "Ignore messages longer than this many characters." },
            { key: "maxReplyLength", label: "Max reply length", type: "number", min: 1, max: 2000,
                hint: "Cap the reply length. Discord's hard limit is 2000." }
        ]
    },
    {
        title: "GitHub search",
        description: "Link related issues and PRs from your repositories.",
        fields: [
            { key: "enableGitHub", label: "GitHub lookups", type: "boolean", hint: "Allow searching GitHub for related issues and PRs." },
            { key: "enableGlobalGitHubSearch", label: "GitHub fallback search", type: "boolean", hint: "When no FAQ matches, search the default repos for a close issue/PR." },
            { key: "githubDefaultRepos", label: "Repositories", type: "list", itemPattern: REPO, itemLabel: "owner/repo", allowEmpty: true,
                hint: "Repos the bot searches, as owner/name. One per line." },
            { key: "globalGitHubSearchMinScore", label: "Fallback match minimum score", type: "number", min: 0, max: 1, step: "0.01",
                hint: "Confidence needed before posting a fallback GitHub match (0–1)." },
            { key: "githubQueryMaxLength", label: "Max query length", type: "number", min: 8,
                hint: "Longest text sent to GitHub search." },
            { key: "githubCacheTtlSeconds", configKey: "githubCacheTtlMs", scale: 1000, label: "Result cache (seconds)", type: "number", min: 0,
                hint: "How long identical searches are cached to avoid rate limits." },
            { key: "githubRequestTimeoutSeconds", configKey: "githubRequestTimeoutMs", scale: 1000, label: "Request timeout (seconds)", type: "number", min: 1,
                hint: "Abort a GitHub API call that takes longer than this." }
        ]
    },
    {
        title: "Commands",
        description: "Slash commands, prefixed chat commands, and the extras they unlock.",
        fields: [
            { key: "enableSlashCommands", label: "Slash commands", type: "boolean", restart: true,
                hint: "Register /commands in the control server (/faq, /rank, /ban, …). The set follows what you enable; changes apply after a restart." },
            { key: "enableManagementCommands", label: "Chat admin commands", type: "boolean", hint: "Allow prefixed admin commands in the control server." },
            { key: "managementCommandPrefix", label: "Command prefix", type: "text", allowEmpty: false,
                hint: "Prefix for in-chat admin commands, e.g. !faqbot status." },
            { key: "enableSupportTriage", label: "Support triage command", type: "boolean", hint: "Adds a command that posts a 'what details do you need' template." },
            { key: "enableCustomCommands", label: "Custom commands", type: "boolean", hint: "Answer exact triggers (e.g. !rules) with a fixed response. Manage them on the Custom commands page." },
            { key: "enablePolls", label: "Polls", type: "boolean", restart: true, hint: "Adds /poll for quick reaction polls. Applies after a restart." },
            { key: "enableGiveaways", label: "Giveaways", type: "boolean", restart: true, hint: "Adds /giveaway with an automatic timed draw. Applies after a restart." }
        ]
    },
    {
        title: "Moderation",
        description: "Automatic enforcement. Keep dry-run on until you trust the rules.",
        fields: [
            { key: "enableModeration", label: "Moderation", type: "boolean", restart: false,
                hint: "Auto-detect scams/spam and allow ban/kick/timeout commands. Needs at least one moderated channel below." },
            { key: "moderationChannelIds", label: "Moderated channels", type: "list", itemPattern: SNOWFLAKE_OR_STAR, itemLabel: "channel ID or *", allowEmpty: true,
                hint: "Channels to auto-moderate. Use a single * to scan the whole server." },
            { key: "moderationDryRun", label: "Dry-run", type: "boolean",
                hint: "Detect and log matches without actually enforcing them." },
            { key: "moderationDefaultAction", label: "Default action", type: "select",
                options: ["log", "delete", "warn", "timeout", "kick", "ban"],
                hint: "Action for a rule that does not specify its own." },
            { key: "moderationDefaultTimeoutSeconds", label: "Default timeout (seconds)", type: "number", min: 1,
                hint: "Timeout length when a timeout rule gives no duration." },
            { key: "moderationBanDeleteMessageSeconds", label: "Ban message purge (seconds)", type: "number", min: 0, max: 604800,
                hint: "How much recent message history to delete on a ban. Discord caps this at 7 days." },
            { key: "moderationExemptUserIds", label: "Exempt users", type: "list", itemPattern: SNOWFLAKE, itemLabel: "user ID", allowEmpty: true,
                hint: "Users automatic moderation never touches. One ID per line." },
            { key: "moderationExemptRoleIds", label: "Exempt roles", type: "list", itemPattern: SNOWFLAKE, itemLabel: "role ID", allowEmpty: true, source: "roles",
                hint: "Roles automatic moderation never touches. One ID per line." }
        ]
    },
    {
        title: "Welcome & goodbye",
        description: "Greet new members and note when they leave. Uses the Server Members intent, so turning these on applies after a restart.",
        fields: [
            { key: "welcomeEnabled", label: "Welcome new members", type: "boolean", restart: true, hint: "Post a message when someone joins." },
            { key: "welcomeChannelId", label: "Welcome channel", type: "text", pattern: SNOWFLAKE, allowEmpty: true, source: "channels", hint: "Channel that receives welcome messages." },
            { key: "welcomeMessage", label: "Welcome message", type: "textarea", allowEmpty: true, hint: "Placeholders: {user} {mention} {tag} {server} {count}." },
            { key: "goodbyeEnabled", label: "Announce leavers", type: "boolean", restart: true, hint: "Post a message when someone leaves." },
            { key: "goodbyeChannelId", label: "Goodbye channel", type: "text", pattern: SNOWFLAKE, allowEmpty: true, source: "channels", hint: "Channel that receives goodbye messages." },
            { key: "goodbyeMessage", label: "Goodbye message", type: "textarea", allowEmpty: true, hint: "Placeholders: {user} {mention} {tag} {server} {count}." },
            { key: "autoRoleIds", label: "Auto-roles on join", type: "list", itemPattern: SNOWFLAKE, itemLabel: "role ID", allowEmpty: true, restart: true, source: "roles", hint: "Roles automatically given to new members." }
        ]
    },
    {
        title: "Reaction roles",
        description: "Let members self-assign roles by reacting to a message. The mappings live on the Reaction roles page.",
        fields: [
            { key: "reactionRolesEnabled", label: "Reaction roles", type: "boolean", restart: true,
                hint: "Grant and remove roles when members react. Needs reaction intents, so it applies after a restart." }
        ]
    },
    {
        title: "Server logging",
        description: "Mirror server events into a log channel. Turning logging on applies after a restart.",
        fields: [
            { key: "loggingEnabled", label: "Enable logging", type: "boolean", restart: true, hint: "Record server events to the log channel below." },
            { key: "logChannelId", label: "Log channel", type: "text", pattern: SNOWFLAKE, allowEmpty: true, source: "channels", hint: "Channel that receives the log." },
            { key: "logMessageDeletes", label: "Log deleted messages", type: "boolean", hint: "Record when a message is deleted." },
            { key: "logMessageEdits", label: "Log edited messages", type: "boolean", hint: "Record when a message is edited." },
            { key: "logJoinsLeaves", label: "Log joins and leaves", type: "boolean", restart: true, hint: "Record members joining and leaving." }
        ]
    },
    {
        title: "Starboard",
        description: "Repost messages the community loves to a highlights channel. Uses reactions, so turning it on applies after a restart.",
        fields: [
            { key: "starboardEnabled", label: "Enable starboard", type: "boolean", restart: true, hint: "Repost a message once it collects enough of the starboard emoji." },
            { key: "starboardChannelId", label: "Starboard channel", type: "text", pattern: SNOWFLAKE, allowEmpty: true, source: "channels", hint: "Where highlighted messages are reposted." },
            { key: "starboardEmoji", label: "Starboard emoji", type: "text", allowEmpty: true, hint: "The reaction that counts, e.g. ⭐. A standard emoji, or a custom emoji's name or ID." },
            { key: "starboardThreshold", label: "Reactions needed", type: "number", min: 1, hint: "How many of the emoji a message needs before it is reposted." }
        ]
    },
    {
        title: "Leveling",
        description: "Reward activity with XP, levels, and role rewards.",
        fields: [
            { key: "levelingEnabled", label: "Enable leveling", type: "boolean", hint: "Give XP for chatting and track levels." },
            { key: "xpPerMessage", label: "XP per message", type: "number", min: 1, hint: "XP granted per qualifying message." },
            { key: "xpCooldownSeconds", label: "XP cooldown (seconds)", type: "number", min: 1, hint: "Minimum gap between XP awards to one user, so it cannot be farmed." },
            { key: "levelUpEnabled", label: "Announce level-ups", type: "boolean", hint: "Post a message when someone reaches a new level." },
            { key: "levelUpChannelId", label: "Level-up channel", type: "text", pattern: SNOWFLAKE, allowEmpty: true, source: "channels", hint: "Where level-ups are announced. Blank uses the channel they leveled up in." },
            { key: "levelUpMessage", label: "Level-up message", type: "textarea", allowEmpty: true, hint: "Placeholders: {mention} {user} {tag} {level}." },
            { key: "levelRoles", label: "Level role rewards", type: "list", itemPattern: /^\d+:\d{5,25}$/, itemLabel: "level:roleId", allowEmpty: true, hint: "Grant a role when a member hits a level. Format level:roleId, one per line — e.g. 5:123456789012345678." }
        ]
    }
];

export const SETTINGS_FIELDS = SETTINGS_SECTIONS.flatMap((section) => section.fields);
const BY_KEY = new Map(SETTINGS_FIELDS.map((field) => [field.key, field]));

function configKeyOf(field) {
    return field.configKey ?? field.key;
}

// The value to show in the form control, read from the live config.
export function displayValue(field, config) {
    const raw = config[configKeyOf(field)];

    if (field.type === "boolean") {
        return Boolean(raw);
    }

    if (field.type === "list") {
        return Array.isArray(raw) ? raw : [];
    }

    if (field.type === "number" && field.scale && Number.isFinite(raw)) {
        return raw / field.scale;
    }

    return raw ?? "";
}

// Parses a submitted form value into the config-space value, throwing a friendly
// Error when it is invalid so the caller can re-render with the message.
export function coerceFromForm(field, rawValue) {
    if (field.type === "boolean") {
        return rawValue === true || rawValue === "1" || rawValue === "on";
    }

    if (field.type === "select") {
        return field.options.includes(rawValue) ? rawValue : field.options[0];
    }

    if (field.type === "list") {
        const items = String(rawValue ?? "")
            .split("\n").map((line) => line.trim()).filter(Boolean);

        if (items.length === 0 && !field.allowEmpty) {
            throw new Error(`${field.label} needs at least one ${field.itemLabel ?? "value"}.`);
        }

        const bad = field.itemPattern ? items.filter((item) => !field.itemPattern.test(item)) : [];

        if (bad.length > 0) {
            throw new Error(`${field.label} has an invalid ${field.itemLabel ?? "value"}: ${bad[0]}`);
        }

        return items;
    }

    if (field.type === "number") {
        const parsed = Number(rawValue);

        if (!Number.isFinite(parsed)) {
            throw new Error(`${field.label} must be a number.`);
        }

        let value = parsed;

        if (field.min !== undefined) {
            value = Math.max(value, field.min);
        }
        if (field.max !== undefined) {
            value = Math.min(value, field.max);
        }

        return field.scale ? value * field.scale : value;
    }

    const text = String(rawValue ?? "").trim();

    if (!text && !field.allowEmpty) {
        throw new Error(`${field.label} cannot be empty.`);
    }

    if (text && field.pattern && !field.pattern.test(text)) {
        throw new Error(`${field.label} is not valid.`);
    }

    return text;
}

// Cross-field checks that must hold after a save (mirrors the startup invariants).
export function validateSettings(config) {
    if (config.enableModeration && (config.moderationChannelIds ?? []).length === 0) {
        throw new Error("Moderation is on but no moderated channels are set. Add a channel or use *.");
    }

    if ((config.enableManagementCommands || config.enableModeration) && !config.controlGuildId) {
        throw new Error("A Discord server ID is required to enable commands or moderation.");
    }
}

export function serializeSetting(field, configValue) {
    if (field.type === "boolean") {
        return configValue ? "1" : "0";
    }

    if (field.type === "list") {
        return JSON.stringify(Array.isArray(configValue) ? configValue : []);
    }

    return String(configValue);
}

function deserializeSetting(field, raw) {
    if (field.type === "boolean") {
        return raw === "1";
    }

    if (field.type === "list") {
        try {
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return [];
        }
    }

    if (field.type === "number") {
        const parsed = Number(raw);
        return Number.isFinite(parsed) ? parsed : undefined;
    }

    return raw;
}

// On startup, overlay saved settings onto the freshly loaded config.
export function applyStoredSettings(config, store) {
    for (const [key, raw] of Object.entries(store.allSettings())) {
        const field = BY_KEY.get(key);

        if (!field || raw === null) {
            continue;
        }

        const value = deserializeSetting(field, raw);

        if (value !== undefined) {
            config[configKeyOf(field)] = value;
        }
    }
}

export { configKeyOf };
