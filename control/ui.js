(() => {
  'use strict';

  const TOKEN = window.__BRIDGE_TOKEN__ || '';
  const PORT = window.__BRIDGE_PORT__ || location.port;
  const $ = (id) => document.getElementById(id);
  const tokenHeader = 'x-magpiebridge-token';
  const STATES = {
    connected: {label: '已连接', kind: 'connected'},
    disconnected: {label: '未连接', kind: 'idle'},
    paused: {label: '已暂停', kind: 'paused'},
    error: {label: '错误', kind: 'error'},
    stopped: {label: '已停止', kind: 'idle'}
  };
  const MODES = {default: '默认模式', lite: '轻量模式'};

  let busy = null;
  let serviceSupported = true;
  let settingsFilled = false;
  let modelNamesFilled = false;
  let modelNamesLoading = false;
  let modelNamesRetryAt = 0;
  let dragRow = null;
  let dragSnapshot = null;
  let pollTimer = null;
  let lastOverview = null;
  let dbData = null;
  let dbLoading = false;
  let updateCommand = '';
  let agentModels = {at: 0, models: null};
  let pendingClean = null;
  let cleaning = false;
  let agentCli = {at: 0, data: null, loading: false};

  function applyTheme() {
    const params = new URLSearchParams(location.search);
    const theme = params.get('theme');
    document.documentElement.dataset.theme = theme === 'dark' || theme === 'light'
      ? theme
      : (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const raw = params.get('tokens');
    if (!raw) return;
    try {
      const bytes = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
      const tokens = JSON.parse(new TextDecoder().decode(bytes));
      for (const [key, value] of Object.entries(tokens)) {
        if (value) document.documentElement.style.setProperty(`--magpie-${key}`, String(value));
      }
    } catch { /* keep the built-in palette */ }
  }

  // The token is minted once per control-service process (see
  // control/server.js) and inlined into the HTML only. When Magpie restarts
  // the plugin host, rebinds the port, or the plugin is reloaded, a console
  // page that is already open keeps the old token and every /api call is
  // refused with 403 「控制口令无效」. Reloading the page fetches the HTML —
  // and with it the current token — again. A short cooldown keeps a second
  // 403 (e.g. a proxy in between) from looping reloads forever.
  const RELOAD_MARK = 'bridge-token-reload-at';
  const RELOAD_COOLDOWN = 15000;

  function reloadForStaleToken() {
    const now = Date.now();
    let last = 0;
    try { last = Number(sessionStorage.getItem(RELOAD_MARK)) || 0; } catch { /* storage is optional */ }
    if (now - last < RELOAD_COOLDOWN) return false;
    try { sessionStorage.setItem(RELOAD_MARK, String(now)); } catch { /* storage is optional */ }
    location.reload();
    return true;
  }

  async function api(pathname, {method = 'GET', body} = {}) {
    const response = await fetch(pathname, {
      method,
      headers: {'content-type': 'application/json', [tokenHeader]: TOKEN},
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store'
    });
    let data = null;
    try { data = await response.json(); } catch {}
    if (!response.ok || !data || data.ok === false) {
      const stale = response.status === 403 && data?.error === '控制口令无效';
      if (stale && reloadForStaleToken()) {
        // The page is about to be replaced; hold the caller instead of
        // flashing a failure the user cannot act on.
        return new Promise(() => {});
      }
      const error = new Error(stale
        ? '控制口令已过期：请点击「刷新页面」重新加载控制台'
        : (data?.error || `HTTP ${response.status}`));
      error.stale = stale;
      throw error;
    }
    return data;
  }

  function timeText(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }

  function shorten(value, most = 44) {
    const text = String(value || '');
    return text.length > most ? `…${text.slice(-(most - 1))}` : text;
  }

  function bytes(value) {
    if (!Number.isFinite(value)) return '—';
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
    return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }

  function setBusy(value) {
    for (const id of ['start', 'stop', 'status', 'restart', 'agentConnect', 'saveModelNames', 'updateRun']) {
      if ($(id)) $(id).disabled = value;
    }
    for (const button of document.querySelectorAll('.row-save')) button.disabled = value;
    if (!serviceSupported) {
      $('start').disabled = true;
      $('restart').disabled = true;
    }
    $('busy').hidden = !value;
    updateDbControls();
  }

  function numberText(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n.toLocaleString('zh-CN') : '—';
  }

  function dbTable(headers, rows) {
    const table = document.createElement('table');
    table.className = 'db-table';
    const head = document.createElement('thead');
    const headRow = document.createElement('tr');
    for (const text of headers) {
      const th = document.createElement('th');
      th.textContent = text;
      headRow.append(th);
    }
    head.append(headRow);
    const body = document.createElement('tbody');
    for (const cells of rows) {
      const row = document.createElement('tr');
      for (const cell of cells) {
        const td = document.createElement('td');
        if (cell && typeof cell === 'object') {
          td.textContent = String(cell.text ?? '');
          if (cell.mono) td.className = 'mono';
          if (cell.title) td.title = cell.title;
        } else {
          td.textContent = String(cell ?? '');
        }
        row.append(td);
      }
      body.append(row);
    }
    table.append(head, body);
    return table;
  }

  function updateDbControls() {
    const unavailable = cleaning || dbLoading || !!busy || !dbData?.exists;
    for (const button of document.querySelectorAll('[data-clean]')) button.disabled = unavailable;
    if ($('dbRefresh')) $('dbRefresh').disabled = cleaning || dbLoading;
    if ($('dbDeep')) $('dbDeep').disabled = cleaning || dbLoading;
    if ($('cleanDays')) $('cleanDays').disabled = cleaning;
    if ($('dbVacuum')) $('dbVacuum').disabled = cleaning;
    if ($('dbBackup')) $('dbBackup').disabled = cleaning;
    if ($('dbConfirmType')) $('dbConfirmType').disabled = cleaning;
    if ($('dbConfirmGo')) {
      $('dbConfirmGo').disabled = cleaning || !pendingClean
        || (pendingClean.scope === 'all' && $('dbConfirmType').value.trim() !== '清空全部');
    }
    if ($('dbConfirmCancel')) $('dbConfirmCancel').disabled = cleaning;
  }

  function notice(message, kind = 'ok') {
    const box = $('notice');
    if (!message) { box.hidden = true; box.textContent = ''; return; }
    box.hidden = false;
    box.dataset.kind = kind;
    box.textContent = message;
  }

  async function loadAgentModels({force = false} = {}) {
    if (!force && agentModels.models && Date.now() - agentModels.at < 30000) return;
    $('agentHint').textContent = '正在读取 Magpie 模型目录…';
    try {
      const data = await api('/api/agent/models');
      const select = $('agentModel');
      const previous = select.value;
      select.replaceChildren(...data.models.map((model) => new Option(model.name || model.id, model.id)));
      if (data.current) select.value = data.current;
      else if (previous) select.value = previous;
      agentModels = {at: Date.now(), models: data.models};
      $('agentHint').textContent = data.models.length
        ? '连接后原生引擎自动启动'
        : 'Magpie 里还没有可用的模型，请先在 Magpie 中添加供应商或模型';
    } catch (error) {
      agentModels = {at: 0, models: null};
      $('agentHint').textContent = `读取模型失败：${error.message}`;
    }
  }

  async function connectAgent() {
    if (busy) return;
    const model = $('agentModel').value;
    if (!model) {
      notice('请先选择一个模型', 'warning');
      return;
    }
    busy = '连接模型';
    setBusy(true);
    $('agentHint').textContent = '正在通过 Magpie 连接并启动引擎…';
    try {
      const result = await api('/api/agent/connect', {method: 'POST', body: {model}});
      if (result.overview) render(result.overview);
      notice('已连接模型，原生引擎会自动启动；重启 Cursor 后代理设置生效。', 'ok');
      $('agentHint').textContent = '';
      agentModels = {at: 0, models: null};
    } catch (error) {
      $('agentHint').textContent = `连接失败：${error.message}`;
      notice(`连接失败：${error.message}`, 'error');
    } finally {
      busy = null;
      setBusy(false);
      loadStatus({quiet: true});
    }
  }

  function item(label, value, {mono = false, tone = '', title = ''} = {}) {
    const wrap = document.createElement('div');
    wrap.className = 'item';
    const key = document.createElement('span');
    key.className = 'k';
    key.textContent = label;
    const val = document.createElement('span');
    val.className = `v${mono ? ' mono' : ''}${tone ? ` ${tone}` : ''}`;
    val.textContent = value;
    if (title) val.title = title;
    wrap.append(key, val);
    return wrap;
  }

  function render(overview, {quiet = false} = {}) {
    lastOverview = overview;
    const runtime = overview.runtime;
    const state = STATES[runtime?.state] || {label: runtime?.state || '未运行', kind: 'idle'};
    $('dot').dataset.state = state.kind === 'idle' ? 'unknown' : state.kind;
    $('port').textContent = PORT;
    const model = runtime?.model || overview.connection?.model || '';
    const models = runtime?.models ?? overview.connection?.models ?? 0;
    $('stateText').textContent = runtime
      ? `${state.label}${model ? ` · ${model}` : ''}${models ? ` · ${models} 个模型` : ''}`
      : (overview.connection?.exists ? '后台未运行' : '尚未连接');

    // A missing connection is the normal state right after install: the engine
    // stays stopped until a model is chosen. Offer that choice right here so a
    // fresh install never looks broken.
    const needsModel = overview.serviceSupported !== false && (!overview.connection?.exists || !overview.connection?.enabled);
    $('agentCard').hidden = !needsModel;
    if (needsModel) loadAgentModels();

    const warning = runtime?.warning || runtime?.reason || '';
    if (warning) notice(warning, runtime?.state === 'error' ? 'error' : 'warning');
    else if (!quiet || $('notice').dataset.kind === 'warning') notice('');

    serviceSupported = overview.serviceSupported !== false;
    for (const id of ['start', 'restart']) {
      $(id).disabled = !!busy || !serviceSupported;
      $(id).title = serviceSupported ? '' : '当前平台暂不支持自动安装后台服务';
    }
    const active = !!overview.supervisor?.alive || !!overview.engine?.alive;
    $('stop').disabled = !!busy || !serviceSupported || !active;
    $('stop').title = active ? '停止后台并还原 Cursor 代理' : '后台未运行';

    const configuredMode = runtime?.mode || overview.settings?.values?.runMode || 'default';
    const engineMode = runtime?.engineMode || null;
    const switching = engineMode && engineMode !== configuredMode;
    const engineModeText = MODES[engineMode || configuredMode] || configuredMode;
    // null means no engine is running yet; the flag is only known once it starts.
    const engineOfficialModels = runtime?.engineOfficialModels ?? null;
    const officialModelsText = engineOfficialModels === null ? '—' : (engineOfficialModels ? '官方 + Magpie' : '仅 Magpie');
    const databaseText = engineMode === 'lite'
      ? '内存 · 不落盘'
      : (overview.database ? `${bytes(overview.database.size)} · bridge.db` : '未创建');
    const retention = overview.retention;
    const retentionText = !retention
      ? '尚未运行'
      : (retention.error
        ? `上次失败 · ${shorten(retention.error)}`
        : `上次 ${timeText(retention.at)} · 调用 ${numberText(retention.calls)} / 会话 ${numberText(retention.sessions)}`);
    const cursor = overview.cursor;
    const cursorText = cursor?.version
      ? `${cursor.version}${cursor.tested ? ' · 已实测' : ' · 未验证'}`
      : '未检测到';

    const grid = $('overview');
    grid.replaceChildren(
      item('版本', overview.version || overview.installation?.version || '—', {mono: true}),
      item('Cursor', cursorText, {tone: cursor?.version && !cursor.tested ? 'warn' : '', title: cursor?.hint || ''}),
      item('运行模式', `${engineModeText}${switching ? ' · 切换中' : ''}`, {tone: switching ? 'warn' : ''}),
      item('模型目录', officialModelsText, {tone: engineOfficialModels ? 'ok' : ''}),
      item('数据库', databaseText, {tone: engineMode === 'lite' ? 'ok' : ''}),
      item('自动清理', retentionText, {tone: retention?.error ? 'warn' : ''}),
      item('后台监视器', overview.supervisor.alive
        ? `运行中 · PID ${overview.supervisor.pid}`
        : '未运行', {tone: overview.supervisor.alive ? 'ok' : 'warn'}),
      item('后台服务', overview.serviceSupported === false
        ? `当前平台（${overview.platform || '未知'}）不支持`
        : (overview.launchAgent?.registered ? (overview.launchAgent.state || '已加载') : '未加载'),
        {tone: overview.serviceSupported === false || !overview.launchAgent?.registered ? 'warn' : 'ok'}),
      item('原生引擎', overview.engine.alive
        ? `运行中 · PID ${overview.engine.pid}`
        : (runtime?.state === 'error'
          ? '启动失败'
          : (runtime?.state === 'connected'
            ? '启动中…'
            : (overview.supervisor?.alive ? '等待连接' : '未运行'))), {
        tone: overview.engine.alive ? 'ok' : (runtime?.state === 'error' || runtime?.state === 'connected' ? 'warn' : ''),
        title: !overview.engine.alive && !overview.connection?.exists ? '在下方选择模型后，引擎会自动启动' : ''
      }),
      item('代理端口', runtime?.proxy || '—', {mono: true}),
      item('后端端口', runtime?.backend || '—', {mono: true}),
      item('当前模型', model || '—'),
      item('模型数', models ? String(models) : '—'),
      item('状态更新', timeText(runtime?.updated)),
      item('安装时间', timeText(overview.installation?.installed)),
      item('release', overview.installation?.release ? shorten(overview.installation.release) : '—', {mono: true, title: overview.installation?.release || ''}),
      item('控制服务', `PID ${overview.control.pid} · ${overview.control.uptime}s`, {mono: true})
    );

    const savedSettings = overview.settings?.values;
    if (!settingsFilled && savedSettings) {
      fillSettings(savedSettings);
      settingsFilled = true;
    }
    renderSettingsState();
    // The card is collapsed by default; only load the catalogue once opened.
    if ($('modelNamesCard')?.open && !modelNamesFilled) loadModelNames(overview);
  }

  function fillSettings(values) {
    if (values?.runMode !== undefined) $('runMode').value = values.runMode;
    if (values?.subagentMode !== undefined) $('subagentMode').value = values.subagentMode;
    if (values?.orcaTakeover !== undefined) $('orcaTakeover').value = values.orcaTakeover;
    if (values?.showOfficialModels !== undefined) $('showOfficialModels').value = values.showOfficialModels ? 'on' : 'off';
    for (const key of ['refreshSeconds', 'gatewayGraceSeconds', 'logLimitMB', 'tracesRetentionDays', 'sessionsRetentionDays']) {
      if (values?.[key] !== undefined) $(key).value = values[key];
    }
  }

  // The parameters card is collapsed by default; while closed the summary
  // shows the saved run mode plus a hint that clicking expands the form.
  function renderSettingsState() {
    const mode = lastOverview?.settings?.values?.runMode;
    const card = $('settingsCard');
    const state = $('settingsState');
    if (!mode || !card || !state) return;
    const label = `${MODES[mode] || mode}${lastOverview?.settings?.values?.showOfficialModels ? ' · 含官方模型' : ''}`;
    const text = card.open ? label : `${label} · 展开编辑`;
    if (state.textContent !== text) state.textContent = text;
  }

  // Display names are edited per model id. The catalogue comes from Magpie so
  // a model that has not been connected yet can still be renamed; when the
  // gateway is unreachable, fall back to the models recorded in connection.json.
  async function loadModelNames(overview) {
    if (!overview || modelNamesFilled || modelNamesLoading || Date.now() < modelNamesRetryAt) return;
    modelNamesLoading = true;
    $('modelNamesState').textContent = '正在读取…';
    try {
      let models = agentModels.models?.length ? agentModels.models : null;
      if (!models) {
        try {
          models = (await api('/api/agent/models')).models || [];
        } catch {
          models = [];
        }
      }
      // `overview.connection.models` is a count; the catalogue itself lives in
      // modelList (fallback for an offline Magpie gateway).
      if (!models.length) models = overview.connection?.modelList || [];
      if (!models.length) {
        // Keep the section editable as soon as a catalogue appears, but do not
        // hit the gateway on every two-second status poll while it is down.
        renderModelNameRows([], {});
        modelNamesRetryAt = Date.now() + 15000;
        return;
      }
      renderModelNameRows(models, overview.settings?.values || {});
      modelNamesFilled = true;
    } catch {
      // A malformed overview must not leave the section half-built and silent.
      renderModelNameRows([], {});
      modelNamesRetryAt = Date.now() + 15000;
    } finally {
      modelNamesLoading = false;
    }
  }

  function renderModelNameRows(models, saved) {
    const body = $('modelNameRows');
    const savedNames = saved?.modelNames || {};
    const hidden = new Set(saved?.modelHidden || []);
    const seen = new Set();
    const rows = [];
    for (const model of models || []) {
      if (!model?.id || seen.has(model.id)) continue;
      seen.add(model.id);
      const tr = document.createElement('tr');
      tr.draggable = true;
      tr.dataset.modelId = model.id;
      tr.addEventListener('dragstart', (event) => {
        if (busy) {
          event.preventDefault();
          return;
        }
        dragRow = tr;
        dragSnapshot = [...tr.parentElement.children];
        tr.classList.add('dragging');
        event.dataTransfer.effectAllowed = 'move';
        try { event.dataTransfer.setData('text/plain', model.id); } catch {}
      });
      tr.addEventListener('dragend', () => {
        // A drag that ends outside the table never fires drop: restore the
        // previous order instead of leaving an unsaved rearrangement.
        if (dragRow === tr) {
          if (dragSnapshot) tr.parentElement.replaceChildren(...dragSnapshot);
          dragRow = null;
        }
        dragSnapshot = null;
        tr.classList.remove('dragging');
      });
      const dragCell = document.createElement('td');
      dragCell.className = 'drag-col';
      const handle = document.createElement('span');
      handle.className = 'drag-handle';
      handle.textContent = '⋮⋮';
      handle.title = '拖动调整顺序';
      dragCell.append(handle);
      const modelCell = document.createElement('td');
      const modelName = document.createElement('span');
      modelName.className = 'model-label';
      modelName.textContent = model.name || model.id;
      modelName.title = model.id;
      modelCell.append(modelName);
      const showCell = document.createElement('td');
      showCell.className = 'show-col';
      const show = document.createElement('input');
      show.type = 'checkbox';
      show.dataset.showModel = model.id;
      show.checked = !hidden.has(model.id);
      show.title = show.checked ? '在 Cursor 菜单中显示' : '已从 Cursor 菜单隐藏';
      showCell.append(show);
      const nameCell = document.createElement('td');
      const input = document.createElement('input');
      input.type = 'text';
      input.maxLength = 80;
      input.draggable = false;
      input.placeholder = model.name || model.id;
      input.dataset.modelId = model.id;
      input.value = savedNames[model.id] || '';
      nameCell.append(input);
      const actionCell = document.createElement('td');
      actionCell.className = 'action-col';
      const rowTest = document.createElement('button');
      rowTest.type = 'button';
      rowTest.className = 'ghost row-test';
      rowTest.dataset.testModel = model.id;
      rowTest.textContent = '测试';
      const rowSave = document.createElement('button');
      rowSave.type = 'button';
      rowSave.className = 'ghost row-save';
      rowSave.dataset.saveModel = model.id;
      rowSave.textContent = '保存';
      actionCell.append(rowTest, rowSave);
      tr.append(dragCell, modelCell, showCell, nameCell, actionCell);
      rows.push(tr);
    }
    body.replaceChildren(...rows);
    $('modelNamesTable').hidden = rows.length === 0;
    const custom = [...seen].filter((id) => savedNames[id]).length;
    const hiddenCount = [...seen].filter((id) => hidden.has(id)).length;
    $('modelNamesState').textContent = rows.length
      ? `${rows.length} 个模型${custom ? ` · ${custom} 个自定义` : ''}${hiddenCount ? ` · ${hiddenCount} 个隐藏` : ''}`
      : '当前没有模型目录';
    $('modelNamesHint').textContent = rows.length
      ? '名称与菜单勾选只影响 Cursor 的模型菜单，不改变模型 ID、路由与计费；留空使用 Magpie 原名。勾选变化点「保存全部」应用，保存后约 2–4 秒写入引擎目录。'
      : '当前没有可用的模型目录；连接模型或刷新页面后即可在这里自定义显示名。';
    filterModelRows();
  }

  function filterModelRows() {
    const term = $('modelSearch').value.trim().toLowerCase();
    for (const row of document.querySelectorAll('#modelNameRows tr')) {
      row.hidden = !!term && !row.textContent.toLowerCase().includes(term);
    }
  }

  async function loadStatus({quiet = false} = {}) {
    try {
      const data = await api('/api/status');
      render(data.overview, {quiet});
      // Non-blocking: the switch in the settings card needs the hook state,
      // but a slow `cursor-agent --version` must not delay the status render.
      loadAgentCli();
    } catch (error) {
      if (!quiet) notice(`读取状态失败：${error.message}`, 'error');
      $('dot').dataset.state = 'error';
      // A refused token is not an unreachable service: the page itself is
      // stale and only a reload can fix it.
      $('stateText').textContent = error.stale ? '控制口令已过期，请刷新页面' : '控制服务不可达';
    }
  }

  function output(text, kind = '') {
    const box = $('output');
    box.hidden = false;
    box.dataset.kind = kind;
    box.textContent = text;
  }

  async function runAction(action) {
    if (busy) return;
    if (action !== 'status' && !serviceSupported) {
      notice('当前平台暂不支持自动安装后台服务；可在源码目录直接使用控制台', 'warning');
      return;
    }
    busy = action;
    setBusy(true);
    const label = {start: '启动', stop: '停止', status: '状态', restart: '重启'}[action];
    const win = lastOverview?.platform === 'win32';
    const linux = lastOverview?.platform === 'linux';
    const command = action === 'status'
      ? (win ? 'install.js status' : 'bash setup.command status')
      : (action === 'stop'
        ? (win ? '停止后台进程 + 还原 Cursor 代理'
          : linux ? 'systemctl --user stop + 停止后台进程 + 还原 Cursor 代理'
          : 'launchctl bootout + 停止后台进程 + 还原 Cursor 代理')
        : (action === 'restart'
          ? (win ? '停止后台进程 + install.js setup'
            : linux ? 'systemctl --user stop + 杀掉后台进程 + bash setup.command'
            : 'launchctl bootout + 杀掉后台进程 + bash setup.command')
          : (win ? 'install.js setup' : 'bash setup.command')));
    output(`$ ${command}\n执行中…`);
    notice('');
    try {
      const result = await api('/api/action', {method: 'POST', body: {action}});
      const text = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
      output(`${result.ok ? '[成功]' : '[失败]'} ${result.error || ''}\n${text || '（无输出）'}`.trim(), result.ok ? '' : 'error');
      if (result.overview) render(result.overview);
      if (result.ok) notice(`${label}完成`, 'ok');
    } catch (error) {
      output(`[失败] ${error.message}`, 'error');
      notice(`${label}失败：${error.message}`, 'error');
    } finally {
      busy = null;
      setBusy(false);
      loadStatus({quiet: true});
    }
  }

  async function saveSettings(event) {
    event.preventDefault();
    const beforeMode = lastOverview?.settings?.values?.runMode;
    const beforeSubagentMode = lastOverview?.settings?.values?.subagentMode;
    const beforeOfficialModels = lastOverview?.settings?.values?.showOfficialModels;
    const beforeTraces = lastOverview?.settings?.values?.tracesRetentionDays;
    const beforeSessions = lastOverview?.settings?.values?.sessionsRetentionDays;
    const body = {
      runMode: $('runMode').value,
      subagentMode: $('subagentMode').value,
      orcaTakeover: $('orcaTakeover').value,
      showOfficialModels: $('showOfficialModels').value === 'on',
      refreshSeconds: Number($('refreshSeconds').value),
      gatewayGraceSeconds: Number($('gatewayGraceSeconds').value),
      logLimitMB: Number($('logLimitMB').value),
      tracesRetentionDays: Number($('tracesRetentionDays').value),
      sessionsRetentionDays: Number($('sessionsRetentionDays').value)
    };
    try {
      const result = await api('/api/settings', {method: 'POST', body});
      // Mirror the saved values immediately: the summary and the overview are
      // painted from lastOverview, which the next poll may still fill from a
      // snapshot taken just before the write.
      if (lastOverview?.settings) lastOverview.settings.values = result.settings;
      fillSettings(result.settings);
      settingsFilled = true;
      renderSettingsState();
      const modeHint = beforeMode && beforeMode !== result.settings.runMode
        ? '运行模式已变更，引擎将在数秒内自动重启，当前对话可能中断一次；'
        : '';
      const subagentHint = beforeSubagentMode && beforeSubagentMode !== result.settings.subagentMode
        ? '子代理模式已变更，引擎将在数秒内自动重启，下一次 Task 调用生效；'
        : '';
      const officialModelsHint = beforeOfficialModels !== undefined && beforeOfficialModels !== result.settings.showOfficialModels
        ? (result.settings.showOfficialModels
          ? '已开启 Cursor 官方模型，引擎重启后模型列表将合并官方目录，Auto 也会恢复；'
          : '已关闭 Cursor 官方模型，引擎重启后模型列表只保留 Magpie 模型；')
        : '';
      const retentionHint = beforeTraces !== result.settings.tracesRetentionDays || beforeSessions !== result.settings.sessionsRetentionDays
        ? '保留策略已更新，下一轮后台清理生效；'
        : '';
      const orcaHint = result.orca?.pending === 'running'
        ? `Orca 正在运行，${result.settings.orcaTakeover === 'on' ? '接管' : '取消接管'}将在其退出后自动完成；`
        : (result.orca?.reason === 'foreign-override'
          ? 'Orca 已配置自定义 cursor 命令，兜底接管未改动；'
          : (result.orca?.reason === 'error'
            ? `Orca 配置写入失败：${result.orca.error || '未知错误'}；`
            : (result.orca?.reason === 'wrapper-missing'
              ? '未安装 cursor-agent 包装器，已跳过 Orca 兜底接管；'
              : (result.orca?.reason === 'missing'
                ? '未检测到 Orca，接管意图已记录；'
                : (result.orca?.changed
                  ? `Orca 配置已${result.settings.orcaTakeover === 'on' ? '写入' : '移除'}；`
                  : '')))));
      $('settingsHint').textContent = `已保存：${modeHint}${subagentHint}${officialModelsHint}${retentionHint}${orcaHint}同步间隔与容错下一轮生效，日志上限下次后台启动生效`;
      loadStatus({quiet: true});
      loadAgentCli({force: true});
    } catch (error) {
      $('settingsHint').textContent = `保存失败：${error.message}`;
    }
  }

  // Help text lives in data-tip attributes: CSS shows it on hover/focus, and
  // a click pins it for touch screens. Only one tip stays open at a time so
  // the grouped card never turns into a pile of overlapping bubbles.
  function initSettingTips() {
    const form = $('settingsForm');
    const close = () => {
      for (const tip of form.querySelectorAll('.tip.open')) tip.classList.remove('open');
    };
    form.addEventListener('click', (event) => {
      const tip = event.target.closest?.('.tip');
      if (!tip) { close(); return; }
      event.preventDefault();
      const open = !tip.classList.contains('open');
      close();
      if (open) tip.classList.add('open');
    });
    form.addEventListener('keydown', (event) => {
      const tip = event.target.closest?.('.tip');
      if (!tip) return;
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        tip.click();
      } else if (event.key === 'Escape') {
        tip.classList.remove('open');
        tip.blur();
      }
    });
    document.addEventListener('click', (event) => {
      if (!event.target.closest?.('.settings .tip')) close();
    });
  }

  // Menu preferences live beside the other bridge settings, so every save
  // sends the complete object and changes one part at a time.
  function visibleModelOrder(saved) {
    const visible = [...document.querySelectorAll('#modelNameRows tr')]
      .map((row) => row.dataset.modelId)
      .filter(Boolean);
    const known = new Set(visible);
    return [...visible, ...(saved || []).filter((id) => !known.has(id))];
  }

  async function saveModelSettings(overrides, successText) {
    const values = lastOverview?.settings?.values;
    if (!values) {
      $('modelNamesStatus').textContent = '尚未读取到当前设置，请稍后重试';
      return null;
    }
    try {
      const result = await api('/api/settings', {method: 'POST', body: {
        runMode: values.runMode,
        subagentMode: values.subagentMode,
        refreshSeconds: values.refreshSeconds,
        gatewayGraceSeconds: values.gatewayGraceSeconds,
        logLimitMB: values.logLimitMB,
        modelNames: values.modelNames,
        modelOrder: values.modelOrder,
        modelHidden: values.modelHidden,
        ...overrides
      }});
      if (lastOverview?.settings) lastOverview.settings.values = result.settings;
      $('modelNamesStatus').textContent = successText;
      loadStatus({quiet: true});
      return result;
    } catch (error) {
      $('modelNamesStatus').textContent = `保存失败：${error.message}`;
      return null;
    }
  }

  // Save every visible row plus the current drag order.
  async function saveModelNames() {
    if (busy) return;
    const inputs = [...document.querySelectorAll('#modelNameRows input[data-model-id]')];
    if (!inputs.length) {
      $('modelNamesStatus').textContent = '当前没有可编辑的模型目录';
      return;
    }
    const values = lastOverview?.settings?.values;
    if (!values) {
      $('modelNamesStatus').textContent = '尚未读取到当前设置，请稍后重试';
      return;
    }
    // Merge instead of replace: the catalogue may not list every configured
    // model (gateway offline), and those entries must survive a save.
    const names = {...(values.modelNames || {})};
    for (const input of inputs) {
      const id = input.dataset.modelId;
      const value = input.value.trim();
      if (value) names[id] = value;
      else delete names[id];
    }
    const modelHidden = [...document.querySelectorAll('#modelNameRows tr')]
      .filter((row) => row.dataset.modelId && row.querySelector('input[data-show-model]')?.checked === false)
      .map((row) => row.dataset.modelId);
    busy = '保存模型显示名';
    setBusy(true);
    $('modelNamesStatus').textContent = '正在保存…';
    const result = await saveModelSettings(
      {modelNames: names, modelOrder: visibleModelOrder(values.modelOrder), modelHidden},
      '已保存全部显示名、顺序与菜单显示，Cursor 菜单将在数秒内刷新'
    );
    busy = null;
    setBusy(false);
    if (result) {
      for (const input of inputs) input.value = result.settings.modelNames?.[input.dataset.modelId] || '';
    }
  }

  // Row-level save: only this model's display name changes.
  async function saveModelRow(id) {
    if (busy) return;
    const input = [...document.querySelectorAll('#modelNameRows input[data-model-id]')]
      .find((item) => item.dataset.modelId === id);
    if (!input) return;
    const values = lastOverview?.settings?.values;
    if (!values) {
      $('modelNamesStatus').textContent = '尚未读取到当前设置，请稍后重试';
      return;
    }
    const names = {...(values.modelNames || {})};
    const value = input.value.trim();
    if (value) names[id] = value;
    else delete names[id];
    busy = '保存模型显示名';
    setBusy(true);
    $('modelNamesStatus').textContent = '正在保存…';
    const result = await saveModelSettings({modelNames: names}, `已保存 ${input.placeholder || id} 的显示名`);
    busy = null;
    setBusy(false);
    if (result) input.value = result.settings.modelNames?.[id] || '';
  }

  async function testModelRow(id, button) {
    if (busy) return;
    button.disabled = true;
    button.textContent = '测试中…';
    try {
      const data = await api('/api/agent/test', {method: 'POST', body: {model: id}});
      button.textContent = `${numberText(data.latencyMs)}ms`;
      button.title = String(data.text || '通过');
      $('modelNamesStatus').textContent = `${id} 测试通过 · ${String(data.text || '').slice(0, 80)}`;
    } catch (error) {
      button.textContent = '失败';
      button.title = error.message;
      $('modelNamesStatus').textContent = `${id} 测试失败：${error.message}`;
      notice(`模型测试失败：${error.message}`, 'error');
    } finally {
      button.disabled = false;
    }
  }

  // Dragging saves the order immediately; names are left exactly as configured
  // so an unsaved edit in another row is never committed by a drag.
  async function saveModelOrder() {
    if (busy) return;
    const values = lastOverview?.settings?.values;
    if (!values) {
      $('modelNamesStatus').textContent = '尚未读取到当前设置，请稍后重试';
      return;
    }
    const rows = $('modelNameRows');
    const previous = [...rows.children];
    busy = '保存模型顺序';
    setBusy(true);
    $('modelNamesStatus').textContent = '正在保存顺序…';
    const result = await saveModelSettings(
      {modelOrder: visibleModelOrder(values.modelOrder)},
      '顺序已保存，Cursor 菜单将在数秒内刷新'
    );
    busy = null;
    setBusy(false);
    if (!result) rows.replaceChildren(...previous);
  }

  // ---- Cursor 存储（state.vscdb） ----
  let storeOverview = null;
  let storeWorkspaceList = [];
  let storeLoading = false;
  let storeOffset = 0;
  let storeDetail = {id: '', offset: 0, total: 0};
  let storeScanning = '';
  let storeSizeToken = 0;
  let storeRangeReady = false;
  let storeSelected = new Set();
  let storeDeleteIds = [];
  let storeDeleteMode = 'selected';
  const storeScans = new Map();
  const STORE_MESSAGE_CAP = 1500;
  const CHAT_CHUNK = 30;
  const STORE_PAGE_SIZES = [10, 20, 50, 100];
  let storeChat = {messages: [], rendered: 0, id: ''};

  function storePageSize() {
    const value = Number($('storePageSize').value);
    return STORE_PAGE_SIZES.includes(value) ? value : 10;
  }

  function storeWorkspaceName(id) {
    const found = storeWorkspaceList.find((entry) => entry.id === id);
    return found ? found.name : (id ? id.slice(0, 8) : '—');
  }

  async function loadStore() {
    if (storeLoading) return;
    storeLoading = true;
    ensureStoreRangeDefaults();
    $('storeState').textContent = '读取中…';
    try {
      const [overview, workspaces] = await Promise.all([
        api('/api/cursor-store/overview'),
        api('/api/cursor-store/workspaces')
      ]);
      storeOverview = overview;
      storeWorkspaceList = workspaces.workspaces || [];
      renderStore();
      await loadStoreSessions({reset: true});
    } catch (error) {
      $('storeState').textContent = '读取失败';
      $('storeHint').textContent = `读取 Cursor 存储失败：${error.message}`;
    } finally {
      storeLoading = false;
    }
  }

  function renderStore() {
    const store = storeOverview?.store;
    if (!store || !store.exists) {
      $('storeState').textContent = '未找到';
      $('storeHint').textContent = store
        ? `未找到 Cursor 数据库：${store.path}。请确认 Cursor 已安装并至少打开过一次。`
        : '未读取到 Cursor 存储信息。';
      $('storeSummary').hidden = true;
      $('storeSessions').replaceChildren();
      $('storePager').hidden = true;
      return;
    }
    const composers = store.composers || {};
    $('storeState').textContent = `${bytes(store.file.size)} · ${numberText(composers.total || 0)} 会话`;
    $('storeHint').textContent = '浏览与统计只读，不会在打开面板时扫盘；删除与压缩是显式写操作，执行前必须完全退出 Cursor。';
    $('storeSummary').replaceChildren(
      item('数据库文件', bytes(store.file.size), {mono: true, title: store.path}),
      item('WAL / SHM', `${bytes(store.file.wal)} / ${bytes(store.file.shm)}`, {mono: true}),
      item('页数 × 页大小', `${numberText(store.page.pageCount)} × ${numberText(store.page.pageSize)} B`, {mono: true}),
      item('空闲页', numberText(store.page.freelistCount), {mono: true}),
      item('会话总数', numberText(composers.total || 0), {mono: true}),
      item('主 / 子代理', `${numberText((composers.total || 0) - (composers.subagents || 0))} / ${numberText(composers.subagents || 0)}`, {mono: true}),
      item('项目数', numberText(composers.workspaces || 0), {mono: true}),
      item('最近写入', timeText(store.file.updated))
    );
    $('storeSummary').hidden = false;

    const select = $('storeWorkspace');
    const current = select.value;
    const options = [new Option('全部项目', '')];
    for (const workspace of storeWorkspaceList) {
      options.push(new Option(`${workspace.name} · ${workspace.id.slice(0, 6)}`, workspace.id));
    }
    select.replaceChildren(...options);
    select.value = current;

    const free = (store.page.freelistCount || 0) * (store.page.pageSize || 0);
    $('storeScanHint').textContent = free > 0
      ? `按类统计（缓存 2 分钟）· 当前空闲页约 ${bytes(free)}`
      : '按类统计（缓存 2 分钟）· 粗体两类默认 1/16 采样';
    renderStoreScans(storeOverview.categories || []);
    renderStoreActions(storeOverview.actions || []);
  }

  function renderStoreScans(categories) {
    const table = document.createElement('table');
    table.className = 'db-table store-scan-table';
    const head = document.createElement('thead');
    const headRow = document.createElement('tr');
    for (const text of ['类别', '行数', '体积', '操作']) {
      const th = document.createElement('th');
      th.textContent = text;
      headRow.append(th);
    }
    head.append(headRow);
    const body = document.createElement('tbody');
    for (const category of categories) {
      const scan = storeScans.get(category.id);
      const row = document.createElement('tr');
      const name = document.createElement('td');
      name.textContent = category.label;
      name.title = category.hint;
      if (category.heavy) name.className = 'store-heavy';
      const rows = document.createElement('td');
      rows.className = 'mono';
      rows.textContent = scan ? `${scan.sampled ? '≈' : ''}${numberText(scan.rows)}` : '—';
      const size = document.createElement('td');
      size.className = 'mono';
      size.textContent = scan ? bytes(scan.bytes) : '—';
      if (scan) size.title = `${scan.sampled ? '1/16 采样估算' : '精确统计'} · ${numberText(scan.elapsedMs)} ms`;
      const action = document.createElement('td');
      action.className = 'store-scan-actions';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'ghost';
      button.textContent = storeScanning === category.id ? '统计中…' : (category.heavy ? '估算' : '统计');
      button.disabled = Boolean(storeScanning);
      button.addEventListener('click', () => loadStoreScan(category.id, category.heavy ? 'estimate' : 'exact'));
      action.append(button);
      if (category.heavy && scan) {
        const exact = document.createElement('button');
        exact.type = 'button';
        exact.className = 'ghost';
        exact.textContent = '精确';
        exact.disabled = Boolean(storeScanning);
        exact.addEventListener('click', () => loadStoreScan(category.id, 'exact'));
        action.append(exact);
      }
      row.append(name, rows, size, action);
      body.append(row);
    }
    table.append(head, body);
    $('storeScanBody').replaceChildren(table);
  }

  function renderStoreActions(actions) {
    const wrap = document.createElement('div');
    wrap.className = 'store-actions';
    for (const action of actions) {
      const row = document.createElement('div');
      row.className = 'cleanup-row';
      const copy = document.createElement('div');
      copy.className = 'cleanup-copy';
      const title = document.createElement('strong');
      title.textContent = action.title;
      const hint = document.createElement('span');
      hint.className = 'hint';
      hint.textContent = action.hint;
      const code = document.createElement('code');
      code.className = 'store-command';
      code.textContent = action.palette;
      copy.append(title, hint, code);
      row.append(copy);
      wrap.append(row);
    }
    $('storeActions').replaceChildren(wrap);
  }

  async function loadStoreScan(category, mode) {
    if (storeScanning) return;
    storeScanning = category;
    renderStoreScans(storeOverview?.categories || []);
    $('storeScanHint').textContent = mode === 'exact'
      ? '精确统计中，内容块类可能需要数分钟，请勿关闭面板…'
      : '估算中（读取 1/16 的行），约 15–30 秒…';
    try {
      const data = await api(`/api/cursor-store/scan?category=${encodeURIComponent(category)}&mode=${mode}`);
      storeScans.set(category, data.scan);
      $('storeScanHint').textContent = `${data.scan.label}：${bytes(data.scan.bytes)} · ${numberText(data.scan.rows)} 行 · ${numberText(data.scan.elapsedMs)} ms${data.scan.cached ? '（缓存）' : ''}`;
    } catch (error) {
      $('storeScanHint').textContent = `统计失败：${error.message}`;
    } finally {
      storeScanning = '';
      renderStoreScans(storeOverview?.categories || []);
    }
  }

  function storeDateValue(date) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  // The custom range starts at "last 30 days" so the Apply button is useful
  // immediately; anything the user cannot parse falls back to "no bound".
  function ensureStoreRangeDefaults() {
    if (storeRangeReady) return;
    storeRangeReady = true;
    const today = new Date();
    $('storeSince').value = storeDateValue(new Date(today.getTime() - 30 * 86400000));
    $('storeUntil').value = storeDateValue(today);
  }

  function storeRangeParams() {
    const value = $('storeRange').value;
    if (value === 'custom') {
      const since = $('storeSince').value ? new Date(`${$('storeSince').value}T00:00:00`).getTime() : 0;
      const until = $('storeUntil').value ? new Date(`${$('storeUntil').value}T23:59:59.999`).getTime() : 0;
      return {
        since: Number.isFinite(since) && since > 0 ? since : 0,
        until: Number.isFinite(until) && until > 0 ? until : 0
      };
    }
    if (value === 'all') return {since: 0, until: 0};
    // recent-N keeps conversations active within N days; older-N keeps the
    // ones that have been idle for at least N days.
    const match = /^(recent|older)-(\d+)$/.exec(value);
    if (!match) return {since: 0, until: 0};
    const days = Number(match[2]);
    if (!Number.isFinite(days) || days <= 0) return {since: 0, until: 0};
    const cutoff = Date.now() - days * 86400000;
    return match[1] === 'recent' ? {since: cutoff, until: 0} : {since: 0, until: cutoff};
  }

  function storeFilterParams(offset, limit) {
    const params = new URLSearchParams({
      kind: $('storeKind').value,
      offset: String(offset),
      limit: String(limit)
    });
    const workspace = $('storeWorkspace').value;
    if (workspace) params.set('workspace', workspace);
    params.set('named', $('storeNamed').value);
    const mode = $('storeMode').value;
    if (mode) params.set('mode', mode);
    const range = storeRangeParams();
    if (range.since) params.set('since', String(range.since));
    if (range.until) params.set('until', String(range.until));
    return params;
  }

  function updateStoreSelection() {
    const count = storeSelected.size;
    $('storeBulk').hidden = count === 0;
    $('storeBulkInfo').textContent = `已选 ${numberText(count)} 个会话`;
  }

  async function loadStoreSessions({reset = false} = {}) {
    if (reset) storeOffset = 0;
    storeSelected.clear();
    updateStoreSelection();
    $('storeListHint').textContent = '读取会话…';
    const pageSize = storePageSize();
    const params = storeFilterParams(storeOffset, pageSize);
    try {
      const data = await api(`/api/cursor-store/sessions?${params}`);
      if (!data.supported) {
        $('storeListHint').textContent = '当前 Cursor 版本没有 composerHeaders 表，无法列出会话。';
        $('storeSessions').replaceChildren();
        $('storePager').hidden = true;
        return;
      }
      renderStoreSessions(data.sessions || []);
      $('storeListHint').textContent = `共 ${numberText(data.total)} 个会话`;
      const pages = Math.max(1, Math.ceil(data.total / pageSize));
      $('storePager').hidden = data.total === 0;
      $('storePageInfo').textContent = data.total
        ? `第 ${Math.floor(storeOffset / pageSize) + 1} / ${pages} 页`
        : '';
      $('storePrev').disabled = storeOffset <= 0;
      $('storeNext').disabled = storeOffset + pageSize >= data.total;
    } catch (error) {
      $('storeListHint').textContent = `读取会话失败：${error.message}`;
    }
  }

  function renderStoreSessions(sessions) {
    if (!sessions.length) {
      $('storeSessions').replaceChildren(Object.assign(document.createElement('p'), {
        className: 'hint',
        textContent: '没有符合条件的会话。'
      }));
      return;
    }
    const table = document.createElement('table');
    table.className = 'db-table store-sessions';
    const head = document.createElement('thead');
    const headRow = document.createElement('tr');
    const selectAll = document.createElement('input');
    selectAll.type = 'checkbox';
    selectAll.ariaLabel = '选择当前页全部会话';
    selectAll.checked = sessions.every((session) => storeSelected.has(session.id));
    selectAll.addEventListener('change', () => {
      for (const session of sessions) {
        if (selectAll.checked) storeSelected.add(session.id);
        else storeSelected.delete(session.id);
      }
      for (const box of document.querySelectorAll('.store-row-check')) box.checked = selectAll.checked;
      updateStoreSelection();
    });
    const selectAllCell = document.createElement('th');
    selectAllCell.className = 'store-check-cell';
    selectAllCell.append(selectAll);
    headRow.append(selectAllCell);
    for (const text of ['ID', '会话', '项目', '体积', '更新时间', '类型', '']) {
      const th = document.createElement('th');
      th.textContent = text;
      headRow.append(th);
    }
    head.append(headRow);
    const body = document.createElement('tbody');
    for (const session of sessions) {
      const row = document.createElement('tr');
      const check = document.createElement('td');
      check.className = 'store-check-cell';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.className = 'store-row-check';
      box.checked = storeSelected.has(session.id);
      box.ariaLabel = `选择 ${session.name || session.id.slice(0, 8)}`;
      box.addEventListener('change', () => {
        if (box.checked) storeSelected.add(session.id);
        else storeSelected.delete(session.id);
        updateStoreSelection();
      });
      check.append(box);
      const name = document.createElement('td');
      name.textContent = session.name || `（未命名 ${session.id.slice(0, 8)}）`;
      name.title = session.id;
      const id = document.createElement('td');
      id.className = 'mono store-session-id';
      id.textContent = session.id.slice(0, 8);
      id.title = session.id;
      const workspace = document.createElement('td');
      workspace.textContent = storeWorkspaceName(session.workspaceId);
      workspace.title = session.workspaceId;
      const size = document.createElement('td');
      size.className = 'mono store-size-cell';
      size.dataset.id = session.id;
      size.textContent = '…';
      const updated = document.createElement('td');
      updated.className = 'mono';
      updated.textContent = timeText(session.lastUpdatedAt || session.createdAt);
      const kind = document.createElement('td');
      kind.textContent = session.archived ? '已归档' : (session.subagent ? '子代理' : '主会话');
      const open = document.createElement('td');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'ghost';
      button.textContent = '打开';
      button.addEventListener('click', () => openStoreSession(session.id));
      open.append(button);
      row.append(check, id, name, workspace, size, updated, kind, open);
      body.append(row);
    }
    table.append(head, body);
    $('storeSessions').replaceChildren(table);
    fillSessionSizes(sessions, ++storeSizeToken);
  }

  // Sizes arrive after the list so browsing is never blocked by byte totals:
  // the server resolves the whole page in one statement and caches per session.
  async function fillSessionSizes(sessions, token) {
    const ids = sessions.map((session) => session.id).filter(Boolean);
    if (!ids.length) return;
    try {
      const data = await api(`/api/cursor-store/sizes?ids=${encodeURIComponent(ids.join(','))}`);
      if (token !== storeSizeToken) return;
      for (const cell of document.querySelectorAll('.store-size-cell')) {
        const size = data.sizes?.[cell.dataset.id];
        if (!size) {
          cell.textContent = '—';
          continue;
        }
        cell.textContent = bytes(size.bytes);
        cell.title = `${numberText(size.messages)} 条记录（消息 / 工具 / 分片）+ 会话数据`;
      }
    } catch {
      if (token !== storeSizeToken) return;
      for (const cell of document.querySelectorAll('.store-size-cell')) cell.textContent = '—';
    }
  }

  // ---- 删除与压缩 ----

  function spaceTable(rows) {
    const table = document.createElement('table');
    table.className = 'db-table store-delete-table';
    const body = document.createElement('tbody');
    for (const [label, value] of rows) {
      const row = document.createElement('tr');
      const left = document.createElement('td');
      left.textContent = label;
      const right = document.createElement('td');
      right.textContent = value;
      row.append(left, right);
      body.append(row);
    }
    table.append(body);
    return table;
  }

  function storeDeleteReady() {
    const ready = $('storeDeleteCursor').checked && $('storeDeleteWord').value.trim() === '删除';
    $('storeDeleteGo').disabled = !ready || !storeDeleteIds.length;
  }

  async function openStoreDelete(ids, {mode = 'selected'} = {}) {
    storeDeleteIds = ids;
    storeDeleteMode = mode;
    const dialog = $('storeDeleteDialog');
    $('storeDeleteTitle').textContent = mode === 'filtered' ? '删除筛选结果' : '删除选中会话';
    $('storeDeleteMeta').textContent = `共 ${numberText(ids.length)} 个会话`;
    $('storeDeleteSummary').textContent = '正在统计将删除的数据…';
    $('storeDeleteHint').textContent = '';
    $('storeDeleteHint').className = 'hint';
    $('storeDeleteWord').value = '';
    $('storeDeleteCursor').checked = false;
    $('storeDeleteGo').disabled = true;
    if (!dialog.open) dialog.showModal();
    try {
      const data = await api(`/api/cursor-store/delete-preview?ids=${encodeURIComponent(ids.join(','))}`);
      const preview = data.preview;
      const kinds = Object.entries(preview.kinds)
        .filter(([, value]) => value.rows)
        .map(([kind, value]) => `${kind} ${numberText(value.rows)}`)
        .join(' · ');
      $('storeDeleteSummary').replaceChildren(
        spaceTable([
          ['会话', `${numberText(preview.ids.length)} 个`],
          ['数据行', `${numberText(preview.totalRows)} 行`],
          ['数据体积', bytes(preview.totalBytes)],
          ['数据库大小', bytes(data.size)],
          ['磁盘可用', data.free === null ? '未知' : bytes(data.free)]
        ]),
        Object.assign(document.createElement('p'), {className: 'hint', textContent: kinds})
      );
      $('storeDeleteHint').textContent = data.cursorRunning
        ? '检测到 Cursor 正在运行：请完全退出 Cursor 后再删除（关闭窗口不算）。'
        : '已确认 Cursor 未运行。';
      $('storeDeleteHint').className = data.cursorRunning ? 'hint store-danger-text' : 'hint';
    } catch (error) {
      $('storeDeleteSummary').textContent = `统计失败：${error.message}`;
    }
  }

  async function confirmStoreDelete() {
    const button = $('storeDeleteGo');
    button.disabled = true;
    button.textContent = '删除中…';
    try {
      const data = await api('/api/cursor-store/delete', {method: 'POST', body: {ids: storeDeleteIds, confirm: true}});
      $('storeDeleteDialog').close();
      storeSelected.clear();
      updateStoreSelection();
      storeScans.clear();
      notice(`已删除 ${numberText(data.deleted.ids.length)} 个会话（${numberText(data.deleted.totalRows)} 行 / ${bytes(data.deleted.totalBytes)}）。空间需执行「压缩」后释放。`, 'ok');
      await loadStore();
    } catch (error) {
      $('storeDeleteHint').textContent = error.message;
      $('storeDeleteHint').className = 'hint store-danger-text';
    } finally {
      button.textContent = '确认删除';
      storeDeleteReady();
    }
  }

  async function deleteFilteredStore() {
    try {
      const data = await api(`/api/cursor-store/sessions?${storeFilterParams(0, 100)}`);
      if (!data.supported) return;
      if (!data.total) {
        notice('当前筛选没有会话。', 'error');
        return;
      }
      if (data.total > 100) {
        notice(`当前筛选有 ${numberText(data.total)} 个会话，超过单次上限 100；请缩小筛选范围后再试。`, 'error');
        return;
      }
      openStoreDelete(data.sessions.map((session) => session.id), {mode: 'filtered'});
    } catch (error) {
      notice(`读取筛选结果失败：${error.message}`, 'error');
    }
  }

  async function openStoreVacuum() {
    const dialog = $('storeVacuumDialog');
    $('storeVacuumMeta').textContent = '';
    $('storeVacuumSummary').textContent = '正在读取空间信息…';
    $('storeVacuumCursor').checked = false;
    $('storeVacuumGo').disabled = true;
    $('storeVacuumResult').textContent = '';
    if (!dialog.open) dialog.showModal();
    try {
      const data = await api('/api/cursor-store/overview?probe=1');
      const store = data.store;
      if (!store.exists) {
        $('storeVacuumSummary').textContent = '未找到 Cursor 数据库。';
        return;
      }
      const freelist = (store.page.freelistCount || 0) * (store.page.pageSize || 0);
      $('storeVacuumSummary').replaceChildren(spaceTable([
        ['数据库大小', bytes(store.file.size)],
        ['空闲页', `${numberText(store.page.freelistCount)} · 约 ${bytes(freelist)}`],
        ['WAL', bytes(store.file.wal)],
        ['预计需要临时空间', `约 ${bytes(store.file.size)}`],
        ['磁盘可用', store.free === null ? '未知' : bytes(store.free)],
        ['Cursor 状态', data.cursorRunning ? '运行中：请先完全退出' : '未运行']
      ]));
      $('storeVacuumMeta').textContent = data.cursorRunning
        ? '检测到 Cursor 正在运行，压缩会被拒绝'
        : 'VACUUM 会重写整个数据库';
      $('storeVacuumMeta').className = data.cursorRunning ? 'hint store-danger-text' : 'hint';
    } catch (error) {
      $('storeVacuumSummary').textContent = `读取失败：${error.message}`;
    }
  }

  async function confirmStoreVacuum() {
    const button = $('storeVacuumGo');
    button.disabled = true;
    button.textContent = '压缩中…';
    $('storeVacuumResult').textContent = '正在重写数据库，请勿启动 Cursor…';
    try {
      const data = await api('/api/cursor-store/vacuum', {method: 'POST', body: {confirm: true}});
      $('storeVacuumResult').textContent = `完成：${bytes(data.vacuum.before)} → ${bytes(data.vacuum.after)}，释放 ${bytes(data.vacuum.saved)}（${Math.round(data.vacuum.elapsedMs / 1000)} 秒）`;
      storeScans.clear();
      notice(`压缩完成，释放 ${bytes(data.vacuum.saved)}。`, 'ok');
      await loadStore();
    } catch (error) {
      $('storeVacuumResult').textContent = `压缩失败：${error.message}`;
    } finally {
      button.textContent = '确认压缩';
      $('storeVacuumGo').disabled = !$('storeVacuumCursor').checked;
    }
  }

  async function openStoreSession(id) {
    storeDetail = {id, total: 0};
    const dialog = $('storeDetailDialog');
    if (!dialog.open) dialog.showModal();
    $('storeDetailTitle').textContent = '会话';
    $('storeDetailMeta').textContent = '读取中…';
    $('storeMessages').replaceChildren();
    storeChat = {messages: [], rendered: 0, id};
    const tools = $('storeShowTools').checked ? '&tools=1' : '';
    try {
      const data = await api(`/api/cursor-store/session?id=${encodeURIComponent(id)}&limit=${STORE_MESSAGE_CAP}${tools}`);
      renderStoreSession(data.session);
    } catch (error) {
      $('storeDetailMeta').textContent = `读取失败：${error.message}`;
    }
  }

  function renderStoreSession(session) {
    storeDetail = {id: session.id, total: session.listTotal};
    $('storeDetailTitle').textContent = session.name || `会话 ${session.id.slice(0, 8)}`;
    $('storeToolCount').textContent = session.toolCount ? `（${numberText(session.toolCount)}）` : '';
    const meta = [
      storeWorkspaceName(session.workspaceId),
      session.subagent ? '子代理' : '主会话',
      session.archived ? '已归档' : '',
      `消息 ${numberText(session.messageCount)} 条`,
      session.toolCount ? `工具 ${numberText(session.toolCount)} 条` : '',
      session.fragmentCount ? `分片 ${numberText(session.fragmentCount)}` : '',
      bytes(session.messageBytes + session.toolBytes),
      `创建于 ${timeText(session.createdAt)}`
    ].filter(Boolean);
    if (session.truncated) meta.push(`仅载入前 ${numberText(STORE_MESSAGE_CAP)} 条`);
    $('storeDetailMeta').textContent = meta.join(' · ');
    const list = document.createElement('div');
    list.className = 'chat-list';
    $('storeMessages').replaceChildren(list);
    $('storeMessages').scrollTop = 0;
    storeChat = {messages: session.messages || [], rendered: 0, id: session.id};
    appendChatMessages();
    fillChatViewport();
  }

  // Chat messages keep the Cursor layout: user text in a bubble, assistant
  // text plain. Tool steps collapse to one line (verb + target) and expand
  // into params/result on click, instead of a tall card per call.
  function chatMessageNode(message) {
    if (message.kind === 'tool') return chatToolNode(message);
    const wrap = document.createElement('div');
    wrap.className = `chat-msg ${message.type === 1 ? 'chat-msg-user' : 'chat-msg-assistant'}`;
    const head = document.createElement('div');
    head.className = 'chat-msg-head';
    const role = document.createElement('strong');
    role.textContent = message.type === 1 ? '你' : 'Cursor';
    const stats = document.createElement('span');
    stats.className = 'hint';
    stats.textContent = [
      message.createdAt ? timeText(message.createdAt) : '',
      bytes(message.bytes),
      message.thinking ? `思考 ${message.thinking}` : ''
    ].filter(Boolean).join(' · ');
    head.append(role, stats);
    const body = document.createElement('div');
    body.className = 'chat-msg-body';
    body.textContent = message.preview || '（无文本内容）';
    wrap.append(head, body);
    if (message.truncated || !message.preview) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'ghost chat-more';
      more.textContent = '查看原文';
      more.addEventListener('click', () => loadStoreValue(message.key));
      wrap.append(more);
    }
    return wrap;
  }

  function chatToolNode(message) {
    const wrap = document.createElement('div');
    wrap.className = 'chat-tool';
    const row = document.createElement('div');
    row.className = 'chat-tool-row';
    row.tabIndex = 0;
    const verb = document.createElement('span');
    verb.className = 'chat-tool-verb';
    verb.textContent = message.verb || message.toolName || '工具';
    const target = document.createElement('span');
    target.className = 'chat-tool-target';
    target.textContent = message.target || '';
    target.title = message.target || message.toolName || '';
    const stats = document.createElement('span');
    stats.className = 'chat-tool-stats';
    stats.textContent = [
      message.createdAt ? timeText(message.createdAt) : '',
      bytes(message.bytes),
      message.toolStatus
    ].filter(Boolean).join(' · ');
    const caret = document.createElement('span');
    caret.className = 'chat-tool-caret';
    caret.textContent = '▸';
    row.append(verb, target, stats, caret);
    const detail = document.createElement('div');
    detail.className = 'chat-tool-detail';
    detail.hidden = true;
    const block = (label, text) => {
      if (!text) return null;
      const box = document.createElement('div');
      box.className = 'chat-tool-block';
      const head = document.createElement('span');
      head.textContent = label;
      const pre = document.createElement('pre');
      pre.textContent = text;
      box.append(head, pre);
      return box;
    };
    for (const child of [block('参数', message.paramsPreview), block('结果', message.resultPreview)]) {
      if (child) detail.append(child);
    }
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'ghost chat-more';
    more.textContent = '查看原文';
    more.addEventListener('click', (event) => {
      event.stopPropagation();
      loadStoreValue(message.key);
    });
    detail.append(more);
    const toggle = () => {
      detail.hidden = !detail.hidden;
      caret.textContent = detail.hidden ? '▸' : '▾';
    };
    row.addEventListener('click', toggle);
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        toggle();
      }
    });
    wrap.append(row, detail);
    return wrap;
  }

  function appendChatMessages() {
    const list = document.querySelector('#storeMessages .chat-list');
    if (!list) return;
    const end = Math.min(storeChat.messages.length, storeChat.rendered + CHAT_CHUNK);
    const fragment = document.createDocumentFragment();
    for (let index = storeChat.rendered; index < end; index += 1) {
      fragment.append(chatMessageNode(storeChat.messages[index]));
    }
    list.append(fragment);
    storeChat.rendered = end;
  }

  // Fill the first screen without waiting for a scroll; short conversations
  // then reveal everything at once.
  function fillChatViewport() {
    const box = $('storeMessages');
    if (!box) return;
    if (storeChat.rendered < storeChat.messages.length && box.scrollHeight <= box.clientHeight + 48) {
      appendChatMessages();
      requestAnimationFrame(fillChatViewport);
    }
  }

  // Full bodies open in a modal: the list stays scannable and the dialog gets
  // the whole viewport for code-heavy payloads.
  async function loadStoreValue(key) {
    const dialog = $('storeValueDialog');
    $('storeDialogTitle').textContent = key.length > 90 ? `…${key.slice(-86)}` : key;
    $('storeDialogMeta').textContent = '读取中…';
    $('storeDialogBody').textContent = '';
    if (!dialog.open) dialog.showModal();
    try {
      const data = await api(`/api/cursor-store/value?key=${encodeURIComponent(key)}`);
      if (!data.value.found) {
        $('storeDialogMeta').textContent = '未找到';
        $('storeDialogBody').textContent = '该 key 不存在（已查 cursorDiskKV 与 ItemTable）。';
        return;
      }
      let text = data.value.text || '（空值）';
      if (text.length <= 65536) {
        try { text = JSON.stringify(JSON.parse(text), null, 2); } catch { /* 非 JSON 原样展示 */ }
      }
      if (data.value.truncated) text += `\n\n…（已截断，原值 ${bytes(data.value.bytes)}）`;
      $('storeDialogBody').textContent = text;
      $('storeDialogMeta').textContent = `${bytes(data.value.bytes)} · ${data.value.table}`;
    } catch (error) {
      $('storeDialogMeta').textContent = '读取失败';
      $('storeDialogBody').textContent = error.message;
    }
  }

  async function loadStoreKeyValue() {
    const key = $('storeKey').value.trim();
    const box = $('storeKeyBody');
    box.hidden = false;
    if (!key) {
      box.textContent = '请输入 key。';
      return;
    }
    box.textContent = '读取中…';
    try {
      const data = await api(`/api/cursor-store/value?key=${encodeURIComponent(key)}`);
      if (!data.value.found) {
        box.textContent = '未找到该 key（先查 cursorDiskKV，再查 ItemTable）。';
        return;
      }
      let text = data.value.text || '（空值）';
      if (text.length <= 65536) {
        try { text = JSON.stringify(JSON.parse(text), null, 2); } catch { /* 非 JSON 原样展示 */ }
      }
      if (data.value.truncated) text += `\n\n…（已截断，原值 ${bytes(data.value.bytes)}）`;
      box.textContent = text;
    } catch (error) {
      box.textContent = `读取失败：${error.message}`;
    }
  }

  function renderDatabase(data) {
    dbData = data;
    $('dbState').textContent = data.exists ? bytes(data.file.db) : '未创建';
    if (!data.exists) {
      $('dbHint').textContent = '数据库尚未创建；轻量模式下引擎不写 bridge.db，因此没有可清理的内容。';
      $('dbSummary').hidden = true;
      $('dbCategories').replaceChildren();
      $('dbConversations').hidden = true;
      $('dbDaysBox').hidden = true;
      $('cleanCallsHint').textContent = '暂无数据库文件';
      updateDbControls();
      return;
    }
    const overhead = Math.max(0, data.file.db - data.totals.bytes);
    $('dbHint').textContent = data.deep
      ? '精确统计完成 · 表内数据按内容字节计算，索引与空闲页计入「索引与空闲」'
      : '快速统计完成 · 内容块体积未计入（点「精确统计」补齐），索引与空闲页计入「索引与空闲」';
    $('dbSummary').replaceChildren(
      item('数据库文件', bytes(data.file.db), {mono: true, title: data.path}),
      item('WAL / SHM', `${bytes(data.file.wal)} / ${bytes(data.file.shm)}`, {mono: true}),
      item('表内数据', bytes(data.totals.bytes), {mono: true}),
      // Without the blob body sizes the remainder is not index/free space:
      // most of it is content the fast pass deliberately skipped.
      item('索引与空闲', data.deep ? `约 ${bytes(overhead)}` : '— · 需精确统计', {mono: true}),
      item('总行数', numberText(data.totals.rows), {mono: true}),
      item('空闲页', numberText(data.page?.freelistCount), {mono: true}),
      item('页大小', data.page?.pageSize ? `${numberText(data.page.pageSize)} B` : '—', {mono: true}),
      item('最近写入', timeText(data.file.updated))
    );
    $('dbSummary').hidden = false;

    const categories = document.createElement('div');
    categories.className = 'db-categories';
    for (const category of data.categories || []) {
      if (!category.tables.length) continue;
      const box = document.createElement('div');
      box.className = 'db-cat';
      const head = document.createElement('div');
      head.className = 'db-cat-head';
      const title = document.createElement('div');
      const name = document.createElement('strong');
      name.textContent = category.label;
      const hint = document.createElement('span');
      hint.className = 'hint';
      hint.textContent = category.hint;
      title.append(name, hint);
      const total = document.createElement('span');
      total.className = 'db-cat-total';
      total.textContent = `${category.measured ? bytes(category.bytes) : '—'} · ${numberText(category.rows)} 行`;
      head.append(title, total);
      box.append(head, dbTable(['表', '行数', '数据体积'], category.tables.map((table) => [
        {text: table.label, title: table.name},
        numberText(table.rows),
        table.measured ? bytes(table.bytes) : '—'
      ])));
      categories.append(box);
    }
    $('dbCategories').replaceChildren(categories);

    const conversations = data.conversations || [];
    $('dbConversations').hidden = !conversations.length;
    if (conversations.length) {
      $('dbConvHint').textContent = `最近 ${conversations.length} 个会话，按更新时间排序`;
      $('dbConvBody').replaceChildren(dbTable(['会话', '更新时间', '消息', '数据体积'], conversations.map((conversation) => [
        {text: conversation.id.slice(0, 8), title: conversation.id, mono: true},
        timeText(conversation.updated),
        numberText(conversation.messages),
        bytes(conversation.bytes)
      ])));
    }

    const days = data.days || [];
    $('dbDaysBox').hidden = !days.length;
    if (days.length) {
      $('dbDaysBody').replaceChildren(dbTable(['日期', '消息数', '数据体积'], days.map((day) => [
        {text: day.day, mono: true},
        numberText(day.count),
        bytes(day.bytes)
      ])));
    }

    const rows = new Map();
    for (const category of data.categories || []) {
      for (const table of category.tables) rows.set(table.name, table);
    }
    const calls = rows.get('llm_calls')?.rows || 0;
    const traces = rows.get('cursor_run_traces')?.rows || 0;
    $('cleanCallsHint').textContent = `模型调用 ${numberText(calls)} 条 · 请求追踪 ${numberText(traces)} 条`;
    updateDbControls();
  }

  async function loadDatabase({force = false, quiet = false, deep = false} = {}) {
    if (dbLoading) return;
    dbLoading = true;
    $('dbState').textContent = deep ? '精确统计中…' : '统计中…';
    if (!quiet) $('dbHint').textContent = deep
      ? '正在扫描全部内容块体积（数据库越大耗时越久）…'
      : '正在快速统计（内容块体积未计入）…';
    updateDbControls();
    try {
      const params = new URLSearchParams();
      if (force) params.set('refresh', '1');
      if (deep) params.set('deep', '1');
      const query = params.toString();
      const data = await api(`/api/database${query ? `?${query}` : ''}`);
      renderDatabase(data.database);
    } catch (error) {
      $('dbState').textContent = '统计失败';
      $('dbHint').textContent = `统计失败：${error.message}`;
      if (!quiet) notice(`数据库统计失败：${error.message}`, 'error');
    } finally {
      dbLoading = false;
      updateDbControls();
    }
  }

  function cleanupPlan(scope) {
    const days = Number($('cleanDays').value) || 3;
    const vacuum = scope === 'vacuum' || $('dbVacuum').checked;
    const backup = scope !== 'vacuum' && $('dbBackup').checked;
    const rows = new Map();
    for (const category of dbData?.categories || []) {
      for (const table of category.tables) rows.set(table.name, table);
    }
    const calls = rows.get('llm_calls')?.rows || 0;
    const traces = rows.get('cursor_run_traces')?.rows || 0;
    const conversations = rows.get('conversations')?.rows || 0;
    let text = '';
    if (scope === 'traces') {
      text = `将删除 ${numberText(calls)} 条模型调用日志与 ${numberText(traces)} 条请求追踪记录。`;
    } else if (scope === 'sessions') {
      text = `将删除 ${days} 天前未更新的会话及其消息、检查点、运行和工具调用记录；blob 内容会保留。`;
    } else if (scope === 'vacuum') {
      text = '不删除数据，仅执行 VACUUM 压缩数据库并回收空闲页。';
    } else {
      text = `将删除 ${numberText(conversations)} 个会话及其全部消息、检查点、运行记录、调用日志与 blob 内容。模型配置与服务设置保留，此操作不可撤销。`;
    }
    const running = lastOverview?.engine?.alive || lastOverview?.supervisor?.alive;
    if (running) text += ' 清理前会短暂暂停桥接，完成后自动重启，当前对话可能中断一次。';
    if (vacuum) {
      text += ' 将执行 VACUUM 回收磁盘空间。';
    } else {
      text += ' 未勾选压缩：删除后的空间会被后续写入复用，文件不会立即缩小。';
    }
    if (backup) {
      text += ' 清理前会生成数据库快照备份到 data/backups，保留最近 3 份。';
    }
    return {scope, days, vacuum, backup, text};
  }

  function refreshCleanupPlan() {
    if (!pendingClean || cleaning) return;
    const scope = pendingClean.scope;
    const typed = $('dbConfirmType').value;
    pendingClean = cleanupPlan(scope);
    $('dbConfirmText').textContent = pendingClean.text;
    $('dbConfirmType').value = typed;
    updateDbControls();
  }

  function showCleanupConfirm(scope) {
    if (!dbData?.exists || cleaning) return;
    // Destructive session resets are backed up by default; diagnostics cleanup
    // can be the largest (and least valuable) copy, so it stays opt-in.
    $('dbBackup').checked = scope === 'sessions' || scope === 'all';
    pendingClean = cleanupPlan(scope);
    $('dbConfirmText').textContent = pendingClean.text;
    $('dbConfirmTypeWrap').hidden = scope !== 'all';
    $('dbConfirmType').value = '';
    $('dbConfirmHint').textContent = '';
    $('dbConfirm').hidden = false;
    updateDbControls();
  }

  async function executeCleanup() {
    const plan = pendingClean;
    if (!plan || cleaning) return;
    if (plan.scope === 'all' && $('dbConfirmType').value.trim() !== '清空全部') return;
    cleaning = true;
    busy = '数据库清理';
    setBusy(true);
    $('dbConfirmHint').textContent = plan.vacuum ? '正在清理并压缩，桥接会短暂重启…' : '正在清理…';
    notice('');
    try {
      const result = await api('/api/database/cleanup', {
        method: 'POST',
        body: {scope: plan.scope, olderThanDays: plan.days, vacuum: plan.vacuum, backup: plan.backup}
      });
      const cleanup = result.cleanup;
      const released = cleanup.reclaimed > 0 ? `，释放 ${bytes(cleanup.reclaimed)}` : '';
      const backedUp = cleanup.backup
        ? `，已备份 ${bytes(cleanup.backup.size)} 到 ${shorten(cleanup.backup.file)}`
        : '';
      const check = cleanup.check && cleanup.check !== 'ok' ? `；数据库检查：${cleanup.check}` : '';
      if (result.restart && !result.restart.ok) {
        notice(`数据库已清理（${bytes(cleanup.before.total)} → ${bytes(cleanup.after.total)}${released}${backedUp}），但桥接重启失败：${result.restart.error || '未知错误'}${check}`, 'error');
      } else {
        const restarted = result.restart?.ok ? '，桥接已重启' : '';
        notice(`清理完成：${bytes(cleanup.before.total)} → ${bytes(cleanup.after.total)}${released}${restarted}${backedUp}${check}。`, check ? 'warning' : 'ok');
      }
      pendingClean = null;
      $('dbConfirm').hidden = true;
      loadStatus({quiet: true});
      loadDatabase({force: true, quiet: true});
    } catch (error) {
      $('dbConfirmHint').textContent = `清理失败：${error.message}`;
      notice(`清理失败：${error.message}`, 'error');
    } finally {
      cleaning = false;
      busy = null;
      setBusy(false);
    }
  }

  // cursor-agent speaks the same protocol as the IDE but ignores settings.json;
  // the console only manages the small wrapper that injects HTTPS_PROXY.
  async function loadAgentCli({force = false} = {}) {
    if (agentCli.loading) return;
    if (!force && agentCli.data && Date.now() - agentCli.at < 15000) return renderAgentCli(agentCli.data, agentCli.orca);
    agentCli.loading = true;
    try {
      const data = await api('/api/cursor-agent');
      agentCli = {at: Date.now(), data: data.agent, orca: data.orca, loading: false};
      renderAgentCli(data.agent, data.orca);
    } catch (error) {
      agentCli.loading = false;
      $('agentCliState').textContent = '读取失败';
      notice(`读取 Cursor CLI 状态失败：${error.message}`, 'error');
    }
  }

  // The switch reflects intent (bridge-settings.json), while injected/running
  // describe the file Orca will read next. Showing both keeps "saved but
  // waiting for Orca to exit" from looking like a failed switch.
  function orcaView(orca, entry) {
    if (!orca.installed) return {text: '未检测到 Orca', tone: 'warn'};
    if (orca.foreignOverride) return {text: '已有自定义命令', tone: 'warn'};
    const wanted = orca.takeover !== 'off';
    if (orca.injected) {
      if (!orca.wrapperInstalled) return {text: '已接管 · 包装器缺失', tone: 'warn'};
      // The file still carries the override while the saved intent is off:
      // either Orca is open (it rewrites the file on exit) or the supervisor
      // has not run yet. Both are "pending", not "failed".
      if (!wanted) return {text: orca.running ? '已接管 · 退出后取消' : '已接管 · 待取消', tone: 'warn'};
      return {text: '已接管', tone: 'ok'};
    }
    if (!orca.wrapperInstalled) return {text: wanted ? '未安装包装器' : '已关闭', tone: wanted ? 'warn' : ''};
    if (orca.running) return {text: wanted ? '等待 Orca 退出后接管' : '已关闭', tone: wanted ? 'warn' : ''};
    if (wanted) return {text: entry?.installed ? '入口已接管 · 配置待写入' : '未接管', tone: entry?.installed ? 'ok' : 'warn'};
    return {text: entry?.installed ? '已关闭 · 官方入口仍接管' : '已关闭', tone: entry?.installed ? 'warn' : ''};
  }

  function renderAgentCli(agent, orca = {}) {
    const compat = agent.compatibility || {};
    const hook = agent.shellHook || {};
    const orcaState = orcaView(orca, agent.entry);
    const versionText = agent.version
      ? `${agent.version}${compat.tested ? ' · 已实测' : ' · 未验证'}`
      : '未检测到';
    $('agentCliSummary').replaceChildren(
      item('Cursor CLI', versionText, {tone: compat.tested ? 'ok' : 'warn', title: compat.hint || agent.executable || ''}),
      item('代理端口', agent.proxy || '未连接', {mono: true, tone: agent.proxy ? 'ok' : 'warn'}),
      item('环境文件', agent.envReady ? '已写入' : '未写入', {tone: agent.envReady ? 'ok' : 'warn', title: agent.envFile}),
      item('包装器', agent.wrapperInstalled ? `已安装${agent.wrapperOnPath ? '' : ' · 不在 PATH'}` : '未安装',
        {tone: agent.wrapperInstalled && agent.wrapperOnPath ? 'ok' : 'warn', title: agent.wrapperFile}),
      item('直接接管', hook.supported ? (hook.installed ? '已启用' : '未启用') : '当前平台不支持',
        {tone: hook.installed ? 'ok' : (hook.supported ? '' : 'warn'), title: hook.path || 'Windows 请使用 cursor-agent-bridge'}),
      item('官方入口', !agent.entry?.entryPresent
        ? '未检测到'
        : (agent.entry.installed ? '已接管' : '未接管'), {
        tone: agent.entry?.installed ? 'ok' : 'warn',
        title: agent.entry?.entry || ''
      }),
      item('Orca 聊天', orcaState.text, {
        tone: orcaState.tone,
        title: orca.path || ''
      })
    );
    $('agentCliSummary').hidden = false;
    $('agentCliState').textContent = agent.wrapperInstalled || hook.installed ? '已启用' : (agent.installed ? '可启用' : '未检测到');
    $('agentCliInstall').disabled = !agent.installed;
    $('agentCliRemove').disabled = !agent.wrapperInstalled;
    $('agentCliEntryInstall').disabled = !agent.entry?.supported || !agent.entry?.entryPresent || agent.entry?.installed;
    $('agentCliEntryRemove').disabled = !agent.entry?.installed;
    // Both buttons reflect the saved intent, not the file's momentary state:
    // an Orca that is still running leaves the switch "on" with a pending
    // write, so the buttons stay usable while the file catches up.
    const orcaWanted = orca.takeover !== 'off';
    $('agentCliOrcaInstall').disabled = !orca.installed || orca.foreignOverride || orcaWanted;
    $('agentCliOrcaRemove').disabled = !orca.installed || orca.foreignOverride || !orcaWanted;
    $('agentCliCopy').disabled = !agent.command;
    // The primary switch lives in the editable settings card; this keeps its
    // value in sync with the rc file the server actually sees.
    const takeover = $('agentTakeover');
    takeover.value = hook.installed ? 'on' : 'off';
    takeover.disabled = !hook.supported;
    takeover.title = hook.supported ? (hook.path || '') : '当前平台不支持，请使用 cursor-agent-bridge';
    $('agentCliHint').textContent = !agent.installed
      ? (compat.hint || '未检测到 Cursor CLI。')
      : (agent.wrapperInstalled
        ? '用 cursor-agent-bridge 启动即可接管；官方 Cursor CLI 保持原样。'
        : '安装后可用 cursor-agent-bridge 启动；也可以直接使用下方一次性命令。');
    const command = $('agentCliCommand');
    command.textContent = agent.wrapperInstalled
      ? `${agent.command} --list-models`
      : (agent.oneShot ? `${agent.oneShot} --list-models` : '');
    command.hidden = !command.textContent;
  }

  async function changeAgentCli(action) {
    const labels = {
      install: '包装器已安装',
      remove: '包装器已移除',
      'hook-install': '已启用直接接管，重新打开终端或执行 source ~/.zshrc 后生效',
      'hook-remove': '已停用直接接管',
      'entry-install': '已接管官方 cursor-agent 入口：Orca 聊天等直接调用会走桥接',
      'entry-remove': '已恢复官方 cursor-agent 入口',
      'orca-install': '已开启 Orca 自动接管',
      'orca-remove': '已关闭 Orca 兜底接管（官方入口不受影响）'
    };
    try {
      const data = await api('/api/cursor-agent', {method: 'POST', body: {action}});
      const label = labels[action] || '操作完成';
      const pending = data.pending === 'running' ? '；Orca 退出后自动生效' : '';
      const missing = data.reason === 'missing' ? '（未检测到 Orca，安装后自动生效）' : '';
      const noWrapper = data.reason === 'wrapper-missing' ? '（未安装 cursor-agent 包装器，已跳过）' : '';
      notice(`${label}${pending}${missing}${noWrapper}${data.path ? `：${data.path}` : ''}`, 'ok');
      // The two Orca controls share one stored intent. Keep the editable
      // parameter in step with the button, otherwise a later "save" in the
      // other form would post the stale value and silently undo this action.
      if (action === 'orca-install' || action === 'orca-remove') {
        const value = action === 'orca-install' ? 'on' : 'off';
        $('orcaTakeover').value = value;
        if (lastOverview?.settings?.values) lastOverview.settings.values.orcaTakeover = value;
      }
      await loadAgentCli({force: true});
    } catch (error) {
      $('agentCliHint').textContent = String(error.message);
      notice(`操作失败：${error.message}`, 'error');
    }
  }

  async function toggleAgentTakeover() {
    const select = $('agentTakeover');
    const enable = select.value === 'on';
    select.disabled = true;
    try {
      const data = await api('/api/cursor-agent', {method: 'POST', body: {action: enable ? 'hook-install' : 'hook-remove'}});
      notice(enable
        ? `已开启直接接管，重新打开终端后生效${data.path ? `：${data.path}` : ''}`
        : '已关闭直接接管', 'ok');
      await loadAgentCli({force: true});
    } catch (error) {
      select.value = enable ? 'off' : 'on';
      notice(`切换接管失败：${error.message}`, 'error');
    } finally {
      select.disabled = !(agentCli.data?.shellHook?.supported ?? false);
    }
  }

  async function copyAgentCli() {
    const text = $('agentCliCommand').textContent || '';
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      notice('启动命令已复制', 'ok');
    } catch {
      notice('复制失败，请手动选择命令行文本', 'error');
    }
  }

  async function loadCalls() {
    const limit = $('callsLimit').value;
    const errors = $('callsErrors').checked ? '1' : '0';
    $('callsState').textContent = '读取中…';
    try {
      const data = await api(`/api/calls?limit=${encodeURIComponent(limit)}&errors=${errors}`);
      if (!data.exists) {
        $('callsState').textContent = '未创建';
        $('callsHint').textContent = '数据库尚未创建；轻量模式下没有可读取的调用记录。';
        $('callsBody').replaceChildren();
        return;
      }
      $('callsState').textContent = `${numberText(data.calls.length)} 条${data.truncated ? ' · 已有更多' : ''}`;
      $('callsHint').textContent = '时间、模型、状态、耗时、token 与错误摘要；错误内容已脱敏。';
      const rows = data.calls.map((call) => [
        {text: timeText(call.created), mono: true},
        {text: call.model, title: call.id},
        {text: call.finish ? `${call.status} / ${call.finish}` : call.status},
        call.durationMs ? `${numberText(call.durationMs)} ms` : '—',
        `${numberText(call.inputTokens)} / ${numberText(call.outputTokens)} / ${numberText(call.totalTokens)}`,
        {text: call.error ? shorten(call.error, 90) : '—', title: call.error || ''}
      ]);
      $('callsBody').replaceChildren(rows.length
        ? dbTable(['时间', '模型', '状态', '耗时', 'token（入/出/总）', '错误'], rows)
        : document.createTextNode('暂无调用记录'));
    } catch (error) {
      $('callsState').textContent = '读取失败';
      $('callsHint').textContent = `读取失败：${error.message}`;
      $('callsBody').replaceChildren();
    }
  }

  function renderDiagHints(hints) {
    $('diagHints').replaceChildren(...(hints || []).map((hint) => {
      const node = document.createElement('div');
      node.className = 'notice';
      node.dataset.kind = 'warning';
      const label = document.createElement('strong');
      label.textContent = hint.label;
      node.append(label, document.createTextNode(` · ${hint.hint}`));
      return node;
    }));
  }

  async function loadLogs() {
    const name = $('logName').value;
    const tail = $('logTail').value;
    $('diagState').textContent = '读取中…';
    try {
      const data = await api(`/api/logs?name=${encodeURIComponent(name)}&tail=${encodeURIComponent(tail)}`);
      renderDiagHints(data.hints);
      $('diagOutput').hidden = false;
      $('diagOutput').textContent = data.exists
        ? `${data.text || '（日志为空）'}\n\n— ${data.name} · ${numberText(data.size)} B${data.truncated ? ' · 仅显示尾部' : ''} —`
        : `日志文件不存在：${data.path}`;
      $('diagState').textContent = data.exists
        ? `${numberText(data.lines)} 行${data.truncated ? ' · 已截断' : ''}`
        : '未创建';
    } catch (error) {
      $('diagState').textContent = '读取失败';
      $('diagOutput').hidden = false;
      $('diagOutput').textContent = `读取失败：${error.message}`;
    }
  }

  async function checkUpdate() {
    const button = $('updateCheck');
    button.disabled = true;
    $('updateState').textContent = '正在检查…';
    try {
      const data = await api('/api/update');
      if (!data.ok) {
        $('updateState').textContent = '检查失败';
        notice(`检查更新失败：${data.error}`, 'error');
        return;
      }
      if (!data.updateAvailable) {
        $('updateCard').hidden = true;
        notice(`已是最新版本 v${data.current}`, 'ok');
        return;
      }
      updateCommand = data.command || '';
      $('updateCard').hidden = false;
      $('updateVersion').textContent = `v${data.current} → v${data.latest}`;
      $('updateHint').textContent = data.canUpgrade
        ? `发现新版本 v${data.latest}；当前为干净源码安装，可直接升级并重启后台。`
        : `发现新版本 v${data.latest}；当前安装方式需手动升级${updateCommand ? `：${updateCommand}` : ''}`;
      $('updateRun').hidden = !data.canUpgrade;
      $('updateRun').dataset.version = data.latest;
      $('updateCopy').hidden = !updateCommand;
      $('updateLink').hidden = !data.url;
      if (data.url) $('updateLink').href = data.url;
      $('updateState').textContent = '';
      notice(`发现新版本 v${data.latest}`, 'warning');
    } catch (error) {
      $('updateState').textContent = '检查失败';
      notice(`检查更新失败：${error.message}`, 'error');
    } finally {
      button.disabled = false;
    }
  }

  async function copyUpdateCommand() {
    if (!updateCommand) return;
    try {
      await navigator.clipboard.writeText(updateCommand);
      notice('升级命令已复制', 'ok');
    } catch {
      notice(`请手动复制：${updateCommand}`, 'warning');
    }
  }

  async function runUpdate() {
    const target = $('updateRun').dataset.version;
    if (!target) return;
    if (!confirm(`升级到 v${target} 并重启后台？当前对话可能中断一次。`)) return;
    busy = '升级';
    setBusy(true);
    $('updateState').textContent = '正在升级…';
    try {
      const data = await api('/api/update', {method: 'POST', body: {confirm: true}});
      if (!data.updated) {
        notice(data.message || '已是最新版本', 'ok');
        return;
      }
      $('updateState').textContent = '升级完成';
      notice(`已升级到 v${data.to}，后台已重启；请刷新页面或重启 Magpie 加载新控制台。`, 'ok');
      setTimeout(() => location.reload(), 2500);
    } catch (error) {
      $('updateState').textContent = '升级失败';
      notice(`升级失败：${error.message}`, 'error');
    } finally {
      busy = null;
      setBusy(false);
    }
  }

  async function runSelfTestUI() {
    const button = $('selftestRun');
    button.disabled = true;
    $('selftestState').textContent = '正在检查…（模型请求最长 30 秒）';
    try {
      const data = await api('/api/selftest', {method: 'POST', body: {model: $('selftestModel').checked}});
      const result = data.result;
      const rows = (result.checks || []).map((check) => [
        check.label,
        check.skipped ? '跳过' : (check.ok ? '通过' : '失败'),
        check.detail,
        check.durationMs ? `${numberText(check.durationMs)} ms` : '—'
      ]);
      $('selftestResults').replaceChildren(dbTable(['检查', '结果', '详情', '耗时'], rows));
      $('selftestState').textContent = result.ok ? '自检通过' : '自检发现问题';
      notice(result.ok ? '自检通过：各层均正常。' : '自检发现问题，请查看「日志与诊断」明细。', result.ok ? 'ok' : 'error');
    } catch (error) {
      $('selftestState').textContent = '自检失败';
      notice(`自检失败：${error.message}`, 'error');
    } finally {
      button.disabled = false;
    }
  }

  async function exportDiagnostics() {
    $('diagState').textContent = '正在生成诊断包…';
    try {
      const data = await api('/api/diagnostics', {method: 'POST'});
      renderDiagHints(data.hints);
      $('diagState').textContent = '诊断包已保存';
      notice(`诊断包已保存：${data.file}（日志已脱敏）。`, 'ok');
    } catch (error) {
      $('diagState').textContent = '生成失败';
      notice(`诊断包生成失败：${error.message}`, 'error');
    }
  }

  function wire() {
    for (const [id, action] of [['start', 'start'], ['stop', 'stop'], ['status', 'status'], ['restart', 'restart']]) {
      $(id).addEventListener('click', () => runAction(action));
    }
    $('agentConnect').addEventListener('click', connectAgent);
    const repo = window.__BRIDGE_REPO__ || '';
    if (repo) {
      $('github').href = repo;
      $('github').hidden = false;
      // Magpie's WebView blocks target="_blank"; ask the control service to
      // hand the URL to the host OS opener instead.
      $('github').addEventListener('click', async (event) => {
        event.preventDefault();
        try {
          await api('/api/open', {method: 'POST', body: {target: 'github'}});
        } catch (error) {
          notice(`打开 GitHub 失败：${error.message}`, 'error');
        }
      });
    }
    $('refresh').addEventListener('click', () => loadStatus());
    $('updateCheck').addEventListener('click', checkUpdate);
    $('updateRun').addEventListener('click', runUpdate);
    $('updateCopy').addEventListener('click', copyUpdateCommand);
    $('reload').addEventListener('click', () => location.reload());
    $('dbCard').addEventListener('toggle', () => {
      if ($('dbCard').open && !dbData && !cleaning) loadDatabase();
      tellSize();
    });
    $('dbRefresh').addEventListener('click', () => loadDatabase({force: true}));
    $('dbDeep').addEventListener('click', () => loadDatabase({force: true, deep: true}));
    $('storeCard').addEventListener('toggle', () => {
      if ($('storeCard').open && !storeOverview && !storeLoading) loadStore();
    });
    $('storeRefresh').addEventListener('click', () => loadStore());
    $('storeWorkspace').addEventListener('change', () => loadStoreSessions({reset: true}));
    $('storeKind').addEventListener('change', () => loadStoreSessions({reset: true}));
    $('storeRange').addEventListener('change', () => {
      const custom = $('storeRange').value === 'custom';
      $('storeCustomRange').hidden = !custom;
      if (!custom) loadStoreSessions({reset: true});
    });
    $('storeRangeApply').addEventListener('click', () => loadStoreSessions({reset: true}));
    $('storePageSize').addEventListener('change', () => loadStoreSessions({reset: true}));
    $('storeResetFilters').addEventListener('click', () => {
      $('storeWorkspace').value = '';
      $('storeKind').value = 'main';
      $('storeRange').value = 'all';
      $('storeNamed').value = 'all';
      $('storeMode').value = '';
      $('storeCustomRange').hidden = true;
      loadStoreSessions({reset: true});
    });
    $('storeNamed').addEventListener('change', () => loadStoreSessions({reset: true}));
    $('storeMode').addEventListener('change', () => loadStoreSessions({reset: true}));
    $('storeShowTools').addEventListener('change', () => {
      if (storeDetail.id) openStoreSession(storeDetail.id);
    });
    $('storeDialogClose').addEventListener('click', () => $('storeValueDialog').close());
    $('storeValueDialog').addEventListener('click', (event) => {
      // A click on the backdrop targets the dialog element itself.
      if (event.target === $('storeValueDialog')) $('storeValueDialog').close();
    });
    $('storePrev').addEventListener('click', () => {
      storeOffset = Math.max(0, storeOffset - storePageSize());
      loadStoreSessions();
    });
    $('storeNext').addEventListener('click', () => {
      storeOffset += storePageSize();
      loadStoreSessions();
    });
    $('storeMessages').addEventListener('scroll', () => {
      const box = $('storeMessages');
      if (!storeChat.messages.length) return;
      if (box.scrollTop + box.clientHeight >= box.scrollHeight - 240) appendChatMessages();
    });
    $('storeDetailClose').addEventListener('click', () => {
      $('storeDetailDialog').close();
      storeDetail = {id: '', offset: 0, total: 0};
    });
    $('storeDetailDialog').addEventListener('click', (event) => {
      if (event.target === $('storeDetailDialog')) $('storeDetailDialog').close();
    });
    $('storeBulkDelete').addEventListener('click', () => {
      if (storeSelected.size) openStoreDelete([...storeSelected]);
    });
    $('storeBulkClear').addEventListener('click', () => {
      storeSelected.clear();
      updateStoreSelection();
      loadStoreSessions();
    });
    $('storeCleanDelete').addEventListener('click', deleteFilteredStore);
    $('storeVacuum').addEventListener('click', openStoreVacuum);
    $('storeDeleteWord').addEventListener('input', storeDeleteReady);
    $('storeDeleteCursor').addEventListener('change', storeDeleteReady);
    $('storeDeleteGo').addEventListener('click', confirmStoreDelete);
    $('storeDeleteCancel').addEventListener('click', () => $('storeDeleteDialog').close());
    $('storeDeleteDialog').addEventListener('click', (event) => {
      if (event.target === $('storeDeleteDialog')) $('storeDeleteDialog').close();
    });
    $('storeVacuumCursor').addEventListener('change', () => {
      $('storeVacuumGo').disabled = !$('storeVacuumCursor').checked;
    });
    $('storeVacuumGo').addEventListener('click', confirmStoreVacuum);
    $('storeVacuumCancel').addEventListener('click', () => $('storeVacuumDialog').close());
    $('storeVacuumDialog').addEventListener('click', (event) => {
      if (event.target === $('storeVacuumDialog')) $('storeVacuumDialog').close();
    });
    $('storeKeyLoad').addEventListener('click', loadStoreKeyValue);
    $('storeKey').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') loadStoreKeyValue();
    });
    $('callsCard').addEventListener('toggle', () => {
      if ($('callsCard').open) loadCalls();
    });
    $('agentCliCard').addEventListener('toggle', () => {
      if ($('agentCliCard').open) loadAgentCli();
    });
    $('agentCliInstall').addEventListener('click', () => changeAgentCli('install'));
    $('agentCliRemove').addEventListener('click', () => changeAgentCli('remove'));
    $('agentCliEntryInstall').addEventListener('click', () => changeAgentCli('entry-install'));
    $('agentCliEntryRemove').addEventListener('click', () => changeAgentCli('entry-remove'));
    $('agentCliOrcaInstall').addEventListener('click', () => changeAgentCli('orca-install'));
    $('agentCliOrcaRemove').addEventListener('click', () => changeAgentCli('orca-remove'));
    $('agentCliCopy').addEventListener('click', copyAgentCli);
    $('agentTakeover').addEventListener('change', toggleAgentTakeover);
    $('callsRefresh').addEventListener('click', loadCalls);
    $('callsErrors').addEventListener('change', loadCalls);
    $('callsLimit').addEventListener('change', loadCalls);
    $('diagCard').addEventListener('toggle', () => {
      if ($('diagCard').open && !$('diagOutput').dataset.loaded) {
        $('diagOutput').dataset.loaded = '1';
        loadLogs();
      }
    });
    $('logRefresh').addEventListener('click', loadLogs);
    $('diagDownload').addEventListener('click', exportDiagnostics);
    $('selftestRun').addEventListener('click', runSelfTestUI);
    for (const button of document.querySelectorAll('[data-clean]')) {
      button.addEventListener('click', () => showCleanupConfirm(button.dataset.clean));
    }
    $('cleanDays').addEventListener('change', refreshCleanupPlan);
    $('dbVacuum').addEventListener('change', refreshCleanupPlan);
    $('dbBackup').addEventListener('change', refreshCleanupPlan);
    $('dbConfirmType').addEventListener('input', updateDbControls);
    $('dbConfirmGo').addEventListener('click', executeCleanup);
    $('dbConfirmCancel').addEventListener('click', () => {
      pendingClean = null;
      $('dbConfirm').hidden = true;
      $('dbConfirmHint').textContent = '';
      updateDbControls();
    });
    $('settingsForm').addEventListener('submit', saveSettings);
    $('settingsCard').addEventListener('toggle', renderSettingsState);
    initSettingTips();
    $('saveModelNames').addEventListener('click', saveModelNames);
    $('modelNamesCard').addEventListener('toggle', () => {
      if ($('modelNamesCard').open && lastOverview) loadModelNames(lastOverview);
    });
    $('modelSearch').addEventListener('input', filterModelRows);
    const modelRows = $('modelNameRows');
    modelRows.addEventListener('change', (event) => {
      if (event.target.matches?.('input[data-show-model]')) {
        $('modelNamesStatus').textContent = '菜单显示有未保存改动，点击「保存全部」应用';
      }
    });
    modelRows.addEventListener('dragover', (event) => {
      if (!dragRow) return;
      event.preventDefault();
      const rows = [...modelRows.querySelectorAll('tr')].filter((row) => row !== dragRow);
      const next = rows.find((row) => {
        const box = row.getBoundingClientRect();
        return event.clientY < box.top + box.height / 2;
      });
      if (next) modelRows.insertBefore(dragRow, next);
      else modelRows.appendChild(dragRow);
    });
    modelRows.addEventListener('drop', (event) => {
      if (!dragRow) return;
      event.preventDefault();
      const row = dragRow;
      dragRow = null;
      dragSnapshot = null;
      row.classList.remove('dragging');
      saveModelOrder();
    });
    modelRows.addEventListener('dragend', () => {
      if (dragRow) {
        dragRow.classList.remove('dragging');
        if (dragSnapshot) modelRows.replaceChildren(...dragSnapshot);
        dragRow = null;
      }
      dragSnapshot = null;
    });
    modelRows.addEventListener('click', (event) => {
      const test = event.target.closest?.('button[data-test-model]');
      if (test) {
        testModelRow(test.dataset.testModel, test);
        return;
      }
      const button = event.target.closest?.('button[data-save-model]');
      if (button) saveModelRow(button.dataset.saveModel);
    });
    $('resetSettings').addEventListener('click', () => {
      const defaults = lastOverview?.settings?.defaults || {runMode: 'default', subagentMode: 'async', orcaTakeover: 'on', showOfficialModels: false, refreshSeconds: 15, gatewayGraceSeconds: 60, logLimitMB: 4, tracesRetentionDays: 7, sessionsRetentionDays: 0};
      fillSettings(defaults);
      $('settingsHint').textContent = '已填入默认值，点击「保存」后生效';
    });
    for (const button of document.querySelectorAll('[data-target]')) {
      button.addEventListener('click', async () => {
        try {
          await api('/api/open', {method: 'POST', body: {target: button.dataset.target}});
        } catch (error) {
          notice(`打开失败：${error.message}`, 'error');
        }
      });
    }
    $('back').addEventListener('click', () => {
      if (history.length > 1) history.back();
      else notice('请回到 Magpie 的 Agents 面板修改控制端口', 'warning');
    });
  }

  function tellSize() {
    try {
      parent.postMessage({
        magpie: 1,
        method: 'size',
        params: {height: Math.ceil(document.documentElement.getBoundingClientRect().height)}
      }, '*');
    } catch { /* not inside the panel */ }
  }

  function startPolling() {
    clearTimeout(pollTimer);
    const tick = async () => {
      if (document.visibilityState === 'visible' && !busy) await loadStatus({quiet: true});
      // A hidden panel or an idle bridge does not need five-second polling.
      const delay = document.visibilityState === 'visible' ? 5000 : 30000;
      pollTimer = setTimeout(tick, delay);
    };
    pollTimer = setTimeout(tick, 5000);
  }

  applyTheme();
  wire();
  loadStatus();
  startPolling();
  if ('ResizeObserver' in window) new ResizeObserver(tellSize).observe(document.documentElement);
  addEventListener('load', tellSize);
  setTimeout(tellSize, 0);
  setTimeout(tellSize, 300);
})();
