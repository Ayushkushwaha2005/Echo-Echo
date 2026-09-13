import { runPermissionTests, api, authorize, userById, Denied } from '../packages/data/api.js';
import { insideCampus, resolveLocationPhrase, pathLabel, destinationOptions, nodeById, deliverableNodes } from '../packages/data/campus.js';
import { VENDORS, ITEMS } from '../packages/data/catalog.js';

let fails = 0;
const ok = (c, m) => { console.log(`  ${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fails++; };

console.log('\n== Permission matrix ==');
for (const t of runPermissionTests()) ok(t.ok, `${t.name} → ${t.got}`);

const admin = userById('usr_admin'), frisco = userById('usr_owner_frisco'), staff = userById('usr_staff_frisco');

console.log('\n== Shopkeeper scoping (acceptance criteria) ==');
const tulipsItem = ITEMS.find(i => i.caf === 'caf_tulips');
try { api.updateItem(frisco, tulipsItem.id, { desc: 'x' }); ok(false, 'Frisco owner edited Tulips item'); }
catch (e) { ok(e instanceof Denied, `Frisco owner blocked from Tulips: "${e.message}"`); }
const friscoItem = ITEMS.find(i => i.caf === 'caf_frisco');
try { api.updateItem(frisco, friscoItem.id, { desc: 'own edit' }); ok(true, 'Frisco owner edits own item'); }
catch (e) { ok(false, 'own edit blocked: ' + e.message); }
try { api.updateItem(staff, friscoItem.id, { price: 99 }); ok(false, 'staff changed a price'); }
catch (e) { ok(true, `Counter staff blocked from price change: "${e.message}"`); }
try { api.setAvailability(staff, friscoItem.id, false); ok(true, 'Counter staff toggles own availability'); }
catch (e) { ok(false, 'availability blocked: ' + e.message); }
api.setAvailability(staff, friscoItem.id, true);

console.log('\n== Vendor CRUD without breaking history ==');
const before = VENDORS.length;
const v4 = api.createVendor(admin, { name: 'Nescafe Corner', kind: 'Coffee & bakes', zone: 'z_acad', prep_minutes: 6 });
ok(VENDORS.length === before + 1, `Admin added outlet #${VENDORS.length}: ${v4.name} (${v4.id})`);
ok(v4.is_open === false, 'New outlet starts closed until owner opens it');
const it4 = api.createItem(admin, v4.id, { name: 'Filter Coffee', price: 35, cat: 'Coffee', aliases: 'filter, kaapi' });
ok(it4.price === 3500, 'Price stored as paise integer (₹35 → 3500)');
api.archiveVendor(admin, 'caf_tulips');
ok(VENDORS.find(v => v.id === 'caf_tulips').active === false, 'Tulips archived (deactivated, not deleted)');
ok(!!VENDORS.find(v => v.id === 'caf_tulips'), 'Archived vendor row still exists → historical orders resolve');
api.restoreVendor(admin, 'caf_tulips');

console.log('\n== Campus boundary ==');
ok(insideCampus(28.6155, 77.2078) === true, 'A point inside the campus polygon is accepted');
ok(insideCampus(28.7041, 77.1025) === false, 'Delhi city centre rejected as off-campus');
const outside = api.resolveLiveLocation(admin, 28.7041, 77.1025);
ok(outside.inside === false && outside.candidates.length === 0, 'Server refuses to resolve an off-campus fix');
const inside = api.resolveLiveLocation(admin, 28.6157, 77.2078);
ok(inside.inside === true && inside.candidates.length > 0, `On-campus fix → ${inside.candidates.length} candidates, nearest ${inside.candidates[0].label} (${inside.candidates[0].metres}m)`);
try { api.validateDestination(admin, 'Sector 18, Noida'); ok(false, 'accepted a free-text address'); }
catch (e) { ok(true, `Free-text address refused: "${e.message}"`); }
try { api.validateDestination(admin, 'z_acad'); ok(false, 'accepted a non-deliverable container'); }
catch (e) { ok(true, 'Non-deliverable container node refused'); }
ok(api.validateDestination(admin, 's_b_307').label.includes('Room B-307'), 'Deliverable leaf accepted: ' + api.validateDestination(admin, 's_b_307').label);

console.log('\n== Hierarchical location resolution (AI) ==');
const cases = [
  ['Ground pe bhej do', 1],
  ['Library mein', 1],
  ['Block B ke third floor pe', null],
  ['basketball court ke paas', 1],
  ['hostel A block 2', null],
];
for (const [phrase] of cases) {
  const hits = resolveLocationPhrase(phrase);
  console.log(`  "${phrase}" → [${hits.map(h => pathLabel(h)).join(' | ')}]`);
}
const blockB = resolveLocationPhrase('block b pe bhej do');
ok(blockB.length === 2, `"block b" is ambiguous → ${blockB.length} matches: ${blockB.map(h => pathLabel(h)).join(' ; ')}`);
const b3 = resolveLocationPhrase('block b ke third floor pe');
ok(b3.some(h => nodeById(h).name === '3rd Floor'), 'Floor phrase refines the building: ' + b3.map(h => pathLabel(h)).join(' ; '));
const opts = destinationOptions(b3.find(h => nodeById(h).name === '3rd Floor'));
ok(opts.length === 2, `3rd Floor offers ${opts.length} rooms: ${opts.map(o => o.name).join(', ')}`);

console.log('\n== Server-side pricing ==');
const p = api.priceOrder([{ unit: 5000, qty: 2 }, { unit: 9000, qty: 1 }, { unit: 6000, qty: 1 }], 'delivery');
ok(p.total === 26500, `2 cold coffee + burger + fries + delivery = ₹${p.total/100} (roadmap example ₹265)`);
ok(api.priceOrder([{ unit: 5000, qty: 2 }], 'pickup').fee === 0, 'Self pickup carries no delivery fee');

console.log(`\n${fails === 0 ? 'ALL CHECKS PASSED' : fails + ' CHECK(S) FAILED'}`);
process.exit(fails ? 1 : 0);
