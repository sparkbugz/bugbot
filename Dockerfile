# Debian "slim" base (not Alpine): glibc matches the build/CI toolchain and the
# app has no native modules to compile — discord.js and dotenv are pure JS and
# the SQLite engine is Node's built-in node:sqlite (needs Node >= 22.5).
FROM node:24-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY --chown=node:node src ./src
COPY --chown=node:node data ./data
COPY --chown=node:node public ./public

ENV NODE_ENV=production

# Admin panel default port (ADMIN_WEB_PORT). The bot role serves no HTTP; this
# only matters for the panel service.
EXPOSE 8787

USER node

# One image, two roles. docker-compose.yml runs the bot (src/index.js) and the
# panel (src/panelMain.js) as separate services from this same image; the
# default command here is the bot. No HEALTHCHECK here on purpose — it would be
# inherited by the bot, which has no HTTP surface. The panel's healthcheck is
# defined per-service in docker-compose.yml.
CMD ["node", "src/index.js"]
