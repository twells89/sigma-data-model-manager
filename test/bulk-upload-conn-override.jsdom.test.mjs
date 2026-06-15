/**
 * JSDOM regression test for the bulk-upload (Import Data Models) connection
 * override — the cross-org porting path.
 *
 * Bug: the override only rewrote el.source.connectionId at the top level, so
 * any element whose connectionId nests deeper kept the origin org's id:
 *   - join sources:    source.joins[].left/right (recursively nested joins)
 *   - control sources: source.source.connectionId
 *
 * Loads index.html into JSDOM, mocks sigmaFetch to capture the POSTed spec,
 * and runs the real handleBulkUpload() with a connection override against a
 * fixture that mirrors the source shapes observed in a live GET
 * /v2/dataModels/{id}/spec (warehouse-table, join, control, sql,
 * element-sourced derived table).
 *
 * Run (from repo root, after `npm install --no-save jsdom`):
 *   node test/bulk-upload-conn-override.jsdom.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';
import { JSDOM, VirtualConsole } from 'jsdom';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = join(__dirname, '..', 'index.html');

const OLD = 'OLD-CONN-1111';
const NEW = 'NEW-CONN-2222';

const fixtureSpec = {
  dataModelId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  schemaVersion: 1,
  name: 'Conn Override Fixture',
  pages: [{
    name: 'Page 1',
    _internalNote: 'should be stripped',
    elements: [
      // 1. plain warehouse table — the only case the old code handled
      {
        kind: 'table', elementId: 'el_base', name: 'D_STORE',
        source: { connectionId: OLD, kind: 'warehouse-table', path: ['DB', 'SCH', 'D_STORE'] },
      },
      // 2. join source, including a nested join on the right side
      {
        kind: 'table', elementId: 'el_join', name: 'Sales Joined',
        source: {
          kind: 'join',
          joins: [{
            left: { connectionId: OLD, kind: 'warehouse-table', path: ['DB', 'SCH', 'F_SALES'] },
            right: {
              kind: 'join',
              joins: [{
                left: { connectionId: OLD, kind: 'warehouse-table', path: ['DB', 'SCH', 'D_PRODUCT'] },
                right: { connectionId: OLD, kind: 'warehouse-table', path: ['DB', 'SCH', 'D_DATE'] },
                joinType: 'inner', on: [],
              }],
            },
            joinType: 'left', on: [],
          }],
        },
      },
      // 3. control whose source wraps a warehouse table one level down
      {
        kind: 'control', elementId: 'el_ctrl', controlType: 'list-values',
        source: {
          kind: 'source',
          source: { kind: 'warehouse-table', connectionId: OLD, path: ['DB', 'SCH', 'D_STORE'] },
          columnId: 'STORE_NAME',
        },
      },
      // 4. custom SQL element — connectionId at top level of source
      {
        kind: 'table', elementId: 'el_sql',
        source: { kind: 'sql', connectionId: OLD, statement: 'select 1 as X' },
      },
      // 5. element-sourced derived table — no connectionId; must pass through untouched
      {
        kind: 'table', elementId: 'el_derived',
        source: { elementId: 'el_base', kind: 'table' },
      },
    ],
  }],
};

const html = readFileSync(INDEX_HTML, 'utf8');
const vc = new VirtualConsole();
const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  url: 'https://localhost/',
  virtualConsole: vc,
});
const { window } = dom;

// Give the page scripts a tick to finish declaring globals
await new Promise(r => setTimeout(r, 100));

// state is script-lexical (top-level `let`), so set it from inside the page
window.eval('state.accessToken = "test-token";');

const calls = [];
window.sigmaFetch = async (path, options = {}) => {
  calls.push({ path, options });
  return {
    ok: true,
    status: 200,
    json: async () => ({ dataModelId: 'new-model-id' }),
    text: async () => '{}',
  };
};

const fileMeta = [{
  file: { text: async () => JSON.stringify(fixtureSpec) },
  name: 'Conn Override Fixture',
  existingId: fixtureSpec.dataModelId,
}];

// Import as new (cross-org port) with a destination folder + connection override
await window.handleBulkUpload(fileMeta, 'folder-123', NEW, true);

assert.equal(calls.length, 1, 'expected exactly one API call');
const { path, options } = calls[0];
assert.equal(path, '/v2/dataModels/spec', 'import-as-new must POST a new model');
assert.equal(options.method, 'POST');

const body = JSON.parse(options.body);
const bodyStr = JSON.stringify(body);

// Core regression: no trace of the origin org's connection anywhere
assert.ok(!bodyStr.includes(OLD), `old connectionId leaked into POSTed spec: ${bodyStr}`);

// Every original connectionId occurrence was rewritten (6 in the fixture)
const newCount = bodyStr.split(NEW).length - 1;
assert.equal(newCount, 6, `expected 6 overridden connectionIds, got ${newCount}`);

const els = body.pages[0].elements;
const byId = Object.fromEntries(els.map(e => [e.elementId, e]));

// Spot-check the two shapes the old code missed
assert.equal(byId.el_join.source.joins[0].left.connectionId, NEW, 'join left not overridden');
assert.equal(byId.el_join.source.joins[0].right.joins[0].right.connectionId, NEW, 'nested join not overridden');
assert.equal(byId.el_ctrl.source.source.connectionId, NEW, 'control nested source not overridden');

// Shapes the old code did handle still work
assert.equal(byId.el_base.source.connectionId, NEW, 'warehouse-table source not overridden');
assert.equal(byId.el_sql.source.connectionId, NEW, 'sql source not overridden');

// Element-sourced derived table untouched (no connectionId invented)
assert.deepEqual(byId.el_derived.source, { elementId: 'el_base', kind: 'table' });

// Existing behaviors preserved: _ fields stripped, dataModelId dropped, folder set
assert.ok(!bodyStr.includes('_internalNote'), '_ fields must still be stripped');
assert.ok(!('dataModelId' in body), 'dataModelId must not be sent in the spec body');
assert.equal(body.folderId, 'folder-123');
assert.equal(body.schemaVersion, 1);

console.log('✅ bulk-upload connection override deep-replace: all assertions passed');
window.close();
