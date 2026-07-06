// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SparkBugz
//
// HTML rendering for the admin panel. Kept separate from the HTTP plumbing in
// adminServer.js so the server file stays about routing/sessions and this file
// stays about markup.
//
// Constraints that shape the design:
//   * The panel's Content-Security-Policy is `default-src 'none'` with no
//     script-src, so there is NO client-side JavaScript. Anything interactive
//     (theme switch, filters, edits) is a plain form or link that round-trips.
//     Collapsible bits use native <details>, which needs no script.
//   * Fira Sans is self-hosted and served from /assets/fonts, so nothing is
//     fetched from a third party at runtime.
//
// The look is deliberately plain: a real operations tool, not a landing page.
// Flat panels, 1px borders, small corner radius (no pills), one calm accent,
// dense tables. Light and dark are driven by CSS variables.
//
// Theme model: the default is "auto" — the page simply follows the browser's
// prefers-color-scheme, and declares `color-scheme` so browsers with forced
// dark modes don't re-darken an already dark page. The sun/moon toggle writes
// an explicit override cookie; which icon shows is decided purely in CSS from
// the *effective* theme, so the control never disagrees with what's on screen.

import { AREAS, areaLabel, canAccessArea } from "./access.js";

const THEME_MODES = new Set(["light", "dark", "auto"]);

// Footer + license constants. These are the public-facing links; the mailto is
// the contact for the commercial-support / alternative-licensing note.
const PROJECT_NAME = "BugBot";
const LICENSE_NAME = "AGPL-3.0-or-later";
const LICENSE_URL = "https://www.gnu.org/licenses/agpl-3.0.html";
const GITHUB_URL = "https://github.com/sparkbugz";
const WEBSITE_URL = "https://bugmunch.dev";
const CONTACT_EMAIL = "sparkbugz@gmail.com";

// A session that predates the access model, or a test double, is treated as a
// full administrator so nothing is hidden from it; real sessions always carry a
// resolved access result.
function accessOf(session) {
    return session?.access ?? { authorized: true, admin: true, areas: [] };
}

export function normalizeTheme(value) {
    return THEME_MODES.has(value) ? value : "auto";
}

export function escapeHtml(value) {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}

function attr(value) {
    return escapeHtml(value);
}

const FONT_FACES = [400, 500, 600, 700].map((weight) => `
@font-face {
    font-family: "Fira Sans";
    font-style: normal;
    font-weight: ${weight};
    font-display: swap;
    src: url("/assets/fonts/fira-sans-${weight}.woff2") format("woff2");
}`).join("");

// The two palettes. Dark is written once and used twice: for "auto" viewers
// whose browser prefers dark, and for the explicit dark override. The
// --tt-sun/--tt-moon variables drive which theme-toggle icon is visible, so
// the toggle always reflects the effective theme with no script.
const LIGHT_TOKENS = `
    color-scheme: light;
    --bg: #f4f5f7;
    --panel: #ffffff;
    --panel-alt: #f8f9fb;
    --text: #1b1f24;
    --muted: #656d78;
    --border: #d6dae0;
    --border-strong: #c2c8d0;
    --accent: #2a6db0;
    --accent-text: #ffffff;
    --danger: #b42318;
    --danger-border: #e0aca7;
    --ok: #1c7a4b;
    --warn: #9a6a00;
    --input-bg: #ffffff;
    --shadow: rgba(20, 24, 30, 0.06);
    --tt-sun: none;
    --tt-moon: inline-flex;`;

const DARK_TOKENS = `
    color-scheme: dark;
    --bg: #15171b;
    --panel: #1d2025;
    --panel-alt: #23272e;
    --text: #e6e8eb;
    --muted: #98a0aa;
    --border: #2f343b;
    --border-strong: #3a4048;
    --accent: #4a90d9;
    --accent-text: #0d1013;
    --danger: #f0796f;
    --danger-border: #5a3330;
    --ok: #4cc38a;
    --warn: #d6a53a;
    --input-bg: #14161a;
    --shadow: rgba(0, 0, 0, 0.3);
    --tt-sun: inline-flex;
    --tt-moon: none;`;

const BASE_CSS = `
:root {${LIGHT_TOKENS}
    --radius: 5px;
    --mono: "SFMono-Regular", "Menlo", "Consolas", monospace;
}
@media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {${DARK_TOKENS}
    }
}
:root[data-theme="dark"] {${DARK_TOKENS}
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
@media (prefers-reduced-motion: reduce) {
    html { scroll-behavior: auto; }
    * { transition: none !important; }
}
body {
    margin: 0;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    font-family: "Fira Sans", system-ui, -apple-system, sans-serif;
    font-size: 14px;
    line-height: 1.5;
    color: var(--text);
    background: var(--bg);
}
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
a:focus-visible, button:focus-visible, summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 2px; }
code, .mono { font-family: var(--mono); font-size: 12.5px; }
input, textarea, select { accent-color: var(--accent); }

.topbar {
    position: sticky;
    top: 0;
    z-index: 30;
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 14px 20px;
    padding: 9px 22px;
    min-height: 52px;
    background: var(--panel);
    border-bottom: 1px solid var(--border);
}
.brand { display: flex; align-items: center; gap: 9px; font-weight: 600; letter-spacing: 0.2px; white-space: nowrap; }
.brand img { width: 24px; height: 24px; border-radius: 5px; display: block; }
.tabs { display: flex; align-items: center; flex-wrap: wrap; gap: 2px; margin-left: 8px; min-width: 0; }
.tabs a {
    padding: 6px 11px;
    border-radius: var(--radius);
    color: var(--muted);
    font-weight: 500;
    white-space: nowrap;
}
.tabs a:hover { background: var(--panel-alt); color: var(--text); text-decoration: none; }
.tabs a.active { color: var(--text); background: var(--panel-alt); box-shadow: inset 0 -2px 0 var(--accent); }
.tabs .sep { width: 1px; height: 18px; margin: 0 7px; background: var(--border-strong); }
.spacer { flex: 1; }
.userbox { display: flex; align-items: center; flex-wrap: wrap; gap: 10px 14px; color: var(--muted); font-size: 13px; }

/* No-JS hamburger: a visually-hidden checkbox toggles the tab list on small
   screens (strict CSP means no client script). Hidden entirely on desktop, where
   the tabs render inline. */
.nav-toggle { display: none; }
.nav-burger { display: none; align-items: center; justify-content: center; width: 34px; height: 30px; border: 1px solid var(--border); border-radius: var(--radius); color: var(--muted); cursor: pointer; }
.nav-burger:hover { background: var(--panel-alt); color: var(--text); }
.nav-burger span { display: inline-flex; }
.nav-burger .i-close { display: none; }
.nav-burger svg { width: 18px; height: 18px; display: block; }

/* Header connection light: a square lamp plus the bot's name, shown on every
   page so the live gateway state is always visible. */
.botstate { display: inline-flex; align-items: center; gap: 7px; font-size: 12.5px; color: var(--muted); white-space: nowrap; }
.botstate .light { width: 9px; height: 9px; border-radius: 2px; background: var(--border-strong); flex: none; box-shadow: 0 0 0 1px var(--border) inset; }
.botstate .light.on { background: var(--ok); box-shadow: 0 0 6px color-mix(in srgb, var(--ok) 60%, transparent); }
.botstate .light.warn { background: var(--warn); }
.botstate .light.off { background: var(--danger); }
.botstate strong { color: var(--text); font-weight: 600; }
.botstate.off, .botstate.off strong, .botstate.off .state { color: var(--danger); font-weight: 700; }
.botstate.off .light.off { box-shadow: 0 0 6px color-mix(in srgb, var(--danger) 60%, transparent); }
.botoff-banner {
    margin: 0 0 18px;
    padding: 11px 14px;
    border: 1px solid var(--danger);
    border-left: 3px solid var(--danger);
    border-radius: var(--radius);
    background: color-mix(in srgb, var(--danger) 12%, var(--panel));
    color: var(--danger);
    font-weight: 600;
    font-size: 13px;
    line-height: 1.5;
}
.botoff-banner strong { color: var(--danger); font-weight: 700; }

.theme-toggle { display: inline-flex; align-items: center; gap: 7px; }
.theme-toggle .tt {
    width: 28px; height: 28px;
    align-items: center; justify-content: center;
    border: 1px solid var(--border); border-radius: var(--radius);
    color: var(--muted);
}
.theme-toggle .tt:hover { background: var(--panel-alt); color: var(--text); text-decoration: none; }
.theme-toggle .tt.to-light { display: var(--tt-sun); }
.theme-toggle .tt.to-dark { display: var(--tt-moon); }
.theme-toggle .tt svg { width: 15px; height: 15px; display: block; }
.theme-toggle .tt-auto { font-size: 11.5px; color: var(--muted); border-bottom: 1px dotted var(--border-strong); }
.theme-toggle .tt-auto:hover { color: var(--text); text-decoration: none; }

main { flex: 1 0 auto; width: 100%; max-width: 1120px; margin: 26px auto; padding: 0 22px; box-sizing: border-box; }
h1 { font-size: 21px; font-weight: 600; margin: 0 0 4px; }
h2 { font-size: 15px; font-weight: 600; margin: 0 0 12px; }
.page-head { margin: 0 0 22px; }
.page-head h1 { margin: 0 0 4px; }
.page-head .sub { margin: 0; }
.sub { color: var(--muted); margin: 0 0 22px; }

.panel {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 18px 20px;
    margin-bottom: 18px;
}
.panel > h2 { border-bottom: 1px solid var(--border); padding-bottom: 10px; margin: -2px 0 14px; }
.panel > label:first-child,
.panel > .checkbox:first-child,
.panel > .setting-field:first-child label:first-child { margin-top: 0; }
.panel-title { display: flex; align-items: baseline; gap: 6px 12px; flex-wrap: wrap; border-bottom: 1px solid var(--border); padding-bottom: 10px; margin: -2px 0 14px; }
.panel-title h2 { margin: 0; }
.panel-title p { margin: 0; color: var(--muted); font-size: 12.5px; }
.panel-title .manage { margin-left: auto; font-size: 12.5px; white-space: nowrap; }

.stat-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; margin-bottom: 18px; }
.stat { background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius); padding: 14px 16px; }
.stat .n { font-size: 24px; font-weight: 600; font-variant-numeric: tabular-nums; }
.stat .l { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.4px; }

table { width: 100%; border-collapse: collapse; font-size: 13px; }
th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--muted); font-weight: 600; padding: 8px 10px; border-bottom: 1px solid var(--border-strong); }
td { padding: 9px 10px; border-bottom: 1px solid var(--border); vertical-align: top; }
tr:last-child td { border-bottom: 0; }
tbody tr:hover { background: var(--panel-alt); }
.table-wrap { overflow-x: auto; }
.nowrap { white-space: nowrap; }
.muted { color: var(--muted); }

.tag { display: inline-block; padding: 1px 7px; border-radius: 3px; font-size: 11.5px; font-weight: 600; border: 1px solid var(--border-strong); background: var(--panel-alt); }
.tag.ban { color: var(--danger); border-color: var(--danger-border); }
.tag.kick { color: var(--warn); }
.tag.timeout { color: var(--warn); }
.tag.dry { color: var(--muted); }
.tag.undone { color: var(--muted); text-decoration: line-through; }

button, .btn {
    font: inherit;
    font-weight: 500;
    padding: 6px 13px;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    background: var(--panel);
    color: var(--text);
    cursor: pointer;
}
button:hover, .btn:hover { background: var(--panel-alt); text-decoration: none; }
button.primary, .btn.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-text); }
button.primary:hover, .btn.primary:hover { background: var(--accent); filter: brightness(1.08); }
button.danger { color: var(--danger); border-color: var(--danger-border); }
button.small, .btn.small { padding: 3px 9px; font-size: 12px; }
.actions { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
form.inline { display: inline; }

label { display: block; font-weight: 500; margin: 14px 0 5px; }
label .hint { font-weight: 400; color: var(--muted); font-size: 12px; }
input[type=text], input[type=number], textarea, select {
    width: 100%;
    font: inherit;
    padding: 7px 9px;
    color: var(--text);
    background: var(--input-bg);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
}
textarea { min-height: 90px; resize: vertical; }
input:focus, textarea:focus, select:focus { outline: 2px solid var(--accent); outline-offset: -1px; border-color: var(--accent); }
.field-row { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.checkbox { display: flex; align-items: center; gap: 8px; margin-top: 14px; }
.checkbox input { width: auto; }
.setting-field { margin-bottom: 17px; }
.setting-field:last-child { margin-bottom: 0; }
.setting-field input[type=text], .setting-field input[type=number],
.setting-field select, .setting-field textarea, .setting-field .checklist { max-width: 560px; }

details.field-more { margin-top: 6px; font-size: 12.5px; color: var(--muted); }
details.field-more summary { cursor: pointer; width: fit-content; font-size: 12px; user-select: none; }
details.field-more summary:hover { color: var(--text); }
details.field-more[open] { margin-top: 8px; padding: 8px 11px; max-width: 560px; background: var(--panel-alt); border: 1px solid var(--border); border-radius: var(--radius); }
details.field-more[open] summary { margin-bottom: 4px; }
.field-help p { margin: 3px 0; }
.field-help code {
    background: var(--panel-alt);
    border: 1px solid var(--border);
    border-radius: 3px;
    padding: 1px 4px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
}
.field-example {
    margin: 7px 0 0;
    padding: 8px 10px;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    white-space: pre-wrap;
    overflow-x: auto;
}

.flash { border: 1px solid var(--border); border-left: 3px solid var(--accent); background: var(--panel-alt); padding: 10px 14px; border-radius: var(--radius); margin-bottom: 18px; }
.flash.error { border-left-color: var(--danger); }
.filters { display: flex; gap: 8px; align-items: center; margin-bottom: 14px; flex-wrap: wrap; }
.filters a { padding: 4px 11px; border: 1px solid var(--border); border-radius: var(--radius); color: var(--muted); font-size: 13px; }
.filters a.on { background: var(--accent); border-color: var(--accent); color: var(--accent-text); }
.filters a:hover { text-decoration: none; background: var(--panel-alt); }
.filters a.on:hover { background: var(--accent); }
.empty { color: var(--muted); padding: 26px 4px; text-align: center; }
.help {
    display: inline-flex; align-items: center; justify-content: center;
    width: 15px; height: 15px; margin-left: 5px; vertical-align: middle;
    border: 1px solid var(--border-strong); border-radius: 50%;
    color: var(--muted); font-size: 10px; font-weight: 700; cursor: help; position: relative;
}
.help::after {
    content: attr(data-tip); position: absolute; left: 50%; bottom: 160%; transform: translateX(-50%);
    width: 234px; background: var(--text); color: var(--bg); padding: 8px 10px; border-radius: var(--radius);
    font-size: 12px; font-weight: 400; line-height: 1.42; text-transform: none; letter-spacing: 0;
    text-align: left; opacity: 0; pointer-events: none; transition: opacity .12s; z-index: 40;
    box-shadow: 0 4px 16px var(--shadow);
}
.help:hover::after, .help:focus::after { opacity: 1; }
.section-head { margin: 26px 0 12px; }
.section-head h2 { margin: 0; border: 0; padding: 0; }
.section-head p { margin: 3px 0 0; color: var(--muted); font-size: 13px; }
.restart-note { color: var(--warn); font-size: 11px; font-weight: 400; margin-left: 6px; }

.with-rail { display: grid; grid-template-columns: 190px minmax(0, 1fr); gap: 26px; align-items: start; }
.rail {
    position: sticky; top: 66px;
    display: flex; flex-direction: column; gap: 1px;
    font-size: 13px;
    max-height: calc(100vh - 90px); overflow-y: auto;
}
.rail a {
    display: flex; align-items: center; gap: 8px;
    padding: 5px 10px;
    color: var(--muted);
    border-left: 2px solid var(--border);
    border-radius: 0 var(--radius) var(--radius) 0;
    white-space: nowrap;
}
.rail a:hover { color: var(--text); background: var(--panel-alt); text-decoration: none; }
.rail .dot { width: 7px; height: 7px; border-radius: 1px; background: var(--border-strong); flex: none; }
.rail .dot.on { background: var(--ok); }
section[id], .panel[id] { scroll-margin-top: 74px; }
.settings-section { margin-bottom: 18px; }

.savebar {
    position: sticky; bottom: 12px; z-index: 20;
    display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px;
    padding: 12px 16px; margin-top: 20px;
    background: var(--panel);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    box-shadow: 0 -4px 18px var(--shadow), 0 2px 8px var(--shadow);
}
.savebar .muted { font-size: 12.5px; }

.conn-strip { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 18px; padding: 12px 16px; }
.conn-strip .conn-state { color: var(--muted); }
.conn-strip .conn-state strong { color: var(--text); }
.conn-strip details { font-size: 12.5px; color: var(--muted); }
.conn-strip details summary { cursor: pointer; user-select: none; }
.conn-strip details[open] { flex-basis: 100%; padding: 10px 12px; background: var(--panel-alt); border: 1px solid var(--border); border-radius: var(--radius); }
.conn-strip details p { margin: 6px 0 10px; }

.control-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(240px, 0.7fr); gap: 18px; align-items: start; }
.status-line { color: var(--muted); margin: 0 0 12px; }

.ref dl { margin: 0; }
.ref dt { font-weight: 600; margin-top: 9px; }
.ref dt:first-child { margin-top: 0; }
.ref dd { margin: 1px 0 0; color: var(--muted); }
.ref pre { margin: 10px 0 0; padding: 10px 12px; background: var(--panel-alt); border: 1px solid var(--border); border-radius: var(--radius); overflow-x: auto; white-space: pre-wrap; }
.ref p { margin: 0 0 8px; }

.chart { margin-top: 6px; }
.chart .bars { display: flex; align-items: flex-end; gap: 3px; height: 132px; padding-top: 4px; }
.chart .bar-col { flex: 1 1 0; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; height: 100%; min-width: 0; }
.chart .bar { width: 100%; max-width: 34px; background: var(--accent); border-radius: 2px 2px 0 0; min-height: 2px; }
.chart .bar.empty { background: var(--border); }
.chart .bar-x { font-size: 10px; color: var(--muted); margin-top: 5px; white-space: nowrap; }
.chart-legend { display: flex; justify-content: space-between; color: var(--muted); font-size: 12px; margin-top: 6px; }
.checklist { max-height: 210px; overflow-y: auto; border: 1px solid var(--border-strong); border-radius: var(--radius); padding: 6px 11px; background: var(--input-bg); }
.checklist label { display: flex; align-items: center; gap: 8px; margin: 5px 0; font-weight: 400; }
.checklist input { width: auto; margin: 0; }
.checklist label.unknown { color: var(--warn); }
.checklist-empty { color: var(--muted); font-size: 13px; padding: 4px 0; }
.picker-name { color: var(--muted); font-weight: 400; }
.two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }

.login-wrap { min-height: calc(100vh - 140px); display: grid; place-items: center; }
.login { width: 100%; max-width: 400px; margin: 30px auto; text-align: center; }
.login .panel { padding: 34px 30px 26px; }
.login-avatar { width: 64px; height: 64px; border-radius: 14px; border: 1px solid var(--border); margin-bottom: 12px; }
.login h1 { font-size: 22px; margin: 0 0 6px; }
.login .sub { margin-bottom: 22px; }
.btn.discord {
    display: flex; align-items: center; justify-content: center; gap: 10px;
    width: 100%; padding: 10px 14px;
    font-weight: 600;
    background: #5865f2; border-color: #5865f2; color: #ffffff;
}
.btn.discord:hover { background: #4e5bda; border-color: #4e5bda; text-decoration: none; }
.btn.discord svg { width: 20px; height: 20px; flex: none; }
.login-foot { margin: 14px 0 0; color: var(--muted); font-size: 12px; }
.login-explain { margin: 20px 0 0; padding-top: 16px; border-top: 1px solid var(--border); text-align: left; }
.login-explain p { margin: 0 0 10px; font-size: 13px; line-height: 1.55; }
.login-explain p:last-child { margin-bottom: 0; }
.login-explain strong { color: var(--text); }

.sitefoot { border-top: 1px solid var(--border); background: var(--panel); color: var(--muted); font-size: 12.5px; }
.sitefoot .inner { max-width: 1120px; margin: 0 auto; padding: 16px 22px; display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; }
.sitefoot .links { display: flex; flex-wrap: wrap; gap: 6px 16px; align-items: center; }
.sitefoot .sep { color: var(--border-strong); }
.sitefoot .note { flex-basis: 100%; margin: 0; color: var(--muted); font-size: 12px; }
.sitefoot strong { color: var(--text); font-weight: 600; }

.grant-areas { display: flex; flex-wrap: wrap; gap: 4px; }
.pill { display: inline-block; padding: 1px 7px; border-radius: 3px; font-size: 11.5px; border: 1px solid var(--border-strong); background: var(--panel-alt); }
.pill.all { border-color: var(--accent); color: var(--accent); }

@media (max-width: 960px) {
    .with-rail { grid-template-columns: 1fr; }
    .rail { position: static; flex-direction: row; flex-wrap: wrap; gap: 4px; max-height: none; margin-bottom: 6px; }
    .rail a { border: 1px solid var(--border); border-radius: var(--radius); padding: 4px 9px; }
}
@media (max-width: 860px) {
    .topbar { align-items: center; gap: 8px 12px; }
    .spacer { display: none; }
    /* Keep the checkbox in the tab order for keyboard users, but out of sight. */
    .nav-toggle { display: block; position: absolute; width: 1px; height: 1px; margin: -1px; opacity: 0; pointer-events: none; }
    .nav-burger { display: inline-flex; order: 2; margin-left: auto; }
    .nav-toggle:focus-visible ~ .nav-burger { outline: 2px solid var(--accent); outline-offset: 2px; }
    .nav-toggle:checked ~ .nav-burger .i-open { display: none; }
    .nav-toggle:checked ~ .nav-burger .i-close { display: inline-flex; }
    .tabs {
        order: 3; width: 100%; margin-left: 0;
        display: none;
        flex-direction: column; align-items: stretch; gap: 2px;
        margin-top: 4px; padding: 6px;
        border: 1px solid var(--border); border-radius: var(--radius); background: var(--panel-alt);
    }
    .nav-toggle:checked ~ .tabs { display: flex; }
    .tabs a { padding: 9px 12px; }
    .tabs a.active { box-shadow: inset 3px 0 0 var(--accent); }
    .tabs .sep { display: none; }
    .userbox { order: 4; margin-left: auto; justify-content: flex-end; }
    .control-grid { grid-template-columns: 1fr; }
}
@media (max-width: 720px) {
    main { margin: 18px auto; padding: 0 14px; }
    .two-col, .field-row { grid-template-columns: 1fr; }
    .stat-row { grid-template-columns: repeat(2, 1fr); }
    .panel { padding: 15px; }
    .tabs a { padding: 5px 9px; }
    .sitefoot .inner { padding: 14px; gap: 6px 12px; }
}
/* On narrow screens the header controls take their own row so the connection
   light and name never get squeezed against the tabs; a long bot name is
   truncated rather than allowed to overflow. */
@media (max-width: 560px) {
    .userbox { width: 100%; margin-left: 0; justify-content: space-between; }
    .userbox form.inline button { width: auto; }
    .botstate strong { display: inline-block; max-width: 44vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: bottom; }
}
@media (max-width: 460px) {
    .stat-row { grid-template-columns: 1fr; }
    button, .btn { width: 100%; text-align: center; }
    .theme-toggle .tt, .savebar button, .savebar .btn, .userbox form.inline button { width: auto; }
    .actions { width: 100%; }
    .actions form, .actions .inline { width: 100%; }
    .sitefoot .inner { flex-direction: column; align-items: flex-start; gap: 8px; }
    .sitefoot .links { gap: 6px 14px; }
}
`;

function help(tip) {
    return `<span class="help" tabindex="0" data-tip="${attr(tip)}">?</span>`;
}

const SUN_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.6v2.3M12 19.1v2.3M2.6 12h2.3M19.1 12h2.3M5.4 5.4 7 7M17 17l1.6 1.6M18.6 5.4 17 7M7 17l-1.6 1.6"/></svg>`;

const MOON_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.4 14.2A8.5 8.5 0 0 1 9.8 3.6a8.5 8.5 0 1 0 10.6 10.6Z"/></svg>`;

const BURGER_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M3 6h18M3 12h18M3 18h18"/></svg>`;

const CLOSE_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>`;

const DISCORD_ICON = `<svg viewBox="0 0 127.14 96.36" fill="currentColor" aria-hidden="true"><path d="M107.7 8.07A105.15 105.15 0 0 0 81.47 0a72.06 72.06 0 0 0-3.36 6.83 97.68 97.68 0 0 0-29.11 0A72.37 72.37 0 0 0 45.64 0a105.89 105.89 0 0 0-26.25 8.09C2.79 32.65-1.71 56.6.54 80.21a105.73 105.73 0 0 0 32.17 16.15 77.7 77.7 0 0 0 6.89-11.11 68.42 68.42 0 0 1-10.85-5.18c.91-.66 1.8-1.34 2.66-2a75.57 75.57 0 0 0 64.32 0c.87.71 1.76 1.39 2.66 2a68.68 68.68 0 0 1-10.87 5.19 77 77 0 0 0 6.89 11.1 105.25 105.25 0 0 0 32.19-16.14c2.64-27.38-4.51-51.11-18.9-72.15ZM42.45 65.69C36.18 65.69 31 60 31 53s5-12.74 11.43-12.74S54 46 53.89 53s-5.05 12.69-11.44 12.69Zm42.24 0C78.41 65.69 73.25 60 73.25 53s5-12.74 11.44-12.74S96.23 46 96.12 53s-5.04 12.69-11.43 12.69Z"/></svg>`;

// The sun/moon toggle. Both directions are rendered; CSS shows exactly the one
// that applies to the effective theme (see --tt-sun/--tt-moon in the palettes).
// While an override cookie is set, a small "auto" link offers the way back to
// following the browser.
function themeToggle(theme, returnTo) {
    const to = (mode) => `/theme?mode=${mode}&return=${encodeURIComponent(returnTo)}`;
    const reset = theme === "auto"
        ? ""
        : `<a class="tt-auto" href="${attr(to("auto"))}" title="Follow the browser's light/dark preference">auto</a>`;

    return `<span class="theme-toggle">
        <a class="tt to-dark" href="${attr(to("dark"))}" title="Switch to the dark theme" aria-label="Switch to the dark theme">${MOON_ICON}</a>
        <a class="tt to-light" href="${attr(to("light"))}" title="Switch to the light theme" aria-label="Switch to the light theme">${SUN_ICON}</a>
        ${reset}
    </span>`;
}

function navTab(href, label, active) {
    return `<a href="${attr(href)}"${active === href ? ' class="active"' : ""}>${escapeHtml(label)}</a>`;
}

function pageHead(title, sub) {
    return `<div class="page-head"><h1>${escapeHtml(title)}</h1><p class="sub">${escapeHtml(sub)}</p></div>`;
}

// Full HTML document. `session` is null on the login page (no nav / user box).
// `nav` carries which optional modules are enabled; a module that is switched
// off simply has no header link (its page stays reachable and says how to turn
// it on). Omitted flags default to visible.
export function layout({ title, theme, active, path = "/", session = null, flash = null, body, nav = null }) {
    const themeAttr = theme === "auto" ? "" : ` data-theme="${attr(theme)}"`;
    const colorScheme = theme === "auto" ? "light dark" : theme;
    const flashHtml = flash
        ? `<div class="flash${flash.error ? " error" : ""}">${escapeHtml(flash.message)}</div>`
        : "";

    // A standing banner whenever the bot is off, so it is always clear before you
    // act that Discord actions will be queued rather than run now.
    const botStatus = session?.botStatus;
    const botOff = Boolean(botStatus) && (botStatus.botProcess === "down" || botStatus.gatewayStatus === "disconnected");
    const offBanner = botOff
        ? `<div class="botoff-banner">The Discord bot is <strong>OFF</strong>. The panel stays fully usable, but actions that need Discord — unban, clear timeout, post embed, add reaction — will be <strong>queued and run automatically when the bot is back online</strong>.</div>`
        : "";

    // A tab shows only when its module is enabled AND the signed-in principal may
    // open its area. Dashboard and Reference are baseline; Access is admin-only.
    const show = { moderation: true, faq: true, commands: true, roles: true, leveling: true, ...(nav ?? {}) };
    const access = accessOf(session);
    const can = (area) => canAccessArea(access, area);
    const tabs = [
        navTab("/", "Dashboard", active),
        can("analytics") ? navTab("/analytics", "Analytics", active) : "",
        show.moderation && can("moderation") ? navTab("/moderation", "Moderation", active) : "",
        show.faq && can("faq") ? navTab("/faq", "FAQ", active) : "",
        show.commands && can("commands") ? navTab("/commands", "Custom commands", active) : "",
        can("embed") ? navTab("/embed", "Embed builder", active) : "",
        show.roles && can("roles") ? navTab("/roles", "Reaction roles", active) : "",
        show.leveling && can("leveling") ? navTab("/leveling", "Leveling", active) : "",
        can("scheduler") ? navTab("/scheduled", "Scheduler", active) : "",
        `<span class="sep"></span>`,
        navTab("/glossary", "Reference", active),
        can("audit") ? navTab("/audit", "Audit log", active) : "",
        can("settings") ? navTab("/settings", "Settings", active) : "",
        access.admin ? navTab("/access", "Access", active) : ""
    ].filter(Boolean).join("\n        ");

    const header = session
        ? `<header class="topbar">
    <span class="brand"><img src="/assets/avatar.jpg" alt=""> BugBot</span>
    <input type="checkbox" id="nav-toggle" class="nav-toggle" aria-label="Toggle navigation menu">
    <label class="nav-burger" for="nav-toggle"><span class="i-open">${BURGER_ICON}</span><span class="i-close">${CLOSE_ICON}</span></label>
    <nav class="tabs" aria-label="Primary">
        ${tabs}
    </nav>
    <span class="spacer"></span>
    <span class="userbox">
        ${botState(session.botStatus)}
        ${themeToggle(theme, path)}
        <span>${escapeHtml(session.username)}</span>
        <form class="inline" method="post" action="/logout"><input type="hidden" name="csrf" value="${attr(session.csrf)}"><button class="small" type="submit">Log out</button></form>
    </span>
</header>`
        : "";

    return `<!doctype html>
<html lang="en"${themeAttr}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="${colorScheme}">
<title>${escapeHtml(title)}</title>
<link rel="icon" href="/assets/avatar.jpg">
<style>${FONT_FACES}${BASE_CSS}</style>
</head>
<body>
${header}
<main>${offBanner}${flashHtml}${body}</main>
${siteFooter()}
</body>
</html>`;
}

// The header connection lamp: a square light coloured by the gateway state plus
// the bot's connected name, so every page shows whether the bot is live.
function botState(status) {
    if (!status) {
        return "";
    }

    const gateway = status.gatewayStatus ?? (status.connectedAs ? "connected" : "disconnected");
    const processDown = status.botProcess === "down";
    const name = processDown ? "BugBot" : (status.connectedAs ?? "BugBot");
    // "Off" is the bold-red state: the bot process is down or the gateway is
    // disconnected, so live actions will be queued. "Connecting" is a transient
    // amber state, not off.
    const off = processDown || gateway === "disconnected";
    const lamp = gateway === "connected" ? "on" : (gateway === "connecting" ? "warn" : "off");
    const label = processDown
        ? "bot off"
        : (gateway === "connected" ? "" : (gateway === "connecting" ? "connecting…" : "offline"));
    const suffix = label ? ` <span class="state">${label}</span>` : "";
    const title = `Discord gateway: ${attr(gateway)}${processDown ? " — bot process not running" : ""}`;

    return `<span class="botstate${off ? " off" : ""}" title="${title}"><span class="light ${lamp}"></span><strong>${escapeHtml(name)}</strong>${suffix}</span>`;
}

function extLink(href, label) {
    return `<a href="${attr(href)}" rel="noopener noreferrer">${escapeHtml(label)}</a>`;
}

function siteFooter() {
    return `<footer class="sitefoot"><div class="inner">
        <span><strong>${escapeHtml(PROJECT_NAME)}</strong> <span class="sep">·</span> <a href="/license">${escapeHtml(LICENSE_NAME)}</a></span>
        <span class="links">
            ${extLink(GITHUB_URL, "GitHub")}<span class="sep">·</span>
            ${extLink(WEBSITE_URL, "Website")}<span class="sep">·</span>
            ${extLink(LICENSE_URL, "License text")}<span class="sep">·</span>
            <a href="mailto:${attr(CONTACT_EMAIL)}">Contact</a>
        </span>
        <p class="note">Commercial support, custom integrations, and alternative licensing are available — <a href="mailto:${attr(CONTACT_EMAIL)}">${escapeHtml(CONTACT_EMAIL)}</a>.</p>
    </div></footer>`;
}

export function renderLogin({ theme = "auto", message = null } = {}) {
    const body = `<div class="login-wrap"><div class="login"><div class="panel">
        <img class="login-avatar" src="/assets/avatar.jpg" alt="BugBot">
        <h1>BugBot admin console</h1>
        <p class="sub">This is the control panel for the BugBot Discord bot on your server — where its FAQ answers, moderation, settings, and other features are managed.</p>
        ${message ? `<div class="flash${message.error ? " error" : ""}">${escapeHtml(message.text)}</div>` : ""}
        <a class="btn discord" href="/login">${DISCORD_ICON} Continue with Discord</a>
        <div class="login-explain">
            <p><strong>Why sign in with Discord?</strong> The panel uses Discord's own login to confirm who you are and that you belong to this server. BugBot never sees your password — Discord just tells it your account and your roles.</p>
            <p><strong>Who can get in?</strong> Only approved people can open this panel: the server owner, administrators, and any roles or members an administrator has granted access to. If you sign in and you're not approved, you'll be turned away.</p>
            <p class="muted">BugBot only reads your Discord username, the servers you are in, and your roles in this server — just enough to check your access.</p>
        </div>
        <p class="login-foot"><a href="/license">License &amp; terms</a></p>
    </div></div></div>`;

    return layout({ title: "Sign in — BugBot", theme, active: null, path: "/", session: null, body });
}

// Shown after a successful Discord sign-in when the account is not approved for
// the panel. Distinct from the sign-in page so the reason is unambiguous.
export function renderAccessDenied({ theme = "auto", username = null } = {}) {
    const who = username ? ` as <strong>${escapeHtml(username)}</strong>` : "";
    const body = `<div class="login-wrap"><div class="login"><div class="panel">
        <img class="login-avatar" src="/assets/avatar.jpg" alt="BugBot">
        <h1>Access denied</h1>
        <p class="sub">You signed in${who}, but this Discord account is not approved for the BugBot admin console.</p>
        <div class="flash error">Only the server owner, administrators, and roles or members that an administrator has approved can open this panel.</div>
        <div class="login-explain">
            <p>If you believe you should have access, ask a server administrator to grant it — to your account or to one of your roles — from the panel's Access page. Your changes take effect the next time you sign in.</p>
        </div>
        <a class="btn discord" href="/login">${DISCORD_ICON} Try a different account</a>
        <p class="login-foot"><a href="/license">License &amp; terms</a></p>
    </div></div></div>`;

    return layout({ title: "Access denied — BugBot", theme, active: null, path: "/", session: null, body });
}

function fmtTime(ms) {
    if (!ms) {
        return "—";
    }

    const diff = Date.now() - ms;
    const mins = Math.round(diff / 60000);

    if (mins < 1) {
        return "just now";
    }
    if (mins < 60) {
        return `${mins}m ago`;
    }
    if (mins < 1440) {
        return `${Math.round(mins / 60)}h ago`;
    }

    return `${Math.round(mins / 1440)}d ago`;
}

function userCell(userId, tag) {
    const name = tag ? escapeHtml(tag) : "unknown";
    return `${name}<br><span class="mono muted">${escapeHtml(userId ?? "—")}</span>`;
}

function actionTag(row) {
    if (row.undone_at) {
        return `<span class="tag undone">${escapeHtml(row.action)}</span>`;
    }

    const cls = ["ban", "kick", "timeout"].includes(row.action) ? ` ${row.action}` : "";
    const dry = row.dry_run ? ' <span class="tag dry">dry-run</span>' : "";
    return `<span class="tag${cls}">${escapeHtml(row.action)}</span>${dry}`;
}

function renderBotControls({ session, status }) {
    const gatewayStatus = status.gatewayStatus ?? (status.connectedAs ? "connected" : "disconnected");
    const processRestart = status.allowProcessRestart
        ? `<form method="post" action="/restart" class="actions">
            <input type="hidden" name="csrf" value="${attr(session.csrf)}">
            <button class="danger" type="submit">Process restart</button>
        </form>
        <p class="muted" style="margin:10px 0 0">Exits this process. Use only with systemd, Docker, PM2, or another supervisor that will start it again.</p>`
        : `<p class="muted" style="margin:0">Process restart is disabled. Set <span class="mono">ALLOW_PROCESS_RESTART=true</span> only when a supervisor will bring the bot back.</p>`;

    return `<div class="panel"><h2>Bot controls</h2>
        <p class="status-line">Discord connection: <strong>${escapeHtml(gatewayStatus)}</strong>${status.connectedAs ? ` as ${escapeHtml(status.connectedAs)}` : ""}</p>
        <form method="post" action="/bot-control" class="actions">
            <input type="hidden" name="csrf" value="${attr(session.csrf)}">
            <button type="submit" name="action" value="start">Start connection</button>
            <button type="submit" name="action" value="stop">Stop connection</button>
            <button class="primary" type="submit" name="action" value="restart">Reconnect</button>
        </form>
        <p class="muted" style="margin:10px 0 16px">These controls only connect or disconnect the Discord gateway. The admin dashboard stays online.</p>
        ${processRestart}
    </div>`;
}

// The compact version for the settings page: one strip instead of a tall panel,
// with the destructive process restart tucked behind a <details>.
function connectionStrip({ session, status }) {
    if (!status) {
        return "";
    }

    const gatewayStatus = status.gatewayStatus ?? (status.connectedAs ? "connected" : "disconnected");
    const processRestart = status.allowProcessRestart
        ? `<details>
            <summary>Process restart…</summary>
            <p>Exits this process. Use only with systemd, Docker, PM2, or another supervisor that will start it again.</p>
            <form method="post" action="/restart" class="actions">
                <input type="hidden" name="csrf" value="${attr(session.csrf)}">
                <button class="danger small" type="submit">Restart the process</button>
            </form>
        </details>`
        : "";

    return `<div class="panel conn-strip">
        <span class="conn-state">Discord connection: <strong>${escapeHtml(gatewayStatus)}</strong>${status.connectedAs ? ` as ${escapeHtml(status.connectedAs)}` : ""}</span>
        <form method="post" action="/bot-control" class="actions">
            <input type="hidden" name="csrf" value="${attr(session.csrf)}">
            <button class="small" type="submit" name="action" value="start">Start</button>
            <button class="small" type="submit" name="action" value="stop">Stop</button>
            <button class="small primary" type="submit" name="action" value="restart">Reconnect</button>
        </form>
        ${processRestart}
    </div>`;
}

export function renderDashboard({ theme, session, status, summary, recent, nav = null }) {
    const stats = `<div class="stat-row">
        <div class="stat"><div class="n">${summary.total}</div><div class="l">Actions logged</div></div>
        <div class="stat"><div class="n">${summary.last24h}</div><div class="l">Last 24 hours</div></div>
        <div class="stat"><div class="n">${summary.bans}</div><div class="l">Bans</div></div>
        <div class="stat"><div class="n">${summary.reversible}</div><div class="l">Reversible now</div></div>
    </div>`;

    const rows = recent.length
        ? recent.map((row) => `<tr>
            <td class="nowrap muted">${fmtTime(row.created_at)}</td>
            <td>${actionTag(row)}</td>
            <td>${userCell(row.target_user_id, row.target_tag)}</td>
            <td>${escapeHtml(row.reason ?? "—")}</td>
        </tr>`).join("")
        : `<tr><td colspan="4" class="empty">No moderation actions recorded yet.</td></tr>`;

    const overview = `<div class="panel"><h2>Bot status</h2><table>
        <tr><th>Connected as</th><td>${escapeHtml(status.connectedAs ?? "connecting…")}</td></tr>
        <tr><th>Modules</th><td>${escapeHtml(status.modules.join(", "))}</td></tr>
        <tr><th>Control guild</th><td class="mono">${escapeHtml(status.controlGuildId ?? "—")}</td></tr>
        <tr><th>FAQ entries</th><td>${status.faqEntries}</td></tr>
        <tr><th>Allowed channels</th><td>${status.allowedChannelIds.length}</td></tr>
        <tr><th>Moderation</th><td>${status.enableModeration ? (status.moderationDryRun ? "on (dry-run)" : "on") : "off"}</td></tr>
        <tr><th>GitHub fallback</th><td>${status.enableGlobalGitHubSearch ? "on" : "off"}</td></tr>
        <tr><th>Default repos</th><td class="mono">${escapeHtml(status.githubDefaultRepos.join(", ") || "—")}</td></tr>
    </table></div>`;

    // The connection controls belong to the settings area; a scoped principal
    // without it sees the read-only overview alone.
    const overviewBlock = canAccessArea(accessOf(session), "settings")
        ? `<div class="control-grid">${overview}${renderBotControls({ session, status })}</div>`
        : overview;

    const body = `${pageHead("Dashboard", "Live state and the most recent moderation activity.")}
        ${stats}${overviewBlock}
        <div class="panel"><h2>Recent moderation</h2><div class="table-wrap"><table>
            <thead><tr><th>When</th><th>Action</th><th>Target</th><th>Reason</th></tr></thead>
            <tbody>${rows}</tbody>
        </table></div>
        </div>`;

    return layout({ title: "Dashboard — BugBot", theme, active: "/", path: "/", session, body, nav });
}

// A no-JS bar chart: each day is a column whose filled height is scaled to the
// busiest day in the window. The full day and count ride along as a native title
// tooltip, which needs no script under the panel's strict CSP.
function barChart(series) {
    const max = series.reduce((peak, point) => Math.max(peak, point.count), 0);

    const bars = series.map((point) => {
        const height = max > 0 ? Math.max(2, Math.round((point.count / max) * 100)) : 0;
        const empty = point.count === 0 ? " empty" : "";
        const label = point.day.slice(8); // day-of-month
        return `<div class="bar-col" title="${escapeHtml(point.day)}: ${point.count}">
            <div class="bar${empty}" style="height:${height}%"></div>
            <div class="bar-x">${escapeHtml(label)}</div>
        </div>`;
    }).join("");

    const first = series[0]?.day ?? "";
    const last = series[series.length - 1]?.day ?? "";
    return `<div class="chart"><div class="bars">${bars}</div>
        <div class="chart-legend"><span>${escapeHtml(first)}</span><span>peak ${max}</span><span>${escapeHtml(last)}</span></div></div>`;
}

function topKeyTable(rows, keyHeader, emptyText) {
    const body = rows.length
        ? rows.map((row) => `<tr><td class="mono">${escapeHtml(row.key)}</td><td class="nowrap">${row.total}</td></tr>`).join("")
        : `<tr><td colspan="2" class="empty">${escapeHtml(emptyText)}</td></tr>`;

    return `<div class="table-wrap"><table>
        <thead><tr><th>${escapeHtml(keyHeader)}</th><th>Count</th></tr></thead>
        <tbody>${body}</tbody>
    </table></div>`;
}

export function renderAnalytics({ theme, session, enabled, windowDays, tiles, messages, mod, xp, faqAnswers, topFaqs, topCommands, nav = null }) {
    if (!enabled) {
        const body = `${pageHead("Analytics", "Usage trends for this server.")}
            <div class="panel"><p class="empty">No stats store is available.</p></div>`;
        return layout({ title: "Analytics — BugBot", theme, active: "/analytics", path: "/analytics", session, body, nav });
    }

    const statRow = `<div class="stat-row">
        <div class="stat"><div class="n">${tiles.messages}</div><div class="l">Messages seen</div></div>
        <div class="stat"><div class="n">${tiles.faqAnswers}</div><div class="l">FAQ answers</div></div>
        <div class="stat"><div class="n">${tiles.modActions}</div><div class="l">Mod actions</div></div>
        <div class="stat"><div class="n">${tiles.xp.toLocaleString?.() ?? tiles.xp}</div><div class="l">XP awarded</div></div>
    </div>`;

    const body = `${pageHead("Analytics", `Activity over the last ${windowDays} days (UTC). Totals in the tiles cover the same window.`)}
        ${statRow}
        <div class="panel"><h2>Messages per day</h2>${barChart(messages)}</div>
        <div class="two-col">
            <div class="panel"><h2>Moderation actions per day</h2>${barChart(mod)}</div>
            <div class="panel"><h2>FAQ answers per day</h2>${barChart(faqAnswers)}</div>
        </div>
        <div class="panel"><h2>XP awarded per day</h2>${barChart(xp)}</div>
        <div class="two-col">
            <div class="panel"><h2>Top FAQ answers</h2>${topKeyTable(topFaqs, "FAQ entry", "No FAQ answers in this window.")}</div>
            <div class="panel"><h2>Top slash commands</h2>${topKeyTable(topCommands, "Command", "No slash commands used in this window.")}</div>
        </div>`;

    return layout({ title: "Analytics — BugBot", theme, active: "/analytics", path: "/analytics", session, body, nav });
}

const MOD_FILTERS = [
    ["", "All"],
    ["ban", "Bans"],
    ["kick", "Kicks"],
    ["timeout", "Timeouts"],
    ["warn", "Warns"]
];

export function renderModerationLog({ theme, session, actions, filter, undoableOnly, nav = null }) {
    const filterLinks = MOD_FILTERS.map(([value, label]) => {
        const on = value === filter && !undoableOnly ? " on" : "";
        const qs = value ? `?action=${value}` : "";
        return `<a class="${on.trim()}" href="/moderation${qs}">${label}</a>`;
    }).join("");
    const reversibleLink = `<a class="${undoableOnly ? "on" : ""}" href="/moderation?undoable=1">Reversible</a>`;

    const rows = actions.length
        ? actions.map((row) => {
            const canUndo = row.undoable === 1 && !row.undone_at;
            const undo = canUndo
                ? `<form class="inline" method="post" action="/moderation/undo">
                        <input type="hidden" name="csrf" value="${attr(session.csrf)}">
                        <input type="hidden" name="id" value="${row.id}">
                        <button class="small danger" type="submit">Undo ${escapeHtml(row.action)}</button>
                   </form>`
                : (row.undone_at ? `<span class="muted">undone ${fmtTime(row.undone_at)}</span>` : "<span class=\"muted\">—</span>");

            return `<tr>
                <td class="nowrap muted">${fmtTime(row.created_at)}</td>
                <td>${actionTag(row)}<br><span class="muted" style="font-size:11px">${escapeHtml(row.source)}</span></td>
                <td>${userCell(row.target_user_id, row.target_tag)}</td>
                <td>${escapeHtml(row.reason ?? "—")}${row.matched ? `<br><span class="muted">${escapeHtml(row.matched)}</span>` : ""}</td>
                <td class="nowrap">${row.moderator_id ? `<span class="mono muted">${escapeHtml(row.moderator_id)}</span>` : "<span class=\"tag dry\">auto</span>"}</td>
                <td class="nowrap">${undo}</td>
            </tr>`;
        }).join("")
        : `<tr><td colspan="6" class="empty">No matching moderation actions.</td></tr>`;

    const body = `${pageHead("Moderation log", "Every action the bot took, with the reason it decided, and one-click undo for bans and timeouts.")}
        <div class="actions" style="margin-bottom:16px"><a class="btn" href="/moderation/rules">Scam &amp; spam rules</a></div>
        <div class="filters">${filterLinks}${reversibleLink}</div>
        <div class="panel" style="padding:0"><div class="table-wrap"><table>
            <thead><tr><th>When</th><th>Action</th><th>Target</th><th>Reason</th><th>By</th><th></th></tr></thead>
            <tbody>${rows}</tbody>
        </table></div></div>`;

    return layout({ title: "Moderation — BugBot", theme, active: "/moderation", path: "/moderation", session, body, nav });
}

export function renderFaqList({ theme, session, entries, testResult = null, nav = null }) {
    const rows = entries.length
        ? entries.map((entry) => {
            const triggers = [entry.question, ...(entry.questions ?? []), ...(entry.triggers ?? [])]
                .filter(Boolean).slice(0, 2).join(" · ");
            return `<tr>
                <td class="mono">${escapeHtml(entry.id)}</td>
                <td>${escapeHtml(triggers || "—")}</td>
                <td>${entry.enabled === false ? '<span class="tag dry">off</span>' : '<span class="tag">on</span>'}</td>
                <td class="nowrap actions">
                    <a class="btn small" href="/faq/edit?id=${encodeURIComponent(entry.id)}">Edit</a>
                    <form class="inline" method="post" action="/faq/delete">
                        <input type="hidden" name="csrf" value="${attr(session.csrf)}">
                        <input type="hidden" name="id" value="${attr(entry.id)}">
                        <button class="small danger" type="submit">Delete</button>
                    </form>
                </td>
            </tr>`;
        }).join("")
        : `<tr><td colspan="4" class="empty">No FAQ entries yet. Add the first one.</td></tr>`;

    const test = testResult
        ? `<div class="flash${testResult.match ? "" : " error"}">
            ${testResult.match
                ? `Matches <strong>${escapeHtml(testResult.match.id)}</strong> (score ${testResult.score.toFixed(2)}). The bot would reply.`
                : "No entry matches that message with the current threshold. The bot would stay quiet."}
           </div>`
        : "";

    const body = `${pageHead("FAQ entries", "Auto-replies the bot posts when a message matches. Changes apply immediately.")}
        <div class="actions" style="margin-bottom:16px"><a class="btn primary" href="/faq/edit">Add entry</a></div>
        <div class="panel">
            <h2>Test a message ${help("Type a message as a user would send it and see whether any entry matches, and how strongly, before you rely on it.")}</h2>
            ${test}
            <form method="post" action="/faq/test" class="actions">
                <input type="hidden" name="csrf" value="${attr(session.csrf)}">
                <input type="text" name="message" placeholder="how do I reset my password?" value="${attr(testResult?.message ?? "")}" style="flex:1">
                <button type="submit">Test</button>
            </form>
        </div>
        <div class="panel" style="padding:0"><div class="table-wrap"><table>
            <thead><tr><th>ID</th><th>Triggers</th><th>Status</th><th></th></tr></thead>
            <tbody>${rows}</tbody>
        </table></div></div>`;

    return layout({ title: "FAQ — BugBot", theme, active: "/faq", path: "/faq", session, body, nav });
}

// FAQ entries carry a rich matcher schema. Rather than build a widget per field,
// the editor exposes the common fields directly and keeps power-user options
// (regex, github search config) as newline / JSON text areas.
export function renderFaqEditor({ theme, session, entry = null, isNew = true, error = null, nav = null }) {
    const data = entry ?? {};
    const match = data.match ?? {};
    const list = (value) => (Array.isArray(value) ? value.join("\n") : (value ?? ""));
    const answer = data.answer ?? data.response?.message ?? "";
    const links = list(data.response?.links);
    const githubJson = data.github ? JSON.stringify(data.github, null, 2) : "";

    const body = `${pageHead(isNew ? "Add FAQ entry" : "Edit FAQ entry", "When a message matches the triggers below, the bot posts the answer. Changes apply immediately.")}
        ${error ? `<div class="flash error">${escapeHtml(error)}</div>` : ""}
        <form method="post" action="/faq/save"><div class="panel">
            <input type="hidden" name="csrf" value="${attr(session.csrf)}">
            <input type="hidden" name="original_id" value="${attr(data.id ?? "")}">
            <div class="field-row">
                <div><label>Entry ID ${help("A short, stable name for this entry, e.g. reset-password. Used internally and for cooldowns.")}</label>
                    <input type="text" name="id" value="${attr(data.id ?? "")}" placeholder="reset-password" required></div>
                <div><label>Reply cooldown ${help("Seconds before this entry can fire again in the same channel. Leave blank to use the global default.")}</label>
                    <input type="number" min="0" name="cooldownSeconds" value="${attr(data.cooldownSeconds ?? "")}"></div>
            </div>
            <label>Trigger phrases / questions ${help("Example ways people ask this. One per line. A message that closely matches any line triggers the answer.")}</label>
            <textarea name="phrases" placeholder="How do I reset my password?&#10;password reset not working">${escapeHtml(list([...(data.questions ?? []), data.question, ...(match.anyPhrases ?? []), ...(data.triggers ?? [])].filter(Boolean)))}</textarea>
            <label>Keywords ${help("Optional single words. If a message contains these, it counts toward a match. One per line.")}</label>
            <textarea name="keywords">${escapeHtml(list(match.anyTerms ?? data.keywords))}</textarea>
            <label>Answer ${help("The full reply the bot posts. This is one message written exactly as it should appear — not a list, so line breaks are kept as-is.")}</label>
            <textarea name="answer" rows="5" required>${escapeHtml(answer)}</textarea>
            <label>Links ${help("Optional URLs appended under the answer. One URL per line.")}</label>
            <textarea name="links" placeholder="https://github.com/owner/repo/issues/123">${escapeHtml(links)}</textarea>
            <label>GitHub lookup ${help("Optional. JSON that attaches a GitHub issue/PR. Search mode: {&quot;mode&quot;:&quot;search&quot;,&quot;repos&quot;:[&quot;owner/repo&quot;]}. Fixed link: {&quot;mode&quot;:&quot;fixed&quot;,&quot;url&quot;:&quot;https://...&quot;}.")}</label>
            <textarea name="github" class="mono">${escapeHtml(githubJson)}</textarea>
            <div class="checkbox"><input type="checkbox" id="enabled" name="enabled" value="1" ${data.enabled === false ? "" : "checked"}><label for="enabled" style="margin:0">Enabled ${help("Uncheck to keep the entry but stop it from firing.")}</label></div>
            <div class="actions" style="margin-top:18px">
                <button class="primary" type="submit">${isNew ? "Create entry" : "Save changes"}</button>
                <a class="btn" href="/faq">Cancel</a>
            </div>
        </div></form>`;

    return layout({ title: "FAQ editor — BugBot", theme, active: "/faq", path: "/faq", session, body, nav });
}

const COMMAND_MATCH_LABELS = { exact: "Exact message", starts: "Starts with", contains: "Contains" };

export function renderCustomCommands({ theme, session, commands, enabled, nav = null }) {
    const rows = commands.length
        ? commands.map((command) => `<tr>
            <td class="mono">${escapeHtml(command.trigger ?? command.id)}</td>
            <td>${escapeHtml(COMMAND_MATCH_LABELS[command.matchType] ?? "Exact message")}</td>
            <td>${escapeHtml((command.response ?? "").slice(0, 80))}${(command.response ?? "").length > 80 ? "…" : ""}</td>
            <td>${command.enabled === false ? '<span class="tag dry">off</span>' : '<span class="tag">on</span>'}</td>
            <td class="nowrap actions">
                <a class="btn small" href="/commands/edit?id=${encodeURIComponent(command.id)}">Edit</a>
                <form class="inline" method="post" action="/commands/delete">
                    <input type="hidden" name="csrf" value="${attr(session.csrf)}">
                    <input type="hidden" name="id" value="${attr(command.id)}">
                    <button class="small danger" type="submit">Delete</button>
                </form>
            </td>
        </tr>`).join("")
        : `<tr><td colspan="5" class="empty">No custom commands yet.</td></tr>`;

    const disabledNote = enabled ? "" : `<div class="flash error">Custom commands are turned off. Enable them under Settings → Commands.</div>`;

    const body = `${pageHead("Custom commands", "Exact triggers that get a fixed reply — an auto-responder, separate from the fuzzy FAQ matcher. Changes apply immediately.")}
        ${disabledNote}
        <div class="actions" style="margin-bottom:16px"><a class="btn primary" href="/commands/edit">Add command</a></div>
        <div class="panel" style="padding:0"><div class="table-wrap"><table>
            <thead><tr><th>Trigger</th><th>Match</th><th>Response</th><th>Status</th><th></th></tr></thead>
            <tbody>${rows}</tbody>
        </table></div></div>`;

    return layout({ title: "Custom commands — BugBot", theme, active: "/commands", path: "/commands", session, body, nav });
}

export function renderCustomCommandEditor({ theme, session, command = null, isNew = true, error = null, nav = null }) {
    const data = command ?? {};
    const matchType = COMMAND_MATCH_LABELS[data.matchType] ? data.matchType : "exact";
    const options = Object.entries(COMMAND_MATCH_LABELS)
        .map(([value, label]) => `<option value="${value}"${value === matchType ? " selected" : ""}>${escapeHtml(label)}</option>`).join("");

    const body = `${pageHead(isNew ? "Add command" : "Edit command", "When a message matches the trigger, the bot posts the response. Changes apply immediately.")}
        ${error ? `<div class="flash error">${escapeHtml(error)}</div>` : ""}
        <form method="post" action="/commands/save"><div class="panel">
            <input type="hidden" name="csrf" value="${attr(session.csrf)}">
            <input type="hidden" name="original_id" value="${attr(data.id ?? "")}">
            <div class="field-row">
                <div><label>Trigger ${help("The text that fires this command, e.g. !rules. Matching ignores case and surrounding spaces.")}</label>
                    <input type="text" name="trigger" value="${attr(data.trigger ?? "")}" placeholder="!rules" required></div>
                <div><label>Match ${help("Exact: the whole message equals the trigger. Starts with: the message begins with it. Contains: the trigger appears anywhere.")}</label>
                    <select name="matchType">${options}</select></div>
            </div>
            <label>ID ${help("Optional stable name. Leave blank to derive one from the trigger.")}</label>
            <input type="text" name="id" value="${attr(data.id ?? "")}" placeholder="rules">
            <label>Response ${help("Exactly what the bot posts, written as it should appear.")}</label>
            <textarea name="response" rows="5" required>${escapeHtml(data.response ?? "")}</textarea>
            <div class="checkbox"><input type="checkbox" id="cmdEnabled" name="enabled" value="1" ${data.enabled === false ? "" : "checked"}><label for="cmdEnabled" style="margin:0">Enabled</label></div>
            <div class="actions" style="margin-top:18px">
                <button class="primary" type="submit">${isNew ? "Create command" : "Save changes"}</button>
                <a class="btn" href="/commands">Cancel</a>
            </div>
        </div></form>`;

    return layout({ title: "Command editor — BugBot", theme, active: "/commands", path: "/commands", session, body, nav });
}

export function renderEmbedComposer({ theme, session, directory = EMPTY_DIRECTORY, error = null, nav = null }) {
    const channelField = directory.channels.length > 0
        ? `<select name="channel_id" required>${optionList(directory.channels, "", { prefix: "#", includeEmpty: true, emptyLabel: "— choose a channel —" })}</select>`
        : `<input type="text" name="channel_id" placeholder="123456789012345678" required>`;

    const fieldRows = [1, 2, 3].map((index) => `
        <div class="field-row">
            <div><input type="text" name="field_name_${index}" placeholder="Field ${index} title"></div>
            <div><input type="text" name="field_value_${index}" placeholder="Field ${index} value"></div>
        </div>
        <div class="checkbox"><input type="checkbox" id="field_inline_${index}" name="field_inline_${index}" value="1"><label for="field_inline_${index}" style="margin:0">Field ${index} inline</label></div>`).join("");

    const body = `${pageHead("Embed builder", "Compose a rich embed and post it to a channel. Title, description, or at least one field is required.")}
        ${error ? `<div class="flash error">${escapeHtml(error)}</div>` : ""}
        <form method="post" action="/embed/send"><div class="panel">
            <input type="hidden" name="csrf" value="${attr(session.csrf)}">
            <div class="field-row">
                <div><label>Channel</label>${channelField}</div>
                <div><label>Accent color ${help("A hex color for the left bar, e.g. #5865F2. Leave blank for none.")}</label>
                    <input type="text" name="color" placeholder="#5865F2"></div>
            </div>
            <label>Title ${help("Bold heading at the top of the embed.")}</label>
            <input type="text" name="title" placeholder="Announcement">
            <label>Title link ${help("Optional URL the title links to. Must start with http(s)://.")}</label>
            <input type="text" name="url" placeholder="https://example.com">
            <label>Description ${help("The main body. Discord markdown works here.")}</label>
            <textarea name="description" rows="4"></textarea>
            <label>Image URL ${help("Optional large image. Must start with http(s)://.")}</label>
            <input type="text" name="image_url" placeholder="https://example.com/image.png">
            <label>Footer ${help("Small text at the bottom of the embed.")}</label>
            <input type="text" name="footer" placeholder="Posted by the team">
            <div class="section-head"><h2>Fields</h2><p>Up to three name/value pairs. Leave blank to skip.</p></div>
            ${fieldRows}
            <div class="actions" style="margin-top:18px"><button class="primary" type="submit">Post embed</button></div>
        </div></form>`;

    return layout({ title: "Embed builder — BugBot", theme, active: "/embed", path: "/embed", session, body, nav });
}

function restartNote(field) {
    return field.restart ? '<span class="restart-note">restart to fully apply</span>' : "";
}

const EMPTY_DIRECTORY = { channels: [], roles: [] };

function allowedText(field) {
    if (field.docs?.format) {
        return field.docs.format;
    }

    if (field.type === "boolean") {
        return "On or off.";
    }

    if (field.type === "select") {
        return `One of: ${field.options.join(", ")}.`;
    }

    if (field.type === "list") {
        return `One ${field.itemLabel ?? "value"} per line.`;
    }

    if (field.type === "number") {
        const min = field.min !== undefined ? field.min : "-infinity";
        const max = field.max !== undefined ? field.max : "infinity";
        return `Number from ${min} to ${max}.`;
    }

    if (field.pattern) {
        return "Text matching the documented format.";
    }

    return "Text.";
}

// Per-field documentation, folded behind a native <details> so the form stays
// compact. The quick hint lives in the label's "?" tooltip; this holds the
// format, default, when it applies, and an example.
function settingHelp(field) {
    const docs = field.docs ?? {};
    const rows = [
        `<p><strong>Default:</strong> ${escapeHtml(docs.default ?? "No built-in default.")}</p>`,
        `<p><strong>Allowed:</strong> ${escapeHtml(allowedText(field))}</p>`,
        docs.options ? `<p><strong>Options:</strong> ${escapeHtml(docs.options)}</p>` : "",
        `<p><strong>Applies:</strong> ${field.restart ? "After reconnect or process restart." : "Live after saving."}</p>`,
        docs.example ? `<pre class="field-example"><code>${escapeHtml(docs.example)}</code></pre>` : ""
    ].filter(Boolean);

    return `<details class="field-more"><summary>Format &amp; default</summary><div class="field-help">${rows.join("")}</div></details>`;
}

// A <select> of directory entries. A configured value that is no longer in the
// guild is kept as a trailing "(unknown)" option so saving never silently drops it.
function optionList(items, current, { prefix = "", includeEmpty = false, emptyLabel = "— none —" } = {}) {
    const options = [];

    if (includeEmpty) {
        options.push(`<option value=""${current ? "" : " selected"}>${escapeHtml(emptyLabel)}</option>`);
    }

    let matched = false;

    for (const item of items) {
        const selected = item.id === current ? " selected" : "";
        matched = matched || Boolean(selected);
        options.push(`<option value="${attr(item.id)}"${selected}>${escapeHtml(prefix + item.name)}</option>`);
    }

    if (current && !matched) {
        options.push(`<option value="${attr(current)}" selected>${escapeHtml(current)} (unknown)</option>`);
    }

    return options.join("");
}

// A scrollable set of checkboxes sharing one field name, so the form submits every
// checked id. Configured ids missing from the guild stay checked as "(unknown)".
function checklist(name, items, currentValues, prefix) {
    const current = new Set(currentValues ?? []);
    const known = new Set(items.map((item) => item.id));

    const rows = items.map((item) => `<label><input type="checkbox" name="${attr(name)}" value="${attr(item.id)}"${current.has(item.id) ? " checked" : ""}> ${escapeHtml(prefix + item.name)}</label>`);

    for (const id of current) {
        if (!known.has(id)) {
            rows.push(`<label class="unknown"><input type="checkbox" name="${attr(name)}" value="${attr(id)}" checked> ${escapeHtml(id)} (unknown)</label>`);
        }
    }

    if (rows.length === 0) {
        return `<div class="checklist-empty">Nothing to choose from yet.</div>`;
    }

    return `<div class="checklist">${rows.join("")}</div>`;
}

function settingControl(field, directory = EMPTY_DIRECTORY) {
    const name = attr(field.key);
    const labelText = `${escapeHtml(field.label)} ${help(field.hint)}${restartNote(field)}`;
    const wrap = (control) => `<div class="setting-field">${control}${settingHelp(field)}</div>`;

    // When a field is backed by the live guild directory, offer a name picker
    // instead of a raw ID box — but only if the directory actually has entries,
    // otherwise fall through to the plain input so an offline bot still works.
    if (field.source) {
        const items = field.source === "channels" ? directory.channels : directory.roles;
        const prefix = field.source === "channels" ? "#" : "@";

        if (items.length > 0 && field.type === "list") {
            return wrap(`<label>${labelText}</label>${checklist(field.key, items, field.value ?? [], prefix)}`);
        }

        if (items.length > 0 && field.type === "text") {
            return wrap(`<label>${labelText}</label><select name="${name}">${optionList(items, field.value ?? "", { prefix, includeEmpty: field.allowEmpty !== false })}</select>`);
        }
    }

    if (field.type === "boolean") {
        return wrap(`<div class="checkbox">
            <input type="checkbox" id="${name}" name="${name}" value="1" ${field.value ? "checked" : ""}>
            <label for="${name}" style="margin:0">${labelText}</label>
        </div>`);
    }

    if (field.type === "list") {
        return wrap(`<label>${labelText}</label>
            <textarea name="${name}" class="mono" rows="4" placeholder="one ${escapeHtml(field.itemLabel ?? "value")} per line">${escapeHtml((field.value ?? []).join("\n"))}</textarea>`);
    }

    if (field.type === "textarea") {
        return wrap(`<label>${labelText}</label><textarea name="${name}" rows="3">${escapeHtml(field.value ?? "")}</textarea>`);
    }

    if (field.type === "select") {
        const options = field.options
            .map((option) => `<option${option === field.value ? " selected" : ""}>${escapeHtml(option)}</option>`)
            .join("");
        return wrap(`<label>${labelText}</label><select name="${name}">${options}</select>`);
    }

    const inputType = field.type === "number" ? "number" : "text";
    const step = field.step ? ` step="${attr(field.step)}"` : "";
    const min = field.min !== undefined ? ` min="${attr(field.min)}"` : "";
    const max = field.max !== undefined ? ` max="${attr(field.max)}"` : "";

    return wrap(`<label>${labelText}</label>
        <input type="${inputType}"${step}${min}${max} name="${name}" value="${attr(field.value)}">`);
}

function sectionAnchor(title) {
    return `section-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}`;
}

// The section's headline on/off switch, if it has one — used for the little
// state dot in the settings rail.
function sectionToggle(section) {
    return section.fields.find((field) => field.type === "boolean" && /^enable[A-Z]|Enabled$/.test(field.key)) ?? null;
}

export function renderSettings({ theme, session, sections, error = null, directory = EMPTY_DIRECTORY, status = null, nav = null }) {
    const rail = sections.map((section) => {
        const toggle = sectionToggle(section);
        const dot = toggle ? `<span class="dot${toggle.value ? " on" : ""}"></span>` : "";
        return `<a href="#${sectionAnchor(section.title)}">${dot}${escapeHtml(section.title)}</a>`;
    }).join("\n            ");

    const sectionHtml = sections.map((section) => `
            <section class="panel settings-section" id="${sectionAnchor(section.title)}">
                <div class="panel-title"><h2>${escapeHtml(section.title)}</h2><p>${escapeHtml(section.description)}</p></div>
                ${section.fields.map((field) => settingControl(field, directory)).join("")}
            </section>`).join("");

    const body = `${pageHead("Settings", "Everything here is stored in the database and applied live. Fields marked “restart to fully apply” take effect after a reconnect or restart.")}
        ${error ? `<div class="flash error">${escapeHtml(error)}</div>` : ""}
        ${connectionStrip({ session, status })}
        <div class="with-rail">
            <nav class="rail" aria-label="Settings sections">
            ${rail}
            </nav>
            <form method="post" action="/settings">
                <input type="hidden" name="csrf" value="${attr(session.csrf)}">
                ${sectionHtml}
                <div class="savebar">
                    <button class="primary" type="submit">Save all settings</button>
                    <a class="btn" href="/settings">Discard changes</a>
                    <span class="muted">One save applies every section on this page.</span>
                </div>
            </form>
        </div>`;

    return layout({ title: "Settings — BugBot", theme, active: "/settings", path: "/settings", session, body, nav });
}

function codeBlock(value) {
    return `<pre><code>${escapeHtml(value)}</code></pre>`;
}

// A concept card on the Reference page: title, an optional "open the page that
// manages this" link, and free-form content.
function refCard(id, title, manage, content) {
    const manageLink = manage ? `<a class="manage" href="${attr(manage.href)}">${escapeHtml(manage.label)} →</a>` : "";
    return `<section class="panel ref" id="${attr(id)}">
        <div class="panel-title"><h2>${escapeHtml(title)}</h2>${manageLink}</div>
        ${content}
    </section>`;
}

function settingsReference(sections) {
    return sections.map((section) => {
        const rows = section.fields.map((field) => `<tr>
            <td class="nowrap"><strong>${escapeHtml(field.label)}</strong></td>
            <td>${escapeHtml(field.docs?.format ?? allowedText(field))}</td>
            <td class="muted">${escapeHtml(field.docs?.default ?? "No built-in default.")}</td>
        </tr>`).join("");

        return `<div class="panel">
            <div class="panel-title"><h2>${escapeHtml(section.title)}</h2></div>
            <div class="table-wrap"><table>
                <thead><tr><th>Setting</th><th>Format</th><th>Default</th></tr></thead>
                <tbody>${rows}</tbody>
            </table></div>
        </div>`;
    }).join("");
}

// The Reference page (served at /glossary): what each concept means, the
// formats fields accept, worked examples, and a full settings reference.
export function renderGlossary({ theme, session, sections, nav = null }) {
    const faqSearchJson = `{
  "mode": "search",
  "repos": ["owner/repo"],
  "type": "both",
  "query": "oauth callback error",
  "minScore": 0.63
}`;
    const faqFixedJson = `{
  "mode": "fixed",
  "url": "https://github.com/owner/repo/issues/123"
}`;
    const moderationExample = `ID: scam-airdrop
Action: timeout
Reason: Crypto airdrop scam
Phrases:
free airdrop
claim your reward
Any terms:
wallet
airdrop
Timeout seconds: 86400`;
    const commandExample = `Trigger: !rules
Match: Exact message
ID: rules
Response:
Read the server rules in #rules before posting support questions.`;
    const placeholderExample = `Welcome: Welcome {mention}! You are member #{count}.
Goodbye: {user} left {server}.
Level-up: GG {mention}, you reached level {level}!`;

    const cards = [
        refCard("discord-ids", "Discord IDs", null, `
            <p>Discord IDs are snowflakes: long numeric IDs copied from Discord with Developer Mode enabled (User Settings → Advanced), then right-click → Copy ID.</p>
            <dl>
                <dt>Server ID</dt><dd>The guild the bot manages.</dd>
                <dt>Channel ID</dt><dd>A text channel the bot reads or posts to.</dd>
                <dt>Role ID</dt><dd>A role used for admin access, exemptions, auto-roles, or rewards.</dd>
                <dt>User ID</dt><dd>A specific member used for admin access or moderation exemptions.</dd>
            </dl>
            ${codeBlock("123456789012345678")}`),
        refCard("template-tags", "Template tags", { href: "/settings#section-welcome-goodbye", label: "Configure messages" }, `
            <p>Welcome, goodbye, and level-up messages replace these tags when posted.</p>
            <dl>
                <dt>{user}</dt><dd>Username or display name.</dd>
                <dt>{mention}</dt><dd>Discord mention for the member.</dd>
                <dt>{tag}</dt><dd>Username tag when available.</dd>
                <dt>{server}</dt><dd>Server name.</dd>
                <dt>{count}</dt><dd>Member count, for join/leave messages.</dd>
                <dt>{level}</dt><dd>New level, for level-up messages.</dd>
            </dl>
            ${codeBlock(placeholderExample)}`),
        refCard("faq-entries", "FAQ entries", { href: "/faq", label: "Manage entries" }, `
            <dl>
                <dt>Trigger phrases</dt><dd>Full example questions or support statements, one per line.</dd>
                <dt>Keywords</dt><dd>Optional single words that help a message match.</dd>
                <dt>Answer</dt><dd>The exact message the bot posts.</dd>
                <dt>Reply cooldown</dt><dd>Optional seconds before that FAQ can repeat in the same channel.</dd>
            </dl>
            ${codeBlock("Trigger phrases:\nHow do I reset my password?\npassword reset not working\n\nKeywords:\npassword\nreset")}`),
        refCard("custom-commands", "Custom commands", { href: "/commands", label: "Manage commands" }, `
            <p>Commands are exact responders, separate from fuzzy FAQ matching.</p>
            <dl>
                <dt>Exact</dt><dd>The whole message must equal the trigger.</dd>
                <dt>Starts with</dt><dd>The message must begin with the trigger.</dd>
                <dt>Contains</dt><dd>The trigger may appear anywhere in the message.</dd>
            </dl>
            ${codeBlock(commandExample)}`),
        refCard("moderation-rules", "Moderation rules", { href: "/moderation/rules", label: "Manage rules" }, `
            <dl>
                <dt>Phrases</dt><dd>Any listed phrase can trigger the rule.</dd>
                <dt>All terms</dt><dd>Every listed term must appear.</dd>
                <dt>Any terms</dt><dd>At least one listed term must appear.</dd>
                <dt>Regex</dt><dd>Advanced JavaScript regular expressions; keep them short and specific.</dd>
                <dt>Require URL</dt><dd>Only match messages that contain a link.</dd>
            </dl>
            ${codeBlock(moderationExample)}`),
        refCard("moderation-actions", "Moderation actions", null, `
            <p>What a rule or detector does when it matches, from mildest to strongest.</p>
            <dl>
                <dt>log</dt><dd>Records the match only.</dd>
                <dt>delete</dt><dd>Removes the message.</dd>
                <dt>warn</dt><dd>Warns the member.</dd>
                <dt>timeout</dt><dd>Temporarily mutes the member.</dd>
                <dt>kick</dt><dd>Removes the member from the server.</dd>
                <dt>ban</dt><dd>Removes the member and blocks rejoin.</dd>
            </dl>`),
        refCard("github", "GitHub repositories", { href: "/settings#section-github-search", label: "Configure search" }, `
            <p>Repository settings use owner/repo only — never a full URL.</p>
            ${codeBlock("owner/repo\nsparkbugz/bugbot")}
            <p>FAQ entries can attach a fixed GitHub URL, or search GitHub when that FAQ matches.</p>
            ${codeBlock(faqSearchJson)}
            ${codeBlock(faqFixedJson)}`),
        refCard("role-rewards", "Role rewards", { href: "/settings#section-leveling", label: "Configure leveling" }, `
            <p>Level rewards use level:roleId, one per line. The role must be below the bot's highest role.</p>
            ${codeBlock("5:123456789012345678\n10:234567890123456789")}`)
    ];

    const railItems = [
        ["discord-ids", "Discord IDs"],
        ["template-tags", "Template tags"],
        ["faq-entries", "FAQ entries"],
        ["custom-commands", "Custom commands"],
        ["moderation-rules", "Moderation rules"],
        ["moderation-actions", "Moderation actions"],
        ["github", "GitHub repositories"],
        ["role-rewards", "Role rewards"],
        ["settings-reference", "Settings reference"]
    ].map(([id, label]) => `<a href="#${id}">${escapeHtml(label)}</a>`).join("\n            ");

    const body = `${pageHead("Reference", "What each concept means, the formats fields accept, and worked examples.")}
        <div class="with-rail">
            <nav class="rail" aria-label="Reference sections">
            ${railItems}
            </nav>
            <div>
                ${cards.join("\n                ")}
                <section id="settings-reference">
                    <div class="section-head"><h2>Settings reference</h2><p>Every settings field with its accepted format and default.</p></div>
                    ${settingsReference(sections)}
                </section>
            </div>
        </div>`;

    return layout({ title: "Reference — BugBot", theme, active: "/glossary", path: "/glossary", session, body, nav });
}

// Resolves an id to "name<br>id" using the directory, falling back to the bare id.
function namedIdCell(items, id) {
    const name = items.find((item) => item.id === id)?.name;
    return name
        ? `${escapeHtml(name)}<br><span class="mono muted">${escapeHtml(id)}</span>`
        : `<span class="mono">${escapeHtml(id ?? "—")}</span>`;
}

export function renderReactionRoles({ theme, session, mappings, enabled, notice = null, directory = EMPTY_DIRECTORY, nav = null }) {
    const rows = mappings.length
        ? mappings.map((row) => `<tr>
            <td>${namedIdCell(directory.channels, row.channel_id)}</td>
            <td class="mono">${escapeHtml(row.message_id)}</td>
            <td>${escapeHtml(row.emoji)}</td>
            <td>${namedIdCell(directory.roles, row.role_id)}</td>
            <td class="nowrap">
                <form class="inline" method="post" action="/roles/delete">
                    <input type="hidden" name="csrf" value="${attr(session.csrf)}">
                    <input type="hidden" name="message_id" value="${attr(row.message_id)}">
                    <input type="hidden" name="emoji" value="${attr(row.emoji)}">
                    <button class="small danger" type="submit">Remove</button>
                </form>
            </td>
        </tr>`).join("")
        : `<tr><td colspan="5" class="empty">No reaction-role mappings yet.</td></tr>`;

    const disabledNote = enabled ? "" : `<div class="flash error">Reaction roles are turned off. Enable them under Settings → Reaction roles, then restart.</div>`;

    const channelField = directory.channels.length > 0
        ? `<select name="channel_id" required>${optionList(directory.channels, "", { prefix: "#", includeEmpty: true, emptyLabel: "— choose a channel —" })}</select>`
        : `<input type="text" name="channel_id" placeholder="123456789012345678" required>`;
    const roleField = directory.roles.length > 0
        ? `<select name="role_id" required>${optionList(directory.roles, "", { prefix: "@", includeEmpty: true, emptyLabel: "— choose a role —" })}</select>`
        : `<input type="text" name="role_id" placeholder="123456789012345678" required>`;

    const body = `${pageHead("Reaction roles", "Members react to a message to give themselves a role. Point the bot at a message, an emoji, and a role — it adds the reaction so members can click it.")}
        ${disabledNote}
        ${notice ? `<div class="flash${notice.error ? " error" : ""}">${escapeHtml(notice.text)}</div>` : ""}
        <div class="panel">
            <h2>Add a mapping ${help("Right-click a message in Discord → Copy Message ID (Developer Mode on). Paste a standard emoji, or a custom emoji ID.")}</h2>
            <form method="post" action="/roles/save">
                <input type="hidden" name="csrf" value="${attr(session.csrf)}">
                <div class="field-row">
                    <div><label>Channel ${help("The channel the message is in, so the bot can find it and add the reaction.")}</label>
                        ${channelField}</div>
                    <div><label>Message ID ${help("The message members will react to.")}</label>
                        <input type="text" name="message_id" placeholder="123456789012345678" required></div>
                </div>
                <div class="field-row">
                    <div><label>Emoji ${help("A standard emoji like ✅, or a custom emoji's numeric ID.")}</label>
                        <input type="text" name="emoji" placeholder="✅" required></div>
                    <div><label>Role ${help("The role granted while the reaction is present.")}</label>
                        ${roleField}</div>
                </div>
                <div class="actions" style="margin-top:16px"><button class="primary" type="submit">Add mapping</button></div>
            </form>
        </div>
        <div class="panel" style="padding:0"><div class="table-wrap"><table>
            <thead><tr><th>Channel</th><th>Message</th><th>Emoji</th><th>Role</th><th></th></tr></thead>
            <tbody>${rows}</tbody>
        </table></div></div>`;

    return layout({ title: "Reaction roles — BugBot", theme, active: "/roles", path: "/roles", session, body, nav });
}

export function renderLeaderboard({ theme, session, rows, enabled, nav = null }) {
    const body = rows.length
        ? rows.map((row) => `<tr>
            <td class="nowrap">#${row.rank}</td>
            <td class="mono">${escapeHtml(row.user_id)}</td>
            <td>${row.level}</td>
            <td>${row.xp.toLocaleString?.() ?? row.xp}</td>
            <td class="muted">${row.messages.toLocaleString?.() ?? row.messages}</td>
        </tr>`).join("")
        : `<tr><td colspan="5" class="empty">${enabled ? "No XP earned yet." : "Leveling is turned off. Enable it under Settings → Leveling."}</td></tr>`;

    const content = `${pageHead("Leveling", "Top members by XP. Members earn XP by chatting; configure it under Settings → Leveling.")}
        <div class="panel" style="padding:0"><div class="table-wrap"><table>
            <thead><tr><th>Rank</th><th>User</th><th>Level</th><th>XP</th><th>Messages</th></tr></thead>
            <tbody>${body}</tbody>
        </table></div></div>`;

    return layout({ title: "Leveling — BugBot", theme, active: "/leveling", path: "/leveling", session, body: content, nav });
}

const TASK_LABELS = {
    unban: "Temp-ban expiry",
    role_remove: "Temp-role removal",
    announcement: "Announcement",
    giveaway_end: "Giveaway draw"
};

// Relative time that reads correctly for a future run_at as well as a past one.
function fmtRelative(ms) {
    if (!ms) {
        return "—";
    }

    const diff = ms - Date.now();
    const mins = Math.round(Math.abs(diff) / 60000);
    const unit = mins < 60 ? `${mins}m` : (mins < 1440 ? `${Math.round(mins / 60)}h` : `${Math.round(mins / 1440)}d`);

    if (mins < 1) {
        return diff >= 0 ? "any moment" : "now";
    }

    return diff >= 0 ? `in ${unit}` : `${unit} ago`;
}

const ANNOUNCE_INTERVALS = { 0: "One time", 3600: "Hourly", 86400: "Daily", 604800: "Weekly" };

function intervalLabel(seconds) {
    return ANNOUNCE_INTERVALS[seconds] ?? `every ${seconds}s`;
}

export function renderScheduled({ theme, session, tasks, announcements = [], directory = EMPTY_DIRECTORY, nav = null }) {
    const taskRows = tasks.length
        ? tasks.map((task) => `<tr>
            <td>${escapeHtml(TASK_LABELS[task.type] ?? task.type)}</td>
            <td class="nowrap">${escapeHtml(fmtRelative(task.run_at))}</td>
            <td>${escapeHtml(task.label ?? "—")}</td>
            <td class="nowrap">
                <form class="inline" method="post" action="/scheduled/cancel">
                    <input type="hidden" name="csrf" value="${attr(session.csrf)}">
                    <input type="hidden" name="id" value="${attr(task.id)}">
                    <button class="small danger" type="submit">Cancel</button>
                </form>
            </td>
        </tr>`).join("")
        : `<tr><td colspan="4" class="empty">Nothing scheduled. Temp-bans, temp-roles, and giveaway draws show up here.</td></tr>`;

    const announcementRows = announcements.length
        ? announcements.map((row) => `<tr>
            <td>${namedIdCell(directory.channels, row.channel_id)}</td>
            <td>${escapeHtml((row.message ?? "").slice(0, 70))}${(row.message ?? "").length > 70 ? "…" : ""}</td>
            <td class="nowrap">${escapeHtml(intervalLabel(row.interval_seconds))}</td>
            <td class="nowrap">${row.enabled ? escapeHtml(fmtRelative(row.next_run)) : '<span class="tag dry">off</span>'}</td>
            <td class="nowrap actions">
                <form class="inline" method="post" action="/announcements/toggle">
                    <input type="hidden" name="csrf" value="${attr(session.csrf)}">
                    <input type="hidden" name="id" value="${attr(row.id)}">
                    <input type="hidden" name="enabled" value="${row.enabled ? "0" : "1"}">
                    <button class="small" type="submit">${row.enabled ? "Pause" : "Resume"}</button>
                </form>
                <form class="inline" method="post" action="/announcements/delete">
                    <input type="hidden" name="csrf" value="${attr(session.csrf)}">
                    <input type="hidden" name="id" value="${attr(row.id)}">
                    <button class="small danger" type="submit">Delete</button>
                </form>
            </td>
        </tr>`).join("")
        : `<tr><td colspan="5" class="empty">No announcements yet.</td></tr>`;

    const channelField = directory.channels.length > 0
        ? `<select name="channel_id" required>${optionList(directory.channels, "", { prefix: "#", includeEmpty: true, emptyLabel: "— choose a channel —" })}</select>`
        : `<input type="text" name="channel_id" placeholder="123456789012345678" required>`;

    const repeatOptions = Object.entries(ANNOUNCE_INTERVALS)
        .map(([seconds, label]) => `<option value="${seconds}">${escapeHtml(label)}</option>`).join("");

    const body = `${pageHead("Scheduler", "Recurring announcements plus timed actions the bot will run — temp-ban and temp-role expiries and giveaway draws.")}
        <div class="panel">
            <h2>New announcement ${help("The bot posts this message to the channel. Set how long until the first post and whether it repeats.")}</h2>
            <form method="post" action="/announcements/create">
                <input type="hidden" name="csrf" value="${attr(session.csrf)}">
                <div class="field-row">
                    <div><label>Channel</label>${channelField}</div>
                    <div><label>Repeat ${help("One time posts once. Otherwise it reposts on this cadence until you pause or delete it.")}</label>
                        <select name="repeat">${repeatOptions}</select></div>
                </div>
                <label>First post after ${help("Delay before the first post, e.g. 10m, 1h, 1d. Leave blank to post at the next check.")}</label>
                <input type="text" name="delay" placeholder="1h">
                <label>Message</label>
                <textarea name="message" rows="3" required></textarea>
                <div class="actions" style="margin-top:16px"><button class="primary" type="submit">Schedule announcement</button></div>
            </form>
        </div>
        <div class="section-head"><h2>Announcements</h2><p>Recurring and one-time posts.</p></div>
        <div class="panel" style="padding:0"><div class="table-wrap"><table>
            <thead><tr><th>Channel</th><th>Message</th><th>Cadence</th><th>Next</th><th></th></tr></thead>
            <tbody>${announcementRows}</tbody>
        </table></div></div>
        <div class="section-head"><h2>Timed actions</h2><p>Expiries and draws. Cancel anything before it fires.</p></div>
        <div class="panel" style="padding:0"><div class="table-wrap"><table>
            <thead><tr><th>Type</th><th>When</th><th>Detail</th><th></th></tr></thead>
            <tbody>${taskRows}</tbody>
        </table></div></div>`;

    return layout({ title: "Scheduler — BugBot", theme, active: "/scheduled", path: "/scheduled", session, body, nav });
}

export function renderAuditLog({ theme, session, entries, nav = null }) {
    const rows = entries.length
        ? entries.map((row) => `<tr>
            <td class="nowrap muted">${fmtTime(row.created_at)}</td>
            <td>${escapeHtml(row.actor_name ?? row.actor_id ?? "—")}</td>
            <td><code>${escapeHtml(row.action)}</code></td>
            <td>${escapeHtml(row.detail ?? "—")}</td>
        </tr>`).join("")
        : `<tr><td colspan="4" class="empty">No admin activity recorded yet.</td></tr>`;

    const body = `${pageHead("Audit log", "A record of every change made from this console — who did it, and what.")}
        <div class="panel" style="padding:0"><div class="table-wrap"><table>
            <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Detail</th></tr></thead>
            <tbody>${rows}</tbody>
        </table></div></div>`;

    return layout({ title: "Audit log — BugBot", theme, active: "/audit", path: "/audit", session, body, nav });
}

// The access page (admin only): who, beyond administrators, may reach which
// areas. Administrators — the server owner, anyone holding Administrator, and
// the DISCORD_ADMIN_* ids — always have full access and are never listed here.
export function renderAccess({ theme, session, grants, adminBlocks = [], editing = null, directory = EMPTY_DIRECTORY, nav = null }) {
    const roleName = (id) => directory.roles.find((role) => role.id === id)?.name;
    const subjectCell = (type, id) => (type === "role"
        ? (roleName(id)
            ? `@${escapeHtml(roleName(id))}<br><span class="mono muted">${escapeHtml(id)}</span>`
            : `<span class="mono">role ${escapeHtml(id)}</span>`)
        : `<span class="mono">user ${escapeHtml(id)}</span>`);

    const grantRows = grants.length
        ? grants.map((grant) => {
            const subject = subjectCell(grant.subjectType, grant.subjectId);

            const areaPills = grant.areas.length >= AREAS.length
                ? `<span class="pill all">All areas</span>`
                : `<div class="grant-areas">${grant.areas.map((key) => `<span class="pill">${escapeHtml(areaLabel(key))}</span>`).join("")}</div>`;

            return `<tr>
                <td>${subject}</td>
                <td>${areaPills}${grant.label ? `<br><span class="muted">${escapeHtml(grant.label)}</span>` : ""}</td>
                <td class="nowrap muted">${grant.createdBy ? `<span class="mono">${escapeHtml(grant.createdBy)}</span>` : "—"}</td>
                <td class="nowrap actions">
                    <a class="btn small" href="/access?edit=${encodeURIComponent(`${grant.subjectType}:${grant.subjectId}`)}">Edit</a>
                    <form class="inline" method="post" action="/access/delete">
                        <input type="hidden" name="csrf" value="${attr(session.csrf)}">
                        <input type="hidden" name="subject_type" value="${attr(grant.subjectType)}">
                        <input type="hidden" name="subject_id" value="${attr(grant.subjectId)}">
                        <button class="small danger" type="submit">Remove</button>
                    </form>
                </td>
            </tr>`;
        }).join("")
        : `<tr><td colspan="4" class="empty">No scoped grants yet. Administrators already have full access.</td></tr>`;

    const editingType = editing?.subjectType ?? "role";
    const editingAreas = new Set(editing?.areas ?? []);
    const typeOptions = [["role", "Role"], ["user", "User"]]
        .map(([value, label]) => `<option value="${value}"${value === editingType ? " selected" : ""}>${label}</option>`).join("");
    const roleField = directory.roles.length > 0
        ? `<select name="role_id">${optionList(directory.roles, editingType === "role" ? (editing?.subjectId ?? "") : "", { prefix: "@", includeEmpty: true, emptyLabel: "— choose a role —" })}</select>`
        : `<input type="text" name="role_id" placeholder="123456789012345678">`;
    const userValue = editingType === "user" ? (editing?.subjectId ?? "") : "";
    const areaChecklist = AREAS
        .map((area) => `<label><input type="checkbox" name="areas" value="${attr(area.key)}"${editingAreas.has(area.key) ? " checked" : ""}> ${escapeHtml(area.label)}</label>`)
        .join("");

    const form = `<form method="post" action="/access/save"><div class="panel">
        <input type="hidden" name="csrf" value="${attr(session.csrf)}">
        <div class="field-row">
            <div><label>Subject type ${help("Role grants apply to everyone with that Discord role. User grants apply to a single member.")}</label>
                <select name="subject_type">${typeOptions}</select></div>
            <div><label>Label ${help("Optional note shown in the list below, e.g. Support mods.")}</label>
                <input type="text" name="label" value="${attr(editing?.label ?? "")}" placeholder="Support mods"></div>
        </div>
        <div class="field-row">
            <div><label>Role ${help("Used when the subject type is Role.")}</label>${roleField}</div>
            <div><label>User ID ${help("Used when the subject type is User. Paste a Discord user ID.")}</label>
                <input type="text" name="user_id" value="${attr(userValue)}" placeholder="123456789012345678"></div>
        </div>
        <label>Areas ${help("The panel pages and command groups this role or user may use. Everything left unchecked stays blocked.")}</label>
        <div class="checklist">${areaChecklist}</div>
        <div class="actions" style="margin-top:18px">
            <button class="primary" type="submit">${editing ? "Update grant" : "Add grant"}</button>
            ${editing ? `<a class="btn" href="/access">Cancel</a>` : ""}
        </div>
    </div></form>`;

    // Revoking an administrator is the owner's alone. Non-owner admins never see
    // this section.
    const ownerSection = accessOf(session).owner ? renderAdminRevocations({ session, adminBlocks, directory, subjectCell }) : "";

    const body = `${pageHead("Access", "Give roles or members scoped access to this console and the bot's commands. The server owner, anyone with Administrator, and configured admin IDs have full access; only the owner can revoke an administrator.")}
        <div class="section-head"><h2>${editing ? "Edit grant" : "Add a grant"}</h2><p>Choose a role or user, then the exact areas they may use.</p></div>
        ${form}
        <div class="section-head"><h2>Current grants</h2><p>Scoped access recorded in the database. Remove a grant to revoke it right away.</p></div>
        <div class="panel" style="padding:0"><div class="table-wrap"><table>
            <thead><tr><th>Subject</th><th>Areas</th><th>Added by</th><th></th></tr></thead>
            <tbody>${grantRows}</tbody>
        </table></div></div>
        ${ownerSection}`;

    return layout({ title: "Access — BugBot", theme, active: "/access", path: "/access", session, body, nav });
}

// The owner-only "Administrators" block: revoke a role or member's admin access
// and see (and lift) current revocations.
function renderAdminRevocations({ session, adminBlocks, directory, subjectCell }) {
    const blockRows = adminBlocks.length
        ? adminBlocks.map((block) => `<tr>
            <td>${subjectCell(block.subjectType, block.subjectId)}${block.label ? `<br><span class="muted">${escapeHtml(block.label)}</span>` : ""}</td>
            <td class="nowrap muted">${block.createdBy ? `<span class="mono">${escapeHtml(block.createdBy)}</span>` : "—"}</td>
            <td class="nowrap actions">
                <form class="inline" method="post" action="/access/admin-unblock">
                    <input type="hidden" name="csrf" value="${attr(session.csrf)}">
                    <input type="hidden" name="subject_type" value="${attr(block.subjectType)}">
                    <input type="hidden" name="subject_id" value="${attr(block.subjectId)}">
                    <button class="small" type="submit">Restore admin</button>
                </form>
            </td>
        </tr>`).join("")
        : `<tr><td colspan="3" class="empty">No administrators are revoked.</td></tr>`;

    const roleField = directory.roles.length > 0
        ? `<select name="role_id">${optionList(directory.roles, "", { prefix: "@", includeEmpty: true, emptyLabel: "— choose a role —" })}</select>`
        : `<input type="text" name="role_id" placeholder="123456789012345678">`;

    return `<div class="section-head"><h2>Administrators</h2><p>As the owner you can revoke a role or member's administrator access — they keep only any scoped grant above, or lose access entirely. You can never be revoked.</p></div>
        <form method="post" action="/access/admin-block"><div class="panel">
            <input type="hidden" name="csrf" value="${attr(session.csrf)}">
            <div class="field-row">
                <div><label>Subject type ${help("Revoke a whole role, or a single member.")}</label>
                    <select name="subject_type"><option value="role">Role</option><option value="user">User</option></select></div>
                <div><label>Label ${help("Optional note, e.g. why admin was revoked.")}</label>
                    <input type="text" name="label" placeholder="Stepped down"></div>
            </div>
            <div class="field-row">
                <div><label>Role</label>${roleField}</div>
                <div><label>User ID</label><input type="text" name="user_id" placeholder="123456789012345678"></div>
            </div>
            <div class="actions" style="margin-top:18px"><button class="danger" type="submit">Revoke admin</button></div>
        </div></form>
        <div class="panel" style="padding:0"><div class="table-wrap"><table>
            <thead><tr><th>Revoked</th><th>By</th><th></th></tr></thead>
            <tbody>${blockRows}</tbody>
        </table></div></div>`;
}

export function renderLicense({ theme, session = null, nav = null }) {
    const body = `${pageHead("License", "How BugBot is licensed, and how to reach the author about anything the license does not cover.")}
        <section class="panel ref">
            <div class="panel-title"><h2>${escapeHtml(PROJECT_NAME)}</h2></div>
            <p>Copyright © 2026 SparkBugz.</p>
            <p>${escapeHtml(PROJECT_NAME)} is free software: you can redistribute it and change it under the terms of the <strong>GNU Affero General Public License</strong> as published by the Free Software Foundation, either version 3 of the License or (at your option) any later version (${escapeHtml(LICENSE_NAME)}).</p>
            <p>It is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.</p>
            <p>Under the AGPL, if you run a modified version to offer a network service, you must make the modified source available to that service's users.</p>
            <p>${extLink(LICENSE_URL, "Read the full license text")} <span class="sep">·</span> the complete terms also ship in the LICENSE file alongside the source.</p>
        </section>
        <section class="panel ref">
            <div class="panel-title"><h2>Commercial &amp; alternative licensing</h2></div>
            <p>Commercial support, custom integrations, and alternative (non-AGPL) licensing are available. If the AGPL does not fit how you want to use ${escapeHtml(PROJECT_NAME)}, get in touch and we can work something out.</p>
            <p>Contact <a href="mailto:${attr(CONTACT_EMAIL)}">${escapeHtml(CONTACT_EMAIL)}</a> <span class="sep">·</span> ${extLink(GITHUB_URL, "GitHub")} <span class="sep">·</span> ${extLink(WEBSITE_URL, "bugmunch.dev")}</p>
        </section>`;

    return layout({ title: "License — BugBot", theme, active: null, path: "/license", session, body, nav });
}

// Scam heuristics that are not individual phrase rules: blocked domains, the
// action taken for each built-in detector, and the mention-spam cap.
const MODERATION_GLOBALS = [
    { key: "blockedDomains", label: "Blocked domains", type: "list", hint: "Links to any of these domains (or subdomains) are removed and actioned. One per line." },
    { key: "maxMentions", label: "Mention-spam limit", type: "number", hint: "A message with this many mentions or more is treated as spam. 0 disables the check." },
    { key: "blockedDomainAction", label: "Blocked domain action", type: "action", hint: "What to do when a blocked domain is posted." },
    { key: "lookalikeDomainAction", label: "Discord/Nitro lookalike action", type: "action", hint: "For fake Discord/Nitro links paired with scam language." },
    { key: "walletScamAction", label: "Wallet/seed-phrase action", type: "action", hint: "For wallet-drain and seed-phrase bait with a link." },
    { key: "riskyTldAction", label: "Risky TLD action", type: "action", hint: "For risky top-level domains paired with scam terms." },
    { key: "mentionSpamAction", label: "Mention-spam action", type: "action", hint: "When the mention limit above is hit." }
];
const MODERATION_ACTIONS = ["log", "delete", "warn", "timeout", "kick", "ban"];

export function renderModerationRules({ theme, session, globals, rules, nav = null }) {
    const globalControls = MODERATION_GLOBALS.map((field) => {
        const value = globals[field.key];
        const labelText = `${escapeHtml(field.label)} ${help(field.hint)}`;

        if (field.type === "list") {
            return `<label>${labelText}</label><textarea name="${attr(field.key)}" class="mono" rows="3">${escapeHtml((value ?? []).join("\n"))}</textarea>`;
        }
        if (field.type === "action") {
            const options = MODERATION_ACTIONS
                .map((action) => `<option${action === (value ?? "ban") ? " selected" : ""}>${action}</option>`).join("");
            return `<label>${labelText}</label><select name="${attr(field.key)}">${options}</select>`;
        }
        return `<label>${labelText}</label><input type="number" min="0" name="${attr(field.key)}" value="${attr(value ?? 8)}">`;
    }).join("");

    const ruleRows = rules.length
        ? rules.map((rule) => `<tr>
            <td class="mono">${escapeHtml(rule.id)}</td>
            <td><span class="tag ${["ban", "kick", "timeout"].includes(rule.action) ? escapeHtml(rule.action) : ""}">${escapeHtml(rule.action ?? "log")}</span></td>
            <td>${escapeHtml(rule.reason ?? "—")}</td>
            <td>${rule.enabled === false ? '<span class="tag dry">off</span>' : '<span class="tag">on</span>'}</td>
            <td class="nowrap actions">
                <a class="btn small" href="/moderation/rules/edit?id=${encodeURIComponent(rule.id)}">Edit</a>
                <form class="inline" method="post" action="/moderation/rules/delete">
                    <input type="hidden" name="csrf" value="${attr(session.csrf)}">
                    <input type="hidden" name="id" value="${attr(rule.id)}">
                    <button class="small danger" type="submit">Delete</button>
                </form>
            </td>
        </tr>`).join("")
        : `<tr><td colspan="5" class="empty">No custom phrase rules. The built-in scam detectors above still run.</td></tr>`;

    const body = `${pageHead("Scam & spam rules", "Tune the automatic detectors and add your own phrase rules. Changes apply immediately.")}
        <div class="section-head"><h2>Built-in detectors</h2><p>Heuristics that run on every message in a moderated channel.</p></div>
        <form method="post" action="/moderation/rules/globals"><div class="panel">
            <input type="hidden" name="csrf" value="${attr(session.csrf)}">
            ${globalControls}
            <div class="actions" style="margin-top:18px"><button class="primary" type="submit">Save detectors</button></div>
        </div></form>
        <div class="section-head"><h2>Custom phrase rules</h2><p>Match specific phrases, terms, or patterns and act on them.</p></div>
        <div class="actions" style="margin-bottom:14px"><a class="btn primary" href="/moderation/rules/edit">Add rule</a></div>
        <div class="panel" style="padding:0"><div class="table-wrap"><table>
            <thead><tr><th>ID</th><th>Action</th><th>Reason</th><th>Status</th><th></th></tr></thead>
            <tbody>${ruleRows}</tbody>
        </table></div></div>`;

    return layout({ title: "Scam rules — BugBot", theme, active: "/moderation", path: "/moderation/rules", session, body, nav });
}

export function renderModerationRuleEditor({ theme, session, rule = null, isNew = true, error = null, nav = null }) {
    const data = rule ?? {};
    const match = data.match ?? {};
    const list = (value) => (Array.isArray(value) ? value.join("\n") : (value ?? ""));
    const actionOptions = MODERATION_ACTIONS
        .map((action) => `<option${action === (data.action ?? "ban") ? " selected" : ""}>${action}</option>`).join("");

    const body = `${pageHead(isNew ? "Add rule" : "Edit rule", "A message is caught if it matches any of the phrases, all of the required terms, or a pattern below.")}
        ${error ? `<div class="flash error">${escapeHtml(error)}</div>` : ""}
        <form method="post" action="/moderation/rules/save"><div class="panel">
            <input type="hidden" name="csrf" value="${attr(session.csrf)}">
            <input type="hidden" name="original_id" value="${attr(data.id ?? "")}">
            <div class="field-row">
                <div><label>Rule ID ${help("Short stable name, e.g. wallet-drainer. Shown in the log as the reason for the action.")}</label>
                    <input type="text" name="id" value="${attr(data.id ?? "")}" placeholder="wallet-drainer" required></div>
                <div><label>Action ${help("What to do when this rule matches.")}</label>
                    <select name="action">${actionOptions}</select></div>
            </div>
            <label>Reason ${help("Human-readable reason recorded in the moderation log and used as the Discord audit reason.")}</label>
            <input type="text" name="reason" value="${attr(data.reason ?? "")}" placeholder="wallet drainer copy-paste scam">
            <label>Match phrases ${help("Substrings that trigger the rule if they appear anywhere in the message. One per line.")}</label>
            <textarea name="phrases" class="mono">${escapeHtml(list(match.anyPhrases))}</textarea>
            <label>Required terms (all) ${help("The message must contain every one of these words. One per line. Leave blank to ignore.")}</label>
            <textarea name="allTerms" class="mono">${escapeHtml(list(match.allTerms))}</textarea>
            <label>Any terms ${help("The message matches if it contains any one of these words. One per line.")}</label>
            <textarea name="anyTerms" class="mono">${escapeHtml(list(match.anyTerms))}</textarea>
            <label>Regex patterns ${help("Advanced. Regular expressions tested against the message (case-insensitive). One per line.")}</label>
            <textarea name="regex" class="mono">${escapeHtml(list(match.regex))}</textarea>
            <div class="field-row">
                <div><label>Timeout seconds ${help("Only used when the action is timeout. Blank uses the default.")}</label>
                    <input type="number" min="1" name="timeoutSeconds" value="${attr(data.timeoutSeconds ?? "")}"></div>
                <div class="checkbox" style="margin-top:34px"><input type="checkbox" id="requireUrl" name="requireUrl" value="1" ${match.requireUrl ? "checked" : ""}><label for="requireUrl" style="margin:0">Only if the message contains a link ${help("Require a URL in the message before this rule can match. Good for scam-link rules.")}</label></div>
            </div>
            <div class="checkbox"><input type="checkbox" id="deleteMessage" name="deleteMessage" value="1" ${data.deleteMessage === false ? "" : "checked"}><label for="deleteMessage" style="margin:0">Delete the message ${help("Remove the offending message when this rule fires.")}</label></div>
            <div class="checkbox"><input type="checkbox" id="ruleEnabled" name="enabled" value="1" ${data.enabled === false ? "" : "checked"}><label for="ruleEnabled" style="margin:0">Enabled</label></div>
            <div class="actions" style="margin-top:18px">
                <button class="primary" type="submit">${isNew ? "Create rule" : "Save rule"}</button>
                <a class="btn" href="/moderation/rules">Cancel</a>
            </div>
        </div></form>`;

    return layout({ title: "Rule editor — BugBot", theme, active: "/moderation", path: "/moderation/rules", session, body, nav });
}
