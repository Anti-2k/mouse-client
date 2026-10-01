// tools/check-item-table.ts
//
// Dev-only drift check for the hand-maintained ITEM_CATEGORY table in
// extension/src/13-items.js, run against the pinned survev checkout in
// survev-pinned/ (create or re-pin it with `bun tools/fetch-survev.ts`).
// Never shipped - like tools/gen-skins-data.py it is not listed in
// extension/manifest.json and nothing in extension/ imports it.
//
//   bun tools/check-item-table.ts
//
// Exits 0 when the table matches the game and 1 when anything has drifted, so
// it can be run as a gate before tagging a release against a new survev build.
//
// Why this exists: every unrecognized item is a silent failure, not a loud
// one. 21-cosmetics.js finds a player's outfit field by asking
// ITEM_CATEGORY whether a string is an outfit, so a skin missing from the
// table is a skin Anti-Cosmetics quietly refuses to default - which is
// exactly how `outfitMaintainer` once went unhandled. It now asks the live
// def registry first and only falls back to the table, but 10-ctx.js's
// netData lookup reads the table directly.
//
// The comparison is against the defs themselves, not a regex over their
// source: bun imports survev's TypeScript directly, so `def.type` is read
// exactly as the game computes it - including skins that inherit their type
// through a base item, which a textual scan gets wrong.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { RawGameObjectDefs } from "../survev-pinned/shared/defs/gameObjectDefs.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The categories 13-items.js classifies into. Anything whose def.type is
 * not one of these (emotes, crosshairs, roles, quests, ...) is not an item a
 * player carries or wears and is deliberately absent from the table. */
const TRACKED = new Set([
    "ammo",
    "heal",
    "boost",
    "chest",
    "helmet",
    "backpack",
    "scope",
    "throwable",
    "outfit",
    "perk",
    "xp",
    "gun",
    "melee",
]);

/**
 * Loads MOUSE.items out of extension/src/13-items.js by running it against a
 * stub global, rather than re-parsing the table with a regex - the file is a
 * plain IIFE whose only dependency is `window.__MOUSE`.
 */
function loadClientTables() {
    const src = readFileSync(join(repoRoot, "extension/src/13-items.js"), "utf8");
    const MOUSE: any = { log() {}, warn() {} };
    const window = { __MOUSE: MOUSE };
    new Function("window", src)(window);
    if (!MOUSE.items) throw new Error("13-items.js did not populate MOUSE.items");
    return MOUSE.items;
}

const items = loadClientTables();
const category: Record<string, string> = items.ITEM_CATEGORY;

const problems: string[] = [];

// --- ITEM_CATEGORY ------------------------------------------------------
const expectedCategory = new Map<string, string>();
for (const [type, def] of Object.entries(RawGameObjectDefs) as Array<[string, any]>) {
    if (!def || !TRACKED.has(def.type)) continue;
    expectedCategory.set(type, def.type);
}

for (const [type, want] of expectedCategory) {
    const got = category[type];
    if (got === undefined) problems.push(`ITEM_CATEGORY is missing "${type}" (should be "${want}")`);
    else if (got !== want) problems.push(`ITEM_CATEGORY has "${type}" as "${got}", game says "${want}"`);
}
for (const type of Object.keys(category)) {
    if (!expectedCategory.has(type)) problems.push(`ITEM_CATEGORY has "${type}", which the game no longer defines`);
}

// --- Per-category counts, for the table's own header comments -----------
const counts = new Map<string, number>();
for (const want of expectedCategory.values()) counts.set(want, (counts.get(want) || 0) + 1);

if (problems.length) {
    console.error(`${problems.length} problem(s) in extension/src/13-items.js:\n`);
    for (const p of problems) console.error(`  - ${p}`);
    console.error("\nFix the table (and its per-category count comments) before tagging the release.");
    process.exit(1);
}

console.log(`extension/src/13-items.js matches the game (${expectedCategory.size} items).`);
console.log("Per-category counts, for the table's comments:");
for (const [cat, n] of [...counts].sort()) console.log(`  ${cat} (${n})`);
