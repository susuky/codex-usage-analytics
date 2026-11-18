// Exercise portable updates using an isolated executable, database and startup entry.
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { chromium, expect } from '@playwright/test';

if (process.platform !== 'win32') throw new Error('This suite requires Windows.');
const source = resolve(process.argv[2]);
const root = mkdtempSync(join(tmpdir(), 'codex-portable-update-'));
const appDir = join(root, 'Portable app');
const downloads = join(root, 'Downloads');
mkdirSync(appDir); mkdirSync(downloads);
const exe = join(appDir, 'Codex Usage Analytics.exe');
const next = join(downloads, '新版程式.exe');
const broken = join(downloads, '無法啟動的程式.exe');
const invalid = join(downloads, '錯誤檔案.exe');
copyFileSync(source, exe); copyFileSync(source, next);
appendFileSync(next, '\nportable update smoke test\n');
writeFileSync(invalid, 'not an executable');

// A different, valid GUI program with the same product name exits without signalling readiness.
const run = promisify(execFile);
const failingSource = join(root, 'ExitsImmediately.cs');
writeFileSync(failingSource, '\ufeff' + '[assembly:System.Reflection.AssemblyProduct("Codex 用量分析")]\nclass Program { static void Main() {} }');
const compiler = join(process.env.WINDIR, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
await run(compiler, ['/nologo','/target:winexe','/platform:x64',`/out:${broken}`,failingSource], {windowsHide:true});

const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const expected = hash(next);
const dbPath = join(root, 'usage.sqlite3');
const codex = join(root, 'codex');
mkdirSync(join(codex, 'sessions'), {recursive:true});
const db = new DatabaseSync(dbPath);
db.exec('create table settings(key text primary key,value text not null)');
db.prepare('insert into settings values(?,?)').run('app', JSON.stringify({codexHome:codex,sshSources:[],pollMinutes:15,autoUpdatePricing:false}));
db.close();
const socket = createServer();
await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
const port = socket.address().port;
await new Promise(resolve => socket.close(resolve));
const env = {...process.env,CODEX_USAGE_DB_PATH:dbPath,CODEX_HOME:codex,WEBVIEW2_USER_DATA_FOLDER:join(root,'webview'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port}`};
const child = spawn(exe, [], {env,windowsHide:true,stdio:'ignore'});
async function runQuiet(file, args, timeout = 30_000) {
  const process = spawn(file, args, {windowsHide:true,stdio:'ignore'});
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { process.kill(); reject(new Error('Command timed out')); }, timeout);
    process.once('error', error => { clearTimeout(timer); reject(error); });
    process.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`Command exited ${code}`)); });
  });
}
const runKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const startupName = `CodexUsageAnalytics-test-${createHash('sha256').update(dbPath).digest('hex').slice(0,16)}`;
async function registry() {
  try { return (await run('reg.exe', ['query',runKey,'/v',startupName], {windowsHide:true})).stdout; }
  catch (error) { if (error.code === 1) return null; throw error; }
}
const before = await registry();
if (before !== null) throw new Error('The isolated startup entry already exists');

const dialogScript = join(root, 'select-file.ps1');
writeFileSync(dialogScript, '\ufeff' + `param([string]$AppExe,[string]$SelectedFile)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class UpdateDialog {
  public delegate bool EnumProc(IntPtr hwnd,IntPtr extra);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback,IntPtr extra);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent,EnumProc callback,IntPtr extra);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint process);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd,StringBuilder text,int length);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hwnd,StringBuilder text,int length);
  [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr hwnd);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr hwnd,uint message,IntPtr w,string l);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd,uint message,IntPtr w,IntPtr l);
  public static IntPtr Find(int pid,string title) {
    IntPtr result=IntPtr.Zero;
    EnumWindows((window,extra)=>{uint owner; GetWindowThreadProcessId(window,out owner); var text=new StringBuilder(512); GetWindowText(window,text,text.Capacity);
      if(owner==pid && text.ToString()==title){result=window;return false;}return true;},IntPtr.Zero);
    return result;
  }
  public static IntPtr FindChild(IntPtr parent,int id) {
    IntPtr result=IntPtr.Zero;
    EnumChildWindows(parent,(window,extra)=>{if(GetDlgCtrlID(window)==id){result=window;return false;}return true;},IntPtr.Zero);
    return result;
  }
  public static string Describe(IntPtr parent) {
    var result=new StringBuilder();
    EnumChildWindows(parent,(window,extra)=>{var name=new StringBuilder(256);GetClassName(window,name,name.Capacity);result.Append(name).Append(':').Append(GetDlgCtrlID(window)).Append(' ');return true;},IntPtr.Zero);
    return result.ToString();
  }
}
'@
$appProcessId=(Get-Process | Where-Object Path -eq $AppExe | Select-Object -First 1).Id
for ($attempt=0; $attempt -lt 100; $attempt++) {
  $window=[UpdateDialog]::Find($AppProcessId,'選擇新版 Codex 用量分析')
  if ($window -ne [IntPtr]::Zero) {
    $input=[UpdateDialog]::FindChild($window,1148)
    if ($input -eq [IntPtr]::Zero) { throw "Filename input missing: $([UpdateDialog]::Describe($window))" }
    [void][UpdateDialog]::SendMessage($input,0x000C,[IntPtr]::Zero,$SelectedFile)
    [void][UpdateDialog]::PostMessage($window,0x0111,[IntPtr]1,[IntPtr]::Zero)
    exit 0
  }
  Start-Sleep -Milliseconds 100
}
throw 'File selection dialog did not appear'
`, 'utf8');
const dismissScript = join(root, 'dismiss-error.ps1');
writeFileSync(dismissScript, '\ufeff' + `param([string]$AppDirectory)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$root=[System.Windows.Automation.AutomationElement]::RootElement
$condition=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty,'Codex 用量分析更新失敗')
for($i=0;$i -lt 100;$i++) {
  foreach($window in $root.FindAll([System.Windows.Automation.TreeScope]::Children,$condition)) {
    $process=Get-Process -Id $window.Current.ProcessId -ErrorAction SilentlyContinue
    if($process -and $process.Path -and $process.Path.StartsWith($AppDirectory + '\\',[StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($process.Path) -eq 'helper.exe') {
      $window.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern).Close(); exit 0
    }
  }
  Start-Sleep -Milliseconds 100
}
throw 'Expected update failure message did not appear'
`, 'utf8');
const cleanupScript = join(root, 'stop-test-processes.ps1');
writeFileSync(cleanupScript, '\ufeff' + `param([string]$AppDirectory,[string]$AppExe)
$stagePrefix=$AppDirectory + '\\.codex-usage-update-'
Get-CimInstance Win32_Process | Where-Object {
  $_.ExecutablePath -and ($_.ExecutablePath -eq $AppExe -or
    ($_.ExecutablePath.StartsWith($stagePrefix,[StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($_.ExecutablePath) -eq 'helper.exe'))
} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
`, 'utf8');

let browser;
let page;
const errors = [];
async function connect() {
  let last;
  for (const deadline = Date.now() + 60_000; Date.now() < deadline;) {
    try {
      const connected = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, {timeout:1000});
      const current = connected.contexts()[0]?.pages()[0];
      if (!current) { await connected.close(); await delay(200); continue; }
      await expect(current.getByRole('heading',{name:'用量總覽'})).toBeVisible({timeout:5000});
      browser = connected; page = current;
      page.on('pageerror', error => errors.push(error.message));
      return;
    } catch (error) { last = error; await delay(250); }
  }
  throw new Error(`Updated app did not start: ${last}. Evidence: ${root}`);
}
const preferences = () => page.evaluate(() => window.__TAURI_INTERNALS__.invoke('get_desktop_preferences'));
const save = preferences => page.evaluate(value => window.__TAURI_INTERNALS__.invoke('save_desktop_preferences',{preferences:value}), preferences);
async function waitForReplacement(expectedHash) {
  await expect.poll(() => { try { return existsSync(exe) ? hash(exe) : ''; } catch { return ''; } }, {timeout:60_000,intervals:[200,500]}).toBe(expectedHash);
}
async function openUpdateSettings() {
  await page.getByRole('link',{name:'設定',exact:true}).click();
  await expect(page.getByRole('button',{name:'選擇更新檔'})).toBeVisible();
}

async function selectUpdate(file) {
  page.once('dialog', dialog => dialog.accept());
  const selection = runQuiet('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',dialogScript,'-AppExe',exe,'-SelectedFile',file]);
  await Promise.all([selection, page.getByRole('button',{name:'選擇更新檔'}).click()]);
}
try {
  console.log(JSON.stringify({testDirectory:root,processId:child.pid,debugPort:port}));
  await connect();
  await save({launchAtStartup:true,closeToTray:true});
  const enabled = await registry();
  expect(enabled).toContain(`"${exe}" --autostart`);
  await openUpdateSettings();
  await page.getByRole('region',{name:'程式更新'}).scrollIntoViewIfNeeded();
  await page.screenshot({path:join(root,'portable-update.png')});
  await selectUpdate(invalid);
  await expect(page.getByRole('alert')).toContainText('更新檔');
  expect(await registry()).toBe(enabled);
  await selectUpdate(next);
  await expect.poll(() => child.exitCode, {timeout:20_000}).not.toBeNull();
  await browser.close().catch(() => {}); browser = undefined;
  await waitForReplacement(expected);
  await connect();
  expect(await preferences()).toEqual({launchAtStartup:true,closeToTray:true});
  expect(await registry()).toBe(enabled);
  const settings = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('get_settings'));
  expect(settings.codexHome).toBe(codex);
  expect(settings.pricingRules.find(rule => rule.model === 'gpt-6.1-terra').inputUsdPerMillion).toBe(1);

  // A valid-looking executable that exits immediately must restore the previous app.
  await openUpdateSettings();
  await selectUpdate(broken);
  await run('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',dismissScript,'-AppDirectory',appDir],{windowsHide:true,timeout:45_000});
  await waitForReplacement(expected);
  await browser.close().catch(() => {}); browser = undefined;
  await connect();
  expect(await preferences()).toEqual({launchAtStartup:true,closeToTray:true});
  expect(await registry()).toBe(enabled);
  await save({launchAtStartup:false,closeToTray:false});
  await page.getByRole('button',{name:'關閉視窗',exact:true}).click();
  await browser.close().catch(() => {}); browser = undefined;
  await expect.poll(registry,{timeout:10_000}).toBeNull();
  expect(errors).toEqual([]);
  console.log(JSON.stringify({passed:true,testDirectory:root,screenshot:join(root,'portable-update.png'),checks:['native file selection','replacement at the original path','startup entry and settings preserved','invalid file rejected','failed launch rolls back and restarts the original']}));
} finally {
  if (page && browser?.isConnected()) {
    await save({launchAtStartup:false,closeToTray:false}).catch(() => {});
    await page.getByRole('button',{name:'關閉視窗',exact:true}).click().catch(() => {});
  }
  await browser?.close().catch(() => {});
  if (child.exitCode === null) child.kill();
  await run('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',cleanupScript,'-AppDirectory',appDir,'-AppExe',exe],{windowsHide:true,timeout:15_000}).catch(() => {});
  if (await registry()) await run('reg.exe',['delete',runKey,'/v',startupName,'/f'],{windowsHide:true}).catch(() => {});
  await run('reg.exe',['delete','HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run','/v',startupName,'/f'],{windowsHide:true}).catch(() => {});
}
