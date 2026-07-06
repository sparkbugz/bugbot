#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SparkBugz

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

export const MIN_NODE_VERSION = "22.5.0";

const SUPPORTED_PLATFORMS = new Set(["linux", "darwin", "win32", "freebsd"]);

function parseVersion(value) {
    return String(value ?? "")
        .replace(/^v/, "")
        .split(".")
        .map((part) => Number.parseInt(part, 10) || 0);
}

function versionAtLeast(actual, required) {
    const left = parseVersion(actual);
    const right = parseVersion(required);

    for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
        const a = left[index] ?? 0;
        const b = right[index] ?? 0;

        if (a > b) {
            return true;
        }
        if (a < b) {
            return false;
        }
    }

    return true;
}

function commandVersion(command, args = ["--version"]) {
    const result = spawnSync(command, args, { encoding: "utf8" });

    if (result.status !== 0) {
        return null;
    }

    return (result.stdout || result.stderr || "").trim().split(/\r?\n/)[0] || "present";
}

export async function checkSystemDependencies({ rootDir = process.cwd() } = {}) {
    const errors = [];
    const warnings = [];
    const info = [];
    const platform = process.platform;
    const nodeVersion = process.versions.node;

    info.push(`OS: ${os.type()} ${os.release()} (${platform}/${process.arch})`);
    info.push(`Node: ${nodeVersion}`);

    if (!SUPPORTED_PLATFORMS.has(platform)) {
        warnings.push(`This OS (${platform}) is not one of the regularly tested targets: Linux, macOS, Windows, FreeBSD.`);
    }

    if (!versionAtLeast(nodeVersion, MIN_NODE_VERSION)) {
        errors.push(`Node ${MIN_NODE_VERSION} or newer is required. Current Node is ${nodeVersion}.`);
    }

    try {
        await import("node:sqlite");
        info.push("node:sqlite: available");
    } catch {
        errors.push("node:sqlite is not available. Install a newer Node runtime; this bot uses Node's built-in SQLite engine.");
    }

    const npmVersion = commandVersion("npm");
    if (!npmVersion) {
        errors.push("npm is required to install dependencies and run package scripts.");
    } else {
        info.push(`npm: ${npmVersion}`);
    }

    const gitVersion = commandVersion("git");
    if (gitVersion) {
        info.push(`git: ${gitVersion}`);
    } else {
        warnings.push("git was not found. It is not needed at runtime, but it is needed to clone or update the repository.");
    }

    try {
        fs.accessSync(rootDir, fs.constants.R_OK | fs.constants.W_OK);
    } catch {
        errors.push(`The project directory is not readable and writable: ${path.resolve(rootDir)}`);
    }

    return { errors, warnings, info };
}

export function printSystemReport(report) {
    console.log("System check");
    console.log("------------");
    for (const line of report.info) {
        console.log(`- ${line}`);
    }

    if (report.warnings.length > 0) {
        console.log("\nWarnings:");
        for (const warning of report.warnings) {
            console.log(`- ${warning}`);
        }
    }

    if (report.errors.length > 0) {
        console.log("\nBlocking issues:");
        for (const error of report.errors) {
            console.log(`- ${error}`);
        }
    }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";

if (import.meta.url === invokedPath) {
    const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const report = await checkSystemDependencies({ rootDir });
    printSystemReport(report);
    process.exitCode = report.errors.length > 0 ? 1 : 0;
}
