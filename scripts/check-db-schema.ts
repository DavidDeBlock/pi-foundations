import Database from 'better-sqlite3';
import path from 'path';

const dbPath = path.join(__dirname, '..', 'data', 'database.db');
const db = new Database(dbPath);
console.log('PRAGMA table_info(customers):');
const rows = db.pragma("SELECT * FROM pragma_table_info('customers')");
for (const row of rows) {
  console.log(`  ${row.name} (${row.type})`);
}
db.close();
