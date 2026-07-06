// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SparkBugz
//
// Static-site generator for the public BugBot demo (bugbot.bugmunch.dev).
//
// It imports the *real* render functions from src/adminViews.js and feeds them
// invented data, then writes one HTML file per panel page. Because the markup
// comes from the same code the live console uses, the demo tracks the real UI
// with no parallel templates to maintain — only demo/mockData.mjs is bespoke.
//
// Post-processing makes the server-rendered pages work as flat files:
//   * a slim "live demo" ribbon is injected at the top of every page;
//   * demo.css / demo.js are linked in — the live panel ships a strict CSP with
//     no script, but the static host sends none, so a little JS is fine here. It
//     drives the theme toggle client-side and turns every form/POST into a
//     "nothing is saved" toast instead of a dead request.
//
// Output goes to demo/dist/, laid out so Cloudflare Pages' clean URLs resolve
// the panel's own links (/faq, /moderation/rules, …) with no rewrites.

import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
    renderAccess,
    renderAnalytics,
    renderAuditLog,
    renderCustomCommandEditor,
    renderCustomCommands,
    renderDashboard,
    renderEmbedComposer,
    renderFaqEditor,
    renderFaqList,
    renderGlossary,
    renderLeaderboard,
    renderLicense,
    renderLogin,
    renderModerationLog,
    renderModerationRuleEditor,
    renderModerationRules,
    renderReactionRoles,
    renderScheduled,
    renderSettings
} from "../src/adminViews.js";
import { SETTINGS_SECTIONS, SETTING_FIELD_DOCS, displayValue } from "../src/settings.js";
import { mock } from "./mockData.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const DIST = path.join(HERE, "dist");

const REPO_URL = "https://github.com/sparkbugz/bugbot";
const THEME = "auto";

// Settings sections built from the real schema + demo config, exactly as the
// live server's settingSections() does. Powers both /settings and /glossary.
function settingSections() {
    return SETTINGS_SECTIONS.map((section) => ({
        ...section,
        fields: section.fields.map((field) => ({
            ...field,
            docs: SETTING_FIELD_DOCS[field.key] ?? {},
            value: displayValue(field, mock.config)
        }))
    }));
}

const base = () => ({ theme: THEME, session: mock.session, nav: null });

// Every page: the URL path it serves at (Cloudflare Pages maps these to the
// matching .html file) and the fully-rendered document.
const pages = [
    ["/", renderDashboard({ ...base(), status: mock.status, summary: mock.dashboard.summary, recent: mock.dashboard.recent })],
    ["/analytics", renderAnalytics({ ...base(), ...mock.analytics })],
    ["/moderation", renderModerationLog({ ...base(), actions: mock.moderationActions, filter: "", undoableOnly: false })],
    ["/moderation/rules", renderModerationRules({ ...base(), globals: mock.moderationGlobals, rules: mock.moderationRules })],
    ["/moderation/rules/edit", renderModerationRuleEditor({ ...base(), rule: mock.moderationRuleEditor, isNew: false })],
    ["/faq", renderFaqList({ ...base(), entries: mock.faqEntries })],
    ["/faq/edit", renderFaqEditor({ ...base(), entry: mock.faqEditorEntry, isNew: false })],
    ["/commands", renderCustomCommands({ ...base(), commands: mock.customCommands, enabled: true })],
    ["/commands/edit", renderCustomCommandEditor({ ...base(), command: mock.customCommandEditor, isNew: false })],
    ["/embed", renderEmbedComposer({ ...base(), directory: mock.directory })],
    ["/roles", renderReactionRoles({ ...base(), mappings: mock.reactionRoles, enabled: true, directory: mock.directory })],
    ["/leveling", renderLeaderboard({ ...base(), rows: mock.leaderboard, enabled: true })],
    ["/scheduled", renderScheduled({ ...base(), tasks: mock.scheduler.tasks, announcements: mock.scheduler.announcements, directory: mock.directory })],
    ["/glossary", renderGlossary({ ...base(), sections: settingSections() })],
    ["/audit", renderAuditLog({ ...base(), entries: mock.audit })],
    ["/settings", renderSettings({ ...base(), sections: settingSections(), directory: mock.directory, status: mock.status })],
    ["/access", renderAccess({ ...base(), grants: mock.accessGrants, adminBlocks: mock.adminBlocks, directory: mock.directory })],
    ["/license", renderLicense({ ...base() })],
    ["/login", renderLogin({ theme: THEME })]
];

const RIBBON = `<div class="demo-ribbon" role="note">
    <span class="demo-ribbon__dot" aria-hidden="true"></span>
    <span class="demo-ribbon__text"><strong>Live demo</strong> — a click-around preview of the BugBot admin console. Nothing here is saved.</span>
    <a class="demo-ribbon__cta" href="${REPO_URL}">Get BugBot on GitHub →</a>
</div>`;

const HEAD_INJECT = `<link rel="stylesheet" href="/assets/demo.css"><script defer src="/assets/demo.js"></script>`;

// Turn one server-rendered document into a static page: link the demo asset
// pair into <head> and drop the ribbon in right after <body>.
function staticize(html, servePath) {
    let out = html
        .replace("</head>", `${HEAD_INJECT}</head>`)
        .replace(/<body>\s*/, `<body>\n${RIBBON}\n`);

    // On the sign-in page, "Continue with Discord" should walk into the demo
    // rather than loop back to itself.
    if (servePath === "/login") {
        out = out.replaceAll('href="/login"', 'href="/"');
    }

    return out;
}

function fileFor(servePath) {
    if (servePath === "/") {
        return "index.html";
    }
    return `${servePath.replace(/^\//, "")}.html`;
}

function build() {
    rmSync(DIST, { recursive: true, force: true });
    mkdirSync(DIST, { recursive: true });

    for (const [servePath, html] of pages) {
        const target = path.join(DIST, fileFor(servePath));
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, staticize(html, servePath));
    }

    // Assets the panel references: self-hosted fonts, the avatar/favicon, and
    // the demo-only css/js this generator adds.
    const assets = path.join(DIST, "assets");
    mkdirSync(assets, { recursive: true });
    cpSync(path.join(ROOT, "public", "fonts"), path.join(assets, "fonts"), { recursive: true });
    cpSync(path.join(ROOT, "public", "avatar.jpg"), path.join(assets, "avatar.jpg"));
    cpSync(path.join(HERE, "assets", "demo.css"), path.join(assets, "demo.css"));
    cpSync(path.join(HERE, "assets", "demo.js"), path.join(assets, "demo.js"));

    // Long-cache the fingerprint-free assets; HTML stays revalidated so a new
    // deploy shows up immediately.
    writeFileSync(path.join(DIST, "_headers"), `/assets/*\n  Cache-Control: public, max-age=86400\n`);

    console.log(`Built ${pages.length} pages → ${path.relative(process.cwd(), DIST)}`);
}

build();
