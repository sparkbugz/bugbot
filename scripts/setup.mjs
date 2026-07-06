#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SparkBugz

// Interactive first-run setup. Asks for the essentials and writes a local .env
// with chmod 600. For production, prefer your process manager or host secret
// store and keep only non-secret settings in .env.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { stdin, stdout } from "node:process";
import readline from "node:readline/promises";
import { checkSystemDependencies, printSystemReport } from "./check-system.mjs";

const rl = readline.createInterface({ input: stdin, output: stdout });
const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const envPath = path.join(projectRoot, ".env");

async function ask(question, fallback = "") {
    const suffix = fallback ? ` [${fallback}]` : "";
    const answer = (await rl.question(`${question}${suffix}: `)).trim();
    return answer || fallback;
}

async function askYesNo(question, fallback = false) {
    const answer = (await ask(`${question} (y/n)`, fallback ? "y" : "n")).toLowerCase();
    return answer.startsWith("y");
}

async function collectSecret(env, envKey, { required = false } = {}) {
    const value = await ask(`${envKey}${required ? " (required)" : " (optional, leave blank to skip)"}`);
    if (value) {
        env[envKey] = value;
    } else if (required) {
        throw new Error(`${envKey} is required.`);
    }
}

function writeEnv(env) {
    if (fs.existsSync(envPath)) {
        fs.copyFileSync(envPath, `${envPath}.bak`);
        console.log("\nExisting .env backed up to .env.bak");
    }

    const lines = Object.entries(env).map(([key, value]) => `${key}=${value}`);
    fs.writeFileSync(envPath, `${lines.join("\n")}\n`, { mode: 0o600 });
    fs.chmodSync(envPath, 0o600);
}

async function main() {
    console.log("BugBot setup\n------------");
    const systemReport = await checkSystemDependencies({ rootDir: projectRoot });
    printSystemReport(systemReport);

    if (systemReport.errors.length > 0) {
        throw new Error("Fix the blocking system issues above, then rerun setup.");
    }

    console.log("\nThis writes a local .env with chmod 600. On a hosted deployment, put secrets in the host's secret manager instead.\n");

    const env = {};

    env.BOT_NAME = await ask("Bot name (Discord presence; the admin console stays branded BugBot)", "BugBot");
    env.DISCORD_CLIENT_ID = await ask("Discord application client ID");
    env.DISCORD_ALLOWED_CHANNEL_IDS = await ask("Channel IDs to watch (comma-separated)");
    env.GITHUB_DEFAULT_REPOS = await ask("GitHub repos to follow, owner/repo (comma-separated)", "");

    const modules = ["faq", "github"];
    if (await askYesNo("Enable in-chat admin commands?", false)) {
        modules.push("commands");
    }
    if (await askYesNo("Enable support-triage command?", false)) {
        modules.push("support-triage");
    }
    const wantModeration = await askYesNo("Enable moderation (auto scam/spam ban)?", false);
    if (wantModeration) {
        modules.push("moderation");
    }
    const wantDashboard = await askYesNo("Enable the admin web console?", false);
    if (wantDashboard) {
        modules.push("admin-dashboard");
    }
    env.BOT_MODULES = modules.join(",");

    const needsGuild = modules.some((name) => ["commands", "moderation", "admin-dashboard"].includes(name));
    if (needsGuild) {
        env.DISCORD_CONTROL_GUILD_ID = await ask("Control server (guild) ID");
        env.DISCORD_ADMIN_ROLE_IDS = await ask("Admin role IDs (comma-separated, optional)", "");
    }

    if (wantModeration) {
        env.MODERATION_CHANNEL_IDS = await ask("Channels to auto-moderate (comma-separated, or * for all)");
        env.MODERATION_DRY_RUN = "true";
        console.log("  Moderation starts in dry-run. Flip MODERATION_DRY_RUN to false once you trust the rules.");
    }

    if (wantDashboard) {
        env.ADMIN_WEB_PROTOCOL = await ask("Admin web protocol (http for loopback, https for LAN)", "http");
        env.ADMIN_WEB_HOST = await ask("Admin web host", "127.0.0.1");
        env.ADMIN_WEB_PORT = await ask("Admin web port", "8787");
        env.ADMIN_WEB_PUBLIC_URL = await ask("Public URL for OAuth redirects", `${env.ADMIN_WEB_PROTOCOL}://${env.ADMIN_WEB_HOST}:${env.ADMIN_WEB_PORT}`);
        env.DISCORD_OAUTH_CLIENT_ID = env.DISCORD_CLIENT_ID;
        env.DISCORD_OAUTH_REDIRECT_URI = `${env.ADMIN_WEB_PUBLIC_URL}/oauth/callback`;
        if (env.ADMIN_WEB_PROTOCOL === "https") {
            env.ADMIN_WEB_TLS_CERT_PATH = await ask("TLS certificate path", "./certs/admin-web.crt");
            env.ADMIN_WEB_TLS_KEY_PATH = await ask("TLS key path", "./certs/admin-web.key");
        }
        // Session secret is always safe to generate.
        env.ADMIN_SESSION_SECRET = crypto.randomBytes(32).toString("base64url");
        console.log("  Generated a random ADMIN_SESSION_SECRET.");
        console.log(`  Add this redirect URI to your Discord app: ${env.DISCORD_OAUTH_REDIRECT_URI}`);
    }

    console.log("\nNow the secrets.");
    await collectSecret(env, "DISCORD_TOKEN", { required: true });
    await collectSecret(env, "GITHUB_TOKEN");
    if (wantDashboard) {
        await collectSecret(env, "DISCORD_OAUTH_CLIENT_SECRET", { required: true });
    }

    writeEnv(env);

    console.log("\nWrote .env. Next steps:");
    console.log("  npm install");
    console.log("  npm run check:config       # verify the config shape");
    console.log("");
    console.log("BugBot runs as two processes that share the database — start each on its own:");
    console.log("  npm run start:bot          # the Discord bot");

    if (wantDashboard) {
        console.log("  npm run start:panel        # the admin dashboard");
    }

    console.log("Or run both with Docker Compose:  docker compose up -d --build");
}

main()
    .catch((error) => {
        console.error("Setup failed:", error.message);
        process.exitCode = 1;
    })
    .finally(() => rl.close());
