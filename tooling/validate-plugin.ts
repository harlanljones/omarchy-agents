import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(Bun.argv[2] ?? ".");
const manifest = JSON.parse(readFileSync(`${root}/manifest.json`, "utf8"));
const required = [manifest.entryPoints?.barWidget, "Main.qml", "Agent.qml"];
for (const file of required) if (!file || !existsSync(`${root}/${file}`)) throw new Error(`${manifest.id ?? root}: missing ${file ?? "entry point"}`);
if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.kinds) || !manifest.kinds.includes("bar-widget")) throw new Error(`${manifest.id}: unsupported manifest shape`);
if (!existsSync(`${root}/assets`)) throw new Error(`${manifest.id}: provider assets are unavailable`);
console.log(`${manifest.id}: manifest and entry points valid`);
