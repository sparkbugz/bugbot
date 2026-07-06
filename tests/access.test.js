// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SparkBugz

import test from "node:test";
import assert from "node:assert/strict";
import { PermissionFlagsBits } from "discord.js";
import { BotStore } from "../src/store.js";
import {
    AREA_KEYS,
    ADMIN_ONLY,
    areaForPath,
    canAccessArea,
    normalizeAreas,
    resolveAccess
} from "../src/access.js";

const CONFIG = {
    adminUserIds: ["owner-user"],
    adminRoleIds: ["admin-role"],
    adminPermissionNames: ["ManageGuild"]
};

function store() {
    return new BotStore(":memory:");
}

test("normalizeAreas expands the wildcard, drops unknowns, and dedupes", () => {
    assert.deepEqual(normalizeAreas(["*"]), AREA_KEYS);
    assert.deepEqual(normalizeAreas(["moderation", "faq", "moderation", "nope"]), ["moderation", "faq"]);
    assert.deepEqual(normalizeAreas("moderation, faq"), ["moderation", "faq"]);
    assert.deepEqual(normalizeAreas([]), []);
});

test("areaForPath maps routes to areas, with baseline and admin-only cases", () => {
    assert.equal(areaForPath("/"), null);
    assert.equal(areaForPath("/glossary"), null);
    assert.equal(areaForPath("/moderation/rules/edit"), "moderation");
    assert.equal(areaForPath("/faq/save"), "faq");
    assert.equal(areaForPath("/settings"), "settings");
    assert.equal(areaForPath("/bot-control"), "settings");
    assert.equal(areaForPath("/access"), ADMIN_ONLY);
    assert.equal(areaForPath("/access/save"), ADMIN_ONLY);
});

test("resolveAccess grants administrators every area", () => {
    const byId = resolveAccess({ userId: "owner-user" }, CONFIG);
    assert.equal(byId.admin, true);
    assert.equal(byId.owner, false);
    assert.deepEqual(byId.areas, AREA_KEYS);

    const byOwnerFlag = resolveAccess({ userId: "someone", owner: true }, CONFIG);
    assert.equal(byOwnerFlag.admin, true);
    assert.equal(byOwnerFlag.owner, true);

    const byPermission = resolveAccess({ userId: "x", permissions: PermissionFlagsBits.ManageGuild }, CONFIG);
    assert.equal(byPermission.admin, true);
});

test("an owner revocation strips admin, deny-wins, but never touches the owner", () => {
    const db = store();

    // Revoke the configured admin user; they drop to whatever scoped grant they hold.
    db.addAdminBlock({ subjectType: "user", subjectId: "owner-user" });
    const revoked = resolveAccess({ userId: "owner-user" }, CONFIG, db);
    assert.equal(revoked.admin, false);
    assert.equal(revoked.authorized, false);

    db.saveAccessGrant({ subjectType: "user", subjectId: "owner-user", areas: ["faq"] });
    const demoted = resolveAccess({ userId: "owner-user" }, CONFIG, db);
    assert.equal(demoted.admin, false);
    assert.deepEqual(demoted.areas, ["faq"]);

    // Revoking a role removes admin from anyone who holds it, even via another right.
    db.addAdminBlock({ subjectType: "role", subjectId: "admin-role" });
    const byRole = resolveAccess({ userId: "member", roleIds: ["admin-role"], permissions: PermissionFlagsBits.ManageGuild }, CONFIG, db);
    assert.equal(byRole.admin, false);

    // The owner can never be revoked, whatever the blocks say.
    db.addAdminBlock({ subjectType: "user", subjectId: "the-owner" });
    const owner = resolveAccess({ userId: "the-owner", owner: true }, CONFIG, db);
    assert.equal(owner.admin, true);
    assert.equal(owner.owner, true);
});

test("store persists and lifts admin revocations", () => {
    const db = store();
    db.addAdminBlock({ subjectType: "role", subjectId: "mod-role", label: "temp", createdBy: "the-owner" });

    assert.ok(db.getAdminBlock("role", "mod-role"));
    assert.equal(db.isAdminBlocked({ roleIds: ["mod-role"] }), true);
    assert.equal(db.isAdminBlocked({ userId: "mod-role" }), false); // keyed by type
    assert.equal(db.listAdminBlocks().length, 1);

    assert.equal(db.removeAdminBlock("role", "mod-role"), true);
    assert.equal(db.getAdminBlock("role", "mod-role"), null);
    assert.equal(db.removeAdminBlock("role", "mod-role"), false);
});

test("resolveAccess unions scoped grants for a principal's user and roles", () => {
    const db = store();
    db.saveAccessGrant({ subjectType: "role", subjectId: "mod-role", areas: ["moderation", "faq"] });
    db.saveAccessGrant({ subjectType: "user", subjectId: "helper", areas: ["audit"] });

    const access = resolveAccess({ userId: "helper", roleIds: ["mod-role", "unrelated"] }, CONFIG, db);
    assert.equal(access.admin, false);
    assert.equal(access.authorized, true);
    assert.deepEqual([...access.areas].sort(), ["audit", "faq", "moderation"]);
});

test("resolveAccess denies a principal with no admin rights and no grants", () => {
    const db = store();
    const access = resolveAccess({ userId: "stranger", roleIds: ["nobody"] }, CONFIG, db);
    assert.equal(access.authorized, false);
    assert.equal(access.admin, false);
    assert.deepEqual(access.areas, []);
});

test("canAccessArea enforces admin-only, baseline, and scoped areas", () => {
    const admin = { authorized: true, admin: true, areas: [] };
    const scoped = { authorized: true, admin: false, areas: ["moderation"] };
    const nobody = { authorized: false, admin: false, areas: [] };

    assert.equal(canAccessArea(admin, ADMIN_ONLY), true);
    assert.equal(canAccessArea(admin, "settings"), true);

    assert.equal(canAccessArea(scoped, null), true);        // baseline route
    assert.equal(canAccessArea(scoped, "dashboard"), true); // baseline area
    assert.equal(canAccessArea(scoped, "moderation"), true);
    assert.equal(canAccessArea(scoped, "settings"), false);
    assert.equal(canAccessArea(scoped, ADMIN_ONLY), false);

    assert.equal(canAccessArea(nobody, null), false);
});

test("store persists, lists, and revokes access grants", () => {
    const db = store();
    db.saveAccessGrant({ subjectType: "role", subjectId: "mod-role", areas: ["moderation"], label: "Mods", createdBy: "owner-user" });

    const grant = db.getAccessGrant("role", "mod-role");
    assert.equal(grant.label, "Mods");
    assert.deepEqual(grant.areas, ["moderation"]);
    assert.equal(grant.createdBy, "owner-user");

    // Re-saving the same subject updates in place rather than duplicating.
    db.saveAccessGrant({ subjectType: "role", subjectId: "mod-role", areas: ["moderation", "faq"] });
    assert.equal(db.listAccessGrants().length, 1);
    assert.deepEqual(db.getAccessGrant("role", "mod-role").areas, ["moderation", "faq"]);

    assert.equal(db.deleteAccessGrant("role", "mod-role"), true);
    assert.equal(db.getAccessGrant("role", "mod-role"), null);
    assert.equal(db.deleteAccessGrant("role", "mod-role"), false);
});

test("grantsForPrincipal returns matching user and role grants only", () => {
    const db = store();
    db.saveAccessGrant({ subjectType: "user", subjectId: "helper", areas: ["audit"] });
    db.saveAccessGrant({ subjectType: "role", subjectId: "mod-role", areas: ["moderation"] });

    const grants = db.grantsForPrincipal({ userId: "helper", roleIds: ["mod-role", "other"] });
    assert.equal(grants.length, 2);

    const none = db.grantsForPrincipal({ userId: "stranger", roleIds: ["other"] });
    assert.equal(none.length, 0);
});
