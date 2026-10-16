/* ==========================================================================
   A MODULE THAT LOADS AFTER THE PAGE (packages/ui/load-module.js)

   The failure measured on 16 Oct 2026: a page from the build before the
   latest deploy (assets /_v/a5ff3b9fd514/) opened the campus map, and
   /_v/a5ff3b9fd514/packages/ui/map.js answered 404 because the deploy had
   replaced every asset. The loader must name that case truthfully and must
   leave every other failure exactly as it was.
   ========================================================================== */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadModule, versionOf, StaleDeployment } from '../../packages/ui/load-module.js';

const OLD_PAGE = 'https://www.echoecho.tech/_v/a5ff3b9fd514/web/src/app.js';
const CHUNK_ERROR = new TypeError(
  'Failed to fetch dynamically imported module: https://www.echoecho.tech/_v/a5ff3b9fd514/packages/ui/map.js');
const failing = () => Promise.reject(CHUNK_ERROR);
const serving = (version, calls = []) => async (url, init) => {
  calls.push([url, init]);
  return { ok: true, json: async () => ({ version }) };
};

test('versionOf reads the build hash from a module URL', () => {
  assert.equal(versionOf(OLD_PAGE), 'a5ff3b9fd514');
  assert.equal(versionOf('http://localhost:3000/web/src/app.js'), null, 'an unbuilt page has no version');
});

test('a module that loads is returned as it is, with no version lookup', async () => {
  const calls = [];
  const mod = { drawPickerMap() {} };
  assert.equal(await loadModule(async () => mod, OLD_PAGE, { fetchImpl: serving('479aed949e6a', calls) }), mod);
  assert.equal(calls.length, 0);
});

test('the deploy replaced this page\'s assets: StaleDeployment, after an uncached version read', async () => {
  const calls = [];
  await assert.rejects(loadModule(failing, OLD_PAGE, { fetchImpl: serving('479aed949e6a', calls) }), (e) => {
    assert.ok(e instanceof StaleDeployment);
    assert.equal(e.pageVersion, 'a5ff3b9fd514');
    assert.equal(e.liveVersion, '479aed949e6a');
    assert.match(e.message, /updated while this page was open/);
    return true;
  });
  assert.deepEqual(calls, [['/version.json', { cache: 'no-store', credentials: 'same-origin' }]]);
});

test('the page IS the live version: the real error is rethrown, not relabelled', async () => {
  await assert.rejects(loadModule(failing, OLD_PAGE, { fetchImpl: serving('a5ff3b9fd514') }), (e) => e === CHUNK_ERROR);
});

test('the version cannot be read: the real error is rethrown', async () => {
  const offline = async () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(loadModule(failing, OLD_PAGE, { fetchImpl: offline }), (e) => e === CHUNK_ERROR);
  const notFound = async () => ({ ok: false, json: async () => ({}) });
  await assert.rejects(loadModule(failing, OLD_PAGE, { fetchImpl: notFound }), (e) => e === CHUNK_ERROR);
});

test('a module that throws while evaluating is rethrown as itself', async () => {
  const boom = new SyntaxError('Unexpected token');
  await assert.rejects(loadModule(() => Promise.reject(boom), OLD_PAGE, { fetchImpl: serving('a5ff3b9fd514') }),
    (e) => e === boom);
});
