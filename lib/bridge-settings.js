import fs from 'node:fs';
import path from 'node:path';
import {atomic} from './settings.js';

// User-editable bridge parameters. They live beside the other runtime state so
// the supervisor (bridge.js) and the control panel read the same file. Every
// read tolerates a missing or malformed file and falls back to the defaults;
// only an explicit write from the control panel is validated strictly.
export const defaults = Object.freeze({
  runMode: 'default',
  subagentMode: 'async',
  // Orca writes its own cursor override; the panel only records the intent
  // here and the supervisor keeps the file in sync (Orca rewrites it on exit).
  orcaTakeover: 'on',
  // Off keeps the picker bridge-only (Cursor's own catalogue is never polled).
  // On merges the Cursor catalogue with the Magpie models: official models stay
  // selectable and bill to the Cursor plan, Magpie models keep the MAGPIE badge.
  // The engine chooses the catalogue mode at startup, so changing this restarts
  // the engine (conversations are not interrupted by the catalogue refresh).
  showOfficialModels: false,
  refreshSeconds: 15,
  gatewayGraceSeconds: 60,
  logLimitMB: 4,
  // Automatic retention runs in the supervisor without stopping the engine.
  // 0 disables a scope; sessions stay off by default because deleting history
  // is destructive, while call traces are diagnostics with a short useful life.
  tracesRetentionDays: 7,
  sessionsRetentionDays: 0,
  // Model id -> display name. Only the name handed to Cursor changes; ids keep
  // driving routing and billing.
  modelNames: Object.freeze({}),
  // Preferred menu order. Ids not listed keep their catalogue order after the
  // listed ones, so adding a model in Magpie never hides it.
  modelOrder: Object.freeze([]),
  // Model ids hidden from the Cursor menu. The selected model is always kept
  // so the engine never loses the id it is currently routing.
  modelHidden: Object.freeze([])
});

export const MODEL_NAME_LIMIT = 80;
export const MODEL_NAME_MAX_ENTRIES = 200;

// Run modes are intentionally a closed set: the native engine switches its
// storage strategy from this value, so an unknown mode must never fall through
// to a half-configured state.
export const modes = Object.freeze({
  default: '默认模式',
  lite: '轻量模式'
});

// Subagent modes decide how Task calls reach the client. `async` keeps the
// model's own run_in_background intent and lets the bridge wake the parent when
// the subagent finishes; `sync` forces run_in_background=false so the parent
// turn waits for an inline result.
export const subagentModes = Object.freeze({
  async: '异步后台（默认）',
  sync: '同步阻塞'
});

// Orca takeover is a durable preference rather than a one-shot action: the
// supervisor re-applies it after Orca rewrites orca-data.json on exit. `off`
// only stops the bridge's fallback override; the official cursor-agent entry
// stays independently managed by its own switch.
export const takeoverModes = Object.freeze({
  on: '开启（自动维持）',
  off: '关闭'
});

export const rules = Object.freeze({
  refreshSeconds: {min: 5, max: 300, step: 1, label: '模型目录同步间隔（秒）'},
  gatewayGraceSeconds: {min: 10, max: 600, step: 1, label: '网关断线容错（秒）'},
  logLimitMB: {min: 1, max: 64, step: 1, label: '引擎日志上限（MB）'},
  tracesRetentionDays: {min: 0, max: 3650, step: 1, label: '调用日志保留天数（0=不自动清理）'},
  sessionsRetentionDays: {min: 0, max: 3650, step: 1, label: '历史会话保留天数（0=不自动清理）'}
});

export function settingsFile(root) {
  return path.join(root, 'bridge-settings.json');
}

// A map shaped like {"group/opus": "Opus 4.5"} is the only accepted form.
// Empty values mean "remove the override", so clearing an input and saving is
// how a user returns that model to Magpie's own name.
function normalizeModelNames(raw, strict) {
  if (raw === undefined || raw === null || raw === '') return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    if (strict) throw new Error('模型显示名需为「模型 ID → 名称」的对象');
    return {};
  }
  const out = {};
  let count = 0;
  for (const [rawId, rawName] of Object.entries(raw)) {
    const id = typeof rawId === 'string' ? rawId.trim() : '';
    if (!id) {
      if (strict) throw new Error('模型显示名的模型 ID 不能为空');
      continue;
    }
    if (typeof rawName !== 'string') {
      if (strict) throw new Error(`模型 ${id} 的显示名需为文本`);
      continue;
    }
    const name = rawName.trim();
    if (!name) continue;
    if (name.length > MODEL_NAME_LIMIT) {
      if (strict) throw new Error(`模型 ${id} 的显示名不能超过 ${MODEL_NAME_LIMIT} 个字符`);
      continue;
    }
    if (count >= MODEL_NAME_MAX_ENTRIES) {
      if (strict) throw new Error(`模型显示名最多 ${MODEL_NAME_MAX_ENTRIES} 条`);
      break;
    }
    out[id] = name;
    count += 1;
  }
  return out;
}

function normalizeModelHidden(raw, strict) {
  if (raw === undefined || raw === null || raw === '') return [];
  if (!Array.isArray(raw)) {
    if (strict) throw new Error('隐藏模型需为模型 ID 数组');
    return [];
  }
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    if (typeof item !== 'string') {
      if (strict) throw new Error('隐藏模型中的模型 ID 需为文本');
      continue;
    }
    const id = item.trim();
    if (!id || seen.has(id)) continue;
    if (out.length >= MODEL_NAME_MAX_ENTRIES) {
      if (strict) throw new Error(`隐藏模型最多 ${MODEL_NAME_MAX_ENTRIES} 条`);
      break;
    }
    out.push(id);
    seen.add(id);
  }
  return out;
}

function normalizeModelOrder(raw, strict) {
  if (raw === undefined || raw === null || raw === '') return [];
  if (!Array.isArray(raw)) {
    if (strict) throw new Error('模型顺序需为模型 ID 数组');
    return [];
  }
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    if (typeof item !== 'string') {
      if (strict) throw new Error('模型顺序中的模型 ID 需为文本');
      continue;
    }
    const id = item.trim();
    if (!id || seen.has(id)) continue;
    if (out.length >= MODEL_NAME_MAX_ENTRIES) {
      if (strict) throw new Error(`模型顺序最多 ${MODEL_NAME_MAX_ENTRIES} 条`);
      break;
    }
    out.push(id);
    seen.add(id);
  }
  return out;
}

// Applied right before the catalogue goes to the engine, so the Cursor menu
// shows the custom name while every request still carries the original id.
export function applyModelNames(models, modelNames = {}) {
  return models.map((model) => {
    const custom = modelNames?.[model.id];
    return custom ? {...model, name: custom} : model;
  });
}

// Order first, then names. Listed ids win in the given order; everything else
// keeps its catalogue order and follows. The sort is explicit about its
// tie-break so the result does not depend on engine-v8 sort stability.
export function applyModelPreferences(models, {modelNames = {}, modelOrder = [], modelHidden = [], keep = null} = {}) {
  const rank = new Map((modelOrder || []).map((id, index) => [id, index]));
  const ordered = models
    .map((model, index) => ({model, index}))
    .sort((a, b) => {
      const ra = rank.has(a.model.id) ? rank.get(a.model.id) : Number.MAX_SAFE_INTEGER;
      const rb = rank.has(b.model.id) ? rank.get(b.model.id) : Number.MAX_SAFE_INTEGER;
      return ra === rb ? a.index - b.index : ra - rb;
    })
    .map((entry) => entry.model);
  // Hiding a model only removes it from the menu; the currently selected id is
  // always kept, otherwise validate() would reject the catalogue and the
  // engine would stop on the next sync.
  const hidden = new Set((modelHidden || []).filter((id) => id !== keep));
  return applyModelNames(ordered.filter((model) => !hidden.has(model.id)), modelNames);
}

export function normalize(input, {strict = false} = {}) {
  const out = {};
  const mode = input?.runMode;
  if (mode === undefined || mode === null || mode === '') {
    out.runMode = defaults.runMode;
  } else if (Object.hasOwn(modes, mode)) {
    out.runMode = mode;
  } else if (strict) {
    throw new Error(`运行模式需为 ${Object.keys(modes).join(' 或 ')}`);
  } else {
    out.runMode = defaults.runMode;
  }
  const subagentMode = input?.subagentMode;
  if (subagentMode === undefined || subagentMode === null || subagentMode === '') {
    out.subagentMode = defaults.subagentMode;
  } else if (Object.hasOwn(subagentModes, subagentMode)) {
    out.subagentMode = subagentMode;
  } else if (strict) {
    throw new Error(`子代理模式需为 ${Object.keys(subagentModes).join(' 或 ')}`);
  } else {
    out.subagentMode = defaults.subagentMode;
  }
  const orcaTakeover = input?.orcaTakeover;
  if (orcaTakeover === undefined || orcaTakeover === null || orcaTakeover === '') {
    out.orcaTakeover = defaults.orcaTakeover;
  } else if (Object.hasOwn(takeoverModes, orcaTakeover)) {
    out.orcaTakeover = orcaTakeover;
  } else if (strict) {
    throw new Error(`接管 Orca 需为 ${Object.keys(takeoverModes).join(' 或 ')}`);
  } else {
    out.orcaTakeover = defaults.orcaTakeover;
  }
  // A boolean without a legacy string form: anything that is not a real boolean
  // falls back to off (or is rejected when saving from the panel).
  const showOfficialModels = input?.showOfficialModels;
  if (typeof showOfficialModels === 'boolean') {
    out.showOfficialModels = showOfficialModels;
  } else if (showOfficialModels === undefined || showOfficialModels === null || showOfficialModels === '') {
    out.showOfficialModels = defaults.showOfficialModels;
  } else if (strict) {
    throw new Error('显示 Cursor 官方模型需为开关值');
  } else {
    out.showOfficialModels = defaults.showOfficialModels;
  }
  for (const [key, rule] of Object.entries(rules)) {
    const raw = input?.[key];
    if (raw === undefined || raw === null || raw === '') {
      out[key] = defaults[key];
      continue;
    }
    const value = Number(raw);
    if (!Number.isInteger(value) || value < rule.min || value > rule.max) {
      if (strict) throw new Error(`${rule.label}需为 ${rule.min}–${rule.max} 的整数`);
      out[key] = defaults[key];
      continue;
    }
    out[key] = value;
  }
  out.modelNames = normalizeModelNames(input?.modelNames, strict);
  out.modelOrder = normalizeModelOrder(input?.modelOrder, strict);
  out.modelHidden = normalizeModelHidden(input?.modelHidden, strict);
  return out;
}

// Windows can hold a short-lived sharing violation while another process reads
// the file (the supervisor polls it every couple of seconds) or security
// software scans it. A read that fails for that reason must not look like
// "the file is gone": the supervisor would fall back to defaults and restart
// the engine with the wrong catalogue mode. Retry briefly, then reuse the last
// value this process read successfully.
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
function readText(file) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch (error) {
      const retry = process.platform === 'win32' && RETRY_CODES.has(error.code) && attempt < 4;
      if (!retry) throw error;
      sleep(20 * (attempt + 1));
    }
  }
}
const lastGood = new Map();

export function read(root) {
  const file = settingsFile(root);
  try {
    const value = normalize(JSON.parse(readText(file)));
    lastGood.set(file, value);
    return value;
  } catch (error) {
    if (RETRY_CODES.has(error?.code) && lastGood.has(file)) return lastGood.get(file);
    return {...defaults, modelNames: {}, modelOrder: []};
  }
}

export function write(root, input) {
  const value = normalize(input, {strict: true});
  fs.mkdirSync(root, {recursive: true, mode: 0o700});
  // atomic() retries the Windows-only EPERM/EBUSY from replacing a file that
  // another process (supervisor poll, antivirus) still has open. The plain
  // rename this used to do failed the whole save in that window.
  try {
    atomic(settingsFile(root), `${JSON.stringify(value, null, 2)}\n`);
  } catch (error) {
    const busy = process.platform === 'win32' && RETRY_CODES.has(error?.code);
    throw new Error(`保存设置失败：${error?.message || error}${busy ? '（文件正被其他程序占用，请稍后重试）' : ''}`);
  }
  lastGood.set(settingsFile(root), value);
  return value;
}
