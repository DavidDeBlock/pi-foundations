// Debug: re-run the failing test scenario and capture the error.
import fs from 'fs';
import vm from 'vm';

const ctx = { console };
const code = fs.readFileSync('/home/david/projects/pi-foundations/projects/cozy-ledger/_test_boot.js', 'utf8');

// Wrap to add a try/catch around test bodies so we see where it dies.
const wrapped = code.replace(/^test\((.+?), \(\) => \{/gm, (m, args) => {
  return `test(${args}, () => { try {`;
}).replace(/console\.log\('\\n— End-to-end/g, `} catch (e) { console.log('CAUGHT:', e.stack || e.message); }\nconsole.log('\\n— End-to-end`);

vm.createContext(ctx);
vm.runInContext(wrapped, ctx);