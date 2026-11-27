import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {applyModelNames, applyModelPreferences, defaults, normalize, read, settingsFile, write} from '../lib/bridge-settings.js';

const setup = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-bridge-settings-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  return dir;
};

test('missing or malformed bridge settings fall back to defaults', (t) => {
  const root = setup(t);
  assert.deepEqual(read(root), defaults);
  fs.writeFileSync(settingsFile(root), '{"refreshSeconds": 0, "logLimitMB": "x"}');
  assert.deepEqual(read(root), defaults);
});

test('out-of-range values fall back per key when read', (t) => {
  const root = setup(t);
  fs.writeFileSync(settingsFile(root), JSON.stringify({refreshSeconds: 30, gatewayGraceSeconds: 9999, logLimitMB: 8}));
  assert.deepEqual(read(root), {runMode: 'default', subagentMode: 'async', orcaTakeover: 'on', showOfficialModels: false, refreshSeconds: 30, gatewayGraceSeconds: defaults.gatewayGraceSeconds, logLimitMB: 8, tracesRetentionDays: defaults.tracesRetentionDays, sessionsRetentionDays: defaults.sessionsRetentionDays, modelNames: {}, modelOrder: [], modelHidden: []});
});

test('official models are off by default and validated strictly', (t) => {
  const root = setup(t);
  assert.equal(defaults.showOfficialModels, false);
  assert.equal(normalize({}).showOfficialModels, false);
  fs.writeFileSync(settingsFile(root), JSON.stringify({showOfficialModels: 'yes'}));
  assert.equal(read(root).showOfficialModels, false, 'a malformed value falls back on read');
  assert.throws(() => write(root, {showOfficialModels: 'yes'}), /显示 Cursor 官方模型需为开关值/);
  assert.equal(write(root, {showOfficialModels: true}).showOfficialModels, true);
  assert.equal(read(root).showOfficialModels, true);
});

test('orca takeover defaults to on and is validated strictly', (t) => {
  const root = setup(t);
  assert.equal(defaults.orcaTakeover, 'on');
  assert.equal(normalize({}).orcaTakeover, 'on');
  fs.writeFileSync(settingsFile(root), JSON.stringify({orcaTakeover: 'sometimes'}));
  assert.equal(read(root).orcaTakeover, 'on', 'a malformed value falls back on read');
  assert.throws(() => write(root, {orcaTakeover: 'sometimes'}), /接管 Orca 需为 on 或 off/);
  assert.equal(write(root, {orcaTakeover: 'off'}).orcaTakeover, 'off');
  assert.equal(read(root).orcaTakeover, 'off');
});

test('run mode falls back when read and is rejected strictly', (t) => {
  const root = setup(t);
  fs.writeFileSync(settingsFile(root), JSON.stringify({runMode: 'turbo'}));
  assert.equal(read(root).runMode, 'default');
  assert.throws(() => write(root, {runMode: 'turbo'}), /default 或 lite/);
  assert.deepEqual(normalize({runMode: 'lite'}), {...defaults, runMode: 'lite'});
});

test('subagent mode defaults to async and rejects unknown values strictly', (t) => {
  const root = setup(t);
  fs.writeFileSync(settingsFile(root), JSON.stringify({subagentMode: 'parallel'}));
  assert.equal(read(root).subagentMode, 'async');
  assert.throws(() => write(root, {subagentMode: 'parallel'}), /async 或 sync/);
  assert.deepEqual(normalize({subagentMode: 'sync'}), {...defaults, subagentMode: 'sync'});
});

test('writes validate strictly, round-trip and keep the file private', (t) => {
  const root = setup(t);
  assert.throws(() => write(root, {refreshSeconds: 1}), /5–300/);
  const saved = write(root, {runMode: 'lite', subagentMode: 'sync', refreshSeconds: 30, gatewayGraceSeconds: 120, logLimitMB: 8});
  assert.deepEqual(saved, {runMode: 'lite', subagentMode: 'sync', orcaTakeover: 'on', showOfficialModels: false, refreshSeconds: 30, gatewayGraceSeconds: 120, logLimitMB: 8, tracesRetentionDays: defaults.tracesRetentionDays, sessionsRetentionDays: defaults.sessionsRetentionDays, modelNames: {}, modelOrder: [], modelHidden: []});
  assert.deepEqual(read(root), saved);
  if (process.platform !== 'win32') assert.equal(fs.statSync(settingsFile(root)).mode & 0o777, 0o600);
  assert.deepEqual(normalize({}), defaults);
});

test('a transient Windows rename violation retries instead of losing the save', {skip: process.platform !== 'win32'}, (t) => {
  const root = setup(t);
  const original = fs.renameSync;
  let attempts = 0;
  fs.renameSync = (...args) => {
    attempts += 1;
    if (attempts <= 2) {
      const error = new Error('EPERM: operation not permitted, rename');
      error.code = 'EPERM';
      throw error;
    }
    return original(...args);
  };
  try {
    assert.equal(write(root, {showOfficialModels: true}).showOfficialModels, true);
  } finally {
    fs.renameSync = original;
  }
  assert.equal(attempts, 3, 'the save is retried while the target is briefly locked');
  assert.equal(read(root).showOfficialModels, true);
  assert.equal(fs.existsSync(`${settingsFile(root)}.${process.pid}.tmp`), false, 'no temp file is left behind');
});

test('a transient Windows read failure reuses the last good settings', {skip: process.platform !== 'win32'}, (t) => {
  const root = setup(t);
  write(root, {showOfficialModels: true});
  const original = fs.readFileSync;
  fs.readFileSync = (file, ...rest) => {
    if (String(file) === settingsFile(root)) {
      const error = new Error('EBUSY: resource busy or locked');
      error.code = 'EBUSY';
      throw error;
    }
    return original(file, ...rest);
  };
  try {
    // Falling back to defaults here would make the supervisor restart the
    // engine with the wrong catalogue mode on a transient lock.
    assert.equal(read(root).showOfficialModels, true);
  } finally {
    fs.readFileSync = original;
  }
});

test('retention days accept zero to disable and reject negatives strictly', (t) => {
  const root = setup(t);
  const saved = write(root, {tracesRetentionDays: 0, sessionsRetentionDays: 30});
  assert.equal(saved.tracesRetentionDays, 0);
  assert.equal(saved.sessionsRetentionDays, 30);
  assert.throws(() => write(root, {tracesRetentionDays: -1}), /0–3650/);
  fs.writeFileSync(settingsFile(root), JSON.stringify({tracesRetentionDays: 99999, sessionsRetentionDays: 'x'}));
  assert.equal(read(root).tracesRetentionDays, defaults.tracesRetentionDays);
  assert.equal(read(root).sessionsRetentionDays, defaults.sessionsRetentionDays);
});

test('model display names trim, drop empty values and round-trip', (t) => {
  const root = setup(t);
  const saved = write(root, {modelNames: {' group/opus ': '  Opus 4.5  ', 'group/sonnet': '', 'group/gpt': 'GPT-5'}});
  assert.deepEqual(saved.modelNames, {'group/opus': 'Opus 4.5', 'group/gpt': 'GPT-5'});
  assert.deepEqual(read(root).modelNames, saved.modelNames);
  assert.throws(() => write(root, {modelNames: {'group/opus': 'x'.repeat(81)}}), /80 个字符/);
  assert.throws(() => write(root, {modelNames: {'': 'x'}}), /模型 ID 不能为空/);
  assert.throws(() => write(root, {modelNames: {'group/opus': 42}}), /需为文本/);
  assert.throws(() => write(root, {modelNames: []}), /模型 ID → 名称/);
});

test('model display names override only the catalogue name, never the id', () => {
  const models = [
    {id: 'group/opus', name: 'Opus · group/opus', context: 200000},
    {id: 'group/gpt', name: 'GPT'}
  ];
  assert.deepEqual(applyModelNames(models, {'group/opus': 'Opus 4.5'}), [
    {id: 'group/opus', name: 'Opus 4.5', context: 200000},
    {id: 'group/gpt', name: 'GPT'}
  ]);
  assert.equal(applyModelNames(models, {})[0], models[0]);
  assert.equal(applyModelNames(models, {unknown: 'X'})[0], models[0]);
});

test('hidden models trim, dedupe and reject malformed values', (t) => {
  const root = setup(t);
  const saved = write(root, {modelHidden: [' group/opus ', 'group/gpt', 'group/opus', '']});
  assert.deepEqual(saved.modelHidden, ['group/opus', 'group/gpt']);
  assert.deepEqual(read(root).modelHidden, saved.modelHidden);
  assert.throws(() => write(root, {modelHidden: 'group/opus'}), /需为模型 ID 数组/);
  assert.throws(() => write(root, {modelHidden: [42]}), /需为文本/);
});

test('model order trims, dedupes and rejects malformed values', (t) => {
  const root = setup(t);
  const saved = write(root, {modelOrder: [' group/opus ', 'group/gpt', 'group/opus', '']});
  assert.deepEqual(saved.modelOrder, ['group/opus', 'group/gpt']);
  assert.deepEqual(read(root).modelOrder, saved.modelOrder);
  assert.throws(() => write(root, {modelOrder: 'group/opus'}), /需为模型 ID 数组/);
  assert.throws(() => write(root, {modelOrder: [42]}), /需为文本/);
});

test('model order reorders the catalogue and keeps unlisted models after it', () => {
  const models = [
    {id: 'a', name: 'A'},
    {id: 'b', name: 'B'},
    {id: 'c', name: 'C'}
  ];
  assert.deepEqual(
    applyModelPreferences(models, {modelOrder: ['c', 'a'], modelNames: {b: 'Bee'}}).map((model) => [model.id, model.name]),
    [['c', 'C'], ['a', 'A'], ['b', 'Bee']]
  );
  assert.deepEqual(applyModelPreferences(models, {modelOrder: ['unknown']}).map((model) => model.id), ['a', 'b', 'c']);
  assert.deepEqual(applyModelPreferences(models, {}).map((model) => model.id), ['a', 'b', 'c']);
});

test('hidden models leave the menu except the currently selected one', () => {
  const models = [
    {id: 'a', name: 'A'},
    {id: 'b', name: 'B'},
    {id: 'c', name: 'C'}
  ];
  assert.deepEqual(applyModelPreferences(models, {modelHidden: ['b']}).map((model) => model.id), ['a', 'c']);
  assert.deepEqual(applyModelPreferences(models, {modelHidden: ['b'], keep: 'b'}).map((model) => model.id), ['a', 'b', 'c']);
  assert.deepEqual(applyModelPreferences(models, {modelHidden: ['b'], modelOrder: ['c', 'a'], modelNames: {a: 'Ay'}}).map((model) => [model.id, model.name]), [['c', 'C'], ['a', 'Ay']]);
});
