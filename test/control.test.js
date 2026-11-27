import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createControlServer, paths, readConnection} from '../control/server.js';
import platformModule from '../lib/platform.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function fakeHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-bridge-control-'));
  t.after(() => fs.rmSync(home, {recursive: true, force: true}));
  // pathsFor() reads %APPDATA% on Windows, so point the environment at the
  // temporary home as well; CURSOR_BRIDGE_HOME alone is not enough there.
  const env = {};
  for (const key of ['APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME']) env[key] = process.env[key];
  if (process.platform === 'win32') {
    process.env.APPDATA = path.join(home, 'AppData', 'Roaming');
    process.env.LOCALAPPDATA = path.join(home, 'AppData', 'Local');
  } else {
    process.env.XDG_CONFIG_HOME = path.join(home, 'xdg-config');
    process.env.XDG_DATA_HOME = path.join(home, 'xdg-data');
  }
  t.after(() => {
    for (const key of Object.keys(env)) {
      if (env[key] === undefined) delete process.env[key];
      else process.env[key] = env[key];
    }
  });
  const root = platformModule.pathsFor(home).config;
  fs.mkdirSync(root, {recursive: true});
  fs.writeFileSync(path.join(root, 'installation.json'), JSON.stringify({
    version: '9.9.9', release: '/tmp/bridge-release', installed: '2026-01-01T00:00:00.000Z'
  }));
  fs.writeFileSync(path.join(root, 'status.json'), JSON.stringify({
    version: '9.9.9', state: 'connected', model: 'group/opus', models: 4,
    proxy: 'http://127.0.0.1:58160', backend: 'http://127.0.0.1:53902',
    pid: process.pid, updated: '2026-01-01T00:00:01.000Z'
  }));
  fs.writeFileSync(path.join(root, 'connection.json'), JSON.stringify({
    enabled: true, gateway: 'http://127.0.0.1:3425/v1', key: 'secret-gateway-key',
    model: 'group/opus', models: [{id: 'group/opus'}]
  }));
  return home;
}

function request(port, {method = 'GET', path: pathname = '/', headers = {}, body} = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({host: '127.0.0.1', port, path: pathname, method, headers}, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({status: res.statusCode, headers: res.headers, body: data}));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

test('connection lookup skips missing and malformed candidates', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-bridge-connection-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const missing = path.join(dir, 'missing.json');
  const broken = path.join(dir, 'broken.json');
  const valid = path.join(dir, 'valid.json');
  fs.writeFileSync(broken, '{');
  fs.writeFileSync(valid, JSON.stringify({enabled: true, model: 'group/opus'}));
  assert.deepEqual(readConnection([missing, broken, valid]), {enabled: true, model: 'group/opus'});
  assert.equal(readConnection([missing, broken]), null);
});

test('control console serves a tokenised page and guards /api', async (t) => {
  const home = fakeHome(t);
  const previous = process.env.CURSOR_BRIDGE_HOME;
  process.env.CURSOR_BRIDGE_HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.CURSOR_BRIDGE_HOME;
    else process.env.CURSOR_BRIDGE_HOME = previous;
  });
  const {server, port} = await createControlServer({repoRoot, port: 0, log: () => {}});
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const page = await request(port, {path: '/'});
  assert.equal(page.status, 200);
  assert.doesNotMatch(page.body, /__CONTROL_TOKEN__|__CONTROL_PORT__/);
  const token = page.body.match(/__BRIDGE_TOKEN__="([0-9a-f]{64})"/)?.[1];
  assert.ok(token, 'token is inlined into the page');
  assert.equal((await request(port, {path: '/ui.js'})).status, 200);
  assert.match(page.body, /id="github"/);
  assert.match(page.body, /window\.__BRIDGE_REPO__="https:\/\/github\.com\//);
  assert.doesNotMatch(page.body, /__REPO_URL__/);

  const missing = await request(port, {path: '/api/status'});
  assert.equal(missing.status, 403);

  const ok = await request(port, {path: '/api/status', headers: {'x-magpiebridge-token': token}});
  assert.equal(ok.status, 200);
  const overview = JSON.parse(ok.body).overview;
  assert.equal(overview.version, '9.9.9');
  assert.equal(overview.runtime.state, 'connected');
  assert.equal(overview.connection.gateway, 'http://127.0.0.1:3425/v1');
  assert.doesNotMatch(ok.body, /secret-gateway-key/);

  const evilHost = await request(port, {path: '/api/status', headers: {'x-magpiebridge-token': token, host: 'evil.example'}});
  assert.equal(evilHost.status, 421);
  const evilOrigin = await request(port, {path: '/api/status', headers: {'x-magpiebridge-token': token, origin: 'http://evil.example'}});
  assert.equal(evilOrigin.status, 403);

  const preflight = await request(port, {method: 'OPTIONS', path: '/api/status', headers: {origin: 'null'}});
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers['access-control-allow-origin'], 'null');
  assert.match(preflight.headers['access-control-allow-headers'], /x-magpiebridge-token/);
});

test('console lists Magpie models and connects the agent in one click', async (t) => {
  const home = fakeHome(t);
  const previous = process.env.CURSOR_BRIDGE_HOME;
  process.env.CURSOR_BRIDGE_HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.CURSOR_BRIDGE_HOME;
    else process.env.CURSOR_BRIDGE_HOME = previous;
  });
  // Magpie publishes its loopback gateway in gateway.json; the console reads
  // the catalogue from there so the model picker works before connecting.
  const magpieDir = platformModule.magpieConfigDirFor(home);
  fs.mkdirSync(magpieDir, {recursive: true});
  const gateway = http.createServer((req, res) => {
    res.writeHead(200, {'content-type': 'application/json'});
    if (req.url.endsWith('/chat/completions')) {
      res.end(JSON.stringify({choices: [{message: {content: 'BRIDGE_OK'}}]}));
      return;
    }
    res.end(JSON.stringify({data: [
      {id: 'group/opus', magpie_label: 'Opus · Group', display_name: 'Opus'},
      {id: 'group/sonnet', display_name: 'Sonnet'}
    ]}));
  });
  await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => gateway.close(resolve)));
  fs.writeFileSync(path.join(magpieDir, 'gateway.json'), JSON.stringify({addr: `127.0.0.1:${gateway.address().port}`}));

  const p = paths(repoRoot);
  fs.mkdirSync(path.dirname(p.supervisorPid), {recursive: true});
  fs.writeFileSync(p.supervisorPid, String(process.pid));

  const connectAgent = async (model) => {
    // Linux keeps the XDG root for state while Magpie writes connection.json
    // under ~/.config, so the two directories are distinct in this fixture.
    fs.mkdirSync(path.dirname(p.connections[0]), {recursive: true});
    fs.writeFileSync(p.connections[0], JSON.stringify({
      enabled: true, gateway: `http://127.0.0.1:${gateway.address().port}/v1`, key: 'secret',
      model, models: [{id: model}]
    }));
    fs.writeFileSync(p.status, JSON.stringify({
      version: '9.9.9', state: 'connected', mode: 'default', engineMode: 'default',
      model, models: 1, pid: process.pid, updated: new Date().toISOString()
    }));
  };
  const {server, port} = await createControlServer({repoRoot, port: 0, log: () => {}, connectAgent});
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const page = await request(port, {path: '/'});
  const token = page.body.match(/__BRIDGE_TOKEN__="([0-9a-f]{64})"/)[1];
  const headers = {'x-magpiebridge-token': token};

  const catalogue = JSON.parse((await request(port, {path: '/api/agent/models', headers})).body);
  assert.equal(catalogue.ok, true);
  assert.deepEqual(catalogue.models, [
    {id: 'group/opus', name: 'Opus · Group'},
    {id: 'group/sonnet', name: 'Sonnet'}
  ]);

  const connected = JSON.parse((await request(port, {
    method: 'POST', path: '/api/agent/connect', headers: {...headers, 'content-type': 'application/json'},
    body: JSON.stringify({model: 'group/opus'})
  })).body);
  assert.equal(connected.ok, true, JSON.stringify(connected));
  assert.equal(connected.overview.connection.model, 'group/opus');
  assert.equal(connected.overview.engine.alive, true);

  const tested = JSON.parse((await request(port, {
    method: 'POST', path: '/api/agent/test', headers: {...headers, 'content-type': 'application/json'},
    body: JSON.stringify({model: 'group/opus'})
  })).body);
  assert.equal(tested.ok, true, JSON.stringify(tested));
  assert.equal(tested.text, 'BRIDGE_OK');
  assert.ok(tested.latencyMs >= 0);

  const unknown = await request(port, {
    method: 'POST', path: '/api/agent/connect', headers: {...headers, 'content-type': 'application/json'},
    body: JSON.stringify({model: 'group/missing'})
  });
  assert.equal(unknown.status, 400);
});

test('logs are redacted and diagnostics omit gateway credentials', async (t) => {
  const home = fakeHome(t);
  const previous = process.env.CURSOR_BRIDGE_HOME;
  process.env.CURSOR_BRIDGE_HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.CURSOR_BRIDGE_HOME;
    else process.env.CURSOR_BRIDGE_HOME = previous;
  });
  const root = platformModule.pathsFor(home).config;
  fs.writeFileSync(path.join(root, 'engine.log'), 'Authorization: Bearer supersecret\nready\n');
  fs.writeFileSync(path.join(root, 'supervisor.log'), 'EADDRINUSE: port in use\n');
  fs.writeFileSync(path.join(root, 'retention.json'), JSON.stringify({
    at: '2026-01-01T00:00:00.000Z', calls: 2, traces: 1, sessions: 0
  }));
  const {server, port} = await createControlServer({repoRoot, port: 0, log: () => {}});
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const page = await request(port, {path: '/'});
  const token = page.body.match(/__BRIDGE_TOKEN__="([0-9a-f]{64})"/)[1];
  const headers = {'x-magpiebridge-token': token};

  const logs = JSON.parse((await request(port, {path: '/api/logs?name=engine&tail=10', headers})).body);
  assert.equal(logs.ok, true);
  assert.doesNotMatch(logs.text, /supersecret/);
  assert.match(logs.text, /\[redacted\]/);

  const diagnostics = JSON.parse((await request(port, {path: '/api/diagnostics', headers})).body);
  assert.equal(diagnostics.ok, true);
  assert.doesNotMatch(JSON.stringify(diagnostics), /secret-gateway-key/);
  assert.equal(diagnostics.retention.calls, 2);
  assert.match(diagnostics.logs.engine.text, /\[redacted\]/);
  assert.ok(diagnostics.hints.some((hint) => hint.id === 'port'));

  const exported = JSON.parse((await request(port, {method: 'POST', path: '/api/diagnostics', headers})).body);
  assert.equal(exported.ok, true);
  assert.ok(exported.file.startsWith(path.join(root, 'data', 'diagnostics')));
  assert.ok(fs.existsSync(exported.file));
  assert.doesNotMatch(fs.readFileSync(exported.file, 'utf8'), /secret-gateway-key/);
});

test('control settings validate and are written to the bridge root', async (t) => {
  const home = fakeHome(t);
  const previous = process.env.CURSOR_BRIDGE_HOME;
  process.env.CURSOR_BRIDGE_HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.CURSOR_BRIDGE_HOME;
    else process.env.CURSOR_BRIDGE_HOME = previous;
  });
  const {server, port} = await createControlServer({repoRoot, port: 0, log: () => {}});
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const page = await request(port, {path: '/'});
  const token = page.body.match(/__BRIDGE_TOKEN__="([0-9a-f]{64})"/)[1];
  const headers = {'x-magpiebridge-token': token, 'content-type': 'application/json'};

  const bad = await request(port, {method: 'POST', path: '/api/settings', headers, body: JSON.stringify({refreshSeconds: 1})});
  assert.equal(bad.status, 400);
  assert.match(bad.body, /5–300/);

  const badMode = await request(port, {method: 'POST', path: '/api/settings', headers, body: JSON.stringify({runMode: 'turbo'})});
  assert.equal(badMode.status, 400);
  assert.match(badMode.body, /default 或 lite/);

  const badSubagentMode = await request(port, {method: 'POST', path: '/api/settings', headers, body: JSON.stringify({subagentMode: 'parallel'})});
  assert.equal(badSubagentMode.status, 400);
  assert.match(badSubagentMode.body, /async 或 sync/);

  const badOrca = await request(port, {method: 'POST', path: '/api/settings', headers, body: JSON.stringify({orcaTakeover: 'sometimes'})});
  assert.equal(badOrca.status, 400);
  assert.match(badOrca.body, /接管 Orca 需为 on 或 off/);

  const badName = await request(port, {method: 'POST', path: '/api/settings', headers, body: JSON.stringify({modelNames: {'group/opus': 'x'.repeat(81)}})});
  assert.equal(badName.status, 400);
  assert.match(badName.body, /80 个字符/);

  const expected = {runMode: 'lite', subagentMode: 'sync', orcaTakeover: 'off', showOfficialModels: false, refreshSeconds: 20, gatewayGraceSeconds: 90, logLimitMB: 6, tracesRetentionDays: 14, sessionsRetentionDays: 30, modelNames: {'group/opus': 'Opus 4.5'}, modelOrder: ['group/sonnet', 'group/opus'], modelHidden: ['group/sonnet']};
  const good = await request(port, {method: 'POST', path: '/api/settings', headers, body: JSON.stringify(expected)});
  assert.equal(good.status, 200);
  assert.deepEqual(JSON.parse(good.body).settings, expected);
  const file = paths(repoRoot).settings;
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), expected);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  // The model form and the run-parameter form post disjoint fields; a partial
  // save must preserve everything owned by the other form.
  const partial = await request(port, {method: 'POST', path: '/api/settings', headers, body: JSON.stringify({refreshSeconds: 25})});
  assert.equal(partial.status, 200);
  const merged = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(merged.refreshSeconds, 25);
  assert.equal(merged.tracesRetentionDays, expected.tracesRetentionDays);
  assert.deepEqual(merged.modelNames, expected.modelNames);
  assert.deepEqual(merged.modelHidden, expected.modelHidden);
});
