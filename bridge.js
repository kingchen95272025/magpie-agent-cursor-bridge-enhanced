#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn,execFileSync} from 'node:child_process';
import {atomic,applyProxy,restoreProxy} from './lib/settings.js';
import {gatewayModels} from './lib/config.js';
import {read as readBridgeSettings,applyModelPreferences} from './lib/bridge-settings.js';
import platform from './lib/platform.js';
import {createSupervisor} from './lib/supervisor.js';
import {pruneDatabase} from './control/database.js';
import {runRetentionWorker} from './lib/retention.js';
import {writeAgentEnv,removeAgentEnv} from './lib/cursor-agent.js';
import {reconcileOrca} from './lib/orca.js';
import {version} from './version.js';

const packageDir=path.dirname(fileURLToPath(import.meta.url));
const root=process.env.CURSOR_BRIDGE_ROOT||platform.current.paths().config;
const settings=process.env.CURSOR_BRIDGE_SETTINGS||platform.current.cursorSettings();
const file=name=>path.join(root,name);
let lastStatus='';
// cursor-agent cannot read Cursor's settings.json, so its injection point is a
// sourced environment file. Keeping it in lockstep with status.json means the
// port is always current and a stopped/error bridge never leaves the CLI
// pointing at a dead proxy.
function syncAgentEnv(extra) {
  const proxy=typeof extra.proxy==='string'&&extra.proxy?extra.proxy:null;
  if(!proxy) { removeAgentEnv(root); return; }
  const caPath=file('data/ca/ca.crt');
  writeAgentEnv(root,{proxy,caPath:fs.existsSync(caPath)?caPath:null});
}
const status=(state,extra={})=>{const signature=JSON.stringify({version,state,...extra});if(signature!==lastStatus){atomic(file('status.json'),JSON.stringify({version,state,...extra,updated:new Date().toISOString()},null,2));lastStatus=signature;syncAgentEnv(extra);}};
// On Windows Magpie's agent sandbox writes connection.json to its own
// fallback path (see connectionFilesFor); accept the first file that exists.
// A rooted install (tests, portable copies) must not fall back to the real
// profile, so its own connection.json is tried first.
const connectionFiles=process.env.CURSOR_BRIDGE_ROOT
  ?[file('connection.json'),...platform.current.connectionFiles()]
  :platform.current.connectionFiles();
function connectionText() {
  for(const candidate of connectionFiles) {
    try {return fs.readFileSync(candidate,'utf8');} catch { /* try the next candidate */ }
  }
  return '{}';
}
const wait=ms=>new Promise(r=>setTimeout(r,ms));
// On Windows both launch paths (Startup VBS and the detached spawn from setup)
// discard stdio, so the supervisor.log / supervisor-error.log the console reads
// would stay empty exactly when a user needs them. Mirror console output into
// those files there; launchd and systemd already capture stdout/stderr.
function mirrorConsoleToFiles() {
  const limit=4*1024*1024;
  const open=(name)=>{
    const target=file(name);
    try {
      try {if(fs.statSync(target).size>limit) fs.renameSync(target,`${target}.1`);} catch { /* first run */ }
      const fd=fs.openSync(target,'a',0o600);
      return (text)=>{try {fs.writeSync(fd,text);} catch { /* logging must never take the supervisor down */ }};
    } catch { return ()=>{}; }
  };
  const out=open('supervisor.log');
  const err=open('supervisor-error.log');
  const format=(values)=>values.map((value)=>typeof value==='string'?value:(value instanceof Error?value.stack:String(value))).join(' ');
  for(const method of ['log','info','debug']) {
    const original=console[method].bind(console);
    console[method]=(...values)=>{out(`${new Date().toISOString()} ${format(values)}\n`);original(...values);};
  }
  for(const method of ['warn','error']) {
    const original=console[method].bind(console);
    console[method]=(...values)=>{err(`${new Date().toISOString()} ${format(values)}\n`);original(...values);};
  }
}
// The Orca reconcile runs every 30 seconds and usually has nothing to do.
// Log only when its outcome changes, so a pending retry while Orca stays open
// does not fill supervisor.log.
let lastOrcaLog='';
function applyOrcaTakeover(takeover) {
  let result;
  const home=process.env.CURSOR_BRIDGE_HOME||os.homedir();
  try { result=reconcileOrca({root,home,takeover}); }
  catch(error) { result={ok:false,reason:'error',error:String(error?.message||error)}; }
  const signature=JSON.stringify({takeover,ok:result.ok,changed:!!result.changed,pending:result.pending||'',reason:result.reason||''});
  if(signature===lastOrcaLog) return;
  lastOrcaLog=signature;
  if(result.reason==='missing') return;
  if(result.reason==='wrapper-missing') { console.error('orca cursor override skipped: cursor-agent wrapper is not installed'); return; }
  if(result.reason==='foreign-override') { console.error('orca cursor override skipped: a custom cursor command is configured'); return; }
  if(result.reason==='error') { console.error(`orca cursor override failed: ${result.error}`); return; }
  if(result.pending==='running') { console.log(`orca cursor override ${takeover==='on'?'install':'removal'} deferred until Orca exits`); return; }
  if(result.changed) console.log(`orca cursor override ${takeover==='on'?'installed':'removed'}: ${result.path}`);
}
// Native diagnostics stay local: 0600 file next to the other bridge state,
// rotated at the size the control panel configured (default 4 MiB). Writes go
// through a descriptor so rotation happens while the supervisor runs; a stream
// created once would let engine.log grow without bound until the next restart.
let engineLogFd=null;
let engineLogSize=0;
let engineLogLimit=0;
function openEngineLog() {
  if(engineLogFd!==null) return engineLogFd;
  const log=file('engine.log');
  if(!engineLogLimit) engineLogLimit=readBridgeSettings(root).logLimitMB*1024*1024;
  try {engineLogSize=fs.statSync(log).size;} catch {engineLogSize=0;}
  if(engineLogSize>engineLogLimit) {
    try {fs.renameSync(log,file('engine.log.1'));} catch {}
    engineLogSize=0;
  }
  engineLogFd=fs.openSync(log,'a',0o600);
  return engineLogFd;
}
function appendEngineLog(chunk) {
  try {
    const fd=openEngineLog();
    fs.writeSync(fd,chunk);
    engineLogSize+=chunk.length;
    if(engineLogSize>engineLogLimit) {
      try {fs.closeSync(fd);} catch {}
      engineLogFd=null;
      try {fs.renameSync(file('engine.log'),file('engine.log.1'));} catch {}
      engineLogSize=0;
    }
  } catch { /* logging must never take the supervisor down */ }
}
// A reused pid must not look like a live supervisor: match the command line too.
function isLiveSupervisor(pid) {
  if(!Number.isInteger(pid)||pid<=0||pid===process.pid) return false;
  try {process.kill(pid,0);} catch {return false;}
  try {
    const probe=platform.current.processCommand(pid);
    if(!probe) return false;
    const line=execFileSync(probe.command,probe.args,{encoding:'utf8',stdio:['ignore','pipe','ignore'],windowsHide:true}).trim();
    return line.includes('bridge.js')&&line.includes('supervise');
  } catch {return false;}
}
const command=process.argv[2]||'status';
if(command==='status') {
  console.log(fs.existsSync(file('status.json'))?fs.readFileSync(file('status.json'),'utf8'):'未安装或尚未运行');
} else if(command==='restore') {
  console.log(JSON.stringify({preservedExternalChanges:restoreProxy(file('settings-journal.json'))}));
} else if(command==='retain') {
  // Internal: the supervisor runs automatic retention here, in a separate
  // runtime process, so a synchronous prune can never block its event loop.
  const target=process.argv[3]||root;
  const tracesDays=Number(process.argv[4])||0;
  const sessionsDays=Number(process.argv[5])||0;
  const result=await pruneDatabase(path.join(target,'data/bridge.db'),{tracesDays,sessionsDays,check:false});
  process.stdout.write(JSON.stringify(result));
} else if(command==='supervise') {
  fs.mkdirSync(root,{recursive:true,mode:0o700});
  if(!platform.IS_WIN) process.umask(0o077);
  if(platform.IS_WIN) mirrorConsoleToFiles();
  const lock=file('supervisor.lock');
  try {fs.mkdirSync(lock);} catch(error) {
    let live=false;
    try {live=isLiveSupervisor(Number(fs.readFileSync(path.join(lock,'pid'),'utf8')));} catch {}
    if(live) throw new Error('bridge supervisor already running');
    fs.rmSync(lock,{recursive:true,force:true}); fs.mkdirSync(lock);
  }
  fs.writeFileSync(path.join(lock,'pid'),String(process.pid));
  let ending=false;
  // Lite mode starts from an empty in-memory database, so the proxy port cannot
  // be read back from SQLite. Carry the last port across restarts: Cursor does
  // not re-read http.proxy until it restarts.
  let preferredProxyPort='';
  try {const last=JSON.parse(fs.readFileSync(file('status.json'),'utf8'));const url=new URL(last.proxy);if(url.port) preferredProxyPort=url.port;} catch {}
  const supervisor=createSupervisor({
    initialProxyPort:preferredProxyPort,
    readSettings:()=>readBridgeSettings(root),
    readConnection:connectionText,
    // gatewayModels returns the whole connection object; only its models array
    // takes the display-name and order overrides.
    fetchCatalogue:async(connection,config)=>{
      const catalogue=await gatewayModels(connection);
      return {...catalogue,models:applyModelPreferences(catalogue.models,{modelNames:config.modelNames,modelOrder:config.modelOrder,modelHidden:config.modelHidden,keep:connection.model})};
    },
    writeEffective:text=>atomic(file('effective.json'),text),
    // status.json always advertises the configured mode, so the control panel
    // can tell "saved but not yet applied" apart from the running engine's mode.
    publish:(state,extra)=>status(state,extra),
    applyProxy:proxy=>applyProxy(settings,file('settings-journal.json'),proxy),
    restoreProxy:()=>restoreProxy(file('settings-journal.json')),
    // Automatic retention runs online: it batches deletes and never stops the
    // engine or vacuums. It runs in a worker process because Bun's SQLite is
    // synchronous and blocking this loop also stops draining the engine's log
    // pipe. The result is kept for the console.
    pruneDatabase:({tracesDays,sessionsDays})=>runRetentionWorker({
      runtime:process.execPath,
      bridge:path.join(packageDir,'bridge.js'),
      root,
      tracesDays,
      sessionsDays
    }),
    onPrune:result=>atomic(file('retention.json'),JSON.stringify(result,null,2)),
    reconcileOrca:({takeover})=>applyOrcaTakeover(takeover),
    spawnEngine:({mode,subagentMode,showOfficialModels,preferredProxyPort:port})=>spawn(platform.enginePathFor(packageDir),[file('effective.json')],{
      env:{...process.env,CURSOR_BYOK_DATA_DIR:file('data'),CURSOR_BRIDGE_RUN_MODE:mode,CURSOR_BRIDGE_SUBAGENT_MODE:subagentMode,CURSOR_BRIDGE_OFFICIAL_MODELS:showOfficialModels?'1':'0',...(port?{CURSOR_BRIDGE_PROXY_PORT:port}:{})},stdio:['pipe','pipe','pipe'],windowsHide:true
    }),
    // Native diagnostics can contain request information; keep them in a private local file.
    onEngineStderr:appendEngineLog,
    wait,
    isEnding:()=>ending
  });
  for(const signal of ['SIGTERM','SIGINT']) process.on(signal,()=>{ending=true;});
  try {
    await supervisor.run();
  } finally {
    fs.rmSync(lock,{recursive:true,force:true});
  }
} else {throw new Error('usage: node bridge.js status|supervise|restore|retain');}
