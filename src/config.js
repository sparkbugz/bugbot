// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SparkBugz

import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import {
    DEFAULT_ADMIN_PERMISSION_NAMES,
    normalizePermissionNames,
    validatePermissionNames
} from "./auth.js";
import {
    parseBoolean,
    parseCsv,
    parseInteger,
    parseNumber,
    parsePositiveNumber,
    parseRatio
} from "./util.js";

dotenv.config();

function validateOptionalSnowflake(name, value) {
    if (value && !/^\d{5,25}$/.test(value)) {
        throw new Error(`${name} contains an invalid Discord ID value: ${value}`);
    }
}

function validateSnowflakeList(name, values) {
    const invalid = values.filter((value) => !/^\d{5,25}$/.test(value));

    if (invalid.length > 0) {
        throw new Error(`${name} contains invalid Discord ID values: ${invalid.join(", ")}`);
    }
}

const KNOWN_MODULES = new Set([
    "faq",
    "github",
    "commands",
    "support-triage",
    "admin-dashboard",
    "moderation"
]);

function parseModules() {
    const configured = parseCsv(process.env.BOT_MODULES || process.env.ENABLED_MODULES);
    const modules = configured.length > 0 ? configured : ["faq", "github"];

    if (parseBoolean(process.env.ENABLE_MANAGEMENT_COMMANDS, false)) {
        modules.push("commands");
    }

    if (parseBoolean(process.env.ENABLE_SUPPORT_TRIAGE, false)) {
        modules.push("support-triage");
    }

    if (parseBoolean(process.env.ENABLE_ADMIN_DASHBOARD, false)) {
        modules.push("admin-dashboard");
    }

    if (parseBoolean(process.env.ENABLE_MODERATION, false)) {
        modules.push("moderation");
    }

    return [...new Set(modules.map((entry) => entry.toLowerCase()))];
}

function validateModules(modules) {
    const invalid = modules.filter((moduleName) => !KNOWN_MODULES.has(moduleName));

    if (invalid.length > 0) {
        throw new Error(`BOT_MODULES contains unsupported modules: ${invalid.join(", ")}`);
    }
}

function hasModule(modules, moduleName) {
    return modules.includes(moduleName);
}

function validateRepoList(name, values) {
    const invalid = values.filter((value) => !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value));

    if (invalid.length > 0) {
        throw new Error(`${name} contains invalid GitHub repo values: ${invalid.join(", ")}`);
    }
}

function validateSnowflakeOrWildcardList(name, values) {
    if (values.includes("*")) {
        return;
    }

    validateSnowflakeList(name, values);
}

function isLoopbackHost(value) {
    const host = String(value ?? "").toLowerCase();
    return host === "localhost" || host === "::1" || host.startsWith("127.");
}

function resolveDataPath(configuredPath, fallbackPath) {
    const absolutePath = path.resolve(process.cwd(), configuredPath);

    if (fs.existsSync(absolutePath)) {
        return absolutePath;
    }

    return path.resolve(process.cwd(), fallbackPath);
}

function resolveFaqPath() {
    return resolveDataPath(process.env.FAQ_DATA_PATH || "./data/faq.json", "./data/faq.example.json");
}

function resolveDatabasePath() {
    return path.resolve(process.cwd(), process.env.DATABASE_PATH || "./data/bot.db");
}

function resolveModerationRulesPath() {
    return resolveDataPath(
        process.env.MODERATION_RULES_PATH || "./data/moderation.json",
        "./data/moderation.example.json"
    );
}

export function loadFaqEntries(faqPath) {
    const contents = fs.readFileSync(faqPath, "utf8");
    const payload = JSON.parse(contents);

    if (!Array.isArray(payload.entries)) {
        throw new Error(`FAQ data file ${faqPath} must contain an entries array.`);
    }

    return payload.entries;
}

export function loadModerationRules(rulesPath) {
    const contents = fs.readFileSync(rulesPath, "utf8");
    const payload = JSON.parse(contents);

    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new Error(`Moderation rules file ${rulesPath} must contain a JSON object.`);
    }

    if (payload.rules !== undefined && !Array.isArray(payload.rules)) {
        throw new Error(`Moderation rules file ${rulesPath} rules field must be an array.`);
    }

    return payload;
}

export function loadConfig() {
    const token = process.env.DISCORD_TOKEN;

    if (!token) {
        throw new Error("DISCORD_TOKEN is required.");
    }

    const faqPath = resolveFaqPath();
    const moderationRulesPath = resolveModerationRulesPath();
    const allowedChannelIds = parseCsv(process.env.DISCORD_ALLOWED_CHANNEL_IDS);
    const ignoredChannelIds = parseCsv(process.env.DISCORD_IGNORED_CHANNEL_IDS);
    const adminUserIds = parseCsv(process.env.DISCORD_ADMIN_USER_IDS);
    const adminRoleIds = parseCsv(process.env.DISCORD_ADMIN_ROLE_IDS);
    const moderationChannelIds = parseCsv(process.env.MODERATION_CHANNEL_IDS);
    const moderationExemptUserIds = parseCsv(process.env.MODERATION_EXEMPT_USER_IDS);
    const moderationExemptRoleIds = parseCsv(process.env.MODERATION_EXEMPT_ROLE_IDS);
    const moderationLogChannelId = process.env.MODERATION_LOG_CHANNEL_ID || null;
    const githubDefaultRepos = parseCsv(process.env.GITHUB_DEFAULT_REPOS);
    const modules = parseModules();
    const controlGuildId = process.env.DISCORD_CONTROL_GUILD_ID || null;
    const configuredAdminPermissionNames = parseCsv(process.env.DISCORD_ADMIN_PERMISSION_FLAGS);
    const adminPermissionNames = configuredAdminPermissionNames.length > 0
        ? normalizePermissionNames(configuredAdminPermissionNames)
        : DEFAULT_ADMIN_PERMISSION_NAMES;

    if (allowedChannelIds.length === 0) {
        throw new Error("DISCORD_ALLOWED_CHANNEL_IDS must include at least one channel ID.");
    }

    validateModules(modules);
    validateOptionalSnowflake("DISCORD_CONTROL_GUILD_ID", controlGuildId);
    validateSnowflakeList("DISCORD_ALLOWED_CHANNEL_IDS", allowedChannelIds);
    validateSnowflakeList("DISCORD_IGNORED_CHANNEL_IDS", ignoredChannelIds);
    validateSnowflakeList("DISCORD_ADMIN_USER_IDS", adminUserIds);
    validateSnowflakeList("DISCORD_ADMIN_ROLE_IDS", adminRoleIds);
    validateSnowflakeOrWildcardList("MODERATION_CHANNEL_IDS", moderationChannelIds);
    validateSnowflakeList("MODERATION_EXEMPT_USER_IDS", moderationExemptUserIds);
    validateSnowflakeList("MODERATION_EXEMPT_ROLE_IDS", moderationExemptRoleIds);
    validateOptionalSnowflake("MODERATION_LOG_CHANNEL_ID", moderationLogChannelId);
    validateRepoList("GITHUB_DEFAULT_REPOS", githubDefaultRepos);
    validatePermissionNames("DISCORD_ADMIN_PERMISSION_FLAGS", configuredAdminPermissionNames);

    const enableManagementCommands = hasModule(modules, "commands");
    const enableAdminDashboard = hasModule(modules, "admin-dashboard");
    const enableGitHub = hasModule(modules, "github");
    const enableModeration = hasModule(modules, "moderation");

    if ((enableManagementCommands || enableAdminDashboard || enableModeration) && !controlGuildId) {
        throw new Error("DISCORD_CONTROL_GUILD_ID is required when commands, admin dashboard, or moderation modules are enabled.");
    }

    if (enableModeration && moderationChannelIds.length === 0) {
        throw new Error("MODERATION_CHANNEL_IDS is required when moderation is enabled. Use * to scan the whole control guild intentionally.");
    }

    const adminWebProtocol = String(process.env.ADMIN_WEB_PROTOCOL || "http").toLowerCase();
    const adminWebHost = process.env.ADMIN_WEB_HOST || "127.0.0.1";
    const adminWebPort = parseInteger(process.env.ADMIN_WEB_PORT, 8787);
    const adminWebPublicUrl = process.env.ADMIN_WEB_PUBLIC_URL ||
        `${adminWebProtocol}://${adminWebHost}:${adminWebPort}`;
    const adminSessionSecret = process.env.ADMIN_SESSION_SECRET || null;
    const discordOAuthClientId = process.env.DISCORD_OAUTH_CLIENT_ID ||
        process.env.DISCORD_CLIENT_ID ||
        null;
    const discordOAuthClientSecret = process.env.DISCORD_OAUTH_CLIENT_SECRET || null;
    const discordOAuthRedirectUri = process.env.DISCORD_OAUTH_REDIRECT_URI ||
        new URL("/oauth/callback", adminWebPublicUrl).toString();
    const adminWebTlsCertPath = process.env.ADMIN_WEB_TLS_CERT_PATH || null;
    const adminWebTlsKeyPath = process.env.ADMIN_WEB_TLS_KEY_PATH || null;

    if (!["http", "https"].includes(adminWebProtocol)) {
        throw new Error("ADMIN_WEB_PROTOCOL must be either http or https.");
    }

    if (enableAdminDashboard) {
        if (!discordOAuthClientId || !discordOAuthClientSecret) {
            throw new Error("DISCORD_OAUTH_CLIENT_ID and DISCORD_OAUTH_CLIENT_SECRET are required when admin dashboard is enabled.");
        }

        if (!adminSessionSecret || adminSessionSecret.length < 32) {
            throw new Error("ADMIN_SESSION_SECRET must be at least 32 characters when admin dashboard is enabled.");
        }

        if (adminWebProtocol === "http" && !isLoopbackHost(adminWebHost)) {
            throw new Error("ADMIN_WEB_PROTOCOL=http is only allowed when ADMIN_WEB_HOST is loopback.");
        }

        if (adminWebProtocol === "https" && (!adminWebTlsCertPath || !adminWebTlsKeyPath)) {
            throw new Error("ADMIN_WEB_TLS_CERT_PATH and ADMIN_WEB_TLS_KEY_PATH are required when ADMIN_WEB_PROTOCOL=https.");
        }
    }

    return {
        discordToken: token,
        discordClientId: process.env.DISCORD_CLIENT_ID || null,
        botName: process.env.BOT_NAME || "BugBot",
        controlGuildId,
        databasePath: resolveDatabasePath(),
        faqPath,
        faqEntries: loadFaqEntries(faqPath),
        modules,
        enableFaq: hasModule(modules, "faq"),
        enableGitHub,
        allowedChannelIds,
        ignoredChannelIds,
        adminUserIds,
        adminRoleIds,
        adminPermissionNames,
        enableManagementCommands,
        enableSupportTriage: hasModule(modules, "support-triage"),
        enableAdminDashboard,
        enableModeration,
        managementCommandPrefix: process.env.MANAGEMENT_COMMAND_PREFIX || "!faqbot",
        enableSlashCommands: parseBoolean(process.env.ENABLE_SLASH_COMMANDS, true),
        enableCustomCommands: parseBoolean(process.env.ENABLE_CUSTOM_COMMANDS, false),
        customCommands: [],
        enablePolls: parseBoolean(process.env.ENABLE_POLLS, false),
        enableGiveaways: parseBoolean(process.env.ENABLE_GIVEAWAYS, false),
        questionOnlyMode: parseBoolean(process.env.QUESTION_ONLY_MODE, true),
        matchThreshold: parseRatio(process.env.MATCH_THRESHOLD, 0.72),
        responseCooldownSeconds: parsePositiveNumber(process.env.RESPONSE_COOLDOWN_SECONDS, 60),
        userMessageCooldownSeconds: parsePositiveNumber(process.env.USER_MESSAGE_COOLDOWN_SECONDS, 5),
        maxMessageLength: parsePositiveNumber(process.env.MAX_MESSAGE_LENGTH, 1000),
        maxReplyLength: Math.min(parsePositiveNumber(process.env.MAX_REPLY_LENGTH, 1900), 2000),
        githubToken: process.env.GITHUB_TOKEN || null,
        githubDefaultRepos,
        enableGlobalGitHubSearch: enableGitHub && parseBoolean(process.env.ENABLE_GLOBAL_GITHUB_SEARCH, false),
        globalGitHubSearchMinScore: parseRatio(process.env.GLOBAL_GITHUB_SEARCH_MIN_SCORE, 0.63),
        githubCacheTtlMs: parsePositiveNumber(process.env.GITHUB_CACHE_TTL_SECONDS, 600) * 1000,
        githubQueryMaxLength: parsePositiveNumber(process.env.GITHUB_QUERY_MAX_LENGTH, 256),
        githubRequestTimeoutMs: parsePositiveNumber(process.env.GITHUB_REQUEST_TIMEOUT_SECONDS, 8) * 1000,
        moderationRulesPath,
        moderationRules: loadModerationRules(moderationRulesPath),
        moderationChannelIds,
        moderationLogChannelId,
        moderationExemptUserIds,
        moderationExemptRoleIds,
        moderationDefaultAction: process.env.MODERATION_DEFAULT_ACTION || "timeout",
        moderationDefaultTimeoutSeconds: parsePositiveNumber(
            process.env.MODERATION_DEFAULT_TIMEOUT_SECONDS,
            3600
        ),
        moderationBanDeleteMessageSeconds: parseNumber(
            process.env.MODERATION_BAN_DELETE_MESSAGE_SECONDS,
            86400
        ),
        moderationMaxScanLength: parsePositiveNumber(process.env.MODERATION_MAX_SCAN_LENGTH, 4000),
        moderationDryRun: parseBoolean(process.env.MODERATION_DRY_RUN, true),
        welcomeEnabled: parseBoolean(process.env.WELCOME_ENABLED, false),
        welcomeChannelId: process.env.WELCOME_CHANNEL_ID || null,
        welcomeMessage: process.env.WELCOME_MESSAGE
            || "Welcome to {server}, {mention}! You are member #{count}.",
        goodbyeEnabled: parseBoolean(process.env.GOODBYE_ENABLED, false),
        goodbyeChannelId: process.env.GOODBYE_CHANNEL_ID || null,
        goodbyeMessage: process.env.GOODBYE_MESSAGE || "{user} has left the server.",
        autoRoleIds: parseCsv(process.env.AUTO_ROLE_IDS),
        reactionRolesEnabled: parseBoolean(process.env.REACTION_ROLES_ENABLED, false),
        starboardEnabled: parseBoolean(process.env.STARBOARD_ENABLED, false),
        starboardChannelId: process.env.STARBOARD_CHANNEL_ID || null,
        starboardEmoji: process.env.STARBOARD_EMOJI || "⭐",
        starboardThreshold: parsePositiveNumber(process.env.STARBOARD_THRESHOLD, 3),
        levelingEnabled: parseBoolean(process.env.LEVELING_ENABLED, false),
        xpPerMessage: parsePositiveNumber(process.env.XP_PER_MESSAGE, 15),
        xpCooldownSeconds: parsePositiveNumber(process.env.XP_COOLDOWN_SECONDS, 60),
        levelUpEnabled: parseBoolean(process.env.LEVEL_UP_ENABLED, true),
        levelUpChannelId: process.env.LEVEL_UP_CHANNEL_ID || null,
        levelUpMessage: process.env.LEVEL_UP_MESSAGE || "GG {mention}, you reached level {level}!",
        levelRoles: parseCsv(process.env.LEVEL_ROLES),
        loggingEnabled: parseBoolean(process.env.LOGGING_ENABLED, false),
        logChannelId: process.env.LOG_CHANNEL_ID || null,
        logMessageDeletes: parseBoolean(process.env.LOG_MESSAGE_DELETES, true),
        logMessageEdits: parseBoolean(process.env.LOG_MESSAGE_EDITS, true),
        logJoinsLeaves: parseBoolean(process.env.LOG_JOINS_LEAVES, true),
        adminWebProtocol,
        adminWebHost,
        adminWebPort,
        adminWebPublicUrl,
        adminWebTlsCertPath,
        adminWebTlsKeyPath,
        adminSessionSecret,
        discordOAuthClientId,
        discordOAuthClientSecret,
        discordOAuthRedirectUri,
        allowProcessRestart: parseBoolean(process.env.ALLOW_PROCESS_RESTART, false)
    };
}
