// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SparkBugz
//
// Manage scoped access grants from the command line, straight against the SQLite
// store. Administrators — the server owner, anyone with Administrator, and the
// DISCORD_ADMIN_* ids — are resolved live at runtime and are never stored here.
//
// Usage:
//   npm run access -- list
//   npm run access -- add    <role|user> <id> <area,area|all> [label...]
//   npm run access -- remove <role|user> <id>

import path from "node:path";
import process from "node:process";
import dotenv from "dotenv";
import { BotStore } from "../src/store.js";
import { AREAS, AREA_KEYS, areaLabel, normalizeAreas } from "../src/access.js";

dotenv.config();

function databasePath() {
    return path.resolve(process.cwd(), process.env.DATABASE_PATH || "./data/bot.db");
}

function printUsage() {
    console.log([
        "Usage:",
        "  npm run access -- list",
        "  npm run access -- add     <role|user> <id> <area,area|all> [label...]",
        "  npm run access -- remove  <role|user> <id>",
        "  npm run access -- block   <role|user> <id>   (revoke administrator access)",
        "  npm run access -- unblock <role|user> <id>   (restore administrator access)",
        "",
        `Areas: ${AREA_KEYS.join(", ")}  (or "all")`
    ].join("\n"));
}

function subjectType(value) {
    if (value === "role" || value === "user") {
        return value;
    }

    return null;
}

const [action, ...rest] = process.argv.slice(2);

if (!action || action === "help" || action === "--help" || action === "-h") {
    printUsage();
    process.exit(0);
}

const store = new BotStore(databasePath());
let exitCode = 0;

try {
    if (action === "list") {
        const grants = store.listAccessGrants();
        const blocks = store.listAdminBlocks();

        if (grants.length === 0 && blocks.length === 0) {
            console.log("No scoped access grants or admin revocations. Administrators have full access.");
        } else {
            for (const grant of grants) {
                const areas = grant.areas.length >= AREAS.length ? "all areas" : grant.areas.map(areaLabel).join(", ");
                console.log(`grant   ${grant.subjectType.padEnd(4)} ${grant.subjectId}  ${areas}${grant.label ? `  (${grant.label})` : ""}`);
            }
            for (const block of blocks) {
                console.log(`revoked ${block.subjectType.padEnd(4)} ${block.subjectId}${block.label ? `  (${block.label})` : ""}`);
            }
        }
    } else if (action === "block" || action === "unblock") {
        const [type, id] = rest;
        const kind = subjectType(type);

        if (!kind || !/^\d{5,25}$/.test(String(id ?? ""))) {
            console.error(`${action}: expected <role|user> <id>`);
            exitCode = 1;
        } else if (action === "block") {
            store.addAdminBlock({ subjectType: kind, subjectId: id, createdBy: "cli" });
            store.recordAudit({ actorId: "cli", actorName: "cli", action: "access.admin.revoke", detail: `${kind} ${id}` });
            console.log(`Revoked administrator access for ${kind} ${id}.`);
        } else {
            const removed = store.removeAdminBlock(kind, id);
            console.log(removed ? `Restored administrator access for ${kind} ${id}.` : "No matching revocation.");
        }
    } else if (action === "add" || action === "set") {
        const [type, id, areasToken, ...labelParts] = rest;
        const kind = subjectType(type);

        if (!kind || !/^\d{5,25}$/.test(String(id ?? ""))) {
            console.error("add: expected <role|user> <id> <area,area|all> [label...]");
            exitCode = 1;
        } else {
            const areas = String(areasToken ?? "").toLowerCase() === "all" ? [...AREA_KEYS] : normalizeAreas(areasToken);

            if (areas.length === 0) {
                console.error(`No valid areas. Choose from: ${AREA_KEYS.join(", ")} — or "all".`);
                exitCode = 1;
            } else {
                const label = labelParts.join(" ").trim() || null;
                store.saveAccessGrant({ subjectType: kind, subjectId: id, areas, label, createdBy: "cli" });
                store.recordAudit({
                    actorId: "cli",
                    actorName: "cli",
                    action: "access.grant.save",
                    detail: `${kind} ${id} → ${areas.join(", ")}`
                });
                console.log(`Granted ${kind} ${id}: ${areas.map(areaLabel).join(", ")}.`);
            }
        }
    } else if (action === "remove" || action === "delete") {
        const [type, id] = rest;
        const kind = subjectType(type);

        if (!kind || !id) {
            console.error("remove: expected <role|user> <id>");
            exitCode = 1;
        } else {
            const removed = store.deleteAccessGrant(kind, id);
            console.log(removed ? `Removed ${kind} ${id}.` : "No matching grant.");
        }
    } else {
        printUsage();
        exitCode = 1;
    }
} finally {
    store.close();
}

process.exit(exitCode);
