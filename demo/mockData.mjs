// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SparkBugz
//
// Mock data for the static demo of the BugBot admin console. Every field here
// mirrors the shape the live panel feeds to the real render functions in
// src/adminViews.js, so the demo tracks the real UI automatically — only the
// values are invented. Nothing is persisted; this is a look-book, not a bot.

import { AREA_KEYS } from "../src/access.js";

// Snowflake-ish IDs, stable across builds so pages cross-reference cleanly.
const CH = (n) => `11223344556677${String(8800 + n)}`;
const RL = (n) => `22334455667788${String(9900 + n)}`;
const US = (n) => `33445566778899${String(1000 + n)}`;

const CHANNELS = [
    { id: CH(1), name: "general" },
    { id: CH(2), name: "support" },
    { id: CH(3), name: "bug-reports" },
    { id: CH(4), name: "announcements" },
    { id: CH(5), name: "welcome" },
    { id: CH(6), name: "mod-log" },
    { id: CH(7), name: "starboard" },
    { id: CH(8), name: "off-topic" }
];

const ROLES = [
    { id: RL(1), name: "Admin" },
    { id: RL(2), name: "Moderator" },
    { id: RL(3), name: "Support" },
    { id: RL(4), name: "Contributor" },
    { id: RL(5), name: "Member" },
    { id: RL(6), name: "Level 10+" }
];

const DIRECTORY = { channels: CHANNELS, roles: ROLES };

// Time helpers — resolved once per build against the real clock.
const NOW = Date.now();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const ago = (ms) => NOW - ms;
const soon = (ms) => NOW + ms;

function lastDays(n) {
    const out = [];
    const base = new Date(NOW);
    base.setUTCHours(0, 0, 0, 0);

    for (let i = n - 1; i >= 0; i -= 1) {
        const day = new Date(base);
        day.setUTCDate(base.getUTCDate() - i);
        out.push(day.toISOString().slice(0, 10));
    }

    return out;
}

const series = (days, values) => days.map((day, index) => ({ day, count: values[index] ?? 0 }));

// A single admin session that can see everything: owner unlocks every tab plus
// the owner-only "Administrators" revocation block on the Access page.
const SESSION = {
    username: "ada · demo",
    csrf: "demo-csrf-token",
    access: { authorized: true, admin: true, owner: true, areas: [...AREA_KEYS] },
    botStatus: { botProcess: "up", gatewayStatus: "connected", connectedAs: "BugBot#4207" }
};

const STATUS = {
    connectedAs: "BugBot#4207",
    gatewayStatus: "connected",
    botProcess: "up",
    allowProcessRestart: true,
    modules: ["FAQ", "Moderation", "Leveling", "GitHub", "Scheduler", "Reaction roles"],
    controlGuildId: "998877665544332211",
    faqEntries: 12,
    allowedChannelIds: [CH(1), CH(2), CH(3)],
    enableModeration: true,
    moderationDryRun: false,
    enableGlobalGitHubSearch: true,
    githubDefaultRepos: ["sparkbugz/bugbot", "sparkbugz/phoenix"]
};

// Moderation rows — the dashboard shows the first handful, the moderation log
// shows them all. Fields match what actionTag()/userCell()/fmtTime() read.
const MOD_ACTIONS = [
    { id: 1, created_at: ago(6 * MIN), action: "timeout", target_user_id: US(11), target_tag: "spammer_99", reason: "Crypto airdrop scam", matched: "scam-airdrop", source: "auto-detect", moderator_id: null, undoable: 1, undone_at: null, dry_run: false },
    { id: 2, created_at: ago(41 * MIN), action: "delete", target_user_id: US(12), target_tag: "free_nitro_bot", reason: "Discord/Nitro lookalike link", matched: "lookalike-domain", source: "auto-detect", moderator_id: null, undoable: 0, undone_at: null, dry_run: false },
    { id: 3, created_at: ago(2 * HOUR), action: "ban", target_user_id: US(13), target_tag: "wallet_drainer", reason: "Wallet-drainer copy-paste", matched: "wallet-drainer", source: "auto-detect", moderator_id: null, undoable: 1, undone_at: null, dry_run: false },
    { id: 4, created_at: ago(3 * HOUR), action: "warn", target_user_id: US(14), target_tag: "loud_lurker", reason: "Excessive mentions", matched: "mention-spam", source: "auto-detect", moderator_id: null, undoable: 0, undone_at: null, dry_run: false },
    { id: 5, created_at: ago(5 * HOUR), action: "kick", target_user_id: US(15), target_tag: "raidbot_04", reason: "Join raid", matched: null, source: "command", moderator_id: RL(2), undoable: 0, undone_at: null, dry_run: false },
    { id: 6, created_at: ago(8 * HOUR), action: "timeout", target_user_id: US(16), target_tag: "hothead", reason: "Flame war", matched: null, source: "command", moderator_id: US(90), undoable: 1, undone_at: ago(7 * HOUR), dry_run: false },
    { id: 7, created_at: ago(11 * HOUR), action: "ban", target_user_id: US(17), target_tag: "scam_shop", reason: "Risky TLD + scam terms", matched: "risky-tld", source: "auto-detect", moderator_id: null, undoable: 1, undone_at: null, dry_run: false },
    { id: 8, created_at: ago(14 * HOUR), action: "delete", target_user_id: US(18), target_tag: "linkspam", reason: "Blocked domain", matched: "blocked-domain", source: "auto-detect", moderator_id: null, undoable: 0, undone_at: null, dry_run: false },
    { id: 9, created_at: ago(20 * HOUR), action: "warn", target_user_id: US(19), target_tag: "newbie", reason: "Wrong channel", matched: null, source: "command", moderator_id: US(90), undoable: 0, undone_at: null, dry_run: true },
    { id: 10, created_at: ago(26 * HOUR), action: "timeout", target_user_id: US(20), target_tag: "copypasta", reason: "Repeated spam", matched: "spam-repeat", source: "auto-detect", moderator_id: null, undoable: 1, undone_at: null, dry_run: false },
    { id: 11, created_at: ago(30 * HOUR), action: "ban", target_user_id: US(21), target_tag: "alt_account", reason: "Ban evasion", matched: null, source: "command", moderator_id: RL(1), undoable: 1, undone_at: null, dry_run: false },
    { id: 12, created_at: ago(2 * DAY), action: "kick", target_user_id: US(22), target_tag: "trolley", reason: "Trolling after warning", matched: null, source: "command", moderator_id: US(90), undoable: 0, undone_at: null, dry_run: false }
];

const DASHBOARD_SUMMARY = { total: 1287, last24h: 14, bans: 23, reversible: 6 };

// FAQ list — the fuzzy auto-answer entries.
const FAQ_ENTRIES = [
    { id: "reset-password", question: "How do I reset my password?", questions: ["password reset not working"], enabled: true },
    { id: "install-bot", question: "How do I add BugBot to my server?", questions: ["invite the bot"], enabled: true },
    { id: "self-host", question: "Can I self-host BugBot?", questions: ["run it myself", "docker image"], enabled: true },
    { id: "github-link", question: "Why did the bot link a GitHub issue?", questions: [], enabled: true },
    { id: "slash-commands", question: "What slash commands are there?", questions: ["list commands"], enabled: true },
    { id: "leveling-xp", question: "How do I earn XP?", questions: ["how does leveling work"], enabled: true },
    { id: "report-bug", question: "How do I report a bug?", questions: ["found a bug"], enabled: true },
    { id: "contact-support", question: "How do I contact support?", questions: ["talk to a human"], enabled: false }
];

// One fully-populated entry for the FAQ editor page.
const FAQ_EDITOR_ENTRY = {
    id: "reset-password",
    questions: ["How do I reset my password?", "password reset not working", "can't log in"],
    match: { anyTerms: ["password", "reset", "login"] },
    answer: "You can reset your password from the sign-in page — click “Forgot password?”, enter your email, and follow the link we send you. The link is valid for 30 minutes.\n\nStill stuck? Reply here and a maintainer will take a look.",
    response: { links: ["https://docs.bugmunch.dev/account/reset-password"] },
    github: { mode: "search", repos: ["sparkbugz/bugbot"], type: "both", query: "password reset", minScore: 0.63 },
    cooldownSeconds: 60,
    enabled: true
};

// Custom commands — exact-match auto-responders.
const CUSTOM_COMMANDS = [
    { id: "rules", trigger: "!rules", matchType: "exact", response: "Read the server rules in #rules before posting. Be kind, stay on-topic, and wrap logs in code blocks.", enabled: true },
    { id: "invite", trigger: "!invite", matchType: "exact", response: "Add BugBot to your own server: https://bugmunch.dev/invite", enabled: true },
    { id: "docs", trigger: "!docs", matchType: "starts", response: "Docs live at https://docs.bugmunch.dev — try the search box at the top.", enabled: true },
    { id: "gh", trigger: "github", matchType: "contains", response: "Source and issues: https://github.com/sparkbugz/bugbot", enabled: true },
    { id: "ping", trigger: "!ping", matchType: "exact", response: "pong 🏓", enabled: false }
];

const CUSTOM_COMMAND_EDITOR = {
    id: "rules", trigger: "!rules", matchType: "exact",
    response: "Read the server rules in #rules before posting support questions. Be kind, stay on-topic, and wrap logs in code blocks.",
    enabled: true
};

// Analytics — 14 days of daily rollups, zero-safe like the real page.
const DAYS = lastDays(14);
const ANALYTICS = {
    enabled: true,
    windowDays: 14,
    tiles: { messages: 18432, faqAnswers: 214, modActions: 47, xp: 92650 },
    messages: series(DAYS, [980, 1120, 1340, 1210, 1490, 1655, 1720, 1180, 1290, 1410, 1533, 1602, 1288, 1121]),
    mod: series(DAYS, [2, 4, 1, 3, 6, 5, 2, 1, 4, 3, 5, 4, 3, 4]),
    faqAnswers: series(DAYS, [12, 18, 15, 21, 19, 24, 27, 14, 16, 20, 18, 22, 17, 11]),
    xp: series(DAYS, [4900, 5600, 6700, 6050, 7450, 8275, 8600, 5900, 6450, 7050, 7665, 8010, 6440, 5605]),
    topFaqs: [
        { key: "reset-password", total: 63 },
        { key: "install-bot", total: 41 },
        { key: "self-host", total: 28 },
        { key: "slash-commands", total: 19 },
        { key: "leveling-xp", total: 12 }
    ],
    topCommands: [
        { key: "/faq", total: 88 },
        { key: "/rank", total: 54 },
        { key: "/ban", total: 22 },
        { key: "/poll", total: 15 },
        { key: "/giveaway", total: 7 }
    ]
};

// Moderation rules page — built-in detector globals plus custom phrase rules.
const MOD_GLOBALS = {
    blockedDomains: ["free-nitro.gg", "steamcommunlty.com", "discord-airdrop.net"],
    maxMentions: 8,
    blockedDomainAction: "delete",
    lookalikeDomainAction: "ban",
    walletScamAction: "ban",
    riskyTldAction: "timeout",
    mentionSpamAction: "timeout"
};

const MOD_RULES = [
    { id: "wallet-drainer", action: "ban", reason: "Wallet-drainer copy-paste scam", enabled: true, match: {} },
    { id: "fake-giveaway", action: "timeout", reason: "Fake giveaway / airdrop bait", enabled: true, match: {} },
    { id: "dm-me-scam", action: "delete", reason: "\"DM me to claim\" bait", enabled: true, match: {} },
    { id: "slur-list", action: "kick", reason: "Slur filter", enabled: false, match: {} }
];

const MOD_RULE_EDITOR = {
    id: "wallet-drainer",
    action: "ban",
    reason: "wallet drainer copy-paste scam",
    match: {
        anyPhrases: ["connect your wallet", "claim your airdrop"],
        allTerms: [],
        anyTerms: ["wallet", "airdrop", "seed"],
        regex: ["(?:seed|recovery)\\s+phrase"],
        requireUrl: true
    },
    timeoutSeconds: "",
    deleteMessage: true,
    enabled: true
};

// Reaction roles, leaderboard, scheduler, audit, access.
const REACTION_ROLES = [
    { channel_id: CH(4), message_id: "1177001", emoji: "🔔", role_id: RL(4) },
    { channel_id: CH(1), message_id: "1177002", emoji: "🎮", role_id: RL(5) },
    { channel_id: CH(1), message_id: "1177002", emoji: "🐛", role_id: RL(4) }
];

const LEADERBOARD = [
    { rank: 1, user_id: US(50), level: 42, xp: 184320, messages: 9210 },
    { rank: 2, user_id: US(51), level: 38, xp: 151200, messages: 7640 },
    { rank: 3, user_id: US(52), level: 35, xp: 129800, messages: 6110 },
    { rank: 4, user_id: US(53), level: 29, xp: 88400, messages: 4025 },
    { rank: 5, user_id: US(54), level: 24, xp: 61250, messages: 2980 },
    { rank: 6, user_id: US(55), level: 21, xp: 47300, messages: 2210 },
    { rank: 7, user_id: US(56), level: 18, xp: 33900, messages: 1544 },
    { rank: 8, user_id: US(57), level: 14, xp: 19850, messages: 902 }
];

const SCHEDULER = {
    tasks: [
        { id: 1, type: "unban", run_at: soon(3 * HOUR), label: "@spammer_99 temp-ban expiry" },
        { id: 2, type: "role_remove", run_at: soon(20 * HOUR), label: "@event-goer from 42 members" },
        { id: 3, type: "giveaway_end", run_at: soon(2 * DAY), label: "Steam key giveaway draw" },
        { id: 4, type: "announcement", run_at: soon(45 * MIN), label: "Weekly changelog" }
    ],
    announcements: [
        { id: 1, channel_id: CH(4), message: "Weekly changelog is live — see what shipped this week in #announcements.", interval_seconds: 604800, enabled: true, next_run: soon(3 * DAY) },
        { id: 2, channel_id: CH(2), message: "Reminder: include your BugBot version and logs when reporting an issue.", interval_seconds: 86400, enabled: true, next_run: soon(6 * HOUR) },
        { id: 3, channel_id: CH(1), message: "Community call starts in one hour — voice channel is open.", interval_seconds: 0, enabled: false, next_run: null }
    ]
};

const AUDIT = [
    { created_at: ago(9 * MIN), actor_name: "ada", actor_id: US(90), action: "faq.update", detail: "Edited FAQ entry reset-password" },
    { created_at: ago(52 * MIN), actor_name: "ada", actor_id: US(90), action: "settings.save", detail: "Changed matchThreshold 0.60 → 0.63" },
    { created_at: ago(3 * HOUR), actor_name: "linus", actor_id: US(91), action: "moderation.rule.create", detail: "Added rule wallet-drainer" },
    { created_at: ago(6 * HOUR), actor_name: "ada", actor_id: US(90), action: "access.grant", detail: "Granted @Support → faq, commands" },
    { created_at: ago(28 * HOUR), actor_name: "linus", actor_id: US(91), action: "command.create", detail: "Added custom command !docs" },
    { created_at: ago(2 * DAY), actor_name: "ada", actor_id: US(90), action: "bot.restart", detail: "Reconnected the Discord gateway" }
];

const ACCESS_GRANTS = [
    { subjectType: "role", subjectId: RL(2), areas: ["moderation", "faq", "audit"], label: "Mod team", createdBy: US(90) },
    { subjectType: "role", subjectId: RL(3), areas: ["faq", "commands"], label: "Support crew", createdBy: US(90) },
    { subjectType: "user", subjectId: US(58), areas: [...AREA_KEYS], label: "Trusted maintainer", createdBy: US(90) }
];

const ADMIN_BLOCKS = [
    { subjectType: "role", subjectId: RL(6), label: "Auto-granted admin removed", createdBy: US(90) }
];

// Settings sections are assembled from the real schema (src/settings.js) fed a
// demo config, so the Settings and Reference pages stay in lock-step with the
// live field list. Values below are only what a tidy example server looks like.
const DEMO_CONFIG = {
    controlGuildId: "998877665544332211",
    botName: "BugBot",
    allowedChannelIds: [CH(1), CH(2), CH(3)],
    ignoredChannelIds: [CH(8)],
    enableFaq: true,
    matchThreshold: 0.63,
    questionOnlyMode: true,
    responseCooldownSeconds: 60,
    userMessageCooldownSeconds: 30,
    maxMessageLength: 400,
    maxReplyLength: 1200,
    enableGitHub: true,
    enableGlobalGitHubSearch: true,
    githubDefaultRepos: ["sparkbugz/bugbot", "sparkbugz/phoenix"],
    globalGitHubSearchMinScore: 0.7,
    githubQueryMaxLength: 120,
    githubCacheTtlMs: 300_000,
    githubRequestTimeoutMs: 8_000,
    enableSlashCommands: true,
    enableManagementCommands: true,
    managementCommandPrefix: "!bugbot",
    enableSupportTriage: true,
    enableCustomCommands: true,
    enablePolls: true,
    enableGiveaways: true,
    enableModeration: true,
    moderationChannelIds: ["*"],
    moderationDryRun: false,
    moderationDefaultAction: "timeout",
    moderationDefaultTimeoutSeconds: 3600,
    moderationBanDeleteMessageSeconds: 86_400,
    moderationExemptUserIds: [US(90)],
    moderationExemptRoleIds: [RL(1), RL(2)],
    welcomeEnabled: true,
    welcomeChannelId: CH(5),
    welcomeMessage: "Welcome {mention}! You are member #{count}. Say hi in #general 👋",
    goodbyeEnabled: false,
    goodbyeChannelId: "",
    goodbyeMessage: "{user} left {server}.",
    autoRoleIds: [RL(5)],
    reactionRolesEnabled: true,
    loggingEnabled: true,
    logChannelId: CH(6),
    logMessageDeletes: true,
    logMessageEdits: true,
    logJoinsLeaves: true,
    starboardEnabled: true,
    starboardChannelId: CH(7),
    starboardEmoji: "⭐",
    starboardThreshold: 5,
    levelingEnabled: true,
    xpPerMessage: 15,
    xpCooldownSeconds: 60,
    levelUpEnabled: true,
    levelUpChannelId: "",
    levelUpMessage: "GG {mention}, you reached level {level}! 🎉",
    levelRoles: ["5:" + RL(4), "10:" + RL(6)]
};

export const mock = {
    session: SESSION,
    directory: DIRECTORY,
    status: STATUS,
    config: DEMO_CONFIG,
    dashboard: { summary: DASHBOARD_SUMMARY, recent: MOD_ACTIONS.slice(0, 8) },
    moderationActions: MOD_ACTIONS,
    faqEntries: FAQ_ENTRIES,
    faqEditorEntry: FAQ_EDITOR_ENTRY,
    customCommands: CUSTOM_COMMANDS,
    customCommandEditor: CUSTOM_COMMAND_EDITOR,
    analytics: ANALYTICS,
    moderationGlobals: MOD_GLOBALS,
    moderationRules: MOD_RULES,
    moderationRuleEditor: MOD_RULE_EDITOR,
    reactionRoles: REACTION_ROLES,
    leaderboard: LEADERBOARD,
    scheduler: SCHEDULER,
    audit: AUDIT,
    accessGrants: ACCESS_GRANTS,
    adminBlocks: ADMIN_BLOCKS
};
