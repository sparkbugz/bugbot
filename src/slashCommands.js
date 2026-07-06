// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SparkBugz

import { ApplicationCommandOptionType, PermissionFlagsBits } from "discord.js";

// Slash-command definitions as raw application-command payloads. Kept as plain
// data (no builder instances) so the set is trivial to unit test and to filter by
// which features are enabled. Handlers live on the bot; this module only decides
// which commands exist and how their options are shaped.

const { String: STRING, Integer: INTEGER, User: USER, Role: ROLE } = ApplicationCommandOptionType;

function userOption(required, description) {
    return { type: USER, name: "user", description, required };
}

function reasonOption() {
    return {
        type: STRING,
        name: "reason",
        description: "Reason recorded in the moderation log",
        required: false
    };
}

// default_member_permissions is a decimal bitfield string; Discord hides a command
// from members who lack those permissions. The bot still re-checks its own admin
// model in the handler, so this is a first gate rather than the only one.
function permissionBits(...bits) {
    return bits.reduce((accumulator, bit) => accumulator | bit, 0n).toString();
}

// Returns the application-command payloads to register, limited to the features
// that are currently on. Registering the whole set unconditionally would show
// members commands that reply "that module is turned off".
export function buildSlashCommands(config) {
    const commands = [];

    if (config.enableFaq) {
        commands.push({
            name: "faq",
            description: "Look up an answer from the FAQ",
            options: [{ type: STRING, name: "query", description: "What you want to know", required: true }]
        });
    }

    if (config.enableGitHub && (config.githubDefaultRepos?.length ?? 0) > 0) {
        commands.push({
            name: "known",
            description: "Search the tracked GitHub repos for a related issue or PR",
            options: [{ type: STRING, name: "query", description: "What to search for", required: true }]
        });
    }

    if (config.enableSupportTriage) {
        commands.push({
            name: "triage",
            description: "Post the support-triage checklist",
            options: [{ type: STRING, name: "topic", description: "Optional topic to tailor the checklist", required: false }]
        });
    }

    if (config.levelingEnabled) {
        commands.push({
            name: "rank",
            description: "Show a member's level and rank",
            options: [userOption(false, "Whose rank to show (defaults to you)")]
        });
        commands.push({ name: "leaderboard", description: "Show the top members by XP" });
    }

    if (config.enablePolls) {
        commands.push({
            name: "poll",
            description: "Start a quick reaction poll",
            options: [
                { type: STRING, name: "question", description: "What you are asking", required: true },
                { type: STRING, name: "options", description: "Comma-separated options (up to 10); omit for a yes/no poll", required: false }
            ]
        });
    }

    if (config.enableGiveaways) {
        commands.push({
            name: "giveaway",
            description: "Start a giveaway with an automatic timed draw",
            default_member_permissions: permissionBits(PermissionFlagsBits.ManageGuild),
            options: [
                { type: STRING, name: "duration", description: "How long it runs, e.g. 1h, 1d", required: true },
                { type: STRING, name: "prize", description: "What is being given away", required: true },
                { type: INTEGER, name: "winners", description: "How many winners (default 1)", required: false, min_value: 1, max_value: 20 }
            ]
        });
    }

    if (config.enableManagementCommands) {
        commands.push({
            name: "status",
            description: "Show the bot's current status",
            default_member_permissions: permissionBits(PermissionFlagsBits.ManageGuild)
        });
    }

    if (config.enableModeration) {
        commands.push({
            name: "ban",
            description: "Ban a member (optionally for a limited time)",
            default_member_permissions: permissionBits(PermissionFlagsBits.BanMembers),
            options: [
                userOption(true, "Member to ban"),
                { type: STRING, name: "duration", description: "Optional temp-ban length, e.g. 1h, 1d, 1w", required: false },
                reasonOption()
            ]
        });
        commands.push({
            name: "temprole",
            description: "Give a member a role for a limited time",
            default_member_permissions: permissionBits(PermissionFlagsBits.ManageRoles),
            options: [
                userOption(true, "Member to grant the role"),
                { type: ROLE, name: "role", description: "Role to grant", required: true },
                { type: STRING, name: "duration", description: "How long, e.g. 30m, 2h, 1d", required: true },
                reasonOption()
            ]
        });
        commands.push({
            name: "kick",
            description: "Kick a member",
            default_member_permissions: permissionBits(PermissionFlagsBits.KickMembers),
            options: [userOption(true, "Member to kick"), reasonOption()]
        });
        commands.push({
            name: "timeout",
            description: "Time a member out for a duration",
            default_member_permissions: permissionBits(PermissionFlagsBits.ModerateMembers),
            options: [
                userOption(true, "Member to time out"),
                { type: STRING, name: "duration", description: "e.g. 30s, 10m, 1h, 1d, 1w", required: true },
                reasonOption()
            ]
        });
        commands.push({
            name: "untimeout",
            description: "Remove a member's timeout",
            default_member_permissions: permissionBits(PermissionFlagsBits.ModerateMembers),
            options: [userOption(true, "Member to release"), reasonOption()]
        });
        commands.push({
            name: "warn",
            description: "Warn a member by DM and record it",
            default_member_permissions: permissionBits(PermissionFlagsBits.ModerateMembers),
            options: [userOption(true, "Member to warn"), reasonOption()]
        });
        commands.push({
            name: "purge",
            description: "Bulk-delete recent messages in this channel",
            default_member_permissions: permissionBits(PermissionFlagsBits.ManageMessages),
            options: [{
                type: INTEGER,
                name: "count",
                description: "How many messages to delete (1-100)",
                required: true,
                min_value: 1,
                max_value: 100
            }]
        });
    }

    return commands;
}
