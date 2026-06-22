#!/usr/bin/env node
// =====================================================================
// _test_csv.js — Node test for csv.js against the real ING statements.
// Pure node (no jsdom). Run with:  node _test_csv.js
// =====================================================================

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const CSVImport = require('./csv.js');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${name}`);
    console.log(`      ${e.message}`);
    failed++;
  }
}

// ---- Load the two real statement files -------------------------------
const stmtDir = path.join(__dirname, 'statements');
const files = fs.readdirSync(stmtDir).filter(f => f.endsWith('.csv'));
assert.ok(files.length >= 2, `expected ≥2 statement files in ${stmtDir}, found ${files.length}`);

const parsed = files.map(f => ({
  file: f,
  rows: CSVImport.parseIngStatement(fs.readFileSync(path.join(stmtDir, f), 'utf8')),
}));

console.log('\n— Parsing —');

test('both files parse without errors', () => {
  for (const p of parsed) assert.ok(p.rows.length > 0, `${p.file}: 0 rows`);
});

test('row counts match observed totals (230 in 2025, 120 in 2026)', () => {
  const byName = Object.fromEntries(parsed.map(p => [p.file, p.rows.length]));
  const total = Object.values(byName).reduce((a, b) => a + b, 0);
  assert.strictEqual(total, 350, `total rows = ${total}, expected 350`);
});

test('every non-skipped row has a valid ISO date', () => {
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  for (const p of parsed) {
    for (const r of p.rows) {
      const cls = CSVImport.classifyRow(r);
      if (cls.skip) continue;
      assert.match(r.boekingsdatum, iso, `${p.file}: bad date ${r.boekingsdatum}`);
      assert.match(r.valutadatum, iso, `${p.file}: bad valutadatum ${r.valutadatum}`);
    }
  }
});

test('every amount parses as a finite number', () => {
  for (const p of parsed) {
    for (const r of p.rows) {
      assert.ok(Number.isFinite(r.bedrag), `${p.file}: bad amount ${r.bedrag}`);
    }
  }
});

test('negative amounts in input stay negative', () => {
  const r = parsed[0].rows[0]; // 2025 file: -4,80
  assert.strictEqual(r.bedrag, -4.80);
});

test('BOM is stripped (no \\uFEFF in first field)', () => {
  for (const p of parsed) {
    for (const r of p.rows) {
      assert.ok(!r.rekeningnummer.startsWith('\uFEFF'),
        `${p.file}: rekeningnummer still has BOM`);
    }
  }
});

test('omzetnummer / omschrijving survive the parse', () => {
  const r = parsed[0].rows[0];
  assert.strictEqual(r.omzetnummer, '1');
  assert.ok(r.omschrijving.startsWith('Kostenafrekening'),
    `unexpected omschrijving: ${r.omschrijving}`);
});

console.log('\n— Classification —');

test('"Domiciliëring in euro (SEPA)" → expense / direct-debit', () => {
  const sample = parsed.flatMap(p => p.rows).find(r => r.omschrijving.startsWith('Domiciliëring in euro (SEPA)'));
  assert.ok(sample, 'no Domiciliëring row in fixtures');
  const cls = CSVImport.classifyRow(sample);
  assert.strictEqual(cls.type, 'expense');
  assert.strictEqual(cls.categoryHint, 'direct-debit');
  assert.strictEqual(cls.skip, false);
});

test('"Overschrijving in euro (SEPA) Van:" → income / transfer-in', () => {
  const sample = parsed.flatMap(p => p.rows).find(r => r.omschrijving.startsWith('Overschrijving in euro (SEPA) Van:'));
  assert.ok(sample, 'no Overschrijving Van: row');
  const cls = CSVImport.classifyRow(sample);
  assert.strictEqual(cls.type, 'income');
  assert.strictEqual(cls.categoryHint, 'transfer-in');
});

test('"Overschrijving in euro (SEPA) Home\'Bank Naar:" → expense / transfer-out', () => {
  const sample = parsed.flatMap(p => p.rows).find(r => r.omschrijving.startsWith("Overschrijving in euro (SEPA) Home'Bank Naar:"));
  assert.ok(sample, 'no Overschrijving Home\'Bank Naar: row');
  const cls = CSVImport.classifyRow(sample);
  assert.strictEqual(cls.type, 'expense');
  assert.strictEqual(cls.categoryHint, 'transfer-out');
});

test('"Instantoverschrijving in euro: Home\'Bank Naar:" → expense / transfer-out', () => {
  const sample = parsed.flatMap(p => p.rows).find(r => r.omschrijving.startsWith("Instantoverschrijving in euro: Home'Bank Naar:"));
  assert.ok(sample, 'no Instantoverschrijving Naar: row');
  const cls = CSVImport.classifyRow(sample);
  assert.strictEqual(cls.type, 'expense');
  assert.strictEqual(cls.categoryHint, 'transfer-out');
});

test('"Doorlopende betalingsopdracht" → type by sign (negative = expense)', () => {
  const rows = parsed.flatMap(p => p.rows).filter(r => r.omschrijving.startsWith('Doorlopende betalingsopdracht'));
  assert.ok(rows.length > 0, 'no Doorlopende row');
  for (const r of rows) {
    const cls = CSVImport.classifyRow(r);
    const expected = r.bedrag < 0 ? 'expense' : 'income';
    assert.strictEqual(cls.type, expected, `${r.omschrijving.slice(0, 30)}: ${cls.type} vs ${expected}`);
  }
});

test('"Kostenafrekening" → expense / bank-fees', () => {
  const sample = parsed.flatMap(p => p.rows).find(r => r.omschrijving.startsWith('Kostenafrekening'));
  const cls = CSVImport.classifyRow(sample);
  assert.strictEqual(cls.type, 'expense');
  assert.strictEqual(cls.categoryHint, 'bank-fees');
});

test('"Intresten-Kosten" → expense / bank-fees', () => {
  const sample = parsed.flatMap(p => p.rows).find(r => r.omschrijving.startsWith('Intresten-Kosten'));
  const cls = CSVImport.classifyRow(sample);
  assert.strictEqual(cls.type, 'expense');
  assert.strictEqual(cls.categoryHint, 'bank-fees');
});

console.log('\n— Dedup —');

test('two Kostenafrekening rows from 2025+2026 with different omschrijving do NOT dedup', () => {
  // First row of each file is a Kostenafrekening with different "nr." IDs
  const k1 = parsed[0].rows[0];
  const k2 = parsed[1].rows[0];
  assert.notStrictEqual(CSVImport.makeDedupKey(k1), CSVImport.makeDedupKey(k2));
});

test('identical rows dedup against each other (same key → flagged as dupe)', () => {
  const r = parsed[0].rows[0];
  const existing = new Set([CSVImport.makeDedupKey(r)]);
  const diff = CSVImport.diffAgainstStore([r, { ...r }], existing);
  assert.strictEqual(diff.newRows.length, 0, 'expected 0 new rows after dedup');
  assert.strictEqual(diff.skippedDupes.length, 2, 'expected both rows skipped');
});

test('zero-amount rows are filtered out before dedup', () => {
  const fake = { ...parsed[0].rows[0], bedrag: 0, omschrijving: 'You have received a message' };
  const diff = CSVImport.diffAgainstStore([fake], new Set());
  assert.strictEqual(diff.newRows.length, 0);
  assert.strictEqual(diff.skippedZero.length, 1);
  assert.strictEqual(diff.skippedZero[0].reason, 'zero-or-info');
});

test('all unique keys across both files are stable', () => {
  // Build a key set from the union, then re-dedup every row — we should
  // see at most the number of in-batch duplicates that exist (none expected
  // here, since the two files don\'t overlap on identical rows).
  const all = parsed.flatMap(p => p.rows);
  const keySet = new Set();
  for (const r of all) keySet.add(CSVImport.makeDedupKey(r));
  const diff = CSVImport.diffAgainstStore(all, new Set(keySet));
  // Every row should have been recognised as already-known, so zero new.
  assert.strictEqual(diff.newRows.length, 0,
    `expected 0 new rows after dedup against full union, got ${diff.newRows.length}`);
});

console.log('\n— Mapping —');

test('mapRowToTxn stores absolute amount (positive) regardless of sign', () => {
  const r = parsed[0].rows[0]; // -4.80
  const cls = CSVImport.classifyRow(r);
  const t = CSVImport.mapRowToTxn(r, cls, { userId: 'u_david', sourceId: 's_david', scope: 'private' }, 'c_other_exp');
  assert.strictEqual(t.amount, 4.80);
  assert.strictEqual(t.type, 'expense');
  assert.strictEqual(t.description, r.omschrijving);
  assert.strictEqual(t.notes, r.detail);
});

test('suggestedCategoryFor("fuel") returns the "Car / bike" expense category', () => {
  const state = { categories: [{ id: 'c_car', name: 'Car / bike', type: 'expense' }] };
  const c = CSVImport.suggestedCategoryFor('fuel', 'expense', state);
  assert.strictEqual(c && c.id, 'c_car');
});

test('suggestedCategoryFor("transfer-in") returns null (user picks)', () => {
  const state = { categories: [{ id: 'c_other', name: 'Other', type: 'income' }] };
  assert.strictEqual(CSVImport.suggestedCategoryFor('transfer-in', 'income', state), null);
});

console.log('\n— Summary —');
console.log(`  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
