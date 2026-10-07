// Windows release smoke test. All logs, settings and WebView state are isolated.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync, backup } from 'node:sqlite';
import { chromium, expect } from '@playwright/test';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:net';

const projectRoot=resolve(import.meta.dirname,'..');
const {version}=JSON.parse(readFileSync(join(projectRoot,'package.json'),'utf8'));
const exe=resolve(process.argv[2] ?? join(projectRoot,'outputs',`v${version}`,'CodexUsageAnalytics.exe'));
const pe=readFileSync(exe), optional=pe.readUInt32LE(0x3c)+24;
if (pe.readUInt16LE(optional+68)!==2) throw new Error('Executable must use the Windows GUI subsystem');
const root=mkdtempSync(join(tmpdir(),'codex-usage-native-'));
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
const launch=()=>spawn(exe,[],{windowsHide:true,stdio:'ignore',env:{...process.env,CODEX_USAGE_DB_PATH:path,CODEX_HOME:join(root,'codex'),WEBVIEW2_USER_DATA_FOLDER:join(root,'webview'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port} --enable-logging --log-file="${join(root,'webview-debug.log')}"${softwareRendering?' --disable-gpu':''}`}});
let child=launch();
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
  let page=browser.contexts()[0].pages()[0];const errors=[];page.on('pageerror',e=>errors.push(e.message));
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
  const dailyDate=native.daily[0].date;
  const modelPanel=page.getByRole('region',{name:'模型用量排行'});
  await modelPanel.getByLabel('模型分布日期').selectOption(dailyDate);
  const dailyOverview=await page.evaluate(date=>window.__TAURI_INTERNALS__.invoke('get_overview',{filter:{days:30,startDate:date,endDate:date}}),dailyDate);
  await expect(modelPanel.getByText(`${dailyOverview.totals.totalTokens.toLocaleString('en-US')} Tokens`,{exact:true}).first()).toBeVisible();
  await expect(page.getByLabel('日期範圍')).toHaveValue('30');
  await page.screenshot({path:join(root,'native-daily-models.png')});
  await modelPanel.getByRole('button',{name:'返回整個區間'}).click();
  await expect(modelPanel.getByLabel('模型分布日期')).toHaveValue('');
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
  await page.getByRole('button',{name:'編輯 gpt-5.6-sol 價格',exact:true}).click();
  await page.getByLabel('gpt-5.6-sol input 價格').fill('8');
  await page.getByLabel('gpt-5.6-sol cached input 價格').fill('0.4');
  await page.getByLabel('gpt-5.6-sol cache writes 價格').fill('0');
  await page.getByLabel('gpt-5.6-sol output 價格').fill('20');
  await page.getByRole('button',{name:'保存價格'}).click();
  await expect(page.getByText('gpt-5.6-sol 的價格已保存。',{exact:true})).toBeVisible({timeout:30_000});
  await page.getByRole('link',{name:'總覽',exact:true}).click();
  const repriced=await page.evaluate(async()=>window.__TAURI_INTERNALS__.invoke('get_overview',{filter:{days:365,project:'test-project'}}));
  if(repriced.totals.totalTokens!==1100 || repriced.estimateMicrousd!==3920) throw new Error('Repricing or scan idempotence failed');
  const settings=await page.evaluate(async()=>window.__TAURI_INTERNALS__.invoke('get_settings'));
  if(settings.pricingRules.find(rule=>rule.model==='gpt-5.6-sol').cacheWriteUsdPerMillion!==0) throw new Error('Zero cache-write price did not persist');
  await page.getByRole('link',{name:'設定',exact:true}).click();
  await page.getByRole('button',{name:'編輯 gpt-5.6-sol 價格',exact:true}).click();
  await expect(page.getByLabel('gpt-5.6-sol 啟用長 context 加價')).toBeChecked();
  await page.getByLabel('gpt-5.6-sol 長 context 門檻',{exact:true}).fill('500');
  await page.getByLabel('gpt-5.6-sol 長 context 輸入倍率',{exact:true}).fill('2');
  await page.getByLabel('gpt-5.6-sol 長 context 輸出倍率',{exact:true}).fill('1.5');
  await page.getByRole('button',{name:'保存價格',exact:true}).click();
  await expect(page.getByText('gpt-5.6-sol 的價格已保存。',{exact:true})).toBeVisible();
  const longEstimate=await page.evaluate(async()=>window.__TAURI_INTERNALS__.invoke('get_overview',{filter:{days:365,project:'test-project'}}));
  if(longEstimate.estimateMicrousd!==6840) throw new Error('Long-context settings did not reprice the full request including cached tokens');
  await page.getByRole('button',{name:'編輯 gpt-5.6-sol 價格',exact:true}).click();
  await page.getByLabel('gpt-5.6-sol 長 context 門檻',{exact:true}).fill('272000');
  await page.getByRole('button',{name:'保存價格',exact:true}).click();
  await expect(page.getByText('gpt-5.6-sol 的價格已保存。',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'更新官方價格',exact:true}).click();
  await expect(page.getByText('官方價格已更新，自訂價格已保留。',{exact:true})).toBeVisible({timeout:40_000});
  await page.getByRole('button',{name:'編輯 gpt-5.6-sol 價格',exact:true}).click();
  await expect(page.getByLabel('gpt-5.6-sol input 價格')).toHaveValue('8');
  await page.getByRole('button',{name:'取消',exact:true}).click();
  await page.getByLabel('搜尋模型價格').fill('gpt-6-astra');
  await page.getByRole('button',{name:'編輯 gpt-6-astra 價格',exact:true}).click();
  const official=await page.evaluate(async()=>window.__TAURI_INTERNALS__.invoke('get_pricing_status'));
  if(!official.updatedAt || official.lastError) throw new Error('Live official pricing did not update');
  const latestSol=official.officialRules.find(rule=>rule.model==='gpt-6.1-sol');
  if(!latestSol || latestSol.longContextThreshold!==272000 || latestSol.longInputMultiplier!==2 || latestSol.longOutputMultiplier!==1.5) throw new Error('Current official long-context rule was not imported');
  await expect(page.getByLabel('gpt-6-astra input 價格')).toHaveValue(String(official.officialRules.find(rule=>rule.model==='gpt-6-astra').inputUsdPerMillion));
  await page.screenshot({path:join(root,'native-official-pricing.png')});
  await page.getByRole('button',{name:'取消',exact:true}).click();
  await page.getByLabel('搜尋模型價格').fill('');
  await expect(page.locator('.pricing-table tbody tr')).toHaveCount(official.officialRules.length+1);
  const names=await page.locator('.pricing-model-name').allTextContents();
  if(JSON.stringify(names)!==JSON.stringify([...names].sort((a,b)=>a.localeCompare(b,'en',{numeric:true,sensitivity:'base'})))) throw new Error('Native model name sorting failed');
  await page.getByRole('link',{name:'模型價格',exact:true}).click();
  await page.screenshot({path:join(root,'native-pricing-list.png')});
  await page.getByRole('button',{name:'模型名稱排序',exact:true}).click();
  await expect(page.locator('.pricing-model-name').first()).toHaveText(names.at(-1));
  const priceSortChecks=[];
  for(const [label,column] of [['輸入價格排序',1],['快取輸入價格排序',2],['輸出價格排序',3]]) {
    const button=page.getByRole('button',{name:label,exact:true});
    for(const direction of ['ascending','descending']) {
      await button.click();
      await expect(button.locator('..')).toHaveAttribute('aria-sort',direction);
      const rows=await page.locator('.pricing-table tbody tr').evaluateAll((elements,column)=>elements.map(row=>{
        const text=row.children[column].textContent.trim();
        return {model:row.querySelector('.pricing-model-name').textContent,value:text==='—'?null:Number(text.replaceAll(',',''))};
      }),column);
      let missing=false;
      for(let i=0;i<rows.length;i++) {
        if(rows[i].value===null) {missing=true;continue;}
        if(missing) throw new Error(`${label} placed a missing price before a priced model`);
        if(i>0) {
          const difference=rows[i].value-rows[i-1].value;
          if(direction==='ascending'?difference<0:difference>0) throw new Error(`${label} did not sort prices ${direction}`);
          if(difference===0 && rows[i-1].model.localeCompare(rows[i].model,'en',{numeric:true,sensitivity:'base'})>0) throw new Error(`${label} did not sort equal prices by model name`);
        }
      }
      priceSortChecks.push({label,direction,models:rows.length});
    }
  }
  await page.screenshot({path:join(root,'native-price-sorting.png')});
  await page.getByRole('link',{name:'Sessions',exact:true}).click();
  await page.getByRole('link',{name:'test-project',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Session 明細'})).toBeVisible();
  await expect(page.getByText('整段對話 Tokens',{exact:true})).toBeVisible();
  await expect(page.getByText('1,100',{exact:true}).first()).toBeVisible();
  await page.screenshot({path:join(root,'native-detail.png')});
  if(errors.length) throw new Error(errors.join('\n'));
  const checked=new DatabaseSync(path,{readOnly:true});
  const mismatch=checked.prepare('select count(*) n from sessions s where total_tokens != coalesce((select sum(total_tokens) from turns t where t.source_id=s.source_id and t.session_id=s.session_id),0)').get().n;
  const currentTurns=checked.prepare('select count(*) n from turns').get().n;
  checked.close();
  if(mismatch || currentTurns<originalTurns+1) throw new Error('Migration lost history or left inconsistent totals');
  const result={passed:true,softwareRendering,url:page.url(),viewport:await page.evaluate(()=>({width:innerWidth,height:innerHeight})),totalTokens:native.totals.totalTokens,todayTokens:historical.todayTokens,estimateMicrousd:repriced.estimateMicrousd,originalTurns,currentTurns,mismatchedSessions:mismatch,officialModels:official.officialRules.length,priceSortChecks,errors,screenshots:[join(root,'native-dashboard.png'),join(root,'native-overview.png'),join(root,'native-detail.png'),join(root,'native-official-pricing.png'),join(root,'native-pricing-list.png'),join(root,'native-price-sorting.png')],database:path};
  const closeNative=async()=>{
    const exited=new Promise(resolve=>child.once('exit',resolve));
    await page.getByRole('button',{name:'關閉視窗'}).evaluate(button=>button.click());
    await Promise.race([exited,delay(5000)]);
    if(child.exitCode===null) throw new Error('Native close button did not exit the app');
    await browser.close().catch(()=>{});
  };
  const reopenNative=async()=>{
    child=launch();
    browser=undefined;
    const deadline=Date.now()+60_000;
    while(Date.now()<deadline){
      if(child.exitCode!==null) throw new Error(`Relaunch exited: ${child.exitCode}`);
      try { browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`,{timeout:1000});break; } catch { await delay(500); }
    }
    if(!browser) throw new Error('Relaunch did not expose WebView');
    page=browser.contexts()[0].pages()[0];page.on('pageerror',e=>errors.push(e.message));
    await expect(page.getByRole('heading',{name:'用量總覽'})).toBeVisible({timeout:30_000});
  };
  await page.getByRole('link',{name:'總覽',exact:true}).click();
  await page.getByLabel('日期範圍').selectOption('7');
  if(await page.getByRole('button',{name:'收合側欄'}).count()) await page.getByRole('button',{name:'收合側欄'}).click();
  if(await isMaximized()) await page.getByRole('button',{name:'最大化或還原視窗'}).click();
  const resizeScript=join(root,'resize.ps1');
  const scale=await page.evaluate(()=>devicePixelRatio);
  const requestedSize={width:Math.round(1200*scale),height:Math.round(820*scale)};
  writeFileSync(resizeScript,`param([int]$AppProcessId)
Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class NativeResize{[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr window,IntPtr after,int x,int y,int width,int height,uint flags);}'
$window=(Get-Process -Id $AppProcessId).MainWindowHandle
if($window -eq 0 -or -not [NativeResize]::SetWindowPos($window,[IntPtr]::Zero,80,80,${requestedSize.width},${requestedSize.height},4)){throw 'Could not resize native window'}
`);
  await promisify(execFile)('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',resizeScript,'-AppProcessId',String(child.pid)],{windowsHide:true});
  const innerSize=()=>page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('plugin:window|inner_size',{label:'main'}));
  // Win32 resizes the outer rectangle; Tauri persists the client area, excluding
  // the invisible Windows resize border. Compare that exact client size on reopen.
  await expect.poll(async()=>{const size=await innerSize();return Math.abs(size.width-requestedSize.width)<64 && Math.abs(size.height-requestedSize.height)<64;}).toBe(true);
  const savedSize=await innerSize();
  await page.getByRole('button',{name:'最大化或還原視窗'}).click();
  await expect.poll(isMaximized).toBe(true);
  await closeNative();
  await reopenNative();
  await expect.poll(isMaximized).toBe(true);
  await expect(page.getByLabel('日期範圍')).toHaveValue('7');
  await expect(page.getByRole('button',{name:'展開側欄'})).toBeVisible();
  await page.getByRole('button',{name:'最大化或還原視窗'}).click();
  await expect.poll(innerSize).toEqual(savedSize);
  await page.getByRole('button',{name:'選擇日期區間'}).click();
  await page.getByLabel('開始日期').fill('2026-09-01');
  await page.getByLabel('結束日期').fill('2026-09-03');
  await page.getByRole('button',{name:'套用',exact:true}).click();
  await page.getByRole('button',{name:'最小化視窗'}).click();
  await expect.poll(() => page.evaluate(() => window.__TAURI_INTERNALS__.invoke('plugin:window|is_minimized', {label:'main'}))).toBe(true);
  await closeNative();
  await reopenNative();
  await expect.poll(innerSize).toEqual(savedSize);
  await expect.poll(isMaximized).toBe(false);
  await expect(page.getByLabel('日期範圍')).toHaveValue('custom');
  await page.getByRole('button',{name:'選擇日期區間'}).click();
  await expect(page.getByLabel('開始日期')).toHaveValue('2026-09-01');
  await expect(page.getByLabel('結束日期')).toHaveValue('2026-09-03');
  await page.getByRole('button',{name:'取消',exact:true}).click();
  await page.screenshot({path:join(root,'native-restored.png')});
  // A resumed file may contain only new requests; retain its already saved prefix.
  const suffix=[log[0],log[1],
    {type:'event_msg',payload:{type:'thread_settings_applied',thread_settings:{model:'gpt-6-astra',service_tier:'priority'}}},
    {type:'event_msg',timestamp:new Date(Date.parse(stamp)+1000).toISOString(),payload:{type:'token_count',info:{last_token_usage:{input_tokens:1_900_000,cached_input_tokens:1_800_000,output_tokens:100_000,total_tokens:2_000_000}}}},
    {type:'event_msg',payload:{type:'thread_settings_applied',thread_settings:{model:'codex-auto-review'}}},
    {type:'event_msg',timestamp:new Date(Date.parse(stamp)+2000).toISOString(),payload:{type:'token_count',info:{last_token_usage:{total_tokens:350}}}}
  ];
  writeFileSync(join(root,'codex','sessions','sample.jsonl'),suffix.map(value=>JSON.stringify(value)).join('\n')+'\n');
  const scan=()=>page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('scan_sources',{forceFull:true}));
  for(let pass=0;pass<2;pass++) {
    const scanned=await scan();
    if(scanned.sources.find(source=>source.id==='local').stale) throw new Error('Resumed suffix did not import successfully');
    const session=await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('get_session_detail',{sourceId:'local',sessionId:'native-smoke'}));
    if(session.tokens.totalTokens!==2_001_450 || session.tokenEventCount!==3) throw new Error('Resumed scan lost or duplicated usage');
    if(session.turns.map(turn=>turn.model).join(',')!=='gpt-5.6-sol,gpt-6-astra,codex-auto-review') throw new Error('Native model switch was not attributed correctly');
    if(session.turns[2].estimateMicrousd!==0 || session.unpricedTurnCount!==0) throw new Error('Native review usage was billed or marked unpriced');
  }
  await page.getByRole('button',{name:'展開側欄'}).click();
  await page.getByRole('link',{name:'總覽',exact:true}).click();
  await page.getByLabel('日期範圍').selectOption('1');
  await page.getByRole('button',{name:'重新掃描',exact:true}).click();
  await expect(page.getByRole('button',{name:'重新掃描',exact:true})).toBeEnabled({timeout:30_000});
  const fixedModels=page.getByRole('region',{name:'模型用量排行'});
  await expect(fixedModels.getByText('gpt-6-astra',{exact:true})).toBeVisible();
  await expect(fixedModels.getByText('codex-auto-review',{exact:true})).toBeVisible();
  await page.screenshot({path:join(root,'native-model-switch.png')});
  const today=await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('get_overview',{filter:{days:1}}));
  const astraRows=await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('list_sessions',{filter:{days:1,model:'gpt-6-astra'}}));
  const astra=today.models.find(model=>model.model==='gpt-6-astra');
  if(astraRows.length!==1 || astraRows[0].tokens.totalTokens!==2_000_000 || astraRows[0].estimateMicrousd!==astra.estimateMicrousd || astraRows[0].model!=='gpt-6-astra') throw new Error('Filtered Sessions include usage from other models');
  if(today.sessions.reduce((sum,session)=>sum+session.tokens.totalTokens,0)!==today.totals.totalTokens || today.sessions.reduce((sum,session)=>sum+(session.estimateMicrousd??0),0)!==today.estimateMicrousd) throw new Error('Sessions and overview totals differ');
  await fixedModels.getByRole('link',{name:'查看 gpt-6-astra 的 Sessions',exact:true}).click();
  await expect(page.getByRole('region',{name:'篩選結果摘要'})).toContainText('所選期間 Tokens');
  await expect(page.locator('tbody td:nth-child(5)')).toHaveText('2,000,000');
  await page.screenshot({path:join(root,'native-daily-sessions.png')});
  await page.getByRole('link',{name:'活動',exact:true}).click();
  const requests=page.locator('.request-count-panel');
  await expect(requests.locator('strong')).toHaveText('3 次');
  await expect(requests).toContainText('標準與快速模式每次都算 1 次');
  await requests.scrollIntoViewIfNeeded();
  await page.screenshot({path:join(root,'native-request-count.png')});
  await page.getByRole('link',{name:'設定',exact:true}).click();
  await page.getByLabel('搜尋模型價格').fill('codex-auto-review');
  const reviewRow=page.locator('.pricing-table tbody tr').filter({hasText:'codex-auto-review'});
  await expect(reviewRow.getByText('不計費',{exact:true})).toBeVisible();
  await expect(reviewRow.getByRole('button')).toHaveCount(0);
  await reviewRow.scrollIntoViewIfNeeded();
  await page.screenshot({path:join(root,'native-auto-review.png')});
  if(errors.length) throw new Error(errors.join('\n'));
  await closeNative();
  console.log(JSON.stringify({...result,modelSwitch:'Astra and non-billable review imported; resumed suffix retained without duplication',additionalScreenshots:[join(root,'native-model-switch.png'),join(root,'native-auto-review.png')],windowControls:'maximize, restore, minimize, close passed',persistence:'normal size, maximized state, sidebar, preset and custom dates passed across two relaunches'}));
} finally {
  await browser?.close().catch(()=>{});
  if(child.exitCode===null)child.kill();
}
