// Windows release smoke test. All logs, settings and WebView state are isolated.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync, backup } from 'node:sqlite';
import { chromium, expect } from '@playwright/test';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:net';

const exe=resolve(process.argv[2] ?? 'outputs/v0.3.12-final/CodexUsageAnalytics.exe');
const pe=readFileSync(exe), optional=pe.readUInt32LE(0x3c)+24;
if (pe.readUInt16LE(optional+68)!==2) throw new Error('Executable must use the Windows GUI subsystem');
const root=mkdtempSync(join(tmpdir(),'codex-usage-native-0314-'));
mkdirSync(join(root,'codex','sessions'),{recursive:true});
const stamp=new Date().toISOString();
const log=[{type:'session_meta',timestamp:stamp,payload:{id:'native-smoke',timestamp:stamp,cwd:'C:/PRIVATE/test-project'}},
  {type:'turn_context',timestamp:stamp,payload:{model:'gpt-5.6-sol',effort:'high'}},
  {type:'event_msg',timestamp:stamp,payload:{type:'token_count',info:{total_token_usage:{input_tokens:1000,cached_input_tokens:800,output_tokens:100,total_tokens:1100},last_token_usage:{input_tokens:1000,cached_input_tokens:800,output_tokens:100,total_tokens:1100}}}}];
writeFileSync(join(root,'codex','sessions','sample.jsonl'),log.map(v=>JSON.stringify(v)).join('\n')+'\n');
const path=join(root,'usage.sqlite3');
if(process.argv[3]) {
  const original=new DatabaseSync(resolve(process.argv[3]),{readOnly:true});
  await backup(original,path);original.close();
}
const db=new DatabaseSync(path);
const originalTurns=process.argv[3]?db.prepare('select count(*) n from turns').get().n:0;
db.exec('create table if not exists settings(key text primary key,value text not null)');
db.prepare('insert into settings values(?,?) on conflict(key) do update set value=excluded.value').run('app',JSON.stringify({codexHome:join(root,'codex'),sshTarget:'',sshEnabled:false,sshSources:[],cloudEnabled:false,pollMinutes:15}));
db.close();
const socket=createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
const softwareRendering=process.env.CODEX_USAGE_SMOKE_SOFTWARE==='1';
const child=spawn(exe,[],{windowsHide:true,stdio:'ignore',env:{...process.env,CODEX_USAGE_DB_PATH:path,CODEX_HOME:join(root,'codex'),WEBVIEW2_USER_DATA_FOLDER:join(root,'webview'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port} --enable-logging --log-file="${join(root,'webview-debug.log')}"${softwareRendering?' --disable-gpu':''}`}});
console.log(JSON.stringify({testDirectory:root,processId:child.pid,debugPort:port}));
let browser;
try {
  const deadline=Date.now()+60_000;
  let connectionError;
  while(Date.now()<deadline) {
    if(child.exitCode!==null) throw new Error(`Native app exited: ${child.exitCode}`);
    if(await fetch(`http://127.0.0.1:${port}/json/version`,{signal:AbortSignal.timeout(1000)}).then(r=>r.ok).catch(()=>false)) {
      try { browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`,{timeout:2000}); break; }
      catch(error) { connectionError=error; }
    }
    await delay(500);
  }
  if(!browser) throw new Error(`Native WebView test connection did not become ready. Diagnostics: ${root}. ${connectionError??''}`);
  const page=browser.contexts()[0].pages()[0];const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await expect(page.getByRole('heading',{name:'用量總覽'})).toBeVisible({timeout:30_000});
  await expect(page.getByRole('button',{name:'重新掃描',exact:true})).toBeEnabled({timeout:30_000});
  const isMaximized = () => page.evaluate(() => window.__TAURI_INTERNALS__.invoke('plugin:window|is_maximized', {label:'main'}));
  const initiallyMaximized = await isMaximized();
  await page.getByRole('button',{name:'最大化或還原視窗'}).click();
  await expect.poll(isMaximized).toBe(!initiallyMaximized);
  await page.getByRole('button',{name:'最大化或還原視窗'}).click();
  await expect.poll(isMaximized).toBe(initiallyMaximized);
  const collapse = page.getByRole('button', {name:/^(收合|展開)側欄$/});
  const expanded = await collapse.getAttribute('aria-expanded');
  await collapse.click();
  await expect(page.getByRole('button', {name:/^(收合|展開)側欄$/})).toHaveAttribute('aria-expanded', expanded === 'true' ? 'false' : 'true');
  await page.getByRole('button', {name:/^(收合|展開)側欄$/}).click();
  await page.getByLabel('日期範圍').selectOption('30');
  await page.screenshot({path:join(root,'native-dashboard.png')});
  const native=await page.evaluate(async()=>window.__TAURI_INTERNALS__.invoke('get_overview',{filter:{days:365,project:'test-project'}}));
  if(native.totals.totalTokens!==1100 || native.todayTokens!==1100 || native.sessions.length!==1) throw new Error('Native scan totals are incorrect');
  await page.getByRole('button',{name:'重新掃描',exact:true}).click();
  await expect(page.getByRole('button',{name:'重新掃描',exact:true})).toBeEnabled({timeout:30_000});
  await page.getByRole('button',{name:'選擇日期區間',exact:true}).click();
  await page.getByLabel('開始日期').fill('2025-01-01');await page.getByLabel('結束日期').fill('2025-01-01');await page.getByRole('button',{name:'套用',exact:true}).click();
  await expect(page.getByText('區間 Tokens',{exact:true})).toBeVisible();
  const historical=await page.evaluate(async()=>window.__TAURI_INTERNALS__.invoke('get_overview',{filter:{days:1,startDate:'2025-01-01',endDate:'2025-01-01',project:'test-project'}}));
  if(historical.totals.totalTokens!==0 || historical.todayTokens!==1100) throw new Error('Historical filter changed today usage');
  await page.screenshot({path:join(root,'native-overview.png')});
  await page.getByLabel('日期範圍').selectOption('365');
  await page.getByRole('link',{name:'設定',exact:true}).click();
  await page.getByLabel('gpt-5.6-sol input 價格').fill('8');
  await page.getByLabel('gpt-5.6-sol cache writes 價格').fill('0');
  await page.getByRole('button',{name:'保存設定'}).click();
  await expect(page.getByText('設定已保存，既有費用已重新計算',{exact:true})).toBeVisible({timeout:30_000});
  await page.getByRole('link',{name:'總覽',exact:true}).click();
  const repriced=await page.evaluate(async()=>window.__TAURI_INTERNALS__.invoke('get_overview',{filter:{days:365,project:'test-project'}}));
  if(repriced.totals.totalTokens!==1100 || repriced.estimateMicrousd!==3920) throw new Error('Repricing or scan idempotence failed');
  const settings=await page.evaluate(async()=>window.__TAURI_INTERNALS__.invoke('get_settings'));
  if(settings.pricingRules[0].cacheWriteUsdPerMillion!==0) throw new Error('Zero cache-write price did not persist');
  await page.getByRole('link',{name:'Sessions',exact:true}).click();
  await page.getByRole('link',{name:'test-project',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Session 明細'})).toBeVisible();
  await expect(page.getByText('1,100',{exact:true}).first()).toBeVisible();
  await page.screenshot({path:join(root,'native-detail.png')});
  if(errors.length) throw new Error(errors.join('\n'));
  const checked=new DatabaseSync(path,{readOnly:true});
  const mismatch=checked.prepare('select count(*) n from sessions s where total_tokens != coalesce((select sum(total_tokens) from turns t where t.source_id=s.source_id and t.session_id=s.session_id),0)').get().n;
  const currentTurns=checked.prepare('select count(*) n from turns').get().n;
  checked.close();
  if(mismatch || currentTurns<originalTurns+1) throw new Error('Migration lost history or left inconsistent totals');
  const result={passed:true,softwareRendering,url:page.url(),viewport:await page.evaluate(()=>({width:innerWidth,height:innerHeight})),totalTokens:native.totals.totalTokens,todayTokens:historical.todayTokens,estimateMicrousd:repriced.estimateMicrousd,originalTurns,currentTurns,mismatchedSessions:mismatch,errors,screenshots:[join(root,'native-dashboard.png'),join(root,'native-overview.png'),join(root,'native-detail.png')],database:path};
  await page.getByRole('button',{name:'最小化視窗'}).click();
  await expect.poll(() => page.evaluate(() => window.__TAURI_INTERNALS__.invoke('plugin:window|is_minimized', {label:'main'}))).toBe(true);
  await page.getByRole('button',{name:'關閉視窗'}).evaluate(button=>button.click());
  await Promise.race([new Promise(r=>child.once('exit',r)),delay(5000)]);
  if(child.exitCode===null) throw new Error('Native close button did not exit the app');
  console.log(JSON.stringify({...result,windowControls:'maximize, restore, minimize, close passed'}));
} finally {
  await browser?.close().catch(()=>{});
  if(child.exitCode===null)child.kill();
}
