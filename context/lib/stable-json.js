import { createHash } from "node:crypto";

function compareAsciiKeys(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Recursively rebuild plain objects with lexicographically sorted keys while preserving array order.
 */
export function stableSortObject(value, seen = new WeakSet()) {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    return "[Circular]";
  }
  if (Array.isArray(value)) {
    seen.add(value);
    const out = value.map((item) => stableSortObject(item, seen));
    seen.delete(value);
    return out;
  }
  if (!isPlainObject(value)) {
    return value;
  }
  seen.add(value);
  const sorted = {};
  for (const key of Object.keys(value).sort(compareAsciiKeys)) {
    Object.defineProperty(sorted, key, {
      value: stableSortObject(value[key], seen),
      enumerable: true,
      writable: true,
      configurable: true
    });
  }
  seen.delete(value);
  return sorted;
}

/** Deterministic JSON serialization with recursively sorted object keys */
export function stableStringify(value, space) {
  return JSON.stringify(stableSortObject(value), null, space);
}

/** Compute lowercase hex SHA-256 digest of a UTF-8 string */
export function sha256Hex(text) {
  return createHash("sha256").update(String(text ?? ""), "utf8").digest("hex");
}

/**
 * Strictly truncate a string to <= maxBytes UTF-8 bytes without splitting
 * multi-byte characters, surrogate pairs, or stripping legitimate U+FFFD chars.
 */
export function truncateUtf8Safe(text, maxBytes) {
  if (!text) return "";
  const limit = Number.isFinite(Number(maxBytes)) ? Math.max(0, Math.floor(Number(maxBytes))) : 0;
  if (limit === 0) return "";
  const str = String(text);
  const buf = Buffer.from(str, "utf8");
  if (buf.length <= limit) return str;
  let cut = limit;
  while (cut > 0 && (buf[cut] & 0xc0) === 0x80) {
    cut -= 1;
  }
  if (cut > 0) {
    let lastLead = cut - 1;
    while (lastLead > 0 && (buf[lastLead] & 0xc0) === 0x80) {
      lastLead -= 1;
    }
    const lead = buf[lastLead];
    let expectedLen = 1;
    if ((lead & 0xe0) === 0xc0) expectedLen = 2;
    else if ((lead & 0xf0) === 0xe0) expectedLen = 3;
    else if ((lead & 0xf8) === 0xf0) expectedLen = 4;
    if (cut - lastLead < expectedLen) {
      cut = lastLead;
    }
  }
  let out = buf.subarray(0, cut).toString("utf8");
  if (out.length > 0) {
    const lastCode = out.charCodeAt(out.length - 1);
    if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
      out = out.slice(0, -1);
    }
  }
  return out;
}
