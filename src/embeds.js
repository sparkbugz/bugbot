// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SparkBugz

// Builds a Discord embed object from an admin-composed spec, enforcing Discord's
// limits so an over-long field can never make the send fail. Pure and
// Discord-free so it is easy to test; the bot just hands the result to channel.send.

const LIMITS = {
    title: 256,
    description: 4096,
    footer: 2048,
    fieldName: 256,
    fieldValue: 1024,
    fields: 25
};

// Discord embed colors are a 24-bit integer; accept "#RRGGBB" or "RRGGBB".
export function parseColor(value) {
    const hex = String(value ?? "").trim().replace(/^#/, "");
    return /^[0-9a-fA-F]{6}$/.test(hex) ? parseInt(hex, 16) : null;
}

function cap(value, max) {
    const text = String(value ?? "").trim();
    return text.length > max ? text.slice(0, max) : text;
}

function httpUrl(value) {
    const url = String(value ?? "").trim();
    return /^https?:\/\/\S+$/i.test(url) ? url : null;
}

export function buildEmbed(spec = {}) {
    const embed = {};
    const title = cap(spec.title, LIMITS.title);
    const description = cap(spec.description, LIMITS.description);
    const footer = cap(spec.footer, LIMITS.footer);

    if (title) {
        embed.title = title;
    }
    if (description) {
        embed.description = description;
    }

    const color = parseColor(spec.color);
    if (color !== null) {
        embed.color = color;
    }

    const url = httpUrl(spec.url);
    if (url) {
        embed.url = url;
    }

    const image = httpUrl(spec.imageUrl);
    if (image) {
        embed.image = { url: image };
    }

    if (footer) {
        embed.footer = { text: footer };
    }

    const fields = (spec.fields ?? [])
        .map((field) => ({
            name: cap(field.name, LIMITS.fieldName),
            value: cap(field.value, LIMITS.fieldValue),
            inline: Boolean(field.inline)
        }))
        .filter((field) => field.name && field.value)
        .slice(0, LIMITS.fields);

    if (fields.length > 0) {
        embed.fields = fields;
    }

    return embed;
}

// An embed Discord would reject: nothing to show. Title, description, or at least
// one field is required.
export function isEmptyEmbed(embed) {
    return !embed.title && !embed.description && !(embed.fields?.length > 0);
}
