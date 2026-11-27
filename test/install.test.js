import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {paths,verifyPackage,initializeCertificate,stage,pruneReleases,activate,plistText,systemdUnitText,windowsLauncherScript,installWindowsAutostart,removeWindowsAutostart,windowsRunCommand,windowsAutostartRegistered,writeCursorAuthority,cursorAuthority,trustLinuxNss,writeLinuxTrustMarker,nssNickname} from '../lib/install.js';
import platformModule from '../lib/platform.js';
import {version} from '../version.js';
const source=fileURLToPath(new URL('..',import.meta.url));
const engine=platformModule.enginePathFor(source);
const stagedEngine=path.relative(source,engine);
const runtimeName=platformModule.runtimeNameFor();
const IS_WIN=platformModule.IS_WIN;
const IS_DARWIN=platformModule.IS_DARWIN;
const IS_LINUX=platformModule.IS_LINUX;
const temp=t=>{const p=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-install-test-'));t.after(()=>fs.rmSync(p,{recursive:true,force:true}));return p;};
// pathsFor() resolves the Windows layout from %APPDATA%/%LOCALAPPDATA%, not
// from the home argument, so tests must point those at the temporary home or
// they write into the real installation.
const fakePaths=t=>{
 const home=temp(t);
 const env={};
 for(const key of ['APPDATA','LOCALAPPDATA']) env[key]=process.env[key];
 if(IS_WIN) {
  process.env.APPDATA=path.join(home,'AppData','Roaming');
  process.env.LOCALAPPDATA=path.join(home,'AppData','Local');
 }
 t.after(()=>{for(const key of Object.keys(env)) {if(env[key]===undefined) delete process.env[key];else process.env[key]=env[key];}});
 return paths(home);
};
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const init=root=>spawnSync(engine,['--init-ca'],{encoding:'utf8',env:{...process.env,CURSOR_BYOK_DATA_DIR:root}});
test('fresh machines generate distinct CAs without a BYOK install, database or trust changes',t=>{
 const root=temp(t),one=path.join(root,'one'),two=path.join(root,'two');
 assert.equal(init(one).status,0);assert.equal(init(two).status,0);
 assert.equal(JSON.parse(init(one).stdout).ca,'untrusted');
 assert.notEqual(hash(path.join(one,'ca/ca.key')),hash(path.join(two,'ca/ca.key')));
 if(!IS_WIN) {
  assert.equal(fs.statSync(path.join(one,'ca/ca.key')).mode&0o777,0o600);
  assert.equal(fs.statSync(path.join(one,'ca')).mode&0o777,0o700);
 }
 const before=hash(path.join(one,'ca/ca.key'));assert.equal(init(one).status,0);assert.equal(hash(path.join(one,'ca/ca.key')),before);
 assert.deepEqual(fs.readdirSync(one),['ca']);
 fs.unlinkSync(path.join(one,'ca/ca.crt'));assert.notEqual(init(one).status,0);assert.equal(hash(path.join(one,'ca/ca.key')),before);
});
test('package and native engine have the same pinned version and digest',()=>{
 assert.equal(verifyPackage(source).version,version);
 const integrity=JSON.parse(fs.readFileSync(path.join(source,'integrity.json'),'utf8'));
 assert.equal(integrity.version,version);
 assert.equal(integrity.engineVersion,'0.2.16');
});
test('certificate trust uses SSL policy and argument arrays, and refuses failed authorization',{skip:!IS_DARWIN},t=>{
 const p=fakePaths(t),calls=[];let trusted=false;
 const exec=(cmd,args,options)=>{calls.push({cmd,args,options});if(args[0]==='--init-ca')return {status:0,stdout:'{"ca":"untrusted"}'};if(args[0]==='add-trusted-cert'){trusted=true;return {status:0};}return {status:trusted?0:1};};
 initializeCertificate(engine,p,exec);
 assert.equal(calls.filter(c=>c.args[0]==='add-trusted-cert').length,1);
 assert.deepEqual(calls.at(-1).args.slice(-2),['-p','ssl']);
 calls.length=0;initializeCertificate(engine,p,exec);assert.equal(calls.some(c=>c.args[0]==='add-trusted-cert'),false);
 trusted=false;assert.throws(()=>initializeCertificate(engine,p,exec,{trust:false}),/尚未受信任/);
 assert.throws(()=>initializeCertificate(engine,p,(cmd,args)=>args[0]==='--init-ca'?{stdout:'{}'}:{status:1}),/信任未完成/);
});
test('windows certificate trust elevates once and verifies the machine Root store',{skip:!IS_WIN},t=>{
 const p=fakePaths(t);
 fs.mkdirSync(path.join(p.root,'data/ca'),{recursive:true});
 fs.writeFileSync(path.join(p.root,'data/ca/ca.crt'),`-----BEGIN CERTIFICATE-----\n${Buffer.from('test-certificate-body').toString('base64')}\n-----END CERTIFICATE-----\n`);
 const calls=[];let elevated=false,elevations=0;
 const exec=(cmd,args)=>{
  calls.push({cmd,args});
  if(args[0]==='--init-ca')return {status:0,stdout:'{"ca":"untrusted"}'};
  const script=String(args.at(-1)||'');
  if(script.includes('Start-Process')){elevated=true;elevations+=1;return {status:0,stdout:''};}
  const thumb=(script.match(/eq '([0-9A-F]+)'/)||[])[1]||'';
  return {status:0,stdout:elevated?thumb:''};
 };
 initializeCertificate(engine,p,exec);
 assert.equal(elevations,1,'one UAC elevation');
 const add=calls.find(c=>String(c.args.at(-1)||'').includes("'-addstore'"));
 assert.ok(add,'certutil -addstore runs elevated');
 assert.match(String(add.args.at(-1)),/'-addstore','Root'/);
 initializeCertificate(engine,p,exec);
 assert.equal(elevations,1,'an already trusted CA skips the prompt');
 assert.throws(()=>initializeCertificate(engine,p,exec,{trust:false}),/尚未受信任/);
});
test('windows trust fails clearly when the administrator prompt is declined',{skip:!IS_WIN},t=>{
 const p=fakePaths(t);
 fs.mkdirSync(path.join(p.root,'data/ca'),{recursive:true});
 fs.writeFileSync(path.join(p.root,'data/ca/ca.crt'),`-----BEGIN CERTIFICATE-----\n${Buffer.from('declined-certificate').toString('base64')}\n-----END CERTIFICATE-----\n`);
 const exec=(cmd,args)=>args[0]==='--init-ca'?{status:0,stdout:'{"ca":"untrusted"}'}:{status:1,stdout:'',stderr:'canceled'};
 assert.throws(()=>initializeCertificate(engine,p,exec),/管理员确认/);
});
test('service plist escapes paths and uses an installed runtime, independent of nvm and Magpie cache',t=>{
 const p=fakePaths(t);const xml=plistText(p,'/tmp/A & B/runtime','/tmp/A < B/release');
 assert.match(xml,/A &amp; B/);assert.match(xml,/A &lt; B/);assert.doesNotMatch(xml,/nvm|\.cache/);
});
test('linux service unit quotes paths, restarts on failure and appends logs',{skip:!IS_LINUX},t=>{
 const p=fakePaths(t);
 const unit=systemdUnitText(p,'/tmp/A & B/runtime','/tmp/A < B/release');
 assert.match(unit,/ExecStart="\/tmp\/A & B\/runtime" "\/tmp\/A < B\/release\/bridge\.js" supervise/);
 assert.match(unit,/Restart=on-failure/);
 assert.match(unit,/RestartSec=5/);
 assert.match(unit,/WantedBy=default\.target/);
 assert.match(unit,/Environment="CURSOR_BRIDGE_ROOT=/);
 assert.match(unit,/supervisor\.log/);
 assert.match(unit,/supervisor-error\.log/);
});
test('cursor argv.json keeps user comments while pointing at the bridge CA',t=>{
 const p=fakePaths(t),file=path.join(p.home,'.config/Cursor/argv.json');
 fs.mkdirSync(path.dirname(file),{recursive:true});
 fs.writeFileSync(file,'{\n  // generated by Cursor\n  "locale": "en"\n}\n');
 assert.equal(writeCursorAuthority(file,path.join(p.root,'data/ca/ca.crt')),true);
 assert.equal(writeCursorAuthority(file,path.join(p.root,'data/ca/ca.crt')),false);
 const text=fs.readFileSync(file,'utf8');
 assert.match(text,/generated by Cursor/);
 assert.match(text,/"locale": "en"/);
 assert.equal(cursorAuthority(file),path.join(p.root,'data/ca/ca.crt'));
});
test('linux NSS import creates the store, replaces the nickname and reports failure',t=>{
 const p=fakePaths(t);
 const database=path.join(p.home,'.pki/nssdb');
 const cert=path.join(p.home,'ca.crt');fs.writeFileSync(cert,'CERT');
 const calls=[];
 const exec=(cmd,args)=>{
  calls.push(args);
  const key=args.find(arg=>String(arg).startsWith('sql:'))||'';
  const dir=String(key).replace(/^sql:/,'');
  if(args.includes('-N')) {fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'cert9.db'),'db');return {status:0};}
  return {status:0};
 };
 const result=trustLinuxNss(cert,p.home,exec,{database,certutil:'/usr/bin/certutil'});
 assert.equal(result.imported,true);
 assert.ok(calls.some(args=>args.includes('-D')&&args.includes(nssNickname)));
 assert.ok(calls.some(args=>args.includes('-A')&&args.includes('C,,')));
 assert.equal(trustLinuxNss(cert,p.home,()=>({status:1}),{database,certutil:null}).reason,'no-certutil');
});
test('linux trust marker hashes exactly what the engine re-reads',t=>{
 const p=fakePaths(t);fs.mkdirSync(path.join(p.root,'data/ca'),{recursive:true});
 const cert=path.join(p.root,'data/ca/ca.crt');fs.writeFileSync(cert,'  CERT  \n');
 const file=writeLinuxTrustMarker(cert,p.root);
 assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).sha256,createHash('sha256').update('CERT').digest('hex'));
});
test('linux activation falls back to a detached supervisor when no user manager answers',{skip:!IS_LINUX,timeout:15000},async t=>{
 const p=fakePaths(t);
 const release=path.join(p.target,'releases','test');
 fs.mkdirSync(path.join(release,'bin'),{recursive:true});
 fs.writeFileSync(path.join(release,'bridge.js'),'// bridge');
 fs.writeFileSync(path.join(release,'bin',runtimeName),'fake');
 const exec=(cmd,args)=>({status:args.includes('show-environment')?1:0,stdout:'',stderr:''});
 let launched=0;
 const launch=()=>{launched++;fs.mkdirSync(path.join(p.root,'supervisor.lock'),{recursive:true});fs.writeFileSync(path.join(p.root,'supervisor.lock/pid'),String(process.pid));};
 await activate(p,release,'',exec,launch);
 assert.equal(launched,1);
 const unit=fs.readFileSync(p.systemdUnit,'utf8');
 assert.match(unit,/ExecStart=.*bridge\.js" supervise/);
 assert.match(unit,/WantedBy=default\.target/);
});
test('staging reuses identical releases and never overwrites a running one',t=>{
 const p=fakePaths(t);const fakeRuntime=path.join(p.home,'runtime');fs.writeFileSync(fakeRuntime,'test');
 const one=stage(source,p,version,fakeRuntime),two=stage(source,p,version,fakeRuntime);
 assert.equal(two,one,'identical payloads reuse the staged copy');
 assert.equal(hash(path.join(one,stagedEngine)),hash(engine));
 assert.ok(fs.existsSync(path.join(two,'vendor/jsonc-parser/package.json')));
 if(!IS_WIN) assert.equal(fs.statSync(path.join(two,'bin',runtimeName)).mode&0o777,0o755);
 // A different runtime identity or plugin version must stage a fresh copy.
 fs.writeFileSync(fakeRuntime,'test-v2');
 const changedRuntime=stage(source,p,version,fakeRuntime);
 assert.notEqual(changedRuntime,one);
 const changedVersion=stage(source,p,`${version}-next`,fakeRuntime);
 assert.notEqual(changedVersion,one);
});
test('release pruning keeps only the activated release',t=>{
 const p=fakePaths(t);const dir=path.join(p.target,'releases');
 for(const name of ['old-a','old-b','keep']) fs.mkdirSync(path.join(dir,name),{recursive:true});
 assert.equal(pruneReleases(p,path.join(dir,'keep')),2);
 assert.deepEqual(fs.readdirSync(dir),['keep']);
});
test('windows activation writes a Startup launcher and starts the supervisor once',{skip:!IS_WIN},async t=>{
 const p=fakePaths(t);
 fs.mkdirSync(path.join(p.root,'supervisor.lock'),{recursive:true});
 fs.writeFileSync(path.join(p.root,'supervisor.lock/pid'),'999999');
 const release=path.join(p.target,'releases','test');
 fs.mkdirSync(path.join(release,'bin'),{recursive:true});
 fs.writeFileSync(path.join(release,'bridge.js'),'// bridge');
 fs.writeFileSync(path.join(release,'bin',runtimeName),'fake');
 let launched=0;
 const exec=()=>({status:0});
 const launch=(releaseDir)=>{launched++;fs.mkdirSync(path.join(p.root,'supervisor.lock'),{recursive:true});fs.writeFileSync(path.join(p.root,'supervisor.lock/pid'),String(process.pid));};
 const activation=await activate(p,release,'',exec,launch);
 assert.equal(launched,1);
 assert.equal(activation.autostart.kind,'startup');
 const text=fs.readFileSync(p.autostart,'utf8');
 assert.match(text,/bridge\.js/);
 assert.match(text,/, 0, False/);
 assert.equal(fs.readFileSync(path.join(p.root,'supervisor.lock/pid'),'utf8'),String(process.pid));
});
test('windows autostart falls back to the Run key when the Startup folder is blocked',{skip:!IS_WIN},t=>{
 const p=fakePaths(t);
 const calls=[];
 const exec=(cmd,args)=>{calls.push(args);return {status:0,stdout:'local.magpie.cursor-bridge'};};
 const write=(file,body)=>{
  if(file===p.autostart) throw new Error('blocked by security software');
  fs.mkdirSync(path.dirname(file),{recursive:true});
  fs.writeFileSync(file,body);
 };
 const result=installWindowsAutostart(p,'C:\\releases\\v0','C:\\Program Files\\magpie\\runtime.exe',{exec,write,log:()=>{}});
 assert.equal(result.kind,'run');
 const launcher=path.join(p.root,'supervisor-launch.vbs');
 assert.ok(fs.existsSync(launcher));
 assert.match(fs.readFileSync(launcher,'utf8'),/supervise", 0, False/);
 const add=calls.find((args)=>args[0]==='add');
 assert.ok(add,'the Run value is written');
 assert.equal(add[1],platformModule.windowsRunKey);
 assert.deepEqual(add.slice(2,7),['/v','local.magpie.cursor-bridge','/t','REG_SZ','/d']);
 assert.equal(add[7],windowsRunCommand(launcher));
 assert.equal(windowsAutostartRegistered(p,{exec}),true);
});
test('windows setup keeps starting the service when every autostart mechanism is blocked',{skip:!IS_WIN},t=>{
 const p=fakePaths(t);
 const result=installWindowsAutostart(p,'C:\\releases\\v0','C:\\runtime.exe',{
  exec:()=>({status:1,stdout:''}),
  write:()=>{throw new Error('blocked by security software');},
  log:()=>{}
 });
 assert.equal(result.kind,'none');
 assert.match(result.error,/blocked by security software/);
 assert.equal(windowsAutostartRegistered(p,{exec:()=>({status:1})}),false);
});
test('windows uninstall removes both autostart forms',{skip:!IS_WIN},t=>{
 const p=fakePaths(t);
 fs.mkdirSync(path.dirname(p.autostart),{recursive:true});
 fs.mkdirSync(p.root,{recursive:true});
 fs.writeFileSync(p.autostart,'launcher');
 fs.writeFileSync(path.join(p.root,'supervisor-launch.vbs'),'launcher');
 const calls=[];
 const removed=removeWindowsAutostart(p,{exec:(cmd,args)=>{calls.push(args);return {status:0};}});
 assert.equal(removed.length,2);
 assert.equal(fs.existsSync(p.autostart),false);
 assert.equal(fs.existsSync(path.join(p.root,'supervisor-launch.vbs')),false);
 assert.ok(calls.some((args)=>args[0]==='delete'&&args.includes('/v')));
});
test('windows launcher hides the console window and doubles embedded quotes',()=>{
 const script=windowsLauncherScript('C:\\Users\\u\\releases\\v','C:\\Program Files\\magpie\\runtime.exe');
 assert.match(script,/CreateObject\("WScript\.Shell"\)\.Run/);
 assert.match(script,/""C:\\Program Files\\magpie\\runtime\.exe""/);
 assert.match(script,/supervise", 0, False/);
});
test('failed activation restores previous launch configuration and restarts previous release',{skip:!IS_DARWIN,timeout:15000},async t=>{
 const p=fakePaths(t);fs.mkdirSync(path.dirname(p.plist),{recursive:true});fs.writeFileSync(p.plist,'previous');
 let bootstraps=0;const exec=(cmd,args)=>{if(args[0]==='bootstrap'){bootstraps++;return {status:bootstraps<=5?1:0};}return {status:1};};
 await assert.rejects(activate(p,'/new/release','gui/999',exec),/未能启动/);
 assert.equal(fs.readFileSync(p.plist,'utf8'),'previous');assert.equal(bootstraps,6);
});

test('GitHub installation stages the vendored JSONC parser without npm install',t=>{
 const p=fakePaths(t);const home=p.home,parent=path.join(home,'node_modules'),plugin=path.join(parent,'magpie-agent-cursor-bridge');
 fs.mkdirSync(plugin,{recursive:true});
 for(const name of fs.readdirSync(source)) {
   if(['node_modules','.git'].includes(name)) continue;
   fs.cpSync(path.join(source,name),path.join(plugin,name),{recursive:true});
 }
 assert.equal(verifyPackage(plugin).version,version);
 const runtime=path.join(home,'runtime');fs.writeFileSync(runtime,'test');
 const release=stage(plugin,p,version,runtime);
 assert.ok(fs.existsSync(path.join(release,'vendor/jsonc-parser/lib/umd/main.js')));
 assert.equal(stage(plugin,p,version,runtime),release,'a second setup reuses the release');
 fs.appendFileSync(path.join(plugin,'lib/config.js'),'\n// development change\n');
 assert.notEqual(stage(plugin,p,version,runtime),release,'changed plugin sources stage a fresh release');
});
