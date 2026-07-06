import test from "node:test";
import assert from "node:assert/strict";
import { renderTemplate, memberContext } from "../src/templates.js";

test("renderTemplate fills known tokens and leaves unknown ones intact", () => {
    const out = renderTemplate("Hi {mention}, welcome to {server}! ({typo})", {
        mention: "<@1>", server: "Guild"
    });

    assert.equal(out, "Hi <@1>, welcome to Guild! ({typo})");
});

test("memberContext derives user, mention, server, and count", () => {
    const ctx = memberContext({
        user: { id: "42", username: "newbie", tag: "newbie#0001" },
        guild: { name: "Test Guild", memberCount: 7 }
    });

    assert.equal(ctx.mention, "<@42>");
    assert.equal(ctx.user, "newbie");
    assert.equal(ctx.tag, "newbie#0001");
    assert.equal(ctx.server, "Test Guild");
    assert.equal(ctx.count, 7);
});
