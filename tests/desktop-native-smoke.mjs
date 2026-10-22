// Native Windows lifecycle checks use isolated data and restore startup registration.
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { chromium, expect } from '@playwright/test';

if (process.platform !== 'win32') throw new Error('This suite requires Windows.');
const sourceExe = resolve(process.argv[2]);
const root = mkdtempSync(join(tmpdir(), 'codex-usage-desktop-'));
const portable = join(root,'Portable app');
mkdirSync(portable);
const exe = join(portable,'Codex Usage Analytics.exe');
copyFileSync(sourceExe,exe);
const dbPath = join(root, 'usage.sqlite3');
const codex = join(root, 'codex');
mkdirSync(join(codex, 'sessions'), {recursive:true});
const db = new DatabaseSync(dbPath);
db.exec('create table settings(key text primary key,value text not null)');
db.prepare('insert into settings values(?,?)').run('app', JSON.stringify({codexHome:codex,sshSources:[],cloudEnabled:false,pollMinutes:15,autoUpdatePricing:false}));
db.close();
const server = createServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
await new Promise(resolve => server.close(resolve));
const env = {...process.env,CODEX_USAGE_DB_PATH:dbPath,CODEX_HOME:codex,WEBVIEW2_USER_DATA_FOLDER:join(root,'webview'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port}`};
const launch = (args = []) => spawn(exe, args, {env,windowsHide:true,stdio:'ignore'});
const run = promisify(execFile);
const runKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const startupName = `CodexUsageAnalytics-test-${createHash('sha256').update(dbPath).digest('hex').slice(0,16)}`;
async function registry() {
  try {
    const {stdout} = await run('reg.exe', ['query',runKey,'/v',startupName], {windowsHide:true});
    return stdout;
  } catch (error) {
    if (error.code === 1) return null;
    throw error;
  }
}
const registryBefore = await registry();
let child;
let browser;
let page;
let originalPreferences;
const errors = [];
const trayScript = join(root,'tray.ps1');
writeFileSync(trayScript, '\ufeff' + `param([int]$AppProcessId,[string]$Action)
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class NativeTray {
  public delegate bool EnumProc(IntPtr window,IntPtr data);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback,IntPtr data);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window,out uint process);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr window,StringBuilder name,int size);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr window,uint message,UIntPtr parameter,IntPtr data);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr window,uint message,UIntPtr parameter,IntPtr data);
  [DllImport("user32.dll")] public static extern int GetMenuItemCount(IntPtr menu);
  [DllImport("user32.dll")] public static extern uint GetMenuItemID(IntPtr menu,int position);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetMenuString(IntPtr menu,uint item,StringBuilder text,int size,uint flags);
  public static IntPtr Find(int process,string type) {
    IntPtr found=IntPtr.Zero;
    EnumWindows((window,data)=>{
      uint owner;GetWindowThreadProcessId(window,out owner);
      var name=new StringBuilder(256);GetClassName(window,name,name.Capacity);
      if(owner==process && name.ToString()==type){found=window;return false;}
      return true;
    },IntPtr.Zero);
    return found;
  }
}
'@
$tray=[NativeTray]::Find($AppProcessId,'tray_icon_app')
if($tray -eq [IntPtr]::Zero){throw 'Tray window is missing'}
# Dispatch the native shell notification; this exercises the registered tray handler.
$mouseMessage=if($Action -eq 'click'){0x202}else{0x205}
if(-not [NativeTray]::PostMessage($tray,6002,[UIntPtr]::Zero,[IntPtr]$mouseMessage)){throw 'Tray notification failed'}
if($Action -eq 'click'){exit 0}
$popup=[IntPtr]::Zero
for($attempt=0;$attempt -lt 50;$attempt++){
  $popup=[NativeTray]::Find($AppProcessId,'#32768')
  if($popup -ne [IntPtr]::Zero){break}
  Start-Sleep -Milliseconds 50
}
if($popup -eq [IntPtr]::Zero){throw 'Tray context menu did not appear'}
$menu=[NativeTray]::SendMessage($popup,0x1E1,[UIntPtr]::Zero,[IntPtr]::Zero)
$items=@()
for($index=0;$index -lt [NativeTray]::GetMenuItemCount($menu);$index++){
  $text=New-Object System.Text.StringBuilder 256
  [void][NativeTray]::GetMenuString($menu,$index,$text,$text.Capacity,0x400)
  $items+=$text.ToString()
}
if($items.Count -ne 2 -or $items[0] -ne '開啟 Codex 用量分析' -or $items[1] -ne '結束'){throw "Unexpected tray menu: $items"}
# UIAutomation exposes no children for this native popup. Dispatch its actual
# Win32 command ID through the registered menu handler without global input.
$position=if($Action -eq 'quit'){1}else{0}
$command=[NativeTray]::GetMenuItemID($menu,$position)
[void][NativeTray]::SendMessage($tray,0x1F,[UIntPtr]::Zero,[IntPtr]::Zero)
if(-not [NativeTray]::PostMessage($tray,0x111,[UIntPtr]$command,[IntPtr]::Zero)){throw 'Tray menu command failed'}
$items | ConvertTo-Json -Compress
`, 'utf8');
async function tray(action) {
  await run('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',trayScript,'-AppProcessId',String(child.pid),'-Action',action],{windowsHide:true,timeout:10_000});
}
async function connect() {
  let lastError;
  for (const deadline = Date.now() + 60_000; Date.now() < deadline;) {
    if (child.exitCode !== null) throw new Error(`App exited before WebView connected: ${child.exitCode}`);
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, {timeout:1000});
      page = browser.contexts()[0].pages()[0];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if(message.type()==='error') errors.push(message.text()); });
      await expect(page.getByRole('heading',{name:'用量總覽'})).toBeVisible({timeout:30_000});
      return;
    } catch (error) { lastError = error; await delay(300); }
  }
  throw new Error(`WebView did not connect: ${lastError}. Evidence: ${root}`);
}
const preferences = () => page.evaluate(() => window.__TAURI_INTERNALS__.invoke('get_desktop_preferences'));
const save = value => page.evaluate(preferences => window.__TAURI_INTERNALS__.invoke('save_desktop_preferences', {preferences}), value);
const visible = () => page.evaluate(() => window.__TAURI_INTERNALS__.invoke('plugin:window|is_visible', {label:'main'}));
const closeWindow = () => page.getByRole('button',{name:'關閉視窗',exact:true}).evaluate(button => button.click());
async function waitForExit(process) {
  await expect.poll(() => process.exitCode, {timeout:10_000}).not.toBeNull();
}
async function exitNormally() {
  await save({...await preferences(),closeToTray:false});
  await closeWindow();
  await waitForExit(child);
  await browser.close().catch(() => {});
  browser = undefined;
}
try {
  child = launch();
  console.log(JSON.stringify({testDirectory:root,sourceExe,exe,processId:child.pid,debugPort:port}));
  await connect();
  originalPreferences = await preferences();
  expect(originalPreferences).toEqual({launchAtStartup:false,closeToTray:true});
  expect(await visible()).toBe(true);
  const blockedWrite = join(root,'usage.desktop.desktop.tmp');
  mkdirSync(blockedWrite);
  try {
    const error = await page.evaluate(async () => {
      try {
        await window.__TAURI_INTERNALS__.invoke('save_desktop_preferences', {preferences:{launchAtStartup:true,closeToTray:false}});
        return null;
      } catch (cause) { return String(cause); }
    });
    expect(error).toContain('無法儲存背景執行設定');
    expect(await preferences()).toEqual(originalPreferences);
    expect(await registry()).toBeNull();
  } finally { rmdirSync(blockedWrite); }
  await page.getByRole('link',{name:'設定',exact:true}).click();
  const section = page.locator('#desktop-settings');
  await expect(section.getByRole('heading',{name:'啟動與背景執行'})).toBeVisible();
  await expect(page.getByLabel('關閉視窗後繼續執行',{exact:true})).toBeChecked();
  await page.getByLabel('開機時自動啟動',{exact:true}).check();
  await expect(section.getByText('啟動與背景執行設定已保存。',{exact:true})).toBeVisible();
  expect(await preferences()).toEqual({launchAtStartup:true,closeToTray:true});
  const registryEnabled = await registry();
  expect(registryBefore).toBeNull();
  const added = registryEnabled.split(/\r?\n/).filter(line => line.includes('REG_SZ'));
  expect(added).toHaveLength(1);
  expect(added[0]).toContain(`"${exe}" --autostart`);
  await section.scrollIntoViewIfNeeded();
  await page.screenshot({path:join(root,'desktop-settings.png')});
  await closeWindow();
  await expect.poll(visible).toBe(false);
  await delay(750);
  expect(child.exitCode).toBeNull();
  await tray('click');
  await expect.poll(visible).toBe(true);
  await closeWindow();
  await expect.poll(visible).toBe(false);
  await tray('open');
  await expect.poll(visible).toBe(true);
  await closeWindow();
  await expect.poll(visible).toBe(false);
  const second = launch();
  await waitForExit(second);
  await expect.poll(visible).toBe(true);
  expect(child.exitCode).toBeNull();
  expect(await preferences()).toEqual({launchAtStartup:true,closeToTray:true});
  await page.reload();
  await page.getByRole('link',{name:'設定',exact:true}).click();
  await expect(page.getByLabel('開機時自動啟動',{exact:true})).toBeChecked();
  await page.getByLabel('開機時自動啟動',{exact:true}).uncheck();
  await expect(page.locator('#desktop-settings').getByText('啟動與背景執行設定已保存。',{exact:true})).toBeVisible();
  expect(await registry()).toBe(registryBefore);
  await exitNormally();

  child = launch(['--autostart']);
  await connect();
  expect(await visible()).toBe(false);
  expect(await preferences()).toEqual({launchAtStartup:false,closeToTray:false});
  const restore = launch();
  await waitForExit(restore);
  await expect.poll(visible).toBe(true);
  await page.getByRole('link',{name:'設定',exact:true}).click();
  await expect(page.getByLabel('關閉視窗後繼續執行',{exact:true})).not.toBeChecked();
  await page.locator('#desktop-settings').scrollIntoViewIfNeeded();
  await page.screenshot({path:join(root,'desktop-restored.png')});
  const environment = {url:page.url(),viewport:await page.evaluate(() => ({width:innerWidth,height:innerHeight}))};
  await save(originalPreferences);
  await tray('quit');
  await waitForExit(child);
  await browser.close().catch(() => {});
  browser = undefined;
  expect(await registry()).toBe(registryBefore);
  expect(errors).toEqual([]);
  console.log(JSON.stringify({passed:true,sourceExe,exe,testDirectory:root,...environment,checks:['save failure rolls back startup registration and keeps residency','quoted executable path with spaces registered and removed','close hides window while process remains alive','tray click and open menu restore window','tray quit exits while residency is enabled','second launch restores existing instance','preferences persist across relaunch','--autostart launches hidden','disabled residency exits on close'],screenshots:[join(root,'desktop-settings.png'),join(root,'desktop-restored.png')],errors}));
} finally {
  if (child?.exitCode === null && page) {
    await save({...originalPreferences,launchAtStartup:false,closeToTray:false}).catch(() => {});
    await closeWindow().catch(() => {});
  }
  await browser?.close().catch(() => {});
  if (child?.exitCode === null) child.kill();
  // Only this suite's unique registration can be removed by cleanup.
  if (registryBefore === null) {
    if (await registry()) await run('reg.exe',['delete',runKey,'/v',startupName,'/f'],{windowsHide:true});
    await run('reg.exe',['delete','HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run','/v',startupName,'/f'],{windowsHide:true}).catch(() => {});
  }
}
