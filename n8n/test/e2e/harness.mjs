// Runs a built workflow in a real n8n against mock-server.mjs.
// API hosts are pointed at the mock and credentials dropped; nodes, expressions and Code run as built.
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const n8n = process.env.N8N_BIN;
if (!n8n) throw new Error("Set N8N_BIN to n8n's bin/n8n");

/** Loads a built workflow with hosts rewritten to the mock and auth removed. */
export function loadWorkflow(file, mockUrl) {
  const text = readFileSync(new URL(`../../${file}`, import.meta.url), "utf8")
    .replaceAll("https://firestore.googleapis.com", `${mockUrl}/firestore`)
    .replaceAll("https://generativelanguage.googleapis.com", `${mockUrl}/gemini`)
    .replaceAll("https://api.tfl.gov.uk", `${mockUrl}/tfl`)
    .replaceAll("https://api.postcodes.io", `${mockUrl}/postcodes`)
    .replaceAll("https://api.agentmail.to", `${mockUrl}/agentmail`)
    .replace("DEIN-GCP-PROJEKT", "test");
  const wf = JSON.parse(text);
  wf.active = false;
  for (const n of wf.nodes) {
    delete n.credentials;
    if (n.type === "n8n-nodes-base.httpRequest") {
      delete n.parameters.authentication;
      delete n.parameters.nodeCredentialType;
      delete n.parameters.genericAuthType;
    }
  }
  return wf;
}

/** Replaces a node with a Code node of the same name (keeps connections). */
export function replaceWithCode(wf, name, jsCode) {
  Object.assign(wf.nodes.find((n) => n.name === name), { type: "n8n-nodes-base.code", typeVersion: 2, parameters: { jsCode } });
}

/** Turns a placeholder node into a POST to the mock so the test can see what reached it. */
export function replaceWithProbe(wf, name, mockUrl, path) {
  Object.assign(wf.nodes.find((n) => n.name === name), {
    type: "n8n-nodes-base.httpRequest",
    typeVersion: 4.2,
    parameters: { method: "POST", url: `${mockUrl}${path}`, sendBody: true, specifyBody: "json", jsonBody: "={{ JSON.stringify($json) }}", options: {} },
  });
}

/** Adds a manual trigger in front of `first` (replacing the workflow's own trigger if given). */
export function startManually(wf, first, { removeTrigger } = {}) {
  if (removeTrigger) {
    wf.nodes = wf.nodes.filter((n) => n.name !== removeTrigger);
    delete wf.connections[removeTrigger];
  }
  wf.nodes.push({ id: "start", name: "Start", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, position: [-220, 0], parameters: {} });
  wf.connections.Start = { main: [[{ node: first, type: "main", index: 0 }]] };
}

/** A fresh n8n home; returns run(wf) that imports and executes the workflow there. */
export function n8nHome() {
  const home = mkdtempSync(join(tmpdir(), "n8n-e2e-"));
  const env = { ...process.env, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost", N8N_USER_FOLDER: home, N8N_DIAGNOSTICS_ENABLED: "false" };
  // Async on purpose: the mock server lives in this process and must keep answering.
  const cli = async (...args) => {
    try {
      return (await promisify(execFile)(process.execPath, [n8n, ...args], { env, maxBuffer: 1 << 28 })).stdout;
    } catch (e) {
      console.error(`n8n ${args[0]} failed:\n${e.stdout?.slice(-3000)}\n${e.stderr?.slice(-3000)}`);
      throw new Error(`n8n ${args[0]} failed`);
    }
  };
  return async function run(wf, id) {
    const file = join(home, `${id}.json`);
    writeFileSync(file, JSON.stringify({ ...wf, id }));
    await cli("import:workflow", `--input=${file}`);
    return cli("execute", `--id=${id}`, "--rawOutput");
  };
}
