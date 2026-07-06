# BugBot demo site

A public, click-around preview of the BugBot admin console, hosted as a static
site at **https://bugbot.bugmunch.dev**. It lets people see every page of the
panel before installing anything — no Discord login, no database, no bot.

## How it works

The demo is generated, not hand-written. `build.mjs` imports the **real** render
functions from [`../src/adminViews.js`](../src/adminViews.js), feeds them the
invented data in [`mockData.mjs`](./mockData.mjs), and writes one static HTML
file per panel page into `dist/`. The Settings and Reference pages are built from
the live settings schema in [`../src/settings.js`](../src/settings.js).

Because the markup comes from the same code the live console uses, the demo
tracks the real UI automatically — when the panel's views change, the demo does
too on the next build. The only bespoke thing here is the sample data.

Two small demo-only assets are injected into every page (`assets/demo.css`,
`assets/demo.js`): a "live demo" ribbon at the top, a client-side theme toggle,
and a "nothing is saved" toast on any form submit. The live panel runs under a
strict CSP with no client script; the static host sends no CSP, so this bit of
JS is only ever present in the demo build.

## Build locally

```bash
npm run build:demo      # writes demo/dist/
```

Then open `demo/dist/index.html` in a browser, or serve the folder:

```bash
npx serve demo/dist     # or: python3 -m http.server -d demo/dist
```

`demo/dist/` is git-ignored — it is a build artifact, regenerated on every deploy.

## Deploy: Cloudflare pulls straight from GitHub

The demo lives in this repository and rebuilds itself whenever `main` changes.
Cloudflare clones the repo, runs the build, and publishes — nothing is uploaded
by hand, and the deploy config is version-controlled here, not stashed in the
dashboard. No secrets and no CI workflow to maintain.

Everything the deploy needs is committed:

- [`../wrangler.jsonc`](../wrangler.jsonc) — an **assets-only Worker** pointing at
  `demo/dist`. No server code, just the static files.
- `build:demo` script in [`../package.json`](../package.json).
- `wrangler` pinned as a devDependency, so `npx wrangler deploy` is reproducible.
- [`../.nvmrc`](../.nvmrc) — Node 22.

### Set it up once (Workers — recommended, config lives in the repo)

1. Cloudflare dashboard → **Workers & Pages → Create → Import a repository →
   Connect to Git**, and pick `sparkbugz/bugbot`.
2. Build settings (Cloudflare reads `wrangler.jsonc` for the rest):
   - **Build command:** `npm run build:demo`
   - **Deploy command:** `npx wrangler deploy`
3. Deploy. Every push to `main` now rebuilds and republishes automatically — the
   only source Cloudflare ever pulls from is this GitHub repo.

### Custom domain

Worker → **Settings → Domains & Routes → Add → Custom domain** →
`bugbot.bugmunch.dev`. Because `bugmunch.dev` is already on Cloudflare, the DNS
record is added for you and TLS provisions automatically.

### Alternative: Cloudflare Pages

If you prefer Pages, connect the same repo under **Pages → Connect to Git** with
build command `npm run build:demo`, output directory `demo/dist`, and env
`NODE_VERSION=22`. Same auto-pull-from-GitHub behaviour; `wrangler.jsonc` is
simply unused on that path.

### Clean URLs

Both products serve `/faq` from `faq.html`, `/moderation/rules` from
`moderation/rules.html`, and so on — exactly the layout `build.mjs` writes, so
the panel's own internal links resolve with no rewrites.

### Verify the build the way Cloudflare will

```bash
npm ci && npm run build:demo && npx wrangler deploy --dry-run
```

A clean install + build + dry-run with no errors means the GitHub-driven deploy
will succeed.

## What's mocked vs. real

| Real (imported from `src/`) | Mocked (`mockData.mjs`) |
| --- | --- |
| All page markup & styling | FAQ entries, commands, mod log rows |
| Settings field schema, docs, sections | Analytics numbers & charts |
| Nav, access-gated tabs, footer, license | Leaderboard, scheduler, audit, access grants |
| Light/dark theming | Sample server channels & roles |

Nothing here talks to Discord, GitHub, or a database. It is a look-book.
