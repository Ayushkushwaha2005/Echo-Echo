import { resolveLocationPhrase, pathLabel, nodeById, destinationOptions } from '../packages/data/campus.js';
const cases = ['Ground pe bhej do','Library mein','Block B ke third floor pe','basketball court ke paas',
  'hostel A block 2','block b pe bhej do','audi ke bahar wale gate','CS lab 2 mein','B-307 pe','LT-3 mein'];
let bad = 0;
for (const c of cases) {
  const h = resolveLocationPhrase(c);
  console.log(`  "${c}"\n     → ${h.length ? h.map(x => pathLabel(x)).join('  |  ') : '(no match)'}`);
}
const hb = resolveLocationPhrase('hostel A block 2');
console.log('\n  hostel A block 2 resolves to exactly one place:', hb.length === 1 && pathLabel(hb[0]) === 'Hostel Area — Hostel A — Block 2' ? 'PASS' : 'FAIL — ' + hb.map(pathLabel).join(' | '));
if (!(hb.length === 1)) bad++;
const bb = resolveLocationPhrase('block b pe bhej do');
console.log('  block b stays ambiguous (2 areas):', bb.length === 2 ? 'PASS' : 'FAIL'); if (bb.length !== 2) bad++;
const b3 = resolveLocationPhrase('Block B ke third floor pe');
console.log('  block b + third floor keeps both areas for disambiguation:', b3.length === 2 ? 'PASS' : 'FAIL'); if (b3.length !== 2) bad++;
process.exit(bad ? 1 : 0);
