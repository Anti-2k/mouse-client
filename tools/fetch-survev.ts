#!/usr/bin/env bun
// tools/fetch-survev.ts
//
// Clones survev's own repository into survev-pinned/ (gitignored) and pins it
// to exactly the build this client targets, so the dev tools that read the
// game's definitions have the right ones to read:
//
//   bun tools/fetch-survev.ts
//
// The pin is MOUSE.TARGET.build in extension/src/00-loader.js, read straight
// out of that file rather than copied here, so bumping the target is a single
// edit and this checkout can never silently lag behind it.
//
// Safe to re-run: an existing checkout is fetched and re-pinned instead of
// cloned again, and any local edits inside it are discarded first - nothing
// in survev-pinned/ is meant to be changed by hand.
//
// Nothing is installed or built: tools/check-item-table.ts only imports the
// plain definition files under shared/defs, which need no dependencies.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SURVEV_REPO = "https://github.com/survev/survev.git";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const checkout = join(repoRoot, "survev-pinned");

const loader = readFileSync(join(repoRoot, "extension/src/00-loader.js"), "utf8");
const match = loader.match(/TARGET:\s*\{\s*survev:\s*"([^"]+)",\s*build:\s*"([0-9a-f]{40})"/);
if (!match) {
    console.error("Could not find MOUSE.TARGET in extension/src/00-loader.js");
    process.exit(1);
}
const [, survevVersion, build] = match;

function run(cmd: string[], cwd: string) {
    console.log(`$ ${cmd.join(" ")}`);
    const proc = Bun.spawnSync(cmd, { cwd, stdio: ["inherit", "inherit", "inherit"] });
    if (proc.exitCode !== 0) {
        console.error(`failed (exit ${proc.exitCode})`);
        process.exit(1);
    }
}

if (!existsSync(checkout)) {
    run(["git", "clone", "--filter=blob:none", "--no-checkout", SURVEV_REPO, checkout], repoRoot);
} else {
    // A clone taken before the pinned commit existed has no object for it,
    // so fetch first - otherwise a target bump fails with "reference is not
    // a tree" instead of landing on the existing checkout.
    run(["git", "fetch", "--filter=blob:none", "origin"], checkout);
    run(["git", "checkout", "--", "."], checkout);
}
run(["git", "-c", "advice.detachedHead=false", "checkout", build], checkout);

console.log(`\nsurvev-pinned/ is at ${build.slice(0, 8)} (survev ${survevVersion}).`);
