import test from "node:test";
import assert from "node:assert/strict";
import { DiscordFaqBot } from "../src/bot.js";
import { renderSettings, renderReactionRoles } from "../src/adminViews.js";

function directoryConfig() {
    return {
        discordToken: "token",
        controlGuildId: "guild-id",
        githubDefaultRepos: [],
        maxReplyLength: 1900
    };
}

// A stand-in gateway guild with cached channels and roles.
function fakeGuild() {
    return {
        id: "guild-id",
        channels: {
            cache: new Map([
                ["c1", { id: "c1", name: "general", type: 0 }],
                ["c2", { id: "c2", name: "voice", type: 2 }], // not text — filtered out
                ["c3", { id: "c3", name: "announce", type: 5 }]
            ])
        },
        roles: {
            cache: new Map([
                ["guild-id", { id: "guild-id", name: "@everyone", position: 0 }], // dropped
                ["r1", { id: "r1", name: "Member", position: 1 }],
                ["r2", { id: "r2", name: "Mod", position: 5 }]
            ])
        }
    };
}

test("guildDirectory returns text channels and non-everyone roles from the cache", () => {
    const bot = new DiscordFaqBot(directoryConfig());
    bot.client = { guilds: { cache: new Map([["guild-id", fakeGuild()]]) } };

    const dir = bot.guildDirectory();
    assert.deepEqual(dir.channels.map((c) => c.name), ["announce", "general"]);
    assert.deepEqual(dir.roles.map((r) => r.name), ["Mod", "Member"]); // sorted by position desc
});

test("guildDirectory is empty when the guild is not cached", () => {
    const bot = new DiscordFaqBot(directoryConfig());
    bot.client = { guilds: { cache: new Map() } };
    assert.deepEqual(bot.guildDirectory(), { channels: [], roles: [] });
});

test("settings render channel selects and role checklists from the directory", () => {
    const sections = [{
        title: "Channels", description: "",
        fields: [
            { key: "logChannelId", label: "Log channel", type: "text", source: "channels", allowEmpty: true, hint: "", value: "c3" },
            { key: "autoRoleIds", label: "Auto-roles", type: "list", source: "roles", allowEmpty: true, hint: "", value: ["r1"] }
        ]
    }];
    const directory = {
        channels: [{ id: "c1", name: "general" }, { id: "c3", name: "announce" }],
        roles: [{ id: "r1", name: "Member" }, { id: "r2", name: "Mod" }]
    };

    const html = renderSettings({ theme: "auto", session: { username: "a", csrf: "x" }, sections, directory });

    // Channel select with the configured value pre-selected by name.
    assert.match(html, /<select name="logChannelId">/);
    assert.match(html, /<option value="c3" selected>#announce<\/option>/);
    // Role checklist with r1 checked, r2 unchecked.
    assert.match(html, /name="autoRoleIds" value="r1" checked/);
    assert.match(html, /name="autoRoleIds" value="r2"(?! checked)/);
});

test("a configured id missing from the guild is preserved as unknown", () => {
    const sections = [{
        title: "Roles", description: "",
        fields: [{ key: "autoRoleIds", label: "Auto-roles", type: "list", source: "roles", allowEmpty: true, hint: "", value: ["gone"] }]
    }];
    const directory = { channels: [], roles: [{ id: "r1", name: "Member" }] };

    const html = renderSettings({ theme: "auto", session: { username: "a", csrf: "x" }, sections, directory });
    assert.match(html, /name="autoRoleIds" value="gone" checked/);
    assert.match(html, /gone \(unknown\)/);
});

test("settings fall back to plain inputs when the directory is empty", () => {
    const sections = [{
        title: "Channels", description: "",
        fields: [{ key: "logChannelId", label: "Log channel", type: "text", source: "channels", allowEmpty: true, hint: "", value: "c3" }]
    }];

    const html = renderSettings({ theme: "auto", session: { username: "a", csrf: "x" }, sections, directory: { channels: [], roles: [] } });
    assert.match(html, /<input type="text"[^>]*name="logChannelId"/);
    assert.ok(!/<select name="logChannelId">/.test(html));
});

test("reaction-role table resolves channel and role names", () => {
    const directory = {
        channels: [{ id: "c1", name: "general" }],
        roles: [{ id: "r1", name: "Member" }]
    };
    const mappings = [{ channel_id: "c1", message_id: "m1", emoji: "✅", role_id: "r1" }];

    const html = renderReactionRoles({ theme: "auto", session: { username: "a", csrf: "x" }, mappings, enabled: true, directory });
    assert.match(html, /general/);
    assert.match(html, /Member/);
    assert.match(html, /<select name="channel_id" required>/);
    assert.match(html, /<select name="role_id" required>/);
});
