// =====================================================================
// csv.js — ING Belgium CSV statement import
// Pure functions: parsing, type classification, dedup, transaction mapping.
// No DOM access. Loaded before app.js so the import modal can use it.
// =====================================================================

const CSVImport = (() => {
  // Strip the boilerplate off an ING Belgium description and return the
  // merchant or counterparty name. Falls back to the raw description if
  // no pattern matches (e.g. manually-typed transactions).
  function extractPayee(description) {
    if (!description) return '';
    let m;
    // Betaling Bancontact DD/MM/YY - HH.MM uur - MERCHANT POSTAL - CITY - ...
    m = description.match(/^Betaling Bancontact \d{2}\/\d{2}\/\d{2} - \d{2}\.\d{2} uur - (.+?) \d{4,} - /);
    if (m) return m[1].trim();
    // Domiciliëring in euro (SEPA) NAME Bericht als bijlage
    m = description.match(/^Domicili[ëe]ring in euro \(SEPA\) (.+?) Bericht als bijlage/);
    if (m) return m[1].trim();
    // Doorlopende betalingsopdracht in euro (SEPA) Naar: NAME - BE...
    m = description.match(/^Doorlopende betalingsopdracht in euro \(SEPA\) Naar: (.+?) - BE\d+/);
    if (m) return m[1].trim();
    // Overschrijving/Instantoverschrijving in euro (SEPA) [source] Naar: NAME - BE...
    m = description.match(/(?:Instant)?[Oo]verschrijving in euro (?:\(SEPA\) )?(?:.+? )?Naar: (.+?) - BE\d+/);
    if (m) return m[1].trim();
    // SEPA Van: NAME - BE...
    m = description.match(/(?:Instant)?[Oo]verschrijving in euro (?:\(SEPA\) )?(?:.+? )?Van: (.+?) - BE\d+/);
    if (m) return m[1].trim();
    return description;
  }

  // ---- Belgian-locale helpers ----------------------------------------

  // "01/01/2025" → "2025-01-01"
  function parseBelgianDate(s) {
    if (!s) return null;
    const m = String(s).trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (!m) return null;
    const [, dd, mm, yyyy] = m;
    return `${yyyy}-${mm}-${dd}`;
  }

  // "-4,80" → -4.80
  function parseBelgianAmount(s) {
    if (s == null) return 0;
    const cleaned = String(s).trim().replace(',', '.');
    const n = parseFloat(cleaned);
    return Number.isFinite(n) ? n : 0;
  }

  // ---- Main parser ----------------------------------------------------

  // Parse the full text of an ING Belgium CSV statement into a list of
  // normalised row objects. Returns [] for empty/invalid input.
  function parseIngStatement(text) {
    if (!text) return [];
    // Strip BOM (UTF-8 BOM is EF BB BF → U+FEFF)
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);

    const lines = text.split(/\r?\n/).filter(l => l.length > 0);
    // First line is the header; bail if it's not what we expect
    const expected =
      'Rekeningnummer;Naam van de rekening;Rekening tegenpartij;Omzetnummer;' +
      'Boekingsdatum;Valutadatum;Bedrag;Munteenheid;Omschrijving;' +
      'Detail van de omzet;Bericht';
    if (lines.length === 0 || lines[0].trim() !== expected) return [];

    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      // Split into at most 11 fields; re-join the trailing tail into Bericht
      // because Omschrijving/Detail/Bericht can contain semicolons.
      const parts = line.split(';');
      const head = parts.slice(0, 10);
      const tail = parts.slice(10).join(';');
      const fields = [...head, tail];
      while (fields.length < 11) fields.push('');

      const [
        rekeningnummer, naam, tegenpartij, omzetnummer,
        boekingsdatumRaw, valutadatumRaw, bedragRaw, munteenheid,
        omschrijving, detail, bericht,
      ] = fields;

      rows.push({
        rekeningnummer: (rekeningnummer || '').trim(),
        naam: (naam || '').trim(),
        tegenpartij: (tegenpartij || '').trim(),
        omzetnummer: (omzetnummer || '').trim(),
        boekingsdatum: parseBelgianDate(boekingsdatumRaw),
        valutadatum: parseBelgianDate(valutadatumRaw),
        bedrag: parseBelgianAmount(bedragRaw),
        munteenheid: (munteenheid || '').trim(),
        omschrijving: (omschrijving || '').trim(),
        detail: (detail || '').replace(/\s+/g, ' ').trim(),
        bericht: (bericht || '').trim(),
      });
    }
    return rows;
  }

  // ---- Type classifier ------------------------------------------------
  // Reads the `Omschrijving` prefix and decides if it's income / expense,
  // whether to skip it (zero amount, info message), and a coarse category
  // hint that the UI can map onto a real Category.

  function classifyRow(row) {
    const o = String(row.omschrijving || '').toLowerCase();

    // Skip rows that aren't real transactions.
    if (row.bedrag === 0 || o.startsWith('you have received a message')) {
      return { type: null, scope: null, categoryHint: null, skip: true, skipReason: 'zero-or-info' };
    }

    let type;
    let categoryHint = null;

    if (o.startsWith('overschrijving in euro') && o.includes(' van:')) {
      // SEPA transfer in (e.g. "(SEPA) Van:" or " Home'Bank Van:")
      type = 'income';
      categoryHint = 'transfer-in';
    } else if (o.startsWith('instantoverschrijving in euro') && o.includes(' van:')) {
      type = 'income';
      categoryHint = 'transfer-in';
    } else if (o.startsWith('overschrijving in euro') && o.includes(' naar:')) {
      type = 'expense';
      categoryHint = 'transfer-out';
    } else if (o.startsWith('instantoverschrijving in euro') && o.includes(' naar:')) {
      type = 'expense';
      categoryHint = 'transfer-out';
    } else if (o.startsWith('domiciliëring in euro')) {
      type = 'expense';
      categoryHint = 'direct-debit';
    } else if (o.startsWith('doorlopende betalingsopdracht')) {
      // Standing order — could be salary in or savings out. Amount sign decides.
      type = row.bedrag < 0 ? 'expense' : 'income';
      categoryHint = 'standing-order';
    } else if (o.startsWith('betaling tankbeurt bancontact')) {
      type = 'expense';
      categoryHint = 'fuel';
    } else if (o.startsWith('betaling bancontact')) {
      type = 'expense';
      categoryHint = 'bancontact';
    } else if (o.startsWith('terugbetaling ing card')) {
      type = 'expense';
      categoryHint = 'card-repayment';
    } else if (o.startsWith('kostenafrekening')) {
      type = 'expense';
      categoryHint = 'bank-fees';
    } else if (o.startsWith('intresten-kosten')) {
      type = 'expense';
      categoryHint = 'bank-fees';
    } else if (o.startsWith('hypothecair krediet')) {
      type = 'expense';
      categoryHint = 'mortgage';
    } else {
      // Unknown prefix: fall back to the sign of the amount.
      type = row.bedrag < 0 ? 'expense' : 'income';
    }

    return { type, scope: 'private', categoryHint, skip: false };
  }

  // ---- Dedup ----------------------------------------------------------

  // Composite key per the README: date + amount + counterparty IBAN + description head.
  function makeDedupKey(row) {
    return [
      row.boekingsdatum || '',
      (row.bedrag || 0).toFixed(2),
      row.tegenpartij || '—',
      String(row.omschrijving || '').slice(0, 40),
    ].join('|');
  }

  // Filter parsed rows against:
  //   - existing transactions (by dedup key)
  //   - zero/info rows (skipped, not imported)
  function diffAgainstStore(rows, existingKeySet) {
    const seenInThisBatch = new Set();
    const newRows = [];
    const skippedDupes = [];
    const skippedZero = [];

    for (const row of rows) {
      const cls = classifyRow(row);
      if (cls.skip) {
        skippedZero.push({ row, reason: cls.skipReason });
        continue;
      }
      const key = makeDedupKey(row);
      if (existingKeySet.has(key) || seenInThisBatch.has(key)) {
        skippedDupes.push({ row, key });
        continue;
      }
      seenInThisBatch.add(key);
      newRows.push({ row, classification: cls, key });
    }

    return { newRows, skippedDupes, skippedZero };
  }

  // ---- Mapping to app Transaction ------------------------------------

  // Resolve a classifier hint into an existing Category (or null).
  // The mapping is best-effort: hints like 'transfer-in' and 'direct-debit'
  // are too generic to auto-pick, so we leave those for the user.
  function suggestedCategoryFor(hint, type, state) {
    if (!state || !Array.isArray(state.categories)) return null;
    const byName = (name) => state.categories.find(c => c.name === name && c.type === type);
    switch (hint) {
      case 'fuel':           return byName('Car / bike');
      case 'mortgage':       return byName('Rent / mortgage');
      case 'bank-fees':      return byName('Other');
      case 'card-repayment': return byName('Other');
      // The rest stay user-selected in the preview UI:
      // bancontact, transfer-in, transfer-out, direct-debit, standing-order
      default: return null;
    }
  }

  // Build a Transaction-shaped object from a parsed row + classification.
  // Caller passes `defaults` for userId / sourceId / scope (the modal
  // collects these from a small form at the top).
  function mapRowToTxn(row, classification, defaults, suggestedCategoryId) {
    const amount = Math.abs(row.bedrag || 0);
    return {
      type: classification.type,
      amount,
      date: row.boekingsdatum || '',
      description: row.omschrijving || (row.detail || '').slice(0, 80),
      categoryId: suggestedCategoryId || defaults.categoryId || '',
      paidByUserId: defaults.userId || '',
      sourceId: defaults.sourceId || '',
      scope: defaults.scope || classification.scope || 'private',
      notes: row.detail || '',
    };
  }

  return {
    parseIngStatement,
    classifyRow,
    makeDedupKey,
    diffAgainstStore,
    suggestedCategoryFor,
    mapRowToTxn,
    extractPayee,
  };
})();

if (typeof window !== 'undefined') window.CSVImport = CSVImport;
// Allow plain-Node test harness to require() this file.
if (typeof module !== 'undefined' && module.exports) module.exports = CSVImport;
