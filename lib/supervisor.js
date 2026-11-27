import {createInterface} from 'node:readline';
import {validate} from './config.js';

// The supervisor is the bridge's state machine: it decides when the native
// engine runs, when it restarts, and when Cursor's proxy must be restored.
// Every side effect is injected so each transition can be tested with a fake
// engine; bridge.js owns process wiring (lock, log rotation, signals).
export function createSupervisor({
  spawnEngine,
  publish,
  readSettings,
  readConnection,
  fetchCatalogue,
  writeEffective,
  applyProxy,
  restoreProxy,
  pruneDatabase = null,
  onPrune = () => {},
  // Orca rewrites its own data file on exit, so the console stores the intent
  // and this hook keeps the external file in sync. It is optional and
  // independent of the connection state; failures never stop the engine.
  reconcileOrca = null,
  orcaIntervalMs = 30 * 1000,
  onEngineStderr = () => {},
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
  isEnding = () => false,
  initialProxyPort = '',
  platformName = process.platform,
  engineReadyTimeoutMs = 30000,
  engineStopTimeoutMs = 12000,
  // A connection file caught mid-rewrite is not a disconnect: while an engine
  // is running, one unreadable poll must not restore Cursor's proxy.
  connectionGraceMs = 5000,
  loopIntervalMs = 2000,
  retentionIntervalMs = 6 * 60 * 60 * 1000,
  retentionInitialDelayMs = 60 * 1000
} = {}) {
  let child = null;
  let ready = null;
  let running = false;
  let runningMode = '';
  let runningSubagentMode = '';
  // The catalogue mode is decided when the engine starts: `false` keeps the
  // bridge-only catalogue, `true` merges Cursor's own models into it.
  let runningShowOfficialModels = false;
  let activeMode = 'default';
  let lastConfig = '';
  let nextRefresh = 0;
  let paused = false;
  let catalogueDownSince = 0;
  let lastModelCount = 0;
  let lastModelPrefs = '';
  let lastEffective = '';
  let preferredProxyPort = initialProxyPort;
  let nextPruneAt = null;
  let pruning = false;
  let nextOrcaAt = null;
  let orcaTakeover = '';
  let reconcilingOrca = false;
  let connectionInvalidSince = 0;

  // A child that has exited keeps its exitCode/signalCode; a fake process in
  // tests follows the same contract.
  const exited = (proc) => !!proc && (
    (proc.exitCode !== null && proc.exitCode !== undefined)
    || (proc.signalCode !== null && proc.signalCode !== undefined)
  );
  const engineAlive = () => !!(child && running);
  // publish() always carries the configured mode and the engine's running mode,
  // so the control panel can tell "saved but not applied" apart.
  const update = (state, extra = {}) => publish(state, {mode: activeMode, engineMode: runningMode || null, engineOfficialModels: running ? runningShowOfficialModels : null, ...extra});

  async function terminate(proc) {
    if (!proc || exited(proc)) return;
    try {
      const done = new Promise((resolve) => proc.once('exit', resolve));
      proc.kill('SIGTERM');
      await Promise.race([done, wait(engineStopTimeoutMs)]);
      if (!exited(proc)) {
        proc.kill('SIGKILL');
        await new Promise((resolve) => proc.once('exit', resolve));
      }
    } catch { /* the process is already gone */ }
  }

  async function stop() {
    // Restore before stopping the listener so Cursor does not point at a dead port.
    const old = child;
    child = null;
    ready = null;
    running = false;
    runningMode = '';
    runningSubagentMode = '';
    runningShowOfficialModels = false;
    try {
      return await restoreProxy();
    } finally {
      await terminate(old);
    }
  }

  // Replacing a crashed engine (or applying a mode switch) is not a
  // disconnect. Re-applying Cursor's http.proxy makes Cursor rebuild every
  // transport, which kills the conversation in flight; the replacement engine
  // reuses the recorded port, so the existing proxy stays valid throughout.
  async function restartEngine() {
    const old = child;
    child = null;
    ready = null;
    running = false;
    runningMode = '';
    runningSubagentMode = '';
    runningShowOfficialModels = false;
    await terminate(old);
  }

  async function start(connection, mode, subagentMode, showOfficialModels) {
    const serialized = JSON.stringify(connection);
    writeEffective(serialized);
    lastEffective = serialized;
    console.log(`[bridge] starting engine (mode=${mode}, subagent=${subagentMode}, officialModels=${showOfficialModels})`);
    const engine = spawnEngine({mode, subagentMode, showOfficialModels, preferredProxyPort});
    runningMode = mode;
    runningSubagentMode = subagentMode;
    runningShowOfficialModels = showOfficialModels;
    child = engine;
    running = true;
    engine.stderr?.on('data', onEngineStderr);
    engine.once('exit', (code, signal) => {
      if (child === engine) {
        running = false;
        console.error(`[bridge] engine exited unexpectedly (code=${code ?? 'null'}, signal=${signal ?? 'null'})`);
      }
    });
    ready = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('bridge startup timed out')), engineReadyTimeoutMs);
      const finish = (settle, value) => { clearTimeout(timer); settle(value); };
      const lines = createInterface({input: engine.stdout});
      lines.on('line', (line) => {
        try {
          const message = JSON.parse(line);
          if (message.event === 'ready') finish(resolve, message);
        } catch { /* engine diagnostics are not JSON */ }
      });
      engine.once('error', (error) => finish(reject, new Error(`cannot start bridge engine (${error.code || error.message}); this build ships a ${platformName} engine only when its binary matches the platform`)));
      engine.once('exit', (code, signal) => finish(reject, new Error(`bridge engine stopped (${signal || code}); check certificate trust`)));
    });
    try { const url = new URL(ready.proxy); if (url.port) preferredProxyPort = url.port; } catch { /* keep the previous port */ }
    applyProxy(ready.proxy);
    console.log(`[bridge] engine ready pid=${engine.pid} proxy=${ready.proxy}`);
  }

  async function run() {
    try {
      await restoreProxy();
      while (!isEnding()) {
        const config = readSettings();
        activeMode = config.runMode;
        // Retention is independent of the connection state and must never stall
        // the loop: bridge.js runs the prune in a separate runtime process, and
        // the next pass starts only after the previous one settles. Lite mode
        // has no on-disk database, so there is nothing to retain.
        const tracesDays = Number(config.tracesRetentionDays) || 0;
        const sessionsDays = Number(config.sessionsRetentionDays) || 0;
        if (pruneDatabase && !pruning && config.runMode !== 'lite' && (tracesDays > 0 || sessionsDays > 0)) {
          if (nextPruneAt === null) nextPruneAt = now() + retentionInitialDelayMs;
          if (now() >= nextPruneAt) {
            nextPruneAt = now() + retentionIntervalMs;
            pruning = true;
            Promise.resolve()
              .then(() => pruneDatabase({tracesDays, sessionsDays}))
              .then((result) => onPrune(result))
              .catch((error) => {
                // A locked or busy database is worth retrying sooner than the
                // normal interval; the console still records the failure.
                nextPruneAt = now() + 60 * 60 * 1000;
                onPrune({at: new Date().toISOString(), error: String(error?.message || error)});
              })
              .finally(() => { pruning = false; });
          }
        }
        // Orca takeover is independent of the connection state too. A saved
        // change applies on the next pass; otherwise the check is throttled
        // because each pass probes a process and may touch an external file.
        // The retry also covers "Orca was running when the user switched".
        const takeover = config.orcaTakeover === 'off' ? 'off' : 'on';
        if (reconcileOrca && !reconcilingOrca
          && (takeover !== orcaTakeover || nextOrcaAt === null || now() >= nextOrcaAt)) {
          orcaTakeover = takeover;
          nextOrcaAt = now() + orcaIntervalMs;
          reconcilingOrca = true;
          Promise.resolve()
            .then(() => reconcileOrca({takeover}))
            .catch(() => { /* the hook owns logging; never stall the loop */ })
            .finally(() => { reconcilingOrca = false; });
        }
        try {
          const raw = readConnection();
          let connection = null;
          let parseError = null;
          try {
            connection = validate(JSON.parse(raw));
          } catch (error) {
            parseError = error;
          }
          if (!connection) {
            // Magpie rewrites connection.json when the model or catalogue
            // changes. One poll that catches the file mid-write (or between
            // unlink and rename) is not a disconnect: tearing the engine down
            // here restores Cursor's proxy and kills the turn in flight.
            if (!connectionInvalidSince) connectionInvalidSince = now();
            if (engineAlive() && now() - connectionInvalidSince < connectionGraceMs) {
              if (now() - connectionInvalidSince <= loopIntervalMs) {
                console.error(`[bridge] connection file is temporarily unusable (${parseError?.message || 'inactive'}); keeping the running engine`);
              }
              await wait(loopIntervalMs);
              continue;
            }
            connectionInvalidSince = 0;
            if (parseError) throw parseError;
            const wasRunning = engineAlive();
            await stop();
            if (wasRunning) console.log('[bridge] connection inactive; engine stopped');
            update('disconnected');
            paused = false;
            lastConfig = '';
          } else if (paused && raw === lastConfig) {
            update('paused', {reason: 'Cursor 代理设置由其他程序改动；请在 Magpie 中断开后重新连接。'});
          } else {
            connectionInvalidSince = 0;
            const changed = raw !== lastConfig;
            const alive = engineAlive();
            // A saved run mode is applied by restarting the engine once; the
            // supervisor never rewrites effective.json just for a mode switch.
            const modeChanged = alive && runningMode !== config.runMode;
            const subagentModeChanged = alive && runningSubagentMode !== config.subagentMode;
            // The catalogue mode is a startup flag in the native engine, so it
            // shares the restart path with the run modes instead of hot-swapping.
            const officialModelsChanged = alive && runningShowOfficialModels !== Boolean(config.showOfficialModels);
            // Display names and menu order live in bridge-settings.json: a
            // change rewrites effective.json and the engine hot-swaps the
            // catalogue, so neither Cursor nor the running conversation restarts.
            const modelPrefsSignature = JSON.stringify({names: config.modelNames || {}, order: config.modelOrder || []});
            const modelPrefsChanged = modelPrefsSignature !== lastModelPrefs;
            if (changed || now() >= nextRefresh || !alive || modeChanged || subagentModeChanged || officialModelsChanged || modelPrefsChanged) {
              let effective = null;
              let failure = null;
              try {
                effective = await fetchCatalogue(connection, config);
              } catch (error) {
                failure = error;
              }
              nextRefresh = now() + config.refreshSeconds * 1000;
              if (failure) {
                if (!catalogueDownSince) {
                  catalogueDownSince = now();
                  console.error(`[bridge] Magpie catalogue unavailable: ${failure.message}`);
                }
                const downFor = now() - catalogueDownSince;
                if (engineAlive() && ready) {
                  // The running engine still has the last complete catalogue
                  // and keeps serving. Stopping it would restore the proxy and
                  // rebuild every Cursor transport mid-conversation, which is
                  // exactly the "断开" this branch used to cause.
                  update('connected', {
                    model: connection.model,
                    models: lastModelCount,
                    proxy: ready.proxy,
                    backend: ready.backend,
                    pid: child.pid,
                    warning: `Magpie gateway unavailable for ${Math.round(downFor / 1000)}s: ${failure.message}`
                  });
                  await wait(2000);
                  continue;
                }
                // No engine is running, so there is no conversation to
                // protect: fall back to Cursor's own backend once the outage
                // outlasts the configured grace window.
                if (downFor >= config.gatewayGraceSeconds * 1000) throw failure;
                update('error', {reason: `Magpie gateway unavailable for ${Math.round(downFor / 1000)}s: ${failure.message}`});
                await wait(2000);
                continue;
              }
              if (catalogueDownSince) {
                catalogueDownSince = 0;
                console.log('[bridge] Magpie catalogue recovered');
              }
              if (!engineAlive() || modeChanged || subagentModeChanged || officialModelsChanged) {
                if (!engineAlive()) console.log('[bridge] engine is not running; restarting in place');
                else console.log('[bridge] restarting engine for a settings change');
                await restartEngine();
                await start(effective, config.runMode, config.subagentMode, Boolean(config.showOfficialModels));
              } else {
                const serialized = JSON.stringify(effective);
                if (serialized !== lastEffective) {
                  writeEffective(serialized);
                  lastEffective = serialized;
                }
              }
              lastConfig = raw;
              paused = false;
              lastModelCount = effective.models.length;
              lastModelPrefs = modelPrefsSignature;
              update('connected', {
                model: connection.model,
                models: effective.models.length,
                proxy: ready.proxy,
                backend: ready.backend,
                pid: child.pid
              });
            }
            try {
              applyProxy(ready.proxy);
            } catch (error) {
              await stop();
              paused = true;
              lastConfig = raw;
              throw error;
            }
          }
        } catch (error) {
          try { await stop(); } catch { /* keep the journal for recovery after malformed settings are fixed */ }
          console.error(`[bridge] error: ${error.message}`);
          update('error', {reason: error.message});
        }
        if (!isEnding()) await wait(loopIntervalMs);
      }
    } finally {
      await stop();
      console.log('[bridge] supervisor stopped');
      update('stopped');
    }
  }

  return {run, stop};
}
