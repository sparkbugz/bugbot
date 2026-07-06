# BugBot

BugBot is a self-hosted Discord support bot. It watches only the channels you allow, answers FAQ-style questions, can link relevant GitHub issues or PRs, moderates scams and spam, and ships an admin console for settings, logs, rules, access control, and maintenance.

It is designed for community servers where support answers, moderation actions, and admin-tuned settings need to survive restarts. Durable state is stored in local SQLite through Node's built-in `node:sqlite` — there is no external database to run.

## Requirements

- Node.js 22.5 or newer. Node 24 LTS is recommended.
- npm.
- A host that can run a long-lived Node process.
- A Discord application and bot token.
- Discord Message Content Intent enabled for the bot.
- Optional: a GitHub token for private repos or higher GitHub API limits.
- Optional dashboard: Discord OAuth client ID/secret and an OAuth redirect URI.

Run the system check before setup:

```bash
npm run check:system
```

## Quick Start

```bash
npm install
npm run setup
npm run check:config
```

Then start the two processes (see [Architecture](#architecture-two-processes)), each in its own terminal — or use Docker Compose from [Deployment](#deployment):

```bash
npm run start:bot      # the Discord bot
npm run start:panel    # the admin dashboard (only when admin-dashboard is enabled)
```

`npm start` is an alias for `npm run start:bot`. `npm run setup` writes a local `.env` with `chmod 600`. For production, put secrets in your host or process manager's secret store and keep only non-secret settings in `.env`.

Minimal `.env`:

```env
DISCORD_TOKEN=your-discord-bot-token
BOT_MODULES=faq,github
DISCORD_ALLOWED_CHANNEL_IDS=123456789012345678
GITHUB_DEFAULT_REPOS=owner/repo
```

Repository values are always `owner/repo`, one per line in the dashboard or comma-separated in `.env`. Do not paste `https://github.com/owner/repo`.

## Configuration model: `.env` vs the database

BugBot reads `.env` (or the process environment) **every time it starts**. The environment is always the source of truth for two things:

- **Secrets and infrastructure** — `DISCORD_TOKEN`, the OAuth client id/secret, `ADMIN_SESSION_SECRET`, `GITHUB_TOKEN`, `DATABASE_PATH`, the `ADMIN_WEB_*` settings, `BOT_MODULES`, and the `DISCORD_ADMIN_*` administrator lists. These are never written to the database.
- **First-run defaults** for the feature settings (watched channels, matching, moderation, welcome, leveling, and so on).

Everything in that second group is also editable from the admin console's **Settings** page. Once you save a change there it is stored in the SQLite database (`DATABASE_PATH`, default `./data/bot.db`) and **the stored value wins**: on each startup the database is overlaid on top of `.env`. So after the first run, editing a panel-managed setting in `.env` has no effect — change it in the panel instead (or clear the stored value in the database).

FAQ entries, moderation rules, custom commands, and access grants also live in the database. FAQ entries and moderation rules seed once from `FAQ_DATA_PATH` / `MODERATION_RULES_PATH` on the very first run, then the database (and the panel) own them.

In short: **secrets and infrastructure → the environment; everything else → the database once the bot is running.**

## Architecture: two processes

BugBot runs as **two independent processes that share the local SQLite database**:

- **the bot** (`npm run start:bot`) — the Discord gateway, scheduler, and moderation pipeline;
- **the admin panel** (`npm run start:panel`) — the web dashboard, and nothing else.

They communicate only through the database, so **stopping, crashing, or restarting one never takes the other down**. Stop the bot and the dashboard stays up and fully usable for viewing and editing every setting — and for switching the bot back on.

The one consequence: actions that need a live Discord connection — unban, clear timeout, post embed, add reaction — cannot run while the bot is off. When the bot is off the panel **queues** them and runs them automatically once it is back, and says so plainly: a red banner and a bold-red "bot off" status in the header whenever the bot's gateway is not connected.

Run each process on its own (`docker compose` does this for you — see [Deployment](#deployment)).

## What It Can Do

- FAQ auto-replies with fuzzy matching.
- Optional GitHub issue/PR search on FAQ entries.
- Optional global GitHub fallback search after no FAQ matched.
- Custom exact commands like `!rules`.
- Polls, giveaways, announcements, starboard, leveling, welcome/goodbye, auto-roles, and server logging.
- Scam/spam moderation with dry-run, audit log, and undo for bans/timeouts.
- OAuth-protected admin dashboard, open only to approved members.
- Two-tier access control: administrators plus scoped, per-area grants for roles or members (managed from the panel, Discord, or the CLI).
- Admin-panel Start, Stop, and Reconnect buttons for the Discord gateway connection.

Start/Stop/Reconnect are not Discord chat commands. They exist only as authenticated dashboard buttons.

## Admin Dashboard

Enable it with:

```env
BOT_MODULES=faq,github,admin-dashboard
DISCORD_CONTROL_GUILD_ID=123456789012345678
ADMIN_WEB_PROTOCOL=http
ADMIN_WEB_HOST=127.0.0.1
ADMIN_WEB_PORT=8787
ADMIN_WEB_PUBLIC_URL=http://127.0.0.1:8787
DISCORD_OAUTH_CLIENT_ID=123456789012345678
DISCORD_OAUTH_CLIENT_SECRET=from-discord-developer-portal
DISCORD_OAUTH_REDIRECT_URI=http://127.0.0.1:8787/oauth/callback
ADMIN_SESSION_SECRET=use-at-least-32-random-characters
```

Add the exact `DISCORD_OAUTH_REDIRECT_URI` in the Discord Developer Portal.

Dashboard pages: Dashboard, Analytics, Moderation, FAQ, Custom commands, Embed builder, Reaction roles, Leveling, Scheduler, Reference, Audit log, Settings, and Access (administrators only). Every page carries a live connection light and the bot's name in the header. The sign-in page explains that only approved members can enter, and anyone who signs in without access is shown a clear Access denied page rather than a blank bounce.

Settings fields show their default, accepted format/range, examples, and whether they apply live or need a reconnect. The Reference page has copy/paste examples for GitHub repository format, FAQ GitHub JSON, moderation rules, commands, template tags, and level role rewards.

The dashboard is intentionally server-rendered with no client-side JavaScript, and its header and footer are mobile-friendly.

## Maintenance Buttons

The dashboard has safe connection controls:

- Start connection: logs the bot into Discord if it is disconnected.
- Stop connection: disconnects from Discord while keeping the dashboard online.
- Reconnect: disconnects and logs in again. Use this after settings that need a reconnect.

There is also a process restart button, but it is disabled by default because it exits the **bot** process (the dashboard, being a separate process, stays up). Enable it only when a supervisor will bring the bot back:

```env
ALLOW_PROCESS_RESTART=true
```

Use that only with systemd, Docker restart policies, PM2, or equivalent.

## GitHub Search Behavior

Global GitHub fallback search is off by default:

```env
ENABLE_GLOBAL_GITHUB_SEARCH=false
```

When enabled and `QUESTION_ONLY_MODE=true`, the bot first checks whether the message looks like a real help question. It then strips question filler words before searching GitHub, so a message like:

```text
How do I fix login failing with oauth callback?
```

searches closer to:

```text
fix login failing oauth callback
```

Cooldowns are applied only after the bot actually replies. A missed GitHub search no longer burns the channel or per-user reply cooldown.

## Common Settings

```env
QUESTION_ONLY_MODE=true
MATCH_THRESHOLD=0.72
RESPONSE_COOLDOWN_SECONDS=60
USER_MESSAGE_COOLDOWN_SECONDS=5
MAX_MESSAGE_LENGTH=1000
MAX_REPLY_LENGTH=1900
GITHUB_DEFAULT_REPOS=owner/repo,owner/other-repo
GLOBAL_GITHUB_SEARCH_MIN_SCORE=0.63
GITHUB_CACHE_TTL_SECONDS=600
GITHUB_QUERY_MAX_LENGTH=256
GITHUB_REQUEST_TIMEOUT_SECONDS=8
```

`RESPONSE_COOLDOWN_SECONDS` is the per-channel cooldown for repeating the same FAQ or fallback reply. `USER_MESSAGE_COOLDOWN_SECONDS` is the per-user throttle after a successful bot reply.

## FAQ Entries

Minimal:

```json
{
  "entries": [
    {
      "id": "reset-password",
      "questions": ["How do I reset my password?"],
      "answer": "Use the account settings reset flow."
    }
  ]
}
```

FAQ entry with GitHub search:

```json
{
  "id": "ci-failing",
  "questions": ["Why is CI failing?", "Why is the pipeline red?"],
  "answer": "Closest related GitHub thread:",
  "github": {
    "mode": "search",
    "repos": ["owner/repo"],
    "type": "both",
    "query": "ci pipeline failing",
    "minScore": 0.63
  }
}
```

FAQ entry with a fixed GitHub link:

```json
{
  "id": "known-oauth-issue",
  "questions": ["OAuth callback is broken"],
  "answer": "This is tracked here:",
  "github": {
    "mode": "fixed",
    "url": "https://github.com/owner/repo/issues/123"
  }
}
```

## Custom Commands

Custom commands are fixed trigger/reply pairs managed on the Commands page.

Example:

```text
Trigger: !rules
Match: Exact message
Response: Read #rules before posting support questions.
```

Match modes:

- Exact message: the whole message must equal the trigger.
- Starts with: the message begins with the trigger.
- Contains: the trigger appears anywhere.

## Moderation

Enable moderation intentionally:

```env
BOT_MODULES=faq,github,moderation,admin-dashboard
DISCORD_CONTROL_GUILD_ID=123456789012345678
MODERATION_CHANNEL_IDS=123456789012345678
MODERATION_DRY_RUN=true
```

Use `MODERATION_CHANNEL_IDS=*` only when you want the entire control server scanned.

Actions:

- `log`: record only.
- `delete`: delete the message.
- `warn`: warn the member.
- `timeout`: temporarily mute the member.
- `kick`: remove the member.
- `ban`: remove and block rejoin.

Keep dry-run on while tuning rules. The dashboard shows moderation decisions and supports undo for bans and timeouts.

## Discord Permissions

Minimum:

- View Channels.
- Send Messages.
- Read Message History.
- Send Messages in Threads if needed.

Feature-specific:

- Manage Messages for deletes and purge.
- Moderate Members for timeout/mute/unmute.
- Kick Members for kick.
- Ban Members for ban.
- Manage Roles for auto-roles and reaction roles.

Join/leave and auto-role features require Discord's privileged Server Members Intent.

## Deployment

Direct Node — run the two processes under a supervisor (a unit each), sharing one `DATABASE_PATH`:

```bash
npm ci
npm run check:system
npm run check:config
npm run start:bot      # one service
npm run start:panel    # a second service
```

Docker Compose runs both for you as the `bot` and `panel` services from a single image, sharing a `bugbot-data` volume. Both pull the published image from GHCR — no local build needed:

```bash
cp .env.example .env   # fill in your secrets
docker compose pull    # fetch ghcr.io/sparkbugz/bugbot:latest
docker compose up -d
# stop just the bot; the dashboard stays reachable:
docker compose stop bot
```

The image is published to **`ghcr.io/sparkbugz/bugbot`** by GitHub Actions (`.github/workflows/docker-publish.yml`): every push to `main` refreshes `:latest`, and a `vX.Y.Z` release tag publishes `:X.Y.Z`, `:X.Y`, and `:latest` (multi-arch, amd64 + arm64). Pin a release with `BUGBOT_TAG=v0.1.0` in `.env`; the default is `:latest`.

**Auto-update.** The bundled `watchtower` service polls GHCR every five minutes and redeploys the `bot`/`panel` containers whenever a newer `:latest` is published — so a push to `main` rolls out on its own. The `bugbot-data` volume persists the SQLite store across updates. Remove the `watchtower` service if you deploy updates another way. (Auto-update only tracks the pulled GHCR image, not a local `build:`.)

To build locally instead of pulling, uncomment `build: .` on the `bot`/`panel` services and run `docker compose up -d --build`.

The panel container binds `0.0.0.0`, which BugBot requires be served over **HTTPS** — point `ADMIN_WEB_*` at your certificates (mounted at `./certs`) or front the panel with a TLS-terminating proxy. Never bake secrets into the image; pass them via `--env-file`/compose.

For VPS installs, run under a supervisor such as systemd, Docker, or PM2. Do not enable `ALLOW_PROCESS_RESTART=true` unless that supervisor is active.

## Troubleshooting

Run:

```bash
npm run check:system
npm run check:config
```

Common dashboard issues:

- `BOT_MODULES` does not include `admin-dashboard`.
- The Discord OAuth redirect URI does not exactly match.
- HTTP dashboard is bound to a non-loopback host. Use HTTPS for LAN/public access.
- Required secrets are missing from the runtime environment.

Common GitHub issues:

- Repos must be `owner/repo`.
- Private repos need `GITHUB_TOKEN`.
- Raise `GITHUB_REQUEST_TIMEOUT_SECONDS` if GitHub is slow.
- Lower `GLOBAL_GITHUB_SEARCH_MIN_SCORE` for looser matching.

## Access control

Access has two tiers.

**Administrators** always have full access to the panel and every command, and can never be locked out of the console. You are an administrator if you are the server owner, hold the Administrator permission (or any of `DISCORD_ADMIN_PERMISSION_FLAGS`), or your id/role is listed in `DISCORD_ADMIN_USER_IDS` / `DISCORD_ADMIN_ROLE_IDS`.

**Scoped grants** let you give a role or a specific member access to only certain areas — for example "the Mod role can use Moderation and FAQ, but not Settings". Areas map to the panel pages and command groups: `analytics`, `moderation`, `faq`, `commands`, `embed`, `roles`, `leveling`, `scheduler`, `settings`, `audit`. Dashboard and Reference are always visible to anyone signed in. Managing grants is administrator-only.

Grants live in the SQLite database and can be managed three ways:

- **Panel** — the *Access* page (visible to administrators).
- **Discord** — `!faqbot access list | add <@role|@user|role:ID|user:ID> <area,area|all> [label] | remove <subject>` (administrators only; uses your `MANAGEMENT_COMMAND_PREFIX`).
- **CLI** — `npm run access -- list`, `npm run access -- add role <id> moderation,faq "Support mods"`, `npm run access -- remove role <id>`.

## Security Notes

- Keep Discord/GitHub/OAuth tokens out of git.
- The dashboard uses an HttpOnly SameSite cookie and CSRF tokens on mutating actions.
- Dashboard authorization is rechecked against Discord guild membership, roles, and permissions, and every request is gated to the areas the signed-in principal is allowed.
- Replies suppress mentions by default.
- Automatic moderation skips configured exempt users/roles.
- GitHub searches are query-capped, cached, timed out, and cooled down.

## License

BugBot is free software licensed under the **GNU Affero General Public License, version 3 or later** (`AGPL-3.0-or-later`) — see [LICENSE](LICENSE). In short: you may use, modify, and redistribute it, but if you run a modified version as a network service you must offer that service's users the corresponding source.

Commercial support, custom integrations, and alternative (non-AGPL) licensing are available — contact <sparkbugz@gmail.com>.

Copyright © 2026 SparkBugz.
