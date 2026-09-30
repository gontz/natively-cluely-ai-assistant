// electron/services/__tests__/ScreenUnderstandingFencedJson2026_09_30.test.mjs
//
// Vision models sometimes wrap their structured-extraction reply in a markdown
// fence (```json ... ```) despite "Return JSON only" in the prompt. The strict
// startsWith('{') / endsWith('}') check in extractStructured then fell through
// to the plain-text path and silently dropped every structured field
// (screenType, taskDetected, confidence, tables, errors...).
//
// Covers fenced, unfenced and junk input, both through the pure helper and
// through the service's extractStructured.
//
// Run: `ELECTRON_RUN_AS_NODE=1 electron --test`

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import Module, { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../../..');
const screenDir = path.join(root, 'dist-electron/electron/services/screen');

// The service transitively pulls in CredentialsManager, which evaluates
// app.getPath('userData') at module load, so stub electron before requiring it
// (same approach as ScreenUnderstandingBudget2026_09_05.test.mjs).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sur-fenced-userdata-'));
process.env.NATIVELY_TEST_USER_DATA = tmp;
const cjs = createRequire(path.join(root, 'package.json'));
const stub = new Module('electron');
stub.exports = {
  app: { isReady: () => true, getPath: (n) => (n === 'userData' ? tmp : os.tmpdir()), getName: () => 'natively-test', getVersion: () => '0.0.0-test', isPackaged: false },
  shell: { openPath: async () => '' },
  safeStorage: { isEncryptionAvailable: () => false },
  ipcMain: { on: () => {}, handle: () => {}, removeAllListeners: () => {} },
  BrowserWindow: { getAllWindows: () => [] },
  desktopCapturer: { getSources: async () => [] },
};
stub.loaded = true;
cjs.cache[cjs.resolve('electron')] = stub;

const { ScreenUnderstandingService, stripWholeReplyCodeFence } = cjs(
  path.join(screenDir, 'ScreenUnderstandingService.js')
);

const PAYLOAD = {
  visibleSummary: 'LeetCode Two Sum problem',
  extractedText: 'Given an array of integers nums and an integer target...',
  screenType: 'coding_interview',
  taskDetected: 'solve two sum',
  confidence: 0.92,
  errors: ['TypeError: x is undefined'],
};
const JSON_TEXT = JSON.stringify(PAYLOAD, null, 2);

function extract(raw) {
  const service = new ScreenUnderstandingService();
  return service.extractStructured(raw);
}

function assertStructured(result) {
  assert.equal(result.visibleSummary, PAYLOAD.visibleSummary);
  assert.equal(result.extractedText, PAYLOAD.extractedText);
  assert.equal(result.screenType, PAYLOAD.screenType);
  assert.equal(result.taskDetected, PAYLOAD.taskDetected);
  assert.equal(result.confidence, PAYLOAD.confidence);
  assert.deepEqual(result.errors, PAYLOAD.errors);
  // The JSON body itself must not be mistaken for a code block.
  assert.deepEqual(result.codeBlocks, []);
}

describe('stripWholeReplyCodeFence', () => {
  test('unwraps ```json fences', () => {
    assert.equal(stripWholeReplyCodeFence('```json\n{"a":1}\n```'), '{"a":1}');
  });
  test('unwraps bare and uppercase-tag fences, CRLF and surrounding whitespace', () => {
    assert.equal(stripWholeReplyCodeFence('  ```\n{"a":1}\n```  '), '{"a":1}');
    assert.equal(stripWholeReplyCodeFence('```JSON\r\n{"a":1}\r\n```'), '{"a":1}');
    assert.equal(stripWholeReplyCodeFence('```json {"a":1} ```'), '{"a":1}');
  });
  test('leaves unfenced and partially fenced text alone (trimmed)', () => {
    assert.equal(stripWholeReplyCodeFence('  {"a":1}  '), '{"a":1}');
    const prose = 'Here is the answer:\n```js\nconst x = 1;\n```\nDone.';
    assert.equal(stripWholeReplyCodeFence(prose), prose);
  });
});

describe('extractStructured with fenced vision replies', () => {
  test('fenced ```json reply keeps every structured field', () => {
    assertStructured(extract('```json\n' + JSON_TEXT + '\n```'));
  });

  test('bare-fenced reply keeps every structured field', () => {
    assertStructured(extract('```\n' + JSON_TEXT + '\n```'));
  });

  test('unfenced reply is unchanged', () => {
    assertStructured(extract(JSON_TEXT));
  });

  test('junk input falls back to the plain-text path without throwing', () => {
    const junk = '```json\n{ this is not json, "a": }\n```';
    const result = extract(junk);
    assert.equal(result.screenType, undefined);
    assert.equal(result.confidence, undefined);
    assert.equal(result.extractedText, junk);

    const prose = 'The screen shows an error dialog.';
    const plain = extract(prose);
    assert.equal(plain.extractedText, prose);
    assert.equal(plain.visibleSummary, prose);
    assert.equal(plain.screenType, undefined);
  });

  test('a fenced non-JSON code reply still yields its code block via the plain-text path', () => {
    const code = '```python\nprint("hi")\n```';
    const result = extract(code);
    assert.equal(result.screenType, undefined);
    assert.deepEqual(result.codeBlocks, ['print("hi")']);
  });
});
