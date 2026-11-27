import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {execFile, spawn} from 'node:child_process';
import {randomBytes, timingSafeEqual} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {read as readBridgeSettings, write as writeBridgeSettings, defaults as bridgeDefaults, rules as bridgeRules, modes as bridgeModes, subagentModes as bridgeSubagentModes, takeoverModes as bridgeTakeoverModes, settingsFile} from '../lib/bridge-settings.js';
import {atomic, restoreProxy} from '../lib/settings.js';
import {cursorCompatibility, compareVersions} from '../lib/compatibility.js';
import {agentStatus, installWrapper, removeWrapper, installShellHook, removeShellHook, installEntry, removeEntry} from '../lib/cursor-agent.js';
import {orcaStatus, reconcileOrca} from '../lib/orca.js';
import {version} from '../version.js';
import {readDatabase, readRecentCalls, cleanDatabase} from './database.js';
import {cursorStorePaths, readStoreOverview, listWorkspaces, listComposers, readComposer, readSessionSizes, readKvValue, scanCategoryCached, previewComposers, deleteComposers, vacuumStore, storeFreeSpace, cursorRunning, clearStoreCaches, CATEGORIES, OFFICIAL_ACTIONS} from './cursor-store.js';
import {tailFile, redact, classify} from './diagnostics.js';
import {runSelfTest} from './selftest.js';
import platform from '../lib/platform.js';

// The control console is served from the Magpie plugin host. It runs the
// same setup.command the user would type in a terminal, so the panel and
// the CLI can never disagree about what "start" or "restart" means.
//
// Security model (mirrors the sandboxed panel that opens it):
//  - loopback only, and the Host header must be this very server;
//  - the page runs in an opaque-origin sandbox, so it needs CORS with
//    Access-Control-Allow-Origin: null and a per-process token;
//  - the token is inline in the HTML only. /api/* without it is refused,
//    which keeps any other opaque-origin frame from driving the bridge.
const TOKEN_HEADER = 'x-magpiebridge-token';
const LABEL = 'local.magpie.cursor-bridge';
const MAX_BODY = 16 * 1024;
const ACTION_TIMEOUT = 180000;

export function paths(repoRoot) {
  // CURSOR_BRIDGE_HOME keeps tests (and a portable copy) away from the real
  // ~/.config; the normal path is always the user's home.
  const home = process.env.CURSOR_BRIDGE_HOME || os.homedir();
  const layout = platform.pathsFor(home);
  const root = layout.config;
  const share = layout.share;
  // Magpie may write the agent connection to a different file on Windows or
  // Linux; `connections` lists the same candidates the supervisor reads.
  const connections = platform.current.connectionFiles(home);
  return {
    home,
    root,
    share,
    data: path.join(root, 'data'),
    database: path.join(root, 'data/bridge.db'),
    databaseWal: path.join(root, 'data/bridge.db-wal'),
    databaseShm: path.join(root, 'data/bridge.db-shm'),
    plist: layout.plist,
    systemdUnit: layout.systemdUnit || null,
    autostart: layout.autostart || null,
    status: path.join(root, 'status.json'),
    installation: path.join(root, 'installation.json'),
    retention: path.join(root, 'retention.json'),
    connection: connections[0],
    connections,
    supervisorPid: path.join(root, 'supervisor.lock/pid'),
    engineLog: path.join(root, 'engine.log'),
    supervisorLog: path.join(root, 'supervisor.log'),
    supervisorError: path.join(root, 'supervisor-error.log'),
    diagnostics: path.join(root, 'data', 'diagnostics'),
    settings: settingsFile(root),
    setup: path.join(repoRoot, 'setup.command'),
    repo: repoRoot
  };
}

const readJson = (file) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
};
const readPid = (file) => {
  try {
    const value = Number(fs.readFileSync(file, 'utf8').trim());
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch { return null; }
};
const stat = (file) => {
  try {
    const s = fs.statSync(file);
    return {size: s.size, updated: s.mtime.toISOString()};
  } catch { return null; }
};
const alive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function run(command, args, {timeout = 15000} = {}) {
  return new Promise((resolve) => {
    // windowsHide is a no-op off Windows; there it keeps the PowerShell pid
    // probe from flashing a console window on every status poll.
    execFile(command, args, {encoding: 'utf8', timeout, maxBuffer: 2 * 1024 * 1024, windowsHide: true}, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        code: typeof error?.code === 'number' ? error.code : (error ? null : 0),
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        error: error ? String(error.message || error) : ''
      });
    });
  });
}

async function commandOf(pid) {
  if (!alive(pid)) return '';
  const probe = platform.current.processCommand(pid);
  if (!probe) return '';
  const result = await run(probe.command, probe.args, {timeout: 5000});
  return result.ok ? result.stdout.trim() : '';
}

async function stopProcess(pid, marker, graceMs) {
  if (!alive(pid)) return false;
  const command = await commandOf(pid);
  if (!command.includes(marker)) return false;
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    try { process.kill(pid, signal); } catch { return false; }
    const until = Date.now() + graceMs;
    while (Date.now() < until) {
      if (!alive(pid)) return true;
      await wait(150);
    }
  }
  return !alive(pid);
}

// Windows autostart has two user-level forms: the Startup-folder launcher and,
// when security software blocks that .vbs, a launcher beside the bridge state
// registered through HKCU Run. The panel must report either as "loaded".
async function windowsAutostartRegistered(p) {
  if (p.autostart && fs.existsSync(p.autostart)) return true;
  const launcher = path.join(p.root, 'supervisor-launch.vbs');
  if (!fs.existsSync(launcher)) return false;
  const reg = platform.current.reg();
  if (!reg) return false;
  const result = await run(reg, ['query', platform.windowsRunKey, '/v', LABEL], {timeout: 8000});
  return result.ok && String(result.stdout || '').includes(LABEL);
}

async function launchAgentState(repoRoot) {
  if (!platform.serviceSupported) return {registered: false, state: null, pid: null, supported: false};
  if (platform.IS_WIN) {
    // Windows autostart is a launcher script in the user's Startup folder,
    // not a scheduled task: creating an ONLOGON task needs elevation the
    // console cannot request.
    const p = paths(repoRoot);
    const pid = readPid(p.supervisorPid);
    const registered = await windowsAutostartRegistered(p);
    return {
      registered,
      state: pid ? (alive(pid) ? 'running' : 'stopped') : (registered ? 'ready' : null),
      pid,
      supported: true
    };
  }
  if (platform.IS_LINUX) {
    // A systemd unit and the detached fallback both write supervisor.lock, so
    // the pid answers "is it running" without shelling out on every poll. The
    // unit file answers "will it come back at login".
    const p = paths(repoRoot);
    const pid = readPid(p.supervisorPid);
    const registered = !!p.systemdUnit && fs.existsSync(p.systemdUnit);
    return {
      registered,
      state: pid ? (alive(pid) ? 'running' : 'stopped') : (registered ? 'ready' : null),
      pid,
      supported: true
    };
  }
  const domain = `gui/${process.getuid()}`;
  const result = await run('/bin/launchctl', ['print', `${domain}/${LABEL}`], {timeout: 10000});
  if (!result.ok) return {registered: false, state: null, pid: null, supported: true};
  const state = /state = ([^\n]+)/.exec(result.stdout)?.[1]?.trim() || null;
  const pid = Number(/pid = (\d+)/.exec(result.stdout)?.[1] || 0) || null;
  return {registered: true, state, pid, supported: true};
}

// Any candidate may be missing or damaged (a half-written file, a legacy
// location); the next one can still hold the live connection. Never stop at
// the first path that merely exists.
export function readConnection(candidates) {
  for (const candidate of candidates) {
    const data = readJson(candidate);
    if (data && typeof data === 'object' && !Array.isArray(data)) return data;
  }
  return null;
}

function repositoryUrl(root) {
  const manifest = readJson(path.join(root, 'package.json'));
  const homepage = String(manifest?.homepage || '').trim();
  if (/^https:\/\/github\.com\//.test(homepage)) return homepage.replace(/#.*$/, '');
  const repository = String(manifest?.repository?.url || '');
  const match = /github\.com[/:]([^/]+)\/([^/.#?]+?)(?:\.git)?(?:#.*)?$/.exec(repository);
  return match ? `https://github.com/${match[1]}/${match[2]}` : '';
}

function safeConnection(repoRoot) {
  const data = readConnection(paths(repoRoot).connections);
  if (!data) return {exists: false};
  return {
    exists: true,
    enabled: data.enabled === true,
    model: typeof data.model === 'string' ? data.model : null,
    models: Array.isArray(data.models) ? data.models.length : 0,
    // `models` above is a count for the overview. The console also needs the
    // catalogue itself to edit display names while the gateway is offline.
    modelList: Array.isArray(data.models)
      ? data.models
        .filter((model) => model && typeof model.id === 'string' && model.id)
        .map((model) => ({id: model.id, name: typeof model.name === 'string' && model.name ? model.name : model.id}))
      : [],
    gateway: typeof data.gateway === 'string' ? data.gateway : null
  };
}

// The console can offer the Magpie catalogue before the agent is connected,
// so a fresh install never looks like a broken one: pick a model here and the
// supervisor starts the engine on its own. Magpie publishes its local gateway
// address in gateway.json and serves /v1/models without auth on loopback.
function gatewayBase(home) {
  const info = readJson(path.join(platform.current.magpieConfigDir(home), 'gateway.json'));
  const addr = typeof info?.addr === 'string' ? info.addr.trim() : '';
  const port = /:(\d+)$/.exec(addr)?.[1];
  return port ? `http://127.0.0.1:${port}` : null;
}

export async function magpieCatalogue(home) {
  const base = gatewayBase(home);
  if (!base) throw new Error('Magpie 网关未运行，请先打开 Magpie');
  let response;
  try {
    response = await fetch(`${base}/v1/models`, {signal: AbortSignal.timeout(5000), redirect: 'error'});
  } catch (error) {
    throw new Error(`无法访问 Magpie 网关（${base}）：${String(error?.message || error)}`);
  }
  if (!response.ok) throw new Error(`Magpie 网关返回 HTTP ${response.status}`);
  const body = await response.json().catch(() => null);
  if (!Array.isArray(body?.data)) throw new Error('Magpie 模型目录格式无效');
  return body.data
    .filter((entry) => entry && typeof entry.id === 'string' && entry.id)
    .map((entry) => ({
      id: entry.id,
      name: typeof entry.magpie_label === 'string' && entry.magpie_label
        ? entry.magpie_label
        : (typeof entry.display_name === 'string' && entry.display_name ? entry.display_name : entry.id)
    }));
}

// A single model check from the model table. The catalogue is refreshed first
// so a removed or renamed model is rejected before spending a request.
async function runModelTest(repoRoot, model) {
  const p = paths(repoRoot);
  const catalogue = await magpieCatalogue(p.home);
  if (!catalogue.some((entry) => entry.id === model)) throw new Error('该模型已不在 Magpie 目录中，请刷新后重试');
  const connection = readConnection(p.connections);
  if (!connection?.key || !connection?.gateway) throw new Error('尚未连接 Magpie 模型');
  const started = Date.now();
  const response = await fetch(`${connection.gateway.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Authorization: `Bearer ${connection.key}`,
      'User-Agent': `cursor-magpie-bridge/${version}-model-test`
    },
    body: JSON.stringify({
      model,
      messages: [{role: 'user', content: 'Reply with exactly BRIDGE_OK. Do not call any tools.'}],
      max_tokens: 8,
      stream: false
    }),
    signal: AbortSignal.timeout(30000)
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`Magpie 网关 HTTP ${response.status}`);
  return {
    model,
    latencyMs: Date.now() - started,
    text: String(body?.choices?.[0]?.message?.content || '').trim().slice(0, 200)
  };
}

// Connecting through Magpie's own CLI keeps `magpie ls`, its Agents page and
// the connection file in sync; writing the file ourselves would leave the
// app believing no model was chosen.
async function runMagpieConnect(model) {
  const magpie = platform.current.magpieExecutable();
  if (!magpie) throw new Error('找不到 Magpie 可执行文件；请在 Magpie → Agents 中选择模型');
  const result = await run(magpie, ['cursor-bridge', model], {timeout: 30000});
  if (!result.ok) {
    const detail = String(result.stderr || result.stdout || result.error || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !/^20\d\d[/-]/.test(line) && !line.includes('EADDRINUSE'))
      .slice(-1)[0];
    throw new Error(detail || 'Magpie 未能连接该模型');
  }
}

async function overview(repoRoot, port) {
  const p = paths(repoRoot);
  const installation = readJson(p.installation);
  const runtime = readJson(p.status);
  const supervisorPid = readPid(p.supervisorPid);
  const supervisorCommand = supervisorPid ? await commandOf(supervisorPid) : '';
  const enginePid = Number(runtime?.pid) || null;
  const engineCommand = enginePid ? await commandOf(enginePid) : '';
  const agent = await launchAgentState(repoRoot);
  return {
    now: new Date().toISOString(),
    version: typeof installation?.version === 'string' ? installation.version : null,
    installation: installation ? {
      version: installation.version || null,
      installed: installation.installed || null,
      release: installation.release || null,
      source: installation.source || null
    } : null,
    runtime: runtime ? {
      state: runtime.state || null,
      model: runtime.model || null,
      models: Number(runtime.models) || 0,
      mode: runtime.mode || null,
      engineMode: runtime.engineMode || null,
      engineOfficialModels: typeof runtime.engineOfficialModels === 'boolean' ? runtime.engineOfficialModels : null,
      proxy: runtime.proxy || null,
      backend: runtime.backend || null,
      pid: Number(runtime.pid) || null,
      updated: runtime.updated || null,
      warning: runtime.warning || null,
      reason: runtime.reason || null
    } : null,
    supervisor: {
      pid: supervisorPid,
      alive: !!supervisorPid && alive(supervisorPid),
      expected: supervisorCommand.includes('bridge.js') && supervisorCommand.includes('supervise')
    },
    engine: {
      pid: enginePid,
      alive: !!enginePid && alive(enginePid),
      expected: engineCommand.includes('cursor-magpie-bridge')
    },
    launchAgent: agent,
    platform: platform.platform,
    serviceSupported: platform.serviceSupported,
    connection: safeConnection(repoRoot),
    cursor: (() => {
      const version = platform.current.cursorVersion(p.home);
      return {version, ...cursorCompatibility(version)};
    })(),
    database: stat(p.database),
    retention: readJson(p.retention),
    settings: {
      values: readBridgeSettings(p.root),
      defaults: bridgeDefaults,
      rules: bridgeRules,
      modes: bridgeModes,
      subagentModes: bridgeSubagentModes,
      file: p.settings
    },
    paths: {
      configDir: p.root,
      installDir: p.share,
      plist: p.plist,
      systemdUnit: p.systemdUnit,
      repo: p.repo,
      setup: p.setup
    },
    logs: {
      engine: stat(p.engineLog),
      supervisor: stat(p.supervisorLog),
      error: stat(p.supervisorError)
    },
    control: {port, pid: process.pid, uptime: Math.round(process.uptime())}
  };
}

function capture(child, resolve) {
  let stdout = '';
  let stderr = '';
  let settled = false;
  let timer = null;
  const clip = (text) => text.length > 60000 ? text.slice(-60000) : text;
  const finish = (value) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    resolve({...value, stdout, stderr});
  };
  child.stdout?.on('data', (chunk) => { stdout = clip(stdout + chunk); });
  child.stderr?.on('data', (chunk) => { stderr = clip(stderr + chunk); });
  child.once('error', (error) => finish({ok: false, code: null, error: String(error.message || error)}));
  child.once('close', (code) => finish(code === 0
    ? {ok: true, code: 0, error: ''}
    : {ok: false, code, error: `命令退出码 ${code ?? '未知'}`}));
  timer = setTimeout(() => {
    if (settled) return;
    try { child.kill('SIGTERM'); } catch {}
    finish({ok: false, code: null, error: '命令超时（180 秒）', timedOut: true});
  }, ACTION_TIMEOUT);
}

function installerCommand(repoRoot, action) {
  const p = paths(repoRoot);
  if (!platform.IS_WIN) {
    // macOS and Linux share setup.command, which resolves Magpie's own Bun
    // runtime; Windows has no bash and runs install.js through the host.
    const bash = platform.current.bash() || '/bin/bash';
    return {command: bash, args: [p.setup, action]};
  }
  return {command: process.execPath, args: [path.join(repoRoot, 'install.js'), action]};
}

function runSetup(repoRoot) {
  if (!platform.serviceSupported) {
    return Promise.resolve({ok: false, code: null, stdout: '', stderr: '', error: `当前平台（${platform.platform}）暂不支持自动安装后台服务`});
  }
  const {command, args} = installerCommand(repoRoot, 'setup');
  if (!fs.existsSync(args[0])) {
    return Promise.resolve({ok: false, code: null, stdout: '', stderr: '', error: `找不到 ${args[0]}`});
  }
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env: {...process.env, TERM: 'dumb'},
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    capture(child, resolve);
  });
}

function runStatus(repoRoot) {
  const p = paths(repoRoot);
  if (!platform.serviceSupported) {
    // No service manager on this platform, but status.json is still the
    // source of truth a manually started bridge writes.
    const text = fs.existsSync(p.status) ? fs.readFileSync(p.status, 'utf8') : '未安装或尚未运行';
    return Promise.resolve({ok: true, code: 0, stdout: text, stderr: '', error: ''});
  }
  const {command, args} = installerCommand(repoRoot, 'status');
  if (!fs.existsSync(args[0])) {
    return Promise.resolve({ok: false, code: null, stdout: '', stderr: '', error: `找不到 ${args[0]}`});
  }
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env: {...process.env, TERM: 'dumb'},
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch {}
      resolve({ok: false, code: null, stdout: '', stderr: '', error: '状态命令超时'});
    }, 20000);
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => {
      clearTimeout(timer);
      resolve({ok: false, code: null, stdout, stderr, error: String(error.message || error)});
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0
        ? {ok: true, code: 0, stdout, stderr, error: ''}
        : {ok: false, code, stdout, stderr, error: `命令退出码 ${code ?? '未知'}`});
    });
  });
}

async function stopBridge(repoRoot) {
  const p = paths(repoRoot);
  if (platform.IS_WIN) {
    await run('schtasks', ['/End', '/TN', platform.serviceName], {timeout: 15000});
  } else if (platform.IS_LINUX) {
    const systemctl = platform.current.systemctl();
    if (systemctl) await run(systemctl, ['--user', 'stop', LABEL], {timeout: 30000});
  } else if (platform.serviceSupported) {
    await run('/bin/launchctl', ['bootout', `gui/${process.getuid()}/${LABEL}`], {timeout: 15000});
  }
  const supervisorPid = readPid(p.supervisorPid);
  if (supervisorPid) await stopProcess(supervisorPid, 'bridge.js', 10000);
  const runtime = readJson(p.status);
  const enginePid = Number(runtime?.pid) || null;
  if (enginePid) await stopProcess(enginePid, 'cursor-magpie-bridge', 5000);
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...corsHeaders(res.req)
  });
  res.end(JSON.stringify(body));
}

function corsHeaders(req) {
  const origin = req.headers.origin;
  return {
    'access-control-allow-origin': origin === 'null' ? 'null' : origin || 'null',
    'access-control-allow-headers': `content-type, ${TOKEN_HEADER}`,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'vary': 'Origin'
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('请求不是合法的 JSON')); }
    });
    req.on('error', reject);
  });
}


const here = path.dirname(fileURLToPath(import.meta.url));

export function createControlServer({repoRoot, port, log = console.log, connectAgent = runMagpieConnect}) {
  const token = randomBytes(32).toString('hex');
  const repoUrl = repositoryUrl(repoRoot);
  const htmlFile = path.join(here, 'ui.html');
  const readAsset = (name, type) => {
    const file = path.join(here, name);
    if (!fs.existsSync(file)) return null;
    return {body: fs.readFileSync(file), type};
  };
  let busy = null;
  let ownPort = port;
  // Content-byte statistics scan the whole database (seconds on a multi-GB
  // file), so concurrent panels share one read and a short-lived cache.
  let databaseCache = {at: 0, data: null, deep: false};
  let databasePending = null;
  let databaseEpoch = 0;
  const DATABASE_CACHE_MS = 20000;
  // /api/status is polled every five seconds per open console, and each miss
  // spawns ps/launchctl. A two-second cache collapses concurrent panels into
  // one snapshot without making the panel feel stale.
  let overviewCache = {at: 0, data: null, pending: null};
  let settingsQueue = Promise.resolve();
  let updateCache = {at: 0, data: null};
  function cachedOverview() {
    if (overviewCache.data && Date.now() - overviewCache.at < 2000) {
      return Promise.resolve(overviewCache.data);
    }
    if (!overviewCache.pending) {
      overviewCache.pending = overview(repoRoot, ownPort)
        .then((data) => {
          overviewCache = {at: Date.now(), data, pending: null};
          return data;
        })
        .catch((error) => {
          overviewCache.pending = null;
          throw error;
        });
    }
    return overviewCache.pending;
  }

  async function buildDiagnostics() {
    const p = paths(repoRoot);
    const snapshot = await cachedOverview();
    const logs = {};
    for (const [name, file] of Object.entries({engine: p.engineLog, supervisor: p.supervisorLog, error: p.supervisorError})) {
      const tail = tailFile(file, {lines: 300});
      logs[name] = {
        exists: tail.exists,
        size: tail.size,
        updated: tail.updated,
        truncated: tail.truncated,
        text: redact(tail.text)
      };
    }
    const hints = new Map();
    for (const entry of Object.values(logs)) {
      for (const hint of classify(entry.text)) hints.set(hint.id, hint);
    }
    const integrity = readJson(path.join(p.repo, 'integrity.json'));
    return {
      ok: true,
      generated: new Date().toISOString(),
      platform: {platform: process.platform, arch: process.arch, release: os.release()},
      versions: {plugin: snapshot.version, engine: integrity?.engineVersion || null},
      overview: snapshot,
      settings: readBridgeSettings(p.root),
      logs,
      hints: [...hints.values()],
      retention: readJson(p.retention)
    };
  }

  function repositorySlug() {
    const manifest = readJson(path.join(repoRoot, 'package.json'));
    const url = String(manifest?.repository?.url || '');
    const match = /github\.com[/:]([^/]+)\/([^/.#?]+?)(?:\.git)?(?:#.*)?$/.exec(url);
    return match ? `${match[1]}/${match[2]}` : null;
  }

  async function updateStatus({force = false} = {}) {
    if (!force && updateCache.data && Date.now() - updateCache.at < 10 * 60 * 1000) return updateCache.data;
    const slug = repositorySlug();
    if (!slug) throw new Error('package.json 中没有可识别的 GitHub 仓库地址');
    const response = await fetch(`https://api.github.com/repos/${slug}/releases/latest`, {
      headers: {'accept': 'application/vnd.github+json', 'user-agent': `cursor-magpie-bridge/${version}`},
      signal: AbortSignal.timeout(8000)
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(body?.message || `GitHub API HTTP ${response.status}`);
    const latestTag = String(body?.tag_name || '');
    const latest = latestTag.replace(/^v/, '');
    if (!latest) throw new Error('GitHub Release 缺少版本号');
    const p = paths(repoRoot);
    const installation = readJson(p.installation);
    const current = String(installation?.version || version);
    const source = installation?.source || repoRoot;
    // A one-click upgrade is only safe for a clean source checkout whose
    // origin is this repository. Magpie-managed or edited installs get the
    // exact command instead of a surprising rewrite.
    const hasEntry = fs.existsSync(path.join(source, 'setup.command')) || fs.existsSync(path.join(source, 'install.js'));
    const mode = hasEntry ? 'source' : 'unknown';
    let canUpgrade = false;
    let command = '';
    if (mode === 'source' && fs.existsSync(path.join(source, '.git'))) {
      const status = await run('git', ['-C', source, 'status', '--porcelain'], {timeout: 8000});
      const origin = await run('git', ['-C', source, 'remote', 'get-url', 'origin'], {timeout: 8000});
      const clean = status.ok && !status.stdout.trim();
      const matches = origin.ok && String(origin.stdout).includes(slug);
      canUpgrade = compareVersions(latest, current) > 0 && clean && matches;
      const setup = platform.IS_WIN ? `node "${path.join(source, 'install.js')}" setup` : `bash "${path.join(source, 'setup.command')}"`;
      command = `git -C "${source}" fetch --tags origin && git -C "${source}" merge --ff-only ${latestTag} && ${setup}`;
    } else {
      const magpie = platform.current.magpieExecutable();
      command = magpie ? `${magpie} plugin update` : 'magpie plugin update';
    }
    const data = {
      ok: true,
      current,
      latest,
      latestTag,
      updateAvailable: compareVersions(latest, current) > 0,
      url: typeof body?.html_url === 'string' ? body.html_url : null,
      name: typeof body?.name === 'string' ? body.name : `v${latest}`,
      published: typeof body?.published_at === 'string' ? body.published_at : null,
      mode,
      canUpgrade,
      command
    };
    updateCache = {at: Date.now(), data};
    return data;
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://127.0.0.1:${ownPort}`);
      const host = String(req.headers.host || '').toLowerCase();
      if (host !== `127.0.0.1:${ownPort}` && host !== `localhost:${ownPort}`) {
        res.writeHead(421, {'content-type': 'text/plain; charset=utf-8'});
        return res.end('misdirected request');
      }
      const origin = req.headers.origin;
      if (origin !== undefined && origin !== 'null' && origin !== `http://127.0.0.1:${ownPort}` && origin !== `http://localhost:${ownPort}`) {
        res.writeHead(403, {'content-type': 'text/plain; charset=utf-8'});
        return res.end('origin not allowed');
      }

      if (req.method === 'OPTIONS') {
        res.writeHead(204, {...corsHeaders(req), 'access-control-max-age': '600'});
        return res.end();
      }

      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        const html = fs.readFileSync(htmlFile, 'utf8')
          .replace('__CONTROL_TOKEN__', token)
          .replace('__CONTROL_PORT__', String(ownPort))
          .replace('__REPO_URL__', JSON.stringify(repoUrl));
        // A sandboxed frame has an opaque origin, where CSP 'self' matches
        // nothing. Name the loopback sources explicitly or ui.css/ui.js are
        // refused and the page falls back to unstyled HTML with no handlers.
        const origin = `http://127.0.0.1:${ownPort}`;
        const alt = `http://localhost:${ownPort}`;
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          'content-security-policy': `default-src 'none'; script-src ${origin} ${alt} 'unsafe-inline'; style-src ${origin} ${alt} 'unsafe-inline'; img-src ${origin} ${alt} data:; connect-src ${origin} ${alt}; font-src ${origin} ${alt}; base-uri 'none'; form-action 'none'; frame-ancestors 'self' wails: http://wails.localhost http://localhost:* http://127.0.0.1:*`
        });
        return res.end(html);
      }

      if (req.method === 'GET' && (url.pathname === '/ui.css' || url.pathname === '/ui.js')) {
        const asset = readAsset(url.pathname.slice(1), url.pathname.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8');
        if (!asset) { res.writeHead(404); return res.end('not found'); }
        res.writeHead(200, {'content-type': asset.type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff'});
        return res.end(asset.body);
      }

      if (url.pathname.startsWith('/api/')) {
        const got = Buffer.from(String(req.headers[TOKEN_HEADER] || ''));
        const want = Buffer.from(token);
        if (got.length !== want.length || !timingSafeEqual(got, want)) {
          return sendJson(res, 403, {ok: false, error: '控制口令无效'});
        }
      }

      if (req.method === 'GET' && url.pathname === '/api/status') {
        return sendJson(res, 200, {ok: true, overview: await cachedOverview()});
      }

      if (req.method === 'GET' && url.pathname === '/api/settings') {
        const p = paths(repoRoot);
        return sendJson(res, 200, {ok: true, settings: readBridgeSettings(p.root), defaults: bridgeDefaults, rules: bridgeRules, modes: bridgeModes, subagentModes: bridgeSubagentModes, takeoverModes: bridgeTakeoverModes, file: p.settings});
      }

      if (req.method === 'POST' && url.pathname === '/api/settings') {
        const body = await readBody(req);
        // Serialise writes so two panels saving at once cannot interleave
        // read-modify-write and leave the file with the older payload.
        const job = settingsQueue.then(() => {
          try {
            // The console has separate forms for run parameters and model
            // preferences; each posts only its own fields. Merge over the
            // current file so one form never resets the other's values, while
            // an explicitly posted {} still clears a list.
            const p = paths(repoRoot);
            const saved = writeBridgeSettings(p.root, {...readBridgeSettings(p.root), ...body});
            // The overview snapshot embeds the saved settings; drop the cache so
            // the status call that follows a save never echoes the old values.
            overviewCache = {at: 0, data: null, pending: null};
            // The saved intent takes effect immediately; when Orca is open the
            // result is "pending" and the supervisor retries after it exits.
            let orca = null;
            try {
              orca = reconcileOrca({home: p.home, root: p.root, takeover: saved.orcaTakeover});
            } catch (error) {
              orca = {ok: false, reason: 'error', error: String(error.message || error)};
            }
            log(`bridge settings saved: ${JSON.stringify(saved)}`);
            return {status: 200, body: {ok: true, settings: saved, orca}};
          } catch (error) {
            return {status: 400, body: {ok: false, error: String(error.message || error)}};
          }
        });
        settingsQueue = job.then(() => {}, () => {});
        const result = await job;
        return sendJson(res, result.status, result.body);
      }

      if (req.method === 'GET' && url.pathname === '/api/calls') {
        const p = paths(repoRoot);
        const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 25));
        const errorsOnly = url.searchParams.get('errors') === '1';
        try {
          return sendJson(res, 200, {ok: true, ...(await readRecentCalls(p.database, {limit, errorsOnly}))});
        } catch (error) {
          return sendJson(res, 500, {ok: false, error: `读取调用记录失败：${error.message}`});
        }
      }

      if (req.method === 'GET' && url.pathname === '/api/database') {
        if (busy) return sendJson(res, 409, {ok: false, error: `正在执行「${busy}」，请稍候`});
        const p = paths(repoRoot);
        const fresh = url.searchParams.get('refresh') === '1';
        const deep = url.searchParams.get('deep') === '1';
        const usable = () => databaseCache.data
          && Date.now() - databaseCache.at < DATABASE_CACHE_MS
          && (databaseCache.deep || !deep);
        if (!fresh && usable()) {
          return sendJson(res, 200, {ok: true, database: databaseCache.data, cached: true});
        }
        try {
          // A scan already in flight is shared; wait for it and reuse the
          // result when it covers what this request asked for.
          if (databasePending) {
            await databasePending.promise.catch(() => {});
            if (usable()) {
              return sendJson(res, 200, {ok: true, database: databaseCache.data, cached: true});
            }
          }
          if (!databasePending) {
            const epoch = databaseEpoch;
            const promise = readDatabase(p.database, {deep})
              .then((data) => {
                if (epoch === databaseEpoch) databaseCache = {at: Date.now(), data, deep};
                return data;
              })
              .finally(() => {
                if (databasePending?.promise === promise) databasePending = null;
              });
            databasePending = {deep, promise};
          }
          const data = await databasePending.promise;
          return sendJson(res, 200, {ok: true, database: data, cached: false,depth: deep ? 'deep' : 'fast'});
        } catch (error) {
          return sendJson(res, 500, {ok: false, error: `读取数据库失败：${error.message}`});
        }
      }

      if (req.method === 'POST' && url.pathname === '/api/database/cleanup') {
        const body = await readBody(req);
        const scope = String(body.scope || '');
        if (!['traces', 'sessions', 'all', 'vacuum'].includes(scope)) {
          return sendJson(res, 400, {ok: false, error: `未知的清理范围：${scope || '空'}`});
        }
        const olderThanDays = body.olderThanDays === undefined ? 3 : Number(body.olderThanDays);
        if (scope === 'sessions' && (!Number.isInteger(olderThanDays) || olderThanDays < 1 || olderThanDays > 3650)) {
          return sendJson(res, 400, {ok: false, error: '保留天数需为 1–3650 的整数'});
        }
        if (busy) return sendJson(res, 409, {ok: false, error: `正在执行「${busy}」，请稍候`});
        const vacuum = scope === 'vacuum' || body.vacuum !== false;
        // Destructive scopes are backed up by default; diagnostics cleanup
        // (traces) is not, because it can be the largest and least valuable
        // copy. The console sends an explicit value once its toggle is used.
        const backup = body.backup === undefined
          ? ['sessions', 'all'].includes(scope)
          : body.backup === true;
        busy = '数据库清理';
        log(`database cleanup: ${scope}${scope === 'sessions' ? ` (>${olderThanDays}d)` : ''} vacuum=${vacuum} backup=${backup}`);
        try {
          const p = paths(repoRoot);
          const runtime = readJson(p.status);
          const enginePid = Number(runtime?.pid) || null;
          const supervisorPid = readPid(p.supervisorPid);
          const wasRunning = (!!enginePid && alive(enginePid)) || (!!supervisorPid && alive(supervisorPid));
          let cleanup = null;
          let restart = null;
          let failure = '';
          try {
            // Let an in-flight statistics read close its read transaction
            // before VACUUM asks for an exclusive lock. databasePending is the
            // {deep, promise} wrapper; awaiting the wrapper itself would return
            // immediately and leave the read running through VACUUM.
            if (databasePending) {
              try { await databasePending.promise; } catch { /* the cache is dropped below */ }
            }
            // The engine keeps the database open in WAL mode; stop it so
            // deletes and VACUUM cannot race a live writer.
            if (wasRunning) await stopBridge(repoRoot);
            cleanup = await cleanDatabase(p.database, {
              scope,
              olderThanDays,
              vacuum,
              backup,
              backupDir: path.join(p.data, 'backups')
            });
          } catch (error) {
            failure = String(error?.message || error);
          } finally {
            if (wasRunning) {
              try {
                restart = await runSetup(repoRoot);
              } catch (error) {
                restart = {ok: false, code: null, stdout: '', stderr: '', error: String(error?.message || error)};
              }
            }
            databaseEpoch += 1;
            databaseCache = {at: 0, data: null, deep: false};
            databasePending = null;
            overviewCache = {at: 0, data: null, pending: null};
          }
          if (failure) {
            return sendJson(res, 500, {ok: false, error: `清理失败：${failure}`, restart});
          }
          return sendJson(res, 200, {ok: true, cleanup, restart});
        } finally {
          busy = null;
        }
      }

      // Cursor's own state.vscdb is not the bridge's database: every route
      // here opens it -readonly and never writes. Session lists come from the
      // indexed composerHeaders table; byte totals are explicit per-category
      // scans that the panel triggers one at a time.
      if (url.pathname.startsWith('/api/cursor-store')) {
        const home = paths(repoRoot).home;
        const store = cursorStorePaths(home);
        try {
          if (url.pathname === '/api/cursor-store/overview') {
            const data = await readStoreOverview(store.stateDb, {workspaceRoot: store.workspaceStorage});
            // `probe=1` additionally checks for a live Cursor process; the
            // console only asks for it inside the write-confirmation dialogs.
            const probe = url.searchParams.get('probe') === '1';
            const running = probe ? await cursorRunning() : null;
            return sendJson(res, 200, {ok: true, store: data, categories: CATEGORIES, actions: OFFICIAL_ACTIONS, cursorRunning: running});
          }
          if (url.pathname === '/api/cursor-store/workspaces') {
            return sendJson(res, 200, {ok: true, workspaces: listWorkspaces(store.workspaceStorage)});
          }
          if (url.pathname === '/api/cursor-store/sessions') {
            const data = await listComposers(store.stateDb, {
              workspaceId: url.searchParams.get('workspace') || '',
              kind: url.searchParams.get('kind') || 'all',
              named: url.searchParams.get('named') || 'all',
              mode: url.searchParams.get('mode') || '',
              since: url.searchParams.get('since') || 0,
              until: url.searchParams.get('until') || 0,
              offset: Number(url.searchParams.get('offset')) || 0,
              limit: Number(url.searchParams.get('limit')) || 50
            });
            return sendJson(res, 200, {ok: true, ...data});
          }
          if (url.pathname === '/api/cursor-store/session') {
            const data = await readComposer(store.stateDb, {
              id: url.searchParams.get('id') || '',
              offset: Number(url.searchParams.get('offset')) || 0,
              limit: Number(url.searchParams.get('limit')) || 30,
              includeTools: url.searchParams.get('tools') === '1'
            });
            return sendJson(res, 200, {ok: true, session: data});
          }
          if (url.pathname === '/api/cursor-store/sizes') {
            const ids = String(url.searchParams.get('ids') || '').split(',').filter(Boolean);
            const data = await readSessionSizes(store.stateDb, ids);
            return sendJson(res, 200, {ok: true, ...data});
          }
          if (url.pathname === '/api/cursor-store/value') {
            const data = await readKvValue(store.stateDb, {key: url.searchParams.get('key') || ''});
            return sendJson(res, 200, {ok: true, value: data});
          }
          if (req.method === 'GET' && url.pathname === '/api/cursor-store/delete-preview') {
            const ids = String(url.searchParams.get('ids') || '').split(',').filter(Boolean);
            const data = await previewComposers(store.stateDb, ids);
            const free = storeFreeSpace(store.stateDb);
            const size = fs.existsSync(store.stateDb) ? fs.statSync(store.stateDb).size : 0;
            return sendJson(res, 200, {ok: true, preview: data, cursorRunning: await cursorRunning(), free, size});
          }
          if (req.method === 'POST' && url.pathname === '/api/cursor-store/delete') {
            const body = await readBody(req);
            if (body.confirm !== true) return sendJson(res, 400, {ok: false, error: '删除需要明确确认'});
            const ids = Array.isArray(body.ids) ? body.ids : [];
            if (!ids.length) return sendJson(res, 400, {ok: false, error: '未选择会话'});
            if (await cursorRunning()) {
              return sendJson(res, 409, {ok: false, error: 'Cursor 正在运行：请完全退出 Cursor 后再删除，否则它会把内存中的会话写回数据库'});
            }
            if (busy) return sendJson(res, 409, {ok: false, error: `正在执行「${busy}」，请稍候`});
            busy = '删除 Cursor 会话';
            log(`cursor store delete: ${ids.length} session(s)`);
            try {
              const deleted = await deleteComposers(store.stateDb, ids);
              clearStoreCaches();
              log(`cursor store delete: ${deleted.totalRows} rows / ${deleted.totalBytes} bytes in ${deleted.elapsedMs} ms`);
              return sendJson(res, 200, {ok: true, deleted});
            } finally {
              busy = null;
            }
          }
          if (req.method === 'POST' && url.pathname === '/api/cursor-store/vacuum') {
            const body = await readBody(req);
            if (body.confirm !== true) return sendJson(res, 400, {ok: false, error: '压缩需要明确确认'});
            if (await cursorRunning()) {
              return sendJson(res, 409, {ok: false, error: 'Cursor 正在运行：请完全退出 Cursor 后再压缩'});
            }
            if (!fs.existsSync(store.stateDb)) return sendJson(res, 404, {ok: false, error: '未找到 Cursor 数据库'});
            const size = fs.statSync(store.stateDb).size;
            const free = storeFreeSpace(store.stateDb);
            if (free !== null && free < size * 1.1) {
              return sendJson(res, 409, {ok: false, error: `可用空间不足：压缩需要约 ${Math.round(size / 1024 ** 3)} GB 临时空间`});
            }
            if (busy) return sendJson(res, 409, {ok: false, error: `正在执行「${busy}」，请稍候`});
            busy = '压缩 Cursor 数据库';
            log(`cursor store vacuum: ${Math.round(size / 1024 ** 3)} GB`);
            try {
              const result = await vacuumStore(store.stateDb);
              clearStoreCaches();
              log(`cursor store vacuum: ${result.before} -> ${result.after} bytes in ${result.elapsedMs} ms`);
              return sendJson(res, 200, {ok: true, vacuum: result});
            } finally {
              busy = null;
            }
          }
          if (url.pathname === '/api/cursor-store/scan') {
            const data = await scanCategoryCached(store.stateDb, {
              category: url.searchParams.get('category') || '',
              mode: url.searchParams.get('mode') === 'exact' ? 'exact' : 'estimate'
            });
            return sendJson(res, 200, {ok: true, scan: data});
          }
          return sendJson(res, 404, {ok: false, error: '未知的 Cursor 存储接口'});
        } catch (error) {
          // A WAL database without its -shm file is handled inside sqlite()
          // (query_only fallback), so a CANTOPEN here means the file or its
          // directory is genuinely inaccessible. The other common failure is a
          // lock timeout while Cursor writes heavily.
          const message = String(error?.message || '');
          const hint = /database is locked|database table is locked|database is busy/i.test(message)
            ? '（数据库正被 Cursor 写入占用，请稍后重试或完全退出 Cursor）'
            : /unable to open database file|SQLITE_CANTOPEN/i.test(message)
              ? '（无法打开数据库文件：请确认文件存在，且当前用户对数据库与所在目录有读写权限）'
              : '';
          return sendJson(res, 500, {ok: false, error: `读取 Cursor 存储失败：${error.message}${hint}`});
        }
      }

      if (req.method === 'GET' && url.pathname === '/api/logs') {
        const p = paths(repoRoot);
        const names = {engine: p.engineLog, supervisor: p.supervisorLog, error: p.supervisorError};
        const name = String(url.searchParams.get('name') || 'engine');
        const file = names[name];
        if (!file) return sendJson(res, 400, {ok: false, error: `未知的日志：${name}`});
        const lines = Math.min(2000, Math.max(1, Number(url.searchParams.get('tail')) || 200));
        const tail = tailFile(file, {lines});
        return sendJson(res, 200, {
          ok: true,
          name,
          path: file,
          exists: tail.exists,
          size: tail.size,
          updated: tail.updated,
          truncated: tail.truncated,
          lines: tail.lines,
          text: redact(tail.text),
          hints: classify(tail.text)
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/selftest') {
        const body = await readBody(req);
        if (busy) return sendJson(res, 409, {ok: false, error: `正在执行「${busy}」，请稍候`});
        busy = '自检';
        try {
          const p = paths(repoRoot);
          const result = await runSelfTest({
            installation: readJson(p.installation),
            connection: readConnection(p.connections),
            runtime: readJson(p.status),
            dataDir: p.data,
            gatewayBase: gatewayBase(p.home),
            includeModel: body.model !== false,
            alive
          });
          const failed = result.checks.filter((check) => !check.ok && !check.skipped).map((check) => check.id);
          log(`self-test: ${result.ok ? 'ok' : `failed (${failed.join(',') || 'unknown'})`}`);
          return sendJson(res, 200, {ok: true, result});
        } finally {
          busy = null;
        }
      }

      if (req.method === 'GET' && url.pathname === '/api/diagnostics') {
        return sendJson(res, 200, await buildDiagnostics());
      }

      if (req.method === 'POST' && url.pathname === '/api/diagnostics') {
        // The control page runs in a WebView where a Blob download may not be
        // wired up; writing the bundle locally and returning its path works on
        // every platform and keeps the text out of the browser.
        const data = await buildDiagnostics();
        const p = paths(repoRoot);
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const file = path.join(p.diagnostics, `diagnostics-${stamp}.json`);
        atomic(file, JSON.stringify(data, null, 2) + '\n');
        return sendJson(res, 200, {ok: true, file, generated: data.generated, hints: data.hints});
      }

      if (req.method === 'GET' && url.pathname === '/api/update') {
        try {
          return sendJson(res, 200, await updateStatus());
        } catch (error) {
          return sendJson(res, 200, {ok: false, error: String(error.message || error)});
        }
      }

      if (req.method === 'POST' && url.pathname === '/api/update') {
        const body = await readBody(req);
        if (body.confirm !== true) return sendJson(res, 400, {ok: false, error: '升级需要显式确认'});
        if (busy) return sendJson(res, 409, {ok: false, error: `正在执行「${busy}」，请稍候`});
        busy = '升级';
        try {
          const info = await updateStatus({force: true});
          if (!info.updateAvailable) {
            return sendJson(res, 200, {ok: true, updated: false, message: `已是最新版本 v${info.current}`});
          }
          if (!info.canUpgrade) {
            return sendJson(res, 409, {ok: false, error: '当前安装方式不支持一键升级，请按提示命令手动升级', command: info.command});
          }
          const p = paths(repoRoot);
          const installation = readJson(p.installation);
          const source = installation?.source || repoRoot;
          const fetched = await run('git', ['-C', source, 'fetch', '--tags', 'origin'], {timeout: 60000});
          if (!fetched.ok) throw new Error(`git fetch 失败：${fetched.error || fetched.stderr || fetched.stdout}`);
          const merged = await run('git', ['-C', source, 'merge', '--ff-only', info.latestTag], {timeout: 30000});
          if (!merged.ok) throw new Error(`无法快进到 ${info.latestTag}：${merged.stderr || merged.stdout || merged.error}`);
          const manifest = readJson(path.join(source, 'package.json'));
          if (manifest?.version !== info.latest) {
            throw new Error(`源码版本为 ${manifest?.version || '未知'}，不是 ${info.latest}`);
          }
          const setup = await runSetup(source);
          updateCache = {at: 0, data: null};
          log(`update: ${info.current} -> ${info.latest} setup=${setup.ok ? 'ok' : 'failed'}`);
          if (!setup.ok) {
            return sendJson(res, 500, {ok: false, error: `源码已更新到 ${info.latest}，但安装失败：${setup.error || '未知错误'}`, setup});
          }
          return sendJson(res, 200, {ok: true, updated: true, from: info.current, to: info.latest, setup});
        } catch (error) {
          return sendJson(res, 500, {ok: false, error: String(error.message || error)});
        } finally {
          busy = null;
        }
      }

      if (req.method === 'POST' && url.pathname === '/api/action') {
        const body = await readBody(req);
        const action = String(body.action || '');
        if (!['start', 'status', 'restart', 'stop'].includes(action)) {
          return sendJson(res, 400, {ok: false, error: `未知操作：${action || '空'}`});
        }
        if (busy) return sendJson(res, 409, {ok: false, error: `正在执行「${busy}」，请稍候`});
        busy = action;
        log(`control action: ${action}`);
        try {
          let result;
          if (action === 'status') {
            result = await runStatus(repoRoot);
          } else if (action === 'stop') {
            await stopBridge(repoRoot);
            const p = paths(repoRoot);
            // A force-killed supervisor cannot run its finally block; restore the
            // journal explicitly and leave a stopped status the panel can show.
            restoreProxy(path.join(p.root, 'settings-journal.json'));
            const current = readJson(p.status) || {};
            atomic(p.status, JSON.stringify({...current, state: 'stopped', updated: new Date().toISOString()}, null, 2));
            result = {ok: true, code: 0, stdout: '后台已停止，Cursor 代理已还原。', stderr: '', error: ''};
          } else if (action === 'restart') {
            await stopBridge(repoRoot);
            result = await runSetup(repoRoot);
          } else {
            result = await runSetup(repoRoot);
          }
          result.action = action;
          result.overview = await overview(repoRoot, ownPort);
          overviewCache = {at: Date.now(), data: result.overview, pending: null};
          return sendJson(res, 200, result);
        } finally {
          busy = null;
        }
      }

      if (req.method === 'GET' && url.pathname === '/api/agent/models') {
        const p = paths(repoRoot);
        try {
          const models = await magpieCatalogue(p.home);
          let current = null;
          for (const candidate of p.connections) {
            const data = readJson(candidate);
            if (data?.model) { current = data.model; break; }
          }
          return sendJson(res, 200, {ok: true, models, current});
        } catch (error) {
          return sendJson(res, 200, {ok: false, error: String(error.message || error)});
        }
      }

      if (req.method === 'POST' && url.pathname === '/api/agent/test') {
        const body = await readBody(req);
        const model = String(body.model || '').trim();
        if (!model) return sendJson(res, 400, {ok: false, error: '请选择一个模型'});
        if (busy) return sendJson(res, 409, {ok: false, error: `正在执行「${busy}」，请稍候`});
        busy = '模型测试';
        try {
          return sendJson(res, 200, {ok: true, ...(await runModelTest(repoRoot, model))});
        } catch (error) {
          return sendJson(res, 500, {ok: false, error: String(error.message || error)});
        } finally {
          busy = null;
        }
      }

      if (req.method === 'POST' && url.pathname === '/api/agent/connect') {
        const body = await readBody(req);
        const model = String(body.model || '').trim();
        if (!model) return sendJson(res, 400, {ok: false, error: '请选择一个模型'});
        if (busy) return sendJson(res, 409, {ok: false, error: `正在执行「${busy}」，请稍候`});
        busy = 'connect';
        try {
          const p = paths(repoRoot);
          const models = await magpieCatalogue(p.home);
          if (!models.some((entry) => entry.id === model)) {
            return sendJson(res, 400, {ok: false, error: '该模型已不在 Magpie 目录中，请刷新后重试'});
          }
          // One click must also work on a fresh install: start the background
          // service first when the user has not pressed 启动 yet.
          const pid = readPid(p.supervisorPid);
          if (!pid || !alive(pid)) {
            const setup = await runSetup(repoRoot);
            if (!setup.ok) {
              return sendJson(res, 500, {ok: false, error: setup.error || '后台服务启动失败', stdout: setup.stdout, stderr: setup.stderr});
            }
          }
          await connectAgent(model);
          // The supervisor polls every two seconds; give it time to start the
          // engine so the console can report a final state instead of "启动中".
          const until = Date.now() + 20000;
          while (Date.now() < until) {
            const runtime = readJson(p.status);
            if ((runtime?.state === 'connected' && runtime.engineMode) || runtime?.state === 'error') break;
            await wait(500);
          }
          let connection = null;
          for (const candidate of p.connections) {
            const data = readJson(candidate);
            if (data?.model) { connection = data; break; }
          }
          if (!connection || connection.model !== model) {
            return sendJson(res, 500, {ok: false, error: '模型没有写入连接配置；请确认 Magpie 中该 agent 可用'});
          }
          const fresh = await overview(repoRoot, ownPort);
          overviewCache = {at: Date.now(), data: fresh, pending: null};
          return sendJson(res, 200, {ok: true, overview: fresh});
        } catch (error) {
          return sendJson(res, 500, {ok: false, error: String(error.message || error)});
        } finally {
          busy = null;
        }
      }

      if (req.method === 'GET' && url.pathname === '/api/cursor-agent') {
        const p = paths(repoRoot);
        const snapshot = await cachedOverview();
        const caPath = path.join(p.data, 'ca/ca.crt');
        const takeover = readBridgeSettings(p.root).orcaTakeover;
        return sendJson(res, 200, {
          ok: true,
          agent: agentStatus({
            root: p.root,
            home: p.home,
            proxy: snapshot.runtime?.proxy || null,
            caPath: fs.existsSync(caPath) ? caPath : null
          }),
          orca: orcaStatus({root: p.root, home: p.home, takeover})
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/cursor-agent') {
        const body = await readBody(req);
        const p = paths(repoRoot);
        try {
          if (body.action === 'install') {
            const result = installWrapper({root: p.root, home: p.home});
            log(`cursor-agent wrapper installed: ${result.path}`);
            return sendJson(res, 200, {ok: true, ...result});
          }
          if (body.action === 'remove') {
            const result = removeWrapper({root: p.root, home: p.home});
            log(`cursor-agent wrapper removed: ${result.path}`);
            return sendJson(res, 200, {ok: true, ...result});
          }
          if (body.action === 'hook-install') {
            const result = installShellHook({root: p.root, home: p.home});
            log(`cursor-agent shell hook installed: ${result.path}`);
            return sendJson(res, 200, {ok: true, ...result});
          }
          if (body.action === 'hook-remove') {
            const result = removeShellHook({home: p.home});
            log(`cursor-agent shell hook removed: ${result.path}`);
            return sendJson(res, 200, {ok: true, ...result});
          }
          if (body.action === 'entry-install') {
            const result = installEntry({root: p.root, home: p.home});
            log(`cursor-agent entry installed: ${result.path}`);
            return sendJson(res, 200, {ok: true, ...result});
          }
          if (body.action === 'entry-remove') {
            const result = removeEntry({home: p.home});
            log(`cursor-agent entry restored: ${result.path}`);
            return sendJson(res, 200, {ok: true, ...result});
          }
          if (body.action === 'orca-install' || body.action === 'orca-remove') {
            const want = body.action === 'orca-install' ? 'on' : 'off';
            const status = orcaStatus({home: p.home, root: p.root, takeover: want});
            // A command the user configured themselves is never replaced, and
            // their intent is not overwritten either.
            if (status.foreignOverride) {
              return sendJson(res, 409, {ok: false, reason: 'foreign-override', error: 'Orca 已配置自定义 cursor 命令；请先清空该设置再接管'});
            }
            // Persist the intent before touching Orca's file: while Orca runs
            // the panel reports "pending" and the supervisor finishes later.
            const saved = writeBridgeSettings(p.root, {...readBridgeSettings(p.root), orcaTakeover: want});
            const result = reconcileOrca({home: p.home, root: p.root, running: status.running, takeover: saved.orcaTakeover});
            log(`orca cursor override ${want === 'on' ? 'requested' : 'removal requested'}: ${result.path}`);
            return sendJson(res, 200, {ok: true, ...result});
          }
          return sendJson(res, 400, {ok: false, error: '未知操作'});
        } catch (error) {
          return sendJson(res, 400, {ok: false, error: String(error.message || error)});
        }
      }

      if (req.method === 'POST' && url.pathname === '/api/open') {
        const body = await readBody(req);
        const p = paths(repoRoot);
        const targets = {
          config: p.root,
          data: p.data,
          diagnostics: p.diagnostics,
          'engine-log': p.engineLog,
          'supervisor-log': p.supervisorLog,
          'supervisor-error-log': p.supervisorError,
          install: p.share,
          repo: p.repo,
          plist: p.plist || '',
          // Opening a URL through the host OS is the only reliable way out of
          // Magpie's WebView, where target="_blank" is blocked.
          github: repoUrl
        };
        const target = targets[String(body.target || '')];
        if (!target) {
          return sendJson(res, 400, {
            ok: false,
            error: body.target === 'github' ? 'package.json 未配置 GitHub 仓库地址' : '未知的打开目标'
          });
        }
        const external = /^https:\/\//i.test(target);
        const opener = platform.current.openCommand(target);
        if (!opener) return sendJson(res, 400, {ok: false, error: `当前平台（${platform.platform}）没有可用的打开命令`});
        // The diagnostics folder only appears after the first export; opening it
        // early should still work instead of reporting a missing path.
        if (body.target === 'diagnostics') {
          try { fs.mkdirSync(target, {recursive: true, mode: 0o700}); } catch { /* report the real path below */ }
        }
        if (!external && !fs.existsSync(target)) return sendJson(res, 404, {ok: false, error: `路径不存在：${target}`});
        const result = await run(opener.command, opener.args, {timeout: 10000});
        // explorer.exe exits 1 even when it opened the folder.
        const opened = result.ok || (platform.IS_WIN && result.code === 1);
        return sendJson(res, opened ? 200 : 500, opened ? {ok: true} : {ok: false, error: result.error || '打开失败'});
      }

      res.writeHead(404, {'content-type': 'text/plain; charset=utf-8'});
      res.end('not found');
    } catch (error) {
      log(`control request failed: ${error?.stack || error}`);
      if (!res.headersSent) sendJson(res, 500, {ok: false, error: String(error?.message || error)});
      else res.end();
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      ownPort = server.address().port;
      log(`listening on http://127.0.0.1:${ownPort}`);
      resolve({server, port: ownPort});
    });
  });
}
