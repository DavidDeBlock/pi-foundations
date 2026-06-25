// =====================================================================
// backup.js — Backup / restore helpers for ISSUE-006
//
// All state lives in one browser's localStorage; this module adds a
// round-trippable JSON export, a CSV view of the transactions for Excel,
// and a replace-only JSON import with a dry-run preview and a pre-import
// safety snapshot.
//
// Design notes:
//  * `buildExport` / `buildCSV` are pure: given a state, they return a
//    serialisable payload or a CSV string. No DOM, no downloads.
//  * `exportJSON` / `exportCSV` take the built payload and trigger a
//    download via a Blob + temporary anchor.
//  * `parseAndValidate` reads a text blob, runs `JSON.parse`, and checks
//    the envelope. It returns either `{ok:true, data}` or
//    `{ok:false, error}` — never throws on bad input.
//  * `applyImport` mutates state in place. It writes the pre-import
//    snapshot *first* so a throw during apply can be recovered from
//    without losing the user's data.
// =====================================================================

const Backup = (() => {
  const SCHEMA_VERSION = 1;
  const APP_TAG = 'cozy-ledger';
  const SNAPSHOT_KEY = 'cozy_ledger_pre_import_backup';

  // ---- Pure helpers -------------------------------------------------

  // RFC 4180 escape: wrap in `"` if the value contains `,`, `"`, CR, or LF.
  // Inner `"` are doubled.
  function csvEscape(value) {
    const s = value == null ? '' : String(value);
    if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function csvRow(fields) {
    return fields.map(csvEscape).join(',');
  }

  function ymd(d) {
    const dt = d instanceof Date ? d : new Date(d);
    if (isNaN(dt.getTime())) return '';
    return dt.toISOString().slice(0, 10);
  }

  // Build a serialisable JSON backup object. The state is deep-cloned so
  // future mutations to the live state do not leak into the backup.
  function buildExport(state) {
    return {
      schemaVersion: SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      app: APP_TAG,
      state: JSON.parse(JSON.stringify(state)),
    };
  }

  // Build the CSV payload (transactions only). Sorted by date descending.
  // `null`/missing entities (categoryId, paidByUserId, sourceId) yield
  // empty cells.
  function buildCSV(state) {
    const cats  = new Map((state.categories || []).map(c => [c.id, c]));
    const users = new Map((state.users     || []).map(u => [u.id, u]));
    const srcs  = new Map((state.sources   || []).map(s => [s.id, s]));

    const header = ['Date', 'Description', 'Amount', 'Type', 'Category', 'User', 'Source', 'Scope', 'Notes'];
    const lines = [csvRow(header)];

    const txns = (state.transactions || []).slice().sort((a, b) => {
      // Sort by date desc, then by createdAt desc as a stable tiebreak.
      const d = b.date.localeCompare(a.date);
      if (d !== 0) return d;
      return (b.createdAt || '').localeCompare(a.createdAt || '');
    });

    for (const t of txns) {
      const cat  = t.categoryId   && cats.get(t.categoryId);
      const user = t.paidByUserId && users.get(t.paidByUserId);
      const src  = t.sourceId     && srcs.get(t.sourceId);

      const amount = (typeof t.amount === 'number' && isFinite(t.amount))
        ? t.amount.toString()
        : '';

      lines.push(csvRow([
        ymd(t.date),
        t.description || '',
        amount,
        t.type || '',
        cat  ? cat.name  : '',
        user ? user.name : '',
        src  ? src.name  : '',
        t.scope || '',
        t.notes || '',
      ]));
    }

    // RFC 4180 uses CRLF. Excel accepts either; CRLF is the safer default.
    return lines.join('\r\n') + '\r\n';
  }

  // Parse and validate a backup file's text content. Returns
  // `{ok:true, data}` or `{ok:false, error}` — never throws on bad input.
  function parseAndValidate(text) {
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      return { ok: false, error: 'Backup file is not valid JSON.' };
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { ok: false, error: 'Backup file is not a JSON object.' };
    }
    if (!('schemaVersion' in data)) {
      return { ok: false, error: 'Backup is missing schemaVersion.' };
    }
    if (data.schemaVersion !== SCHEMA_VERSION) {
      return { ok: false, error: `Backup schema version ${data.schemaVersion} is not supported by this app version (expected ${SCHEMA_VERSION}).` };
    }
    if (!data.state || typeof data.state !== 'object' || Array.isArray(data.state)) {
      return { ok: false, error: 'Backup is missing the "state" key.' };
    }
    return { ok: true, data };
  }

  // Count the records in a parsed backup payload. Used for the dry-run
  // summary modal. Tolerates missing keys (treats them as zero).
  function countRecords(parsed) {
    const s = parsed && parsed.state;
    if (!s || typeof s !== 'object') return { transactions: 0, categories: 0, sources: 0, users: 0, groups: 0 };
    return {
      transactions: Array.isArray(s.transactions) ? s.transactions.length : 0,
      categories:   Array.isArray(s.categories)   ? s.categories.length   : 0,
      sources:      Array.isArray(s.sources)      ? s.sources.length      : 0,
      users:        Array.isArray(s.users)        ? s.users.length        : 0,
      groups:       Array.isArray(s.groups)       ? s.groups.length       : 0,
    };
  }

  // Apply an import in place. Writes the pre-import snapshot FIRST so
  // a throw during apply can be recovered from. Returns `null` on
  // success, or `{error}` if anything went wrong (state has already
  // been restored in that case).
  function applyImport(state, parsed, save) {
    const snapshot = {
      savedAt: new Date().toISOString(),
      state: JSON.parse(JSON.stringify(state)),
    };
    try {
      localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snapshot));
    } catch (e) {
      return { error: 'Could not write safety snapshot: ' + (e && e.message || 'unknown') };
    }

    try {
      // Replace every top-level key in parsed.state. Keys that are NOT
      // present in parsed.state (e.g. `groups` on a pre-ISSUE-007 backup)
      // are left alone.
      for (const k of Object.keys(parsed.state)) {
        state[k] = parsed.state[k];
      }
      save(state);
      return null;
    } catch (e) {
      // Restore from snapshot and persist the restored state.
      try {
        for (const k of Object.keys(snapshot.state)) {
          state[k] = snapshot.state[k];
        }
        save(state);
      } catch (_) { /* swallow — we still want the original error to surface */ }
      return { error: 'Import failed: ' + (e && e.message || 'unknown') };
    }
  }

  // ---- DOM-driven download -----------------------------------------

  function _triggerDownload(filename, mime, content) {
    if (typeof window === 'undefined') return;
    const Blob_ = window.Blob;
    const URL_  = window.URL;
    if (!Blob_ || !URL_ || !URL_.createObjectURL) return;
    const blob = new Blob_([content], { type: mime });
    const url = URL_.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Revoke after a tick so the click has time to start the download.
    setTimeout(() => { try { URL_.revokeObjectURL(url); } catch (_) {} }, 100);
  }

  function exportJSON(state) {
    const payload = buildExport(state);
    const ymd = (payload.exportedAt || new Date().toISOString()).slice(0, 10);
    _triggerDownload(`cozy-ledger-backup-${ymd}.json`, 'application/json', JSON.stringify(payload, null, 2));
  }

  function exportCSV(state) {
    const csv = buildCSV(state);
    const ymd = new Date().toISOString().slice(0, 10);
    _triggerDownload(`cozy-ledger-transactions-${ymd}.csv`, 'text/csv;charset=utf-8', csv);
  }

  // Read a `File` as UTF-8 text via FileReader. Returns a Promise.
  function readFileText(file) {
    return new Promise((resolve, reject) => {
      if (!window.FileReader) { reject(new Error('FileReader not available')); return; }
      const reader = new window.FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(reader.error || new Error('File read failed'));
      reader.readAsText(file, 'utf-8');
    });
  }

  return {
    SCHEMA_VERSION,
    APP_TAG,
    SNAPSHOT_KEY,
    // pure
    csvEscape, csvRow, ymd,
    buildExport, buildCSV,
    parseAndValidate, countRecords, applyImport,
    // DOM-driven
    exportJSON, exportCSV, readFileText,
  };
})();

window.Backup = Backup;
