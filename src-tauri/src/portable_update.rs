use tauri::{AppHandle, WebviewWindow};

#[tauri::command]
pub async fn update_portable_app(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    #[cfg(windows)]
    {
        let owner = window.hwnd().map_err(|error| format!("無法開啟檔案選擇：{error}"))?.0 as isize;
        let started = crate::run_blocking(move || {
            let Some(path) = windows::choose_file(owner)? else { return Ok(false) };
            windows::start_update(&path)?;
            Ok(true)
        }).await?;
        if started { app.exit(0); }
        Ok(())
    }
    #[cfg(not(windows))]
    { let _ = (app, window); Err("目前僅支援 Windows 免安裝版更新。".into()) }
}

pub fn run_helper_if_requested() -> bool {
    #[cfg(windows)]
    { return windows::run_helper_if_requested(); }
    #[cfg(not(windows))]
    { false }
}

pub fn on_app_ready() -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(windows)]
    windows::on_app_ready()?;
    Ok(())
}

#[cfg(windows)]
mod windows {
    use std::{ffi::{c_void, OsStr, OsString}, fs::{self, File}, io::{Read, Seek, SeekFrom}, os::windows::{ffi::{OsStrExt, OsStringExt}, process::CommandExt}, path::{Path, PathBuf}, process::{Command, Stdio}, thread, time::{Duration, Instant, SystemTime, UNIX_EPOCH}};
    use windows_sys::Win32::{
        Foundation::{CloseHandle, WAIT_OBJECT_0},
        Storage::FileSystem::{GetFileVersionInfoSizeW, GetFileVersionInfoW, ReplaceFileW, VerQueryValueW},
        System::Threading::{OpenProcess, WaitForSingleObject, CREATE_NO_WINDOW, PROCESS_SYNCHRONIZE},
        UI::{Controls::Dialogs::{CommDlgExtendedError, GetOpenFileNameW, OPENFILENAMEW, OFN_EXPLORER, OFN_FILEMUSTEXIST, OFN_HIDEREADONLY, OFN_NOCHANGEDIR, OFN_PATHMUSTEXIST}, WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK}},
    };

    const STAGE_PREFIX: &str = ".codex-usage-update-";
    const HELPER_ARG: &str = "--apply-portable-update";
    const READY_ARG: &str = "--portable-update-ready";
    const ROLLBACK_ARG: &str = "--portable-update-rollback";

    fn wide(value: &OsStr) -> Vec<u16> { value.encode_wide().chain(Some(0)).collect() }
    fn wide_str(value: &str) -> Vec<u16> { wide(OsStr::new(value)) }

    pub fn choose_file(owner: isize) -> Result<Option<PathBuf>, String> {
        let filter: Vec<u16> = "程式 (*.exe)\0*.exe\0\0".encode_utf16().collect();
        let title = wide_str("選擇新版 Codex 用量分析");
        let mut filename = vec![0u16; 32_768];
        let mut dialog = OPENFILENAMEW {
            lStructSize: std::mem::size_of::<OPENFILENAMEW>() as u32,
            hwndOwner: owner as _, lpstrFilter: filter.as_ptr(), lpstrFile: filename.as_mut_ptr(),
            nMaxFile: filename.len() as u32, lpstrTitle: title.as_ptr(),
            Flags: OFN_EXPLORER | OFN_FILEMUSTEXIST | OFN_PATHMUSTEXIST | OFN_HIDEREADONLY | OFN_NOCHANGEDIR,
            ..Default::default()
        };
        if unsafe { GetOpenFileNameW(&mut dialog) } == 0 {
            let error = unsafe { CommDlgExtendedError() };
            return if error == 0 { Ok(None) } else { Err(format!("無法開啟檔案選擇（{error}），請重試。")) };
        }
        let length = filename.iter().position(|ch| *ch == 0).unwrap_or(filename.len());
        Ok(Some(OsString::from_wide(&filename[..length]).into()))
    }

    fn pe_machine(path: &Path) -> Result<u16, String> {
        let mut file = File::open(path).map_err(|error| format!("無法讀取更新檔：{error}"))?;
        let size = file.metadata().map_err(|error| error.to_string())?.len();
        if !(512..=512 * 1024 * 1024).contains(&size) { return Err("更新檔大小不正確。".into()); }
        let mut dos = [0u8; 64];
        file.read_exact(&mut dos).map_err(|_| "更新檔不是有效的 Windows 程式。")?;
        if &dos[..2] != b"MZ" { return Err("更新檔不是有效的 Windows 程式。".into()); }
        let offset = u32::from_le_bytes(dos[60..64].try_into().unwrap()) as u64;
        if offset.checked_add(94).is_none_or(|end| end > size) { return Err("更新檔不是有效的 Windows 程式。".into()); }
        file.seek(SeekFrom::Start(offset)).map_err(|error| error.to_string())?;
        let mut header = [0u8; 94];
        file.read_exact(&mut header).map_err(|_| "更新檔不是有效的 Windows 程式。")?;
        if &header[..4] != b"PE\0\0" || u16::from_le_bytes(header[92..94].try_into().unwrap()) != 2 {
            return Err("更新檔不是有效的 Windows 桌面程式。".into());
        }
        Ok(u16::from_le_bytes(header[4..6].try_into().unwrap()))
    }

    fn product_name(path: &Path) -> Result<String, String> {
        let name = wide(path.as_os_str());
        let size = unsafe { GetFileVersionInfoSizeW(name.as_ptr(), std::ptr::null_mut()) };
        if size == 0 || size > 16 * 1024 * 1024 { return Err("無法辨識更新檔的程式資訊。".into()); }
        let mut data = vec![0u8; size as usize];
        if unsafe { GetFileVersionInfoW(name.as_ptr(), 0, size, data.as_mut_ptr() as *mut c_void) } == 0 {
            return Err("無法讀取更新檔的程式資訊。".into());
        }
        let mut pointer: *mut c_void = std::ptr::null_mut();
        let mut length = 0u32;
        let translations = wide_str("\\VarFileInfo\\Translation");
        if unsafe { VerQueryValueW(data.as_ptr() as *const c_void, translations.as_ptr(), &mut pointer, &mut length) } == 0 || pointer.is_null() || length < 4 {
            return Err("無法辨識更新檔的程式資訊。".into());
        }
        let pairs = unsafe { std::slice::from_raw_parts(pointer as *const u8, length as usize) };
        for pair in pairs.chunks_exact(4) {
            let language = u16::from_le_bytes([pair[0], pair[1]]);
            let codepage = u16::from_le_bytes([pair[2], pair[3]]);
            let key = wide_str(&format!("\\StringFileInfo\\{language:04x}{codepage:04x}\\ProductName"));
            let mut value: *mut c_void = std::ptr::null_mut();
            let mut count = 0u32;
            if unsafe { VerQueryValueW(data.as_ptr() as *const c_void, key.as_ptr(), &mut value, &mut count) } != 0 && !value.is_null() && count > 0 {
                let value = unsafe { std::slice::from_raw_parts(value as *const u16, count as usize) };
                return Ok(String::from_utf16_lossy(value).trim_end_matches('\0').to_string());
            }
        }
        Err("無法辨識更新檔的程式資訊。".into())
    }

    fn validate_update(current: &Path, candidate: &Path) -> Result<(), String> {
        if pe_machine(current)? != pe_machine(candidate)? || product_name(current)? != product_name(candidate)? {
            return Err("請選擇與目前程式相同版本類型的 Codex 用量分析 EXE。".into());
        }
        Ok(())
    }

    fn valid_stage(stage: &Path, target: &Path) -> bool {
        stage.file_name().and_then(OsStr::to_str).is_some_and(|name| name.starts_with(STAGE_PREFIX))
            && stage.parent().zip(target.parent()).is_some_and(|(left, right)| left == right)
    }

    pub fn start_update(candidate: &Path) -> Result<(), String> {
        let target = std::env::current_exe().map_err(|error| error.to_string())?;
        if fs::canonicalize(&target).ok().zip(fs::canonicalize(candidate).ok()).is_some_and(|(current, selected)| current == selected) {
            return Err("請選擇下載的新版 EXE，不要選擇目前執行中的程式。".into());
        }
        if fs::metadata(candidate).map_err(|e| format!("無法讀取更新檔：{e}"))?.len() > 512 * 1024 * 1024 {
            return Err("更新檔過大。".into());
        }
        let parent = target.parent().ok_or("找不到程式所在資料夾。")?;
        let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|error| error.to_string())?.as_nanos();
        let stage = parent.join(format!("{STAGE_PREFIX}{}-{stamp}", std::process::id()));
        fs::create_dir(&stage).map_err(|error| format!("無法在程式資料夾準備更新，請確認有寫入權限：{error}"))?;
        let result = (|| {
            let replacement = stage.join("new.exe");
            let helper = stage.join("helper.exe");
            fs::copy(candidate, &replacement).map_err(|error| format!("無法複製更新檔：{error}"))?;
            validate_update(&target, &replacement)?;
            fs::copy(&target, &helper).map_err(|error| format!("無法準備更新程式：{error}"))?;
            Command::new(&helper).arg(HELPER_ARG).arg(&target).arg(&stage).arg(std::process::id().to_string())
                .creation_flags(CREATE_NO_WINDOW).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
                .spawn().map_err(|error| format!("無法開始更新：{error}"))?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(stage.join("new.exe"));
            let _ = fs::remove_file(stage.join("helper.exe"));
            let _ = fs::remove_dir(&stage);
        }
        result
    }

    fn wait_for_process(pid: u32, timeout_ms: u32) -> Result<(), String> {
        let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
        if handle.is_null() {
            let error = std::io::Error::last_os_error();
            return if error.raw_os_error() == Some(87) { Ok(()) } else { Err(format!("無法等候程式結束：{error}")) };
        }
        let result = unsafe { WaitForSingleObject(handle, timeout_ms) };
        unsafe { CloseHandle(handle); }
        if result == WAIT_OBJECT_0 { Ok(()) } else { Err("等候程式結束逾時，更新未完成。".into()) }
    }

    fn replace(target: &Path, replacement: &Path, backup: Option<&Path>) -> Result<(), String> {
        let target = wide(target.as_os_str());
        let replacement = wide(replacement.as_os_str());
        let backup = backup.map(|path| wide(path.as_os_str()));
        let backup_ptr = backup.as_ref().map_or(std::ptr::null(), |value| value.as_ptr());
        if unsafe { ReplaceFileW(target.as_ptr(), replacement.as_ptr(), backup_ptr, 0, std::ptr::null(), std::ptr::null()) } == 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        Ok(())
    }

    fn notify_error(message: &str) {
        let message = wide_str(message);
        let title = wide_str("Codex 用量分析更新失敗");
        unsafe { MessageBoxW(std::ptr::null_mut(), message.as_ptr(), title.as_ptr(), MB_OK | MB_ICONERROR); }
    }

    fn restart(target: &Path, stage: &Path, flag: &str) -> Result<std::process::Child, String> {
        Command::new(target).arg(flag).arg(stage).arg(std::process::id().to_string()).spawn()
            .map_err(|error| format!("無法重新啟動程式：{error}"))
    }

    fn apply_update(target: &Path, stage: &Path, parent: u32) -> Result<(), String> {
        let helper = std::env::current_exe().map_err(|error| error.to_string())?;
        if !valid_stage(stage, target) || helper.parent() != Some(stage) {
            return Err("更新目錄不正確，請重新選擇更新檔。".into());
        }
        wait_for_process(parent, 60_000)?;
        let replacement = stage.join("new.exe");
        let backup = stage.join("old.exe");
        if let Err(error) = replace(target, &replacement, Some(&backup)) {
            if !target.exists() && backup.exists() { let _ = fs::rename(&backup, target); }
            let _ = restart(target, stage, ROLLBACK_ARG);
            return Err(format!("無法替換程式：{error}"));
        }
        let outcome = restart(target, stage, READY_ARG).and_then(|mut child| {
            let deadline = Instant::now() + Duration::from_secs(30);
            let ready_file = stage.join("ready");
            loop {
                let ready = ready_file.exists();
                if ready { thread::sleep(Duration::from_millis(500)); }
                let error = match child.try_wait() {
                    Ok(Some(_)) => return Err("新版程式未能啟動。".into()),
                    Ok(None) if ready => return Ok(()),
                    Ok(None) if Instant::now() >= deadline => "新版程式啟動逾時。".to_string(),
                    Ok(None) => { thread::sleep(Duration::from_millis(100)); continue; }
                    Err(error) => format!("無法確認新版啟動：{error}"),
                };
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
        });
        if let Err(error) = outcome {
            if let Err(rollback) = replace(target, &backup, None) {
                return Err(format!("{error} 無法自動還原：{rollback}。原程式保存在 {}", backup.display()));
            }
            return match restart(target, stage, ROLLBACK_ARG) {
                Ok(_) => Err(format!("{error} 已還原原程式。")),
                Err(restart_error) => Err(format!("{error} 已還原原程式；{restart_error}，請手動開啟。")),
            };
        }
        Ok(())
    }

    pub fn run_helper_if_requested() -> bool {
        let mut args = std::env::args_os().skip(1);
        if args.next().as_deref() != Some(OsStr::new(HELPER_ARG)) { return false; }
        let parsed = args.next().map(PathBuf::from).zip(args.next().map(PathBuf::from))
            .zip(args.next().and_then(|value| value.to_string_lossy().parse::<u32>().ok()));
        match parsed {
            Some(((target, stage), parent)) => if let Err(error) = apply_update(&target, &stage, parent) { notify_error(&error); },
            None => notify_error("更新參數不完整，請重新選擇更新檔。"),
        }
        true
    }

    pub fn on_app_ready() -> Result<(), String> {
        let mut args = std::env::args_os().skip(1);
        let flag = args.next();
        if flag.as_deref() != Some(OsStr::new(READY_ARG)) && flag.as_deref() != Some(OsStr::new(ROLLBACK_ARG)) { return Ok(()); }
        let stage = args.next().map(PathBuf::from).ok_or("更新目錄不正確。")?;
        let helper = args.next().and_then(|value| value.to_string_lossy().parse::<u32>().ok()).ok_or("更新程序不正確。")?;
        let target = std::env::current_exe().map_err(|error| error.to_string())?;
        if !valid_stage(&stage, &target) { return Err("更新目錄不正確。".into()); }
        if flag.as_deref() == Some(OsStr::new(READY_ARG)) {
            fs::write(stage.join("ready"), b"ok").map_err(|error| format!("無法完成更新：{error}"))?;
        }
        thread::spawn(move || {
            if wait_for_process(helper, u32::MAX).is_ok() {
                for name in ["old.exe", "new.exe", "helper.exe", "ready"] { let _ = fs::remove_file(stage.join(name)); }
                let _ = fs::remove_dir(stage);
            }
        });
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn windows_replacement_keeps_a_restorable_backup() {
            let root = std::env::temp_dir().join(format!("codex-update-test-{}-{}", std::process::id(), SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
            fs::create_dir(&root).unwrap();
            let target = root.join("app.exe");
            let replacement = root.join("new.exe");
            let backup = root.join("old.exe");
            fs::write(&target, b"old").unwrap();
            fs::write(&replacement, b"new").unwrap();
            replace(&target, &replacement, Some(&backup)).unwrap();
            assert_eq!(fs::read(&target).unwrap(), b"new");
            assert_eq!(fs::read(&backup).unwrap(), b"old");
            replace(&target, &backup, None).unwrap();
            assert_eq!(fs::read(&target).unwrap(), b"old");
            fs::remove_file(target).unwrap();
            fs::remove_dir(root).unwrap();
        }

        #[test]
        fn rejects_non_executable_updates_and_stage_directories_outside_the_app_folder() {
            let path = std::env::temp_dir().join(format!("codex-invalid-update-{}.exe", std::process::id()));
            fs::write(&path, vec![0u8; 512]).unwrap();
            assert!(pe_machine(&path).is_err());
            fs::remove_file(path).unwrap();
            assert!(valid_stage(Path::new(r"C:\app\.codex-usage-update-1"), Path::new(r"C:\app\app.exe")));
            assert!(!valid_stage(Path::new(r"C:\other\.codex-usage-update-1"), Path::new(r"C:\app\app.exe")));
        }
    }
}
