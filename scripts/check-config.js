// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SparkBugz

import fs from "node:fs";
import dotenv from "dotenv";

dotenv.config();

const secretNames = new Set([
    "DISCORD_TOKEN",
    "DISCORD_OAUTH_CLIENT_SECRET",
    "ADMIN_SESSION_SECRET",
    "GITHUB_TOKEN"
]);

function parseCsv(value) {
    return String(value ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
}

function hasValue(name) {
    return Boolean(String(process.env[name] ?? "").trim());
}

function displayValue(name) {
    if (!hasValue(name)) {
        return "(missing)";
    }

    if (secretNames.has(name)) {
        return "(set)";
    }

    return process.env[name];
}

function checkRequired(name, errors) {
    if (!hasValue(name)) {
        errors.push(`${name} is required.`);
    }
}

function main() {
    const modules = parseCsv(process.env.BOT_MODULES || "faq,github");
    const errors = [];
    const warnings = [];

    if (!fs.existsSync(".env")) {
        warnings.push(".env is missing. Copy .env.example to .env and fill in local values.");
    }

    checkRequired("DISCORD_TOKEN", errors);
    checkRequired("DISCORD_ALLOWED_CHANNEL_IDS", errors);

    if (modules.includes("commands") || modules.includes("admin-dashboard") || modules.includes("moderation")) {
        checkRequired("DISCORD_CONTROL_GUILD_ID", errors);
    }

    if (modules.includes("moderation")) {
        checkRequired("MODERATION_CHANNEL_IDS", errors);
    }

    if (modules.includes("admin-dashboard")) {
        checkRequired("DISCORD_OAUTH_CLIENT_ID", errors);
        checkRequired("DISCORD_OAUTH_CLIENT_SECRET", errors);
        checkRequired("DISCORD_OAUTH_REDIRECT_URI", errors);
        checkRequired("ADMIN_SESSION_SECRET", errors);

        if (hasValue("ADMIN_SESSION_SECRET") && process.env.ADMIN_SESSION_SECRET.length < 32) {
            errors.push("ADMIN_SESSION_SECRET must be at least 32 characters.");
        }

        if (
            process.env.ADMIN_WEB_PROTOCOL === "http" &&
            !["127.0.0.1", "::1", "localhost"].includes(process.env.ADMIN_WEB_HOST || "127.0.0.1")
        ) {
            errors.push("HTTP admin dashboard binding is only allowed on loopback. Use HTTPS for LAN/public access.");
        }
    }

    console.log("Discord FAQ bot config check");
    console.log(`BOT_MODULES=${modules.join(",")}`);
    console.log(`DISCORD_ALLOWED_CHANNEL_IDS=${displayValue("DISCORD_ALLOWED_CHANNEL_IDS")}`);
    console.log(`DISCORD_CONTROL_GUILD_ID=${displayValue("DISCORD_CONTROL_GUILD_ID")}`);
    console.log(`ADMIN_WEB_PROTOCOL=${displayValue("ADMIN_WEB_PROTOCOL")}`);
    console.log(`ADMIN_WEB_HOST=${displayValue("ADMIN_WEB_HOST")}`);
    console.log(`ADMIN_WEB_PORT=${displayValue("ADMIN_WEB_PORT")}`);
    console.log(`ADMIN_WEB_PUBLIC_URL=${displayValue("ADMIN_WEB_PUBLIC_URL")}`);
    console.log(`DISCORD_OAUTH_CLIENT_ID=${displayValue("DISCORD_OAUTH_CLIENT_ID")}`);
    console.log(`DISCORD_OAUTH_CLIENT_SECRET=${displayValue("DISCORD_OAUTH_CLIENT_SECRET")}`);
    console.log(`ADMIN_SESSION_SECRET=${displayValue("ADMIN_SESSION_SECRET")}`);
    console.log(`MODERATION_CHANNEL_IDS=${displayValue("MODERATION_CHANNEL_IDS")}`);
    console.log(`MODERATION_DRY_RUN=${displayValue("MODERATION_DRY_RUN")}`);

    if (warnings.length > 0) {
        console.log("\nWarnings:");
        for (const warning of warnings) {
            console.log(`- ${warning}`);
        }
    }

    if (errors.length > 0) {
        console.log("\nBlocking issues:");
        for (const error of errors) {
            console.log(`- ${error}`);
        }
        process.exitCode = 1;
        return;
    }

    console.log("\nConfig shape looks usable. This does not validate Discord OAuth credentials with Discord.");
}

main();
