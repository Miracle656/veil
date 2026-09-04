/**
 * Minimal CJS mock for smol-toml (ESM-only).
 * Only handles the subset of TOML that stellar.toml files typically use.
 */
function parse(str) {
  // Very basic TOML parser for stellar.toml files
  const result = {};
  let current = result;
  const stack = [result];
  const keys = [];

  for (const line of str.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Table header [section] or [[array of tables]]
    const tableMatch = trimmed.match(/^\[\[([^\]]+)\]\]$/);
    if (tableMatch) {
      const parts = tableMatch[1].split('.');
      let obj = result;
      for (const p of parts) {
        if (!obj[p]) obj[p] = [];
        const arr = obj[p];
        const newObj = {};
        arr.push(newObj);
        obj = newObj;
      }
      current = obj;
      continue;
    }

    const sectionMatch = trimmed.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      const parts = sectionMatch[1].split('.');
      let obj = result;
      for (const p of parts) {
        if (!obj[p]) obj[p] = {};
        obj = obj[p];
      }
      current = obj;
      continue;
    }

    // Key = value
    const kvMatch = trimmed.match(/^([a-zA-Z0-9_-]+)\s*=\s*(.+)$/);
    if (kvMatch) {
      const key = kvMatch[1];
      let val = kvMatch[2].trim();
      // String
      if (val.startsWith('"') && val.endsWith('"')) {
        current[key] = val.slice(1, -1);
      } else if (val.startsWith("'") && val.endsWith("'")) {
        current[key] = val.slice(1, -1);
      } else if (val === 'true') {
        current[key] = true;
      } else if (val === 'false') {
        current[key] = false;
      } else if (!isNaN(Number(val))) {
        current[key] = Number(val);
      } else {
        current[key] = val;
      }
    }
  }

  return result;
}

module.exports = { parse };
