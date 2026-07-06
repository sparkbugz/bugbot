// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SparkBugz
//
// Access control for the bot and its admin panel. Two tiers sit on top of the
// innate-admin check in auth.js:
//
//   Administrators — the server owner, anyone holding Administrator (or the
//   configured management permissions), and any id/role listed in
//   DISCORD_ADMIN_*. They get every area, the admin flag, and are the only ones
//   who can manage grants. They cannot be locked out from here.
//
//   Scoped grants — a role or user recorded in SQLite with an explicit set of
//   areas (panel pages / command groups) and nothing more. This is how you say
//   "the Mod role can touch moderation and FAQ, but not settings".

import { isAuthorizedPrincipal } from "./auth.js";

// The grantable areas, in the order the panel lists them. Each key names a panel
// page and, where relevant, a group of Discord commands. `dashboard` and
// `reference` are deliberately absent: they are baseline, shown to any
// authorized principal. Managing access is admin-only and is not grantable.
export const AREAS = [
    { key: "analytics", label: "Analytics" },
    { key: "moderation", label: "Moderation" },
    { key: "faq", label: "FAQ" },
    { key: "commands", label: "Custom commands" },
    { key: "embed", label: "Embed builder" },
    { key: "roles", label: "Reaction roles" },
    { key: "leveling", label: "Leveling" },
    { key: "scheduler", label: "Scheduler" },
    { key: "settings", label: "Settings" },
    { key: "audit", label: "Audit log" }
];

export const AREA_KEYS = AREAS.map((area) => area.key);
const AREA_KEY_SET = new Set(AREA_KEYS);
const AREA_LABELS = new Map(AREAS.map((area) => [area.key, area.label]));

// Pages any authorized principal may open regardless of their grants.
export const BASE_AREAS = ["dashboard", "reference"];

// A route requirement meaning "administrators only".
export const ADMIN_ONLY = "admin";

// The wildcard stored on a grant that means "every grantable area".
export const ALL_AREAS = "*";

export function isKnownArea(key) {
    return AREA_KEY_SET.has(key);
}

export function areaLabel(key) {
    return AREA_LABELS.get(key) ?? key;
}

// Normalizes an area list (stored JSON, a CSV string, or user input) to known
// keys. "*" expands to the full set; unknown or duplicate entries are dropped.
export function normalizeAreas(values) {
    const list = Array.isArray(values) ? values : String(values ?? "").split(/[\s,]+/);

    if (list.some((value) => String(value).trim() === ALL_AREAS)) {
        return [...AREA_KEYS];
    }

    const seen = new Set();
    const result = [];

    for (const value of list) {
        const key = String(value).trim().toLowerCase();

        if (AREA_KEY_SET.has(key) && !seen.has(key)) {
            seen.add(key);
            result.push(key);
        }
    }

    return result;
}

// The route → area map. The first matching pattern wins. A path with no match is
// baseline (dashboard, reference, license, theme, auth), open to anyone signed
// in. Bot connection controls ride along with the settings area.
const ROUTE_AREAS = [
    [/^\/access(\/|$)/, ADMIN_ONLY],
    [/^\/analytics$/, "analytics"],
    [/^\/moderation(\/|$)/, "moderation"],
    [/^\/faq(\/|$)/, "faq"],
    [/^\/commands(\/|$)/, "commands"],
    [/^\/embed(\/|$)/, "embed"],
    [/^\/roles(\/|$)/, "roles"],
    [/^\/announcements(\/|$)/, "scheduler"],
    [/^\/scheduled(\/|$)/, "scheduler"],
    [/^\/leveling$/, "leveling"],
    [/^\/audit$/, "audit"],
    [/^\/settings$/, "settings"],
    [/^\/bot-control$/, "settings"],
    [/^\/restart$/, "settings"]
];

export function areaForPath(pathname) {
    for (const [pattern, area] of ROUTE_AREAS) {
        if (pattern.test(pathname)) {
            return area;
        }
    }

    return null;
}

// Resolves a principal (from OAuth or the gateway) to its effective access:
//   { authorized, admin, owner, areas }
// The owner always gets everything and can never be revoked. Other
// administrators get every area unless the owner has revoked them, in which case
// they fall back to any scoped grant. Everyone else gets the union of the areas
// granted to their user id or role ids; with no grants they are not authorized.
export function resolveAccess(principal, config, store = null) {
    const userId = principal?.userId ?? principal?.user?.id ?? principal?.id ?? null;
    const roleIds = principal?.roleIds ?? [];

    if (principal?.owner === true) {
        return { authorized: true, admin: true, owner: true, areas: [...AREA_KEYS] };
    }

    const blocked = store?.isAdminBlocked?.({ userId, roleIds }) ?? false;

    if (isAuthorizedPrincipal(principal, config) && !blocked) {
        return { authorized: true, admin: true, owner: false, areas: [...AREA_KEYS] };
    }

    const grants = store?.grantsForPrincipal?.({ userId, roleIds }) ?? [];
    const areas = new Set();

    for (const grant of grants) {
        for (const key of normalizeAreas(grant.areas)) {
            areas.add(key);
        }
    }

    return { authorized: areas.size > 0, admin: false, owner: false, areas: [...areas] };
}

// Whether an access result may open a route requirement (from areaForPath) or a
// bare area key. Administrators pass everything; a scoped principal passes
// baseline routes and the specific areas it holds.
export function canAccessArea(access, requirement) {
    if (!access?.authorized) {
        return false;
    }

    if (access.admin) {
        return true;
    }

    if (requirement === ADMIN_ONLY) {
        return false;
    }

    if (requirement === null || requirement === undefined || BASE_AREAS.includes(requirement)) {
        return true;
    }

    return access.areas.includes(requirement);
}
