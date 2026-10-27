// In-memory stand-ins for Firestore REST, the Claude Messages API, TfL and postcodes.io,
// just enough for test/e2e/run.mjs to execute london-ingest end to end.
import { createServer } from "node:http";
import { fromFields, toFields, fromValue } from "../../src/firestore.js";

export function startMock(seed) {
  const docs = new Map(Object.entries(seed).map(([path, data]) => [path, toFields(data)]));
  const calls = [];
  const prefix = "/firestore/v1/projects/test/databases/(default)/documents";
  const name = (path) => `projects/test/databases/(default)/documents/${path}`;

  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    const url = new URL(req.url, "http://x");
    const path = decodeURIComponent(url.pathname);
    calls.push({ method: req.method, path, query: Object.fromEntries(url.searchParams), headers: req.headers, body });
    const send = (status, json) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(json));
    };

    if (path.startsWith(prefix)) {
      const rest = path.slice(prefix.length);
      if (rest === ":runQuery") {
        const q = body.structuredQuery;
        const coll = q.from[0].collectionId;
        let rows = [...docs.entries()].filter(([p]) => p.startsWith(`${coll}/`) && !p.slice(coll.length + 1).includes("/"));
        const f = q.where?.fieldFilter;
        if (f) rows = rows.filter(([, fields]) => JSON.stringify(fromValue(fields[f.field.fieldPath])) === JSON.stringify(fromValue(f.value)));
        const o = q.orderBy?.[0];
        if (o) rows.sort((a, b) => (fromValue(b[1][o.field.fieldPath]) ?? 0) - (fromValue(a[1][o.field.fieldPath]) ?? 0));
        rows = rows.slice(0, q.limit ?? rows.length);
        return send(200, rows.length ? rows.map(([p, fields]) => ({ document: { name: name(p), fields }, readTime: "t" })) : [{ readTime: "t" }]);
      }
      if (rest === ":batchGet") {
        return send(200, body.documents.map((n) => {
          const p = n.split("/documents/")[1];
          return docs.has(p) ? { found: { name: n, fields: docs.get(p) } } : { missing: n };
        }));
      }
      const p = rest.slice(1);
      if (req.method === "GET") return docs.has(p) ? send(200, { name: name(p), fields: docs.get(p) }) : send(404, { error: { code: 404, status: "NOT_FOUND" } });
      if (req.method === "PATCH") {
        const mask = url.searchParams.getAll("updateMask.fieldPaths");
        const next = mask.length ? { ...(docs.get(p) ?? {}), ...Object.fromEntries(mask.map((k) => [k, body.fields[k]])) } : body.fields;
        docs.set(p, next);
        return send(200, { name: name(p), fields: next });
      }
    }

    if (path === "/anthropic/v1/messages") {
      const isExtraction = !!body.output_config?.format?.schema?.properties?.listings;
      const answer = isExtraction
        ? { listings: [{
            url: "https://www.example-lettings.co.uk/short-lets/ham-common-family-home", sourceId: null,
            address: "Ham Common", postcode: "TW10", area: "Ham", price: 1450, pricePeriod: "week", billsIncluded: true,
            letType: "short_let", minTermMonths: 6, maxTermMonths: 6, availableFrom: "2028-01-01", beds: 4, baths: null,
            furnished: "furnished", garden: true, parking: null, epc: null, highlight: "Garten nach Süden", photos: [],
          }] }
        : { score: body.messages[0].content.includes("Compton Road") ? 2 : 4, rationale: "Mock-Begründung." };
      return send(200, { model: body.model, stop_reason: "end_turn", content: [{ type: "thinking", thinking: "" }, { type: "text", text: JSON.stringify(answer) }] });
    }

    if (path.startsWith("/tfl/Journey/JourneyResults/")) {
      const walking = url.searchParams.get("mode") === "walking";
      return send(200, { journeys: walking
        ? [{ duration: 21, legs: [{ mode: { id: "walking" } }] }]
        : [{ duration: 14, legs: [{ mode: { id: "walking" } }, { mode: { id: "bus" }, routeOptions: [{ name: "65" }] }] }] });
    }

    if (path.startsWith("/postcodes/postcodes/")) return send(200, { status: 200, result: { postcode: path.split("/").pop(), latitude: 51.44, longitude: -0.3 } });
    if (path.startsWith("/postcodes/outcodes/")) return send(200, { status: 200, result: { outcode: path.split("/").pop(), latitude: 51.45, longitude: -0.29 } });

    if (path === "/notify") return send(200, { ok: true });

    send(404, { error: `no mock for ${req.method} ${path}` });
  });

  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        calls,
        doc: (p) => (docs.has(p) ? fromFields(docs.get(p)) : null),
        paths: () => [...docs.keys()],
        close: () => server.close(),
      }),
    ),
  );
}
