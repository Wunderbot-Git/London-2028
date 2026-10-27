// Firestore REST (v1) value encoding. n8n talks to Firestore through HTTP Request nodes with a
// Google service account, so documents travel as typed "fields" maps.

const TIMESTAMP_KEYS = new Set(["firstSeenAt", "lastSeenAt", "createdAt", "computedAt", "updatedAt"]);

export function toValue(v, key) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === "string") return TIMESTAMP_KEYS.has(key) ? { timestampValue: v } : { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: v.length ? { values: v.map((x) => toValue(x)) } : {} };
  if (typeof v === "object") return { mapValue: { fields: toFields(v) } };
  throw new Error(`Cannot encode ${typeof v}`);
}

export function toFields(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = toValue(v, k);
  return out;
}

export function fromValue(v) {
  if (!v || "nullValue" in v) return null;
  if ("booleanValue" in v) return v.booleanValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("stringValue" in v) return v.stringValue;
  if ("timestampValue" in v) return v.timestampValue;
  if ("referenceValue" in v) return v.referenceValue;
  if ("arrayValue" in v) return (v.arrayValue.values ?? []).map(fromValue);
  if ("mapValue" in v) return fromFields(v.mapValue.fields ?? {});
  return null;
}

export function fromFields(fields = {}) {
  return Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, fromValue(v)]));
}

/** Last path segment of a Firestore document name. */
export const docId = (name) => name.split("/").pop();

/** documents:runQuery body for `collection where field == value`. */
export function equalityQuery(collection, field, value, limit = 5) {
  return {
    structuredQuery: {
      from: [{ collectionId: collection }],
      where: { fieldFilter: { field: { fieldPath: field }, op: "EQUAL", value: toValue(value) } },
      limit,
    },
  };
}

/** documents from a runQuery response (array of { document?, readTime }). */
export function queryDocs(body) {
  return (Array.isArray(body) ? body : [])
    .filter((r) => r.document)
    .map((r) => ({ id: docId(r.document.name), ...fromFields(r.document.fields) }));
}

/** documents:commit write that sets only the given fields of an existing or new document. */
export function updateWrite(name, data, { merge = true } = {}) {
  return {
    update: { name, fields: toFields(data) },
    ...(merge ? { updateMask: { fieldPaths: Object.keys(data) } } : {}),
  };
}
