use std::{path::{Path, PathBuf}, sync::{atomic::{AtomicBool, Ordering}, Mutex}};

use auto_launch::AutoLaunch;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{menu::{Menu, MenuItem}, tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent}, AppHandle, Manager, State};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct DesktopPreferences {
    pub launch_at_startup: bool,
    pub close_to_tray: bool,
}

impl Default for DesktopPreferences {
    fn default() -> Self { Self { launch_at_startup: false, close_to_tray: true } }
}

pub struct DesktopState {
    path: PathBuf,
    close_to_tray: AtomicBool,
    update_lock: Mutex<()>,
    auto_launch: AutoLaunch,
}

// Keep native smoke tests separate from the normal app's instance and login entry.
pub fn test_suffix(path: &Path) -> String {
    format!("{:x}", Sha256::digest(path.to_string_lossy().as_bytes()))[..16].into()
}

fn read_preferences(path: &Path) -> Result<DesktopPreferences, String> {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|error| format!("無法讀取背景執行設定：{error}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(DesktopPreferences::default()),
        Err(error) => Err(format!("無法讀取背景執行設定：{error}")),
    }
}

fn write_preferences(path: &Path, preferences: &DesktopPreferences) -> Result<(), String> {
    let temporary = path.with_extension("desktop.tmp");
    let bytes = serde_json::to_vec(preferences).map_err(|error| error.to_string())?;
    std::fs::write(&temporary, bytes).and_then(|()| std::fs::rename(&temporary, path))
        .map_err(|error| format!("無法儲存背景執行設定：{error}"))
}

fn set_autostart(auto_launch: &AutoLaunch, enabled: bool) -> Result<bool, String> {
    let result = if enabled { auto_launch.enable() } else { auto_launch.disable() };
    match result {
        Ok(()) => Ok(()),
        Err(auto_launch::Error::Io(error)) if !enabled && error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("無法變更開機啟動設定：{error}")),
    }?;
    let actual = auto_launch.is_enabled().map_err(|error| format!("無法確認開機啟動設定：{error}"))?;
    if actual != enabled { return Err("系統未套用開機啟動設定，請檢查啟動應用程式設定後重試。".into()); }
    Ok(actual)
}

#[tauri::command]
pub async fn get_desktop_preferences(state: State<'_, DesktopState>) -> Result<DesktopPreferences, String> {
    Ok(DesktopPreferences {
        launch_at_startup: state.auto_launch.is_enabled().map_err(|error| format!("無法讀取開機啟動設定：{error}"))?,
        close_to_tray: state.close_to_tray.load(Ordering::Acquire),
    })
}

#[tauri::command]
pub async fn save_desktop_preferences(state: State<'_, DesktopState>, mut preferences: DesktopPreferences) -> Result<DesktopPreferences, String> {
    let _guard = state.update_lock.lock().map_err(|_| "無法儲存背景執行設定，請重新啟動程式")?;
    let previously_enabled = state.auto_launch.is_enabled().map_err(|error| format!("無法讀取開機啟動設定：{error}"))?;
    // Re-enable updates the executable path after moving a portable app.
    let result = set_autostart(&state.auto_launch, preferences.launch_at_startup).and_then(|actual| {
        preferences.launch_at_startup = actual;
        write_preferences(&state.path, &preferences)
    });
    if let Err(error) = result {
        // enable() can fail after writing the login entry, so restore even on an OS error.
        if let Err(rollback) = set_autostart(&state.auto_launch, previously_enabled) {
            return Err(format!("{error}；還原開機啟動設定失敗：{rollback}"));
        }
        return Err(error);
    }
    state.close_to_tray.store(preferences.close_to_tray, Ordering::Release);
    Ok(preferences)
}

pub fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

pub fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let isolated_path = std::env::var_os("CODEX_USAGE_DB_PATH").map(PathBuf::from);
    let path = match &isolated_path {
        Some(path) => path.with_extension("desktop.json"),
        None => app.path().app_data_dir()?.join("desktop.json"),
    };
    if let Some(parent) = path.parent() { std::fs::create_dir_all(parent)?; }
    let preferences = read_preferences(&path)?;
    let name = isolated_path.as_deref().map(|path| format!("CodexUsageAnalytics-test-{}", test_suffix(path)))
        .unwrap_or_else(|| "CodexUsageAnalytics".into());
    let executable = std::env::current_exe()?;
    #[cfg(windows)]
    let executable = format!("\"{}\"", executable.display());
    #[cfg(not(windows))]
    let executable = executable.to_string_lossy().into_owned();
    #[cfg(target_os = "macos")]
    let auto_launch = AutoLaunch::new(&name, &executable, true, &["--autostart"]);
    #[cfg(not(target_os = "macos"))]
    let auto_launch = AutoLaunch::new(&name, &executable, &["--autostart"]);
    app.manage(DesktopState { path, close_to_tray: AtomicBool::new(preferences.close_to_tray), update_lock: Mutex::new(()), auto_launch });

    let open = MenuItem::with_id(app, "open", "開啟 Codex 用量分析", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "結束", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;
    let mut tray = TrayIconBuilder::with_id("codex-usage")
        .tooltip("Codex 用量分析")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main(app),
            "quit" => app.exit(0),
            _ => {},
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(event, TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. }) {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() { tray = tray.icon(icon.clone()); }
    tray.build(app)?;
    if std::env::args().any(|arg| arg == "--autostart") {
        if let Some(window) = app.get_webview_window("main") { window.hide()?; }
    } else { show_main(app.handle()); }
    Ok(())
}

pub fn on_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    if window.label() != "main" { return; }
    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        if window.state::<DesktopState>().close_to_tray.load(Ordering::Acquire) && window.hide().is_ok() {
            api.prevent_close();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn desktop_preferences_persist_separately_and_default_to_resident() {
        let path = std::env::temp_dir().join(format!("codex-desktop-{}-{}.json", std::process::id(), chrono::Utc::now().timestamp_nanos_opt().unwrap()));
        assert_eq!(read_preferences(&path).unwrap(), DesktopPreferences::default());
        let preferences = DesktopPreferences { launch_at_startup: true, close_to_tray: false };
        write_preferences(&path, &preferences).unwrap();
        assert_eq!(read_preferences(&path).unwrap(), preferences);
        write_preferences(&path, &DesktopPreferences::default()).unwrap();
        assert_eq!(read_preferences(&path).unwrap(), DesktopPreferences::default());
        std::fs::remove_file(path).unwrap();
    }
}
