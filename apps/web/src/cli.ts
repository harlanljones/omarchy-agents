import { runIndex } from "./server/indexer";
import { runNightly } from "./server/analyst";

const command = Bun.argv[2];
if (command === "index") console.log(JSON.stringify(await runIndex(), null, 2));
else if (command === "analyze") { await runIndex(); console.log(JSON.stringify(await runNightly(), null, 2)); }
else { console.error("Usage: bun src/cli.ts <index|analyze>"); process.exitCode = 2; }
