// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SparkBugz

import { PermissionFlagsBits } from "discord.js";

const PERMISSION_ALIASES = new Map([
    ["administrator", "Administrator"],
    ["admin", "Administrator"],
    ["manageguild", "ManageGuild"],
    ["manage_guild", "ManageGuild"],
    ["manage server", "ManageGuild"],
    ["manageserver", "ManageGuild"],
    ["managechannels", "ManageChannels"],
    ["manage_channels", "ManageChannels"],
    ["managemessages", "ManageMessages"],
    ["manage_messages", "ManageMessages"],
    ["moderatemembers", "ModerateMembers"],
    ["moderate_members", "ModerateMembers"],
    ["timeoutmembers", "ModerateMembers"],
    ["timeout_members", "ModerateMembers"]
]);

export const DEFAULT_ADMIN_PERMISSION_NAMES = [
    "Administrator",
    "ManageGuild",
    "ManageMessages",
    "ModerateMembers"
];

export function normalizePermissionName(value) {
    const raw = String(value ?? "").trim();

    if (!raw) {
        return null;
    }

    if (PermissionFlagsBits[raw] !== undefined) {
        return raw;
    }

    return PERMISSION_ALIASES.get(raw.toLowerCase().replace(/\s+/g, "")) ?? null;
}

export function normalizePermissionNames(values) {
    return values
        .map(normalizePermissionName)
        .filter(Boolean);
}

export function validatePermissionNames(name, values) {
    const invalid = values.filter((value) => !normalizePermissionName(value));

    if (invalid.length > 0) {
        throw new Error(`${name} contains unsupported Discord permission names: ${invalid.join(", ")}`);
    }
}

function asPermissionBit(value) {
    if (value === undefined || value === null) {
        return 0n;
    }

    if (typeof value === "bigint") {
        return value;
    }

    if (typeof value === "number") {
        return BigInt(value);
    }

    if (typeof value === "string" && /^\d+$/.test(value)) {
        return BigInt(value);
    }

    return 0n;
}

export function hasDiscordPermission(permissions, permissionName) {
    const normalizedName = normalizePermissionName(permissionName);

    if (!normalizedName) {
        return false;
    }

    if (permissions?.has) {
        return permissions.has(PermissionFlagsBits[normalizedName]);
    }

    const permissionBits = asPermissionBit(permissions);
    const requiredBit = asPermissionBit(PermissionFlagsBits[normalizedName]);

    return requiredBit !== 0n && (permissionBits & requiredBit) === requiredBit;
}

export function getRoleIds(memberOrPrincipal) {
    const roles = memberOrPrincipal?.roles;

    if (!roles) {
        return [];
    }

    if (Array.isArray(roles)) {
        return roles.map(String);
    }

    if (roles.cache?.keys) {
        return [...roles.cache.keys()];
    }

    if (roles.keys) {
        return [...roles.keys()];
    }

    return [];
}

export function isAuthorizedPrincipal(principal, config) {
    const userId = principal?.userId || principal?.user?.id || principal?.id;

    if (!userId) {
        return false;
    }

    // The server owner is always an administrator. Discord reports ownership
    // directly, so this holds even if the computed permission bits are missing.
    if (principal.owner === true) {
        return true;
    }

    if ((config.adminUserIds ?? []).includes(userId)) {
        return true;
    }

    const roleIds = principal.roleIds ?? getRoleIds(principal);

    if (roleIds.some((roleId) => (config.adminRoleIds ?? []).includes(roleId))) {
        return true;
    }

    const permissionNames = config.adminPermissionNames ?? DEFAULT_ADMIN_PERMISSION_NAMES;

    return permissionNames.some((permissionName) => (
        hasDiscordPermission(principal.permissions, permissionName)
    ));
}

export function canManageDiscordMessage(message, config) {
    if (!message?.guild || !message?.author || message.author.bot) {
        return false;
    }

    if (config.controlGuildId && message.guild.id !== config.controlGuildId) {
        return false;
    }

    return isAuthorizedPrincipal({
        userId: message.author.id,
        roleIds: getRoleIds(message.member),
        permissions: message.member?.permissions,
        owner: message.guild.ownerId === message.author.id
    }, config);
}
