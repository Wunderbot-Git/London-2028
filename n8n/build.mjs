// Builds the importable n8n workflows from src/*.js.
//   node build.mjs          write london-ingest.json and london-weekly.json
//   node build.mjs --check  fail if either file is out of date (used in CI)
import { readFileSync, writeFileSync } from "node:fs";
import { ingest } from "./build/ingest.mjs";
import { weekly } from "./build/weekly.mjs";

const check = process.argv.includes("--check");
let stale = false;
for (const [file, build] of [["london-ingest.json", ingest], ["london-weekly.json", weekly]]) {
  const wf = build();
  const out = JSON.stringify(wf, null, 2) + "\n";
  const target = new URL(`./${file}`, import.meta.url);
  if (check) {
    let current = "";
    try {
      current = readFileSync(target, "utf8");
    } catch {
      // missing counts as stale
    }
    if (current !== out) {
      console.error(`${file} is out of date – run \`npm run build\` in n8n/.`);
      stale = true;
    } else console.log(`${file} is up to date.`);
  } else {
    writeFileSync(target, out);
    console.log(`Wrote ${file} (${wf.nodes.length} nodes).`);
  }
}
if (stale) process.exit(1);
