// electron/services/__tests__/SkillAutoMatch2026_09_30.test.mjs
//
// Skill auto-match with answerType routing (ported from
// rishikeshl0510/natively-cluely-ai-assistant@59c42e84 / @51caf466 /
// @0a4b3dec). Complements SkillMatcher.test.mjs (pure matcher) and
// SkillGovernsAnswerContract2026_09_28.test.mjs (prompt framing) with:
//
//   1. SkillsManager parses `answerTypes:` frontmatter, feeds it to
//      matchSkillByAnswerType, and the in-memory cache is invalidated by
//      invalidateCache() / setSkillEnabled().
//   2. The built-in skill carries NO answerTypes, so live answerType routing
//      is inert for a user who never wrote a tagged skill.
//   3. The live-turn prompt cap on skill instructions.
//   4. The settings gate: unset = on, explicit false = off, and every
//      automatic call site consults it.
//
// No platform branch in this path; skills live under userData on both darwin
// and win32 and the directory watcher only drops the cache.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../../..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const cjsRequire = createRequire(import.meta.url);

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'natively-skill-automatch-'));
const electronStub = {
  app: {
    isReady: () => true,
    getPath: (name) => (name === 'userData' ? userDataDir : os.tmpdir()),
  },
  shell: { openPath: async () => '' },
};

const originalLoad = Module._load;
let SkillsManager;
let matcher;

before(() => {
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return electronStub;
    return originalLoad.call(this, request, parent, isMain);
  };
  const distPath = path.join(root, 'dist-electron/electron/services/SkillsManager.js');
  delete cjsRequire.cache[distPath];
  ({ SkillsManager } = cjsRequire(distPath));
  if (SkillsManager.instance) SkillsManager.instance = undefined;
  matcher = cjsRequire(path.join(root, 'dist-electron/electron/services/skills/skillMatcher.js'));
});

after(() => {
  Module._load = originalLoad;
  try {
    SkillsManager?.instance?.watcher?.close();
  } catch {}
  try {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  } catch {}
});

function writeSkill(folder, frontmatter, body) {
  const dir = path.join(userDataDir, 'skills', folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n\n${body}\n`, 'utf8');
}

describe('SkillsManager answerTypes + cache', () => {
  test('answerTypes frontmatter is parsed and routes the live turn', () => {
    const manager = SkillsManager.getInstance();
    writeSkill('sysdesign', 'name: sysdesign\ndescription: System design answers.\nanswerTypes: system_design_answer, coding_question_answer', 'Open with the requirements.');
    manager.invalidateCache();
    const list = manager.listSkills();
    const skill = list.find((s) => s.id === 'sysdesign');
    assert.ok(skill, `expected sysdesign in ${list.map((s) => s.id).join(', ')}`);
    assert.deepEqual(skill.answerTypes, ['system_design_answer', 'coding_question_answer']);

    const enabled = list.filter((s) => s.enabled !== false);
    const hit = matcher.matchSkillByAnswerType('system_design_answer', enabled, 'design twitter');
    assert.equal(hit?.skillId, 'sysdesign');
    assert.equal(matcher.matchSkillByAnswerType('behavioral_answer', enabled, 'tell me about a conflict'), null);
  });

  test('the built-in skill has no answerTypes, so live routing is inert without a tagged skill', () => {
    const manager = SkillsManager.getInstance();
    const builtins = manager.listSkills().filter((s) => s.source === 'builtin');
    assert.ok(builtins.length > 0);
    for (const b of builtins) assert.equal(b.answerTypes, undefined, `${b.id} must not be answerType-tagged`);
    for (const type of ['coding_question_answer', 'system_design_answer', 'behavioral_answer', 'general_answer']) {
      assert.equal(matcher.matchSkillByAnswerType(type, builtins, 'anything'), null);
    }
  });

  test('a disabled skill drops out of the enabled list (cache invalidated by setSkillEnabled)', () => {
    const manager = SkillsManager.getInstance();
    assert.equal(manager.setSkillEnabled('sysdesign', false).success, true);
    const enabled = manager.listSkills().filter((s) => s.enabled !== false);
    assert.equal(matcher.matchSkillByAnswerType('system_design_answer', enabled, ''), null);
    assert.equal(manager.setSkillEnabled('sysdesign', true).success, true);
    assert.ok(manager.listSkills().find((s) => s.id === 'sysdesign')?.enabled);
  });

  test('a skill written behind the manager appears after invalidateCache()', () => {
    const manager = SkillsManager.getInstance();
    manager.listSkills(); // prime the cache
    writeSkill('late', 'name: late\ndescription: Use when asked to "explain the tradeoffs".', 'Name two tradeoffs.');
    manager.invalidateCache();
    assert.ok(manager.listSkills().some((s) => s.id === 'late'));
  });

  test('buildPromptBlock caps oversized instructions for the live prompt', () => {
    const manager = SkillsManager.getInstance();
    writeSkill('huge', 'name: huge\ndescription: Big one.', 'x'.repeat(9000));
    manager.invalidateCache();
    const block = manager.buildPromptBlock(manager.getSkill('huge'));
    assert.ok(block.length < 7000, `block length ${block.length}`);
    assert.match(block, /truncated/);
    const small = manager.buildPromptBlock(manager.getSkill('late'));
    assert.doesNotMatch(small, /truncated/);
  });
});

describe('skillAutoMatchEnabled gate', () => {
  test('unset reads as on, only an explicit false turns it off', () => {
    assert.equal(matcher.isSkillAutoMatchEnabled(undefined), true);
    assert.equal(matcher.isSkillAutoMatchEnabled(null), true);
    assert.equal(matcher.isSkillAutoMatchEnabled(true), true);
    assert.equal(matcher.isSkillAutoMatchEnabled(false), false);
  });

  test('typed chat auto-match runs only without a /skill prefix and behind the gate', () => {
    const source = read('electron/ipcHandlers.ts');
    assert.match(
      source,
      /if \(skillPrefixMatch\) \{[\s\S]*?\} else \{[\s\S]{0,900}const autoMatchOn = isSkillAutoMatchEnabled\(SettingsManager\.getInstance\(\)\.get\('skillAutoMatchEnabled'\)\);\s*const enabledSkills = autoMatchOn\s*\?[\s\S]{0,200}:\s*\[\];[\s\S]{0,120}matchSkillForMessage\(message, enabledSkills\)/,
    );
  });

  test('the live V3 site consults the gate and never overrides a caller-supplied skill', () => {
    const source = read('electron/IntelligenceEngine.ts');
    assert.match(
      source,
      /if \(!options\?\.activeSkill && isSkillAutoMatchEnabled\(_Settings\.getInstance\(\)\.get\('skillAutoMatchEnabled'\)\)\)/,
    );
  });

  test('settings IPC is wired end to end', () => {
    const ipc = read('electron/ipcHandlers.ts');
    const preload = read('electron/preload.ts');
    const types = read('src/types/electron.d.ts');
    assert.match(ipc, /safeHandle\('skills:get-auto-match'/);
    assert.match(ipc, /safeHandle\('skills:set-auto-match'/);
    assert.match(preload, /skillsGetAutoMatch:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('skills:get-auto-match'\)/);
    assert.match(preload, /skillsSetAutoMatch:[\s\S]{0,80}ipcRenderer\.invoke\('skills:set-auto-match', enabled\)/);
    assert.match(types, /skillsGetAutoMatch:\s*\(\)\s*=>\s*Promise<boolean>/);
  });
});
