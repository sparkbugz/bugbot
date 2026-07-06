import test from "node:test";
import assert from "node:assert/strict";
import { PermissionFlagsBits } from "discord.js";
import {
    hasDiscordPermission,
    isAuthorizedPrincipal,
    normalizePermissionName
} from "../src/auth.js";

test("normalizePermissionName accepts common admin aliases", () => {
    assert.equal(normalizePermissionName("admin"), "Administrator");
    assert.equal(normalizePermissionName("manage server"), "ManageGuild");
    assert.equal(normalizePermissionName("manage_messages"), "ManageMessages");
});

test("hasDiscordPermission checks bigint permission bitfields", () => {
    const permissions = PermissionFlagsBits.ManageMessages | PermissionFlagsBits.SendMessages;

    assert.equal(hasDiscordPermission(permissions, "ManageMessages"), true);
    assert.equal(hasDiscordPermission(permissions, "Administrator"), false);
});

test("isAuthorizedPrincipal accepts configured users, roles, and permissions", () => {
    const config = {
        adminUserIds: ["user-admin"],
        adminRoleIds: ["role-admin"],
        adminPermissionNames: ["ManageGuild"]
    };

    assert.equal(isAuthorizedPrincipal({ userId: "user-admin" }, config), true);
    assert.equal(isAuthorizedPrincipal({ userId: "other", roleIds: ["role-admin"] }, config), true);
    assert.equal(
        isAuthorizedPrincipal({
            userId: "other",
            roleIds: [],
            permissions: PermissionFlagsBits.ManageGuild
        }, config),
        true
    );
    assert.equal(isAuthorizedPrincipal({ userId: "other", roleIds: [], permissions: 0n }, config), false);
});
