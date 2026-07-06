import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";

function withEnv(values, callback) {
    const previous = {};

    for (const key of Object.keys(values)) {
        previous[key] = process.env[key];

        if (values[key] === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = values[key];
        }
    }

    try {
        return callback();
    } finally {
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = value;
            }
        }
    }
}

test("loadConfig requires at least one allowed Discord channel", () => {
    withEnv({
        DISCORD_TOKEN: "test-token",
        DISCORD_ALLOWED_CHANNEL_IDS: "",
        FAQ_DATA_PATH: "./data/faq.example.json"
    }, () => {
        assert.throws(
            () => loadConfig(),
            /DISCORD_ALLOWED_CHANNEL_IDS must include at least one channel ID/
        );
    });
});

test("loadConfig parses configured Discord channel allowlist", () => {
    withEnv({
        DISCORD_TOKEN: "test-token",
        DISCORD_ALLOWED_CHANNEL_IDS: "111111111111111111, 222222222222222222",
        FAQ_DATA_PATH: "./data/faq.example.json"
    }, () => {
        const config = loadConfig();

        assert.deepEqual(config.allowedChannelIds, [
            "111111111111111111",
            "222222222222222222"
        ]);
    });
});

test("loadConfig rejects invalid Discord channel IDs", () => {
    withEnv({
        DISCORD_TOKEN: "test-token",
        DISCORD_ALLOWED_CHANNEL_IDS: "not-a-channel",
        FAQ_DATA_PATH: "./data/faq.example.json"
    }, () => {
        assert.throws(
            () => loadConfig(),
            /DISCORD_ALLOWED_CHANNEL_IDS contains invalid Discord ID values/
        );
    });
});

test("loadConfig rejects invalid GitHub repo names", () => {
    withEnv({
        DISCORD_TOKEN: "test-token",
        DISCORD_ALLOWED_CHANNEL_IDS: "111111111111111111",
        GITHUB_DEFAULT_REPOS: "owner/repo,not a repo",
        FAQ_DATA_PATH: "./data/faq.example.json"
    }, () => {
        assert.throws(
            () => loadConfig(),
            /GITHUB_DEFAULT_REPOS contains invalid GitHub repo values/
        );
    });
});

test("loadConfig parses default modules", () => {
    withEnv({
        DISCORD_TOKEN: "test-token",
        DISCORD_ALLOWED_CHANNEL_IDS: "111111111111111111",
        BOT_MODULES: undefined,
        FAQ_DATA_PATH: "./data/faq.example.json"
    }, () => {
        const config = loadConfig();

        assert.deepEqual(config.modules, ["faq", "github"]);
        assert.equal(config.enableFaq, true);
        assert.equal(config.enableGitHub, true);
        assert.equal(config.enableManagementCommands, false);
    });
});

test("loadConfig rejects unsupported modules", () => {
    withEnv({
        DISCORD_TOKEN: "test-token",
        DISCORD_ALLOWED_CHANNEL_IDS: "111111111111111111",
        BOT_MODULES: "faq,scary",
        FAQ_DATA_PATH: "./data/faq.example.json"
    }, () => {
        assert.throws(
            () => loadConfig(),
            /BOT_MODULES contains unsupported modules/
        );
    });
});

test("loadConfig requires a control guild for commands", () => {
    withEnv({
        DISCORD_TOKEN: "test-token",
        DISCORD_ALLOWED_CHANNEL_IDS: "111111111111111111",
        BOT_MODULES: "faq,commands",
        DISCORD_CONTROL_GUILD_ID: "",
        FAQ_DATA_PATH: "./data/faq.example.json"
    }, () => {
        assert.throws(
            () => loadConfig(),
            /DISCORD_CONTROL_GUILD_ID is required/
        );
    });
});

test("loadConfig rejects unsupported admin permission names", () => {
    withEnv({
        DISCORD_TOKEN: "test-token",
        DISCORD_ALLOWED_CHANNEL_IDS: "111111111111111111",
        DISCORD_ADMIN_PERMISSION_FLAGS: "Administrator,StealTokens",
        FAQ_DATA_PATH: "./data/faq.example.json"
    }, () => {
        assert.throws(
            () => loadConfig(),
            /DISCORD_ADMIN_PERMISSION_FLAGS contains unsupported Discord permission names/
        );
    });
});

test("loadConfig requires OAuth secrets for admin dashboard", () => {
    withEnv({
        DISCORD_TOKEN: "test-token",
        DISCORD_ALLOWED_CHANNEL_IDS: "111111111111111111",
        DISCORD_CONTROL_GUILD_ID: "222222222222222222",
        BOT_MODULES: "faq,admin-dashboard",
        DISCORD_OAUTH_CLIENT_ID: "333333333333333333",
        DISCORD_OAUTH_CLIENT_SECRET: undefined,
        ADMIN_SESSION_SECRET: "12345678901234567890123456789012",
        FAQ_DATA_PATH: "./data/faq.example.json"
    }, () => {
        assert.throws(
            () => loadConfig(),
            /DISCORD_OAUTH_CLIENT_ID and DISCORD_OAUTH_CLIENT_SECRET are required/
        );
    });
});

test("loadConfig rejects HTTP admin dashboard on non-loopback hosts", () => {
    withEnv({
        DISCORD_TOKEN: "test-token",
        DISCORD_ALLOWED_CHANNEL_IDS: "111111111111111111",
        DISCORD_CONTROL_GUILD_ID: "222222222222222222",
        BOT_MODULES: "faq,admin-dashboard",
        DISCORD_OAUTH_CLIENT_ID: "333333333333333333",
        DISCORD_OAUTH_CLIENT_SECRET: "oauth-secret",
        ADMIN_SESSION_SECRET: "12345678901234567890123456789012",
        ADMIN_WEB_PROTOCOL: "http",
        ADMIN_WEB_HOST: "0.0.0.0",
        FAQ_DATA_PATH: "./data/faq.example.json"
    }, () => {
        assert.throws(
            () => loadConfig(),
            /ADMIN_WEB_PROTOCOL=http is only allowed/
        );
    });
});

test("loadConfig requires explicit moderation channels when moderation is enabled", () => {
    withEnv({
        DISCORD_TOKEN: "test-token",
        DISCORD_ALLOWED_CHANNEL_IDS: "111111111111111111",
        DISCORD_CONTROL_GUILD_ID: "222222222222222222",
        BOT_MODULES: "faq,moderation",
        MODERATION_CHANNEL_IDS: "",
        FAQ_DATA_PATH: "./data/faq.example.json"
    }, () => {
        assert.throws(
            () => loadConfig(),
            /MODERATION_CHANNEL_IDS is required/
        );
    });
});

test("loadConfig parses moderation module with wildcard scope", () => {
    withEnv({
        DISCORD_TOKEN: "test-token",
        DISCORD_ALLOWED_CHANNEL_IDS: "111111111111111111",
        DISCORD_CONTROL_GUILD_ID: "222222222222222222",
        BOT_MODULES: "faq,moderation",
        MODERATION_CHANNEL_IDS: "*",
        MODERATION_DRY_RUN: "false",
        FAQ_DATA_PATH: "./data/faq.example.json"
    }, () => {
        const config = loadConfig();

        assert.equal(config.enableModeration, true);
        assert.deepEqual(config.moderationChannelIds, ["*"]);
        assert.equal(config.moderationDryRun, false);
        assert.ok(Array.isArray(config.moderationRules.rules));
    });
});
