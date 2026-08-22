import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { basename, resolve } from "node:path";

const source = resolve(Bun.argv[2] ?? ".");
const destination = resolve(Bun.argv[3] ?? `dist/${basename(source)}`);
if (!existsSync(`${source}/manifest.json`)) throw new Error(`${source} is not an Omarchy plugin`);
const manifest = JSON.parse(readFileSync(`${source}/manifest.json`, "utf8"));
if (!manifest.id || !manifest.entryPoints?.barWidget) throw new Error("manifest is missing its id or bar widget entry point");
if (basename(destination) !== "dist") throw new Error(`refusing to replace non-dist path: ${destination}`);
rmSync(destination, { recursive: true, force: true });
mkdirSync(destination, { recursive: true });
for (const entry of readdirSync(source)) {
  if (["dist", "node_modules", "package.json"].includes(entry)) continue;
  cpSync(`${source}/${entry}`, `${destination}/${entry}`, { recursive: true, dereference: true });
}
console.log(`${manifest.id} -> ${destination}`);
