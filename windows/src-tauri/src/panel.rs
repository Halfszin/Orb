// The Orb panel: a big window under the island (panel.html) with the assistant,
// tasks, reminders, habits, timers, music, the clipboard history, routines and
// the computer's vitals. Its lists live in the page (localStorage); Rust gives
// it the window, the assistant (the voice's brain, typed), apps to open, the
// clipboard and the system numbers.

use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder};

pub const LABEL: &str = "panel";
const SIZE: (f64, f64) = (920.0, 540.0);
/// Off screen: on Windows the window stays "visible" there, so WebView2 never
/// blanks it nor throttles its timers (the same trick as the dictation pill).
const PARKED: (i32, i32) = (-32000, -32000);
/// Below the closed island, in logical pixels from the top of the island's window.
const TOP_GAP: f64 = 44.0;

fn page_url(app: &AppHandle) -> WebviewUrl {
    #[cfg(dev)]
    if let Some(mut base) = app.config().build.dev_url.clone() {
        base.set_path("/panel.html");
        return WebviewUrl::External(base);
    }
    let _ = app;
    WebviewUrl::App("panel.html".into())
}

/// Creates the panel's window, parked. Before the island, for WebView2's sake
/// (see create_settings_window in lib.rs).
pub fn setup(app: &AppHandle) {
    let park = cfg!(windows);
    let mut builder = WebviewWindowBuilder::new(app, LABEL, page_url(app))
        .additional_browser_args(crate::BROWSER_ARGS)
        .title("Orb")
        .inner_size(SIZE.0, SIZE.1)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible_on_all_workspaces(true)
        .focused(false)
        .maximizable(false)
        .minimizable(false)
        .closable(false)
        .visible(park);
    if park {
        builder = builder.position(PARKED.0 as f64, PARKED.1 as f64);
    }
    if let Err(err) = builder.build() {
        crate::log::line(format!("panel window failed: {err}"));
    }
    start_clipboard_watch();
}

/// Puts the panel under the island, on the island's screen.
#[tauri::command]
pub fn panel_show(app: AppHandle) {
    let Some(win) = app.get_webview_window(LABEL) else { return };
    if let Some(island) = crate::island::window(&app) {
        if let (Ok(origin), Ok(size), Ok(scale)) = (island.outer_position(), island.outer_size(), island.scale_factor()) {
            let w = (SIZE.0 * scale) as i32;
            let x = origin.x + size.width as i32 / 2 - w / 2;
            let y = origin.y + (TOP_GAP * scale) as i32;
            let _ = win.set_position(PhysicalPosition::new(x, y));
        }
    }
    let _ = win.show();
    let _ = tauri::Emitter::emit(&win, "panel-shown", ());
}

#[tauri::command]
pub fn panel_hide(app: AppHandle) {
    let Some(win) = app.get_webview_window(LABEL) else { return };
    if cfg!(windows) {
        let _ = win.set_position(PhysicalPosition::new(PARKED.0, PARKED.1));
    } else {
        let _ = win.hide();
    }
}

/// The panel's own conversation with the assistant (apart from the voice's).
#[derive(Default)]
pub struct Assistant(Mutex<crate::voice::brain::Brain>);

/// One typed turn with the assistant: Claude with the voice's tools (open an
/// app, music, web search…). `memory` is what the user asked Orb to remember.
#[tauri::command]
pub async fn assistant_ask(app: AppHandle, text: String, memory: Vec<String>) -> Result<String, String> {
    let text = text.trim().chars().take(4000).collect::<String>();
    if text.is_empty() {
        return Err("empty".into());
    }
    let extra = memory_prompt(&memory);
    let handle = app.clone();
    let reply = tauri::async_runtime::spawn_blocking(move || {
        let state = handle.state::<Assistant>();
        let mut brain = state.0.lock().unwrap();
        brain.extra = extra;
        brain.respond(&handle, &text)
    })
    .await
    .map_err(|e| e.to_string())?;
    match reply {
        Some(r) if !r.text.is_empty() => Ok(r.text),
        Some(r) if r.acted => Ok("Feito.".into()),
        _ => Err("Não consegui responder: confira sua chave do Claude em Ajustes → Chat.".into()),
    }
}

fn memory_prompt(memory: &[String]) -> String {
    let items: Vec<String> = memory
        .iter()
        .map(|m| m.trim().chars().take(300).collect::<String>())
        .filter(|m| !m.is_empty())
        .take(50)
        .map(|m| format!("- {m}"))
        .collect();
    if items.is_empty() {
        return String::new();
    }
    format!("\nWhat the user asked you to remember about them:\n{}", items.join("\n"))
}

/// Opens an app by name (Start menu shortcut / .desktop entry), for routines.
#[tauri::command]
pub fn panel_open_app(name: String) -> Result<String, String> {
    let (msg, ok) = crate::voice::open_app(&name);
    if ok { Ok(msg) } else { Err(msg) }
}

// ── Clipboard history ─────────────────────────────────────────────────────────
// In memory only, never written to disk: people copy passwords.

const CLIP_MAX: usize = 30;
const CLIP_MAX_CHARS: usize = 20_000;

fn clips() -> &'static Mutex<VecDeque<String>> {
    static CLIPS: std::sync::OnceLock<Mutex<VecDeque<String>>> = std::sync::OnceLock::new();
    CLIPS.get_or_init(|| Mutex::new(VecDeque::new()))
}

/// Puts `text` first in the history, without duplicates.
fn remember_clip(list: &mut VecDeque<String>, text: &str) -> bool {
    let trimmed = text.trim();
    if trimmed.is_empty() || text.chars().count() > CLIP_MAX_CHARS {
        return false;
    }
    if list.front().is_some_and(|f| f == text) {
        return false;
    }
    list.retain(|c| c != text);
    list.push_front(text.to_string());
    list.truncate(CLIP_MAX);
    true
}

fn start_clipboard_watch() {
    std::thread::Builder::new()
        .name("panel-clipboard".into())
        .spawn(|| {
            let mut last = String::new();
            let mut board = None;
            loop {
                std::thread::sleep(Duration::from_millis(1200));
                if board.is_none() {
                    board = arboard::Clipboard::new().ok();
                }
                let Some(b) = board.as_mut() else { continue };
                let Ok(text) = b.get_text() else { continue };
                if text != last {
                    remember_clip(&mut clips().lock().unwrap(), &text);
                    last = text;
                }
            }
        })
        .ok();
}

#[tauri::command]
pub fn clipboard_history() -> Vec<String> {
    clips().lock().unwrap().iter().cloned().collect()
}

#[tauri::command]
pub fn clipboard_copy(text: String) -> bool {
    arboard::Clipboard::new().and_then(|mut b| b.set_text(text)).is_ok()
}

#[tauri::command]
pub fn clipboard_clear() {
    clips().lock().unwrap().clear();
}

// ── Meu PC ────────────────────────────────────────────────────────────────────

#[derive(Serialize, Default, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PcInfo {
    pub host: String,
    pub os: String,
    /// 0…100 since the previous call (0 on the first).
    pub cpu: f64,
    pub mem_used: u64,
    pub mem_total: u64,
    pub disk_used: u64,
    pub disk_total: u64,
    pub uptime_secs: u64,
}

/// (busy, total) CPU ticks of the previous reading.
static CPU_PREV: Mutex<Option<(u64, u64)>> = Mutex::new(None);

fn cpu_percent(busy: u64, total: u64) -> f64 {
    let mut prev = CPU_PREV.lock().unwrap();
    let pct = match *prev {
        Some((b0, t0)) if total > t0 => (busy.saturating_sub(b0)) as f64 * 100.0 / (total - t0) as f64,
        _ => 0.0,
    };
    *prev = Some((busy, total));
    pct.clamp(0.0, 100.0)
}

#[tauri::command]
pub fn pc_info() -> PcInfo {
    platform_pc_info()
}

#[cfg(windows)]
fn platform_pc_info() -> PcInfo {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::FILETIME;
    use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    use windows::Win32::System::SystemInformation::{GetTickCount64, GlobalMemoryStatusEx, MEMORYSTATUSEX};
    use windows::Win32::System::Threading::GetSystemTimes;

    let mut info = PcInfo {
        host: std::env::var("COMPUTERNAME").unwrap_or_default(),
        os: "Windows".into(),
        ..Default::default()
    };
    let ft = |f: FILETIME| ((f.dwHighDateTime as u64) << 32) | f.dwLowDateTime as u64;
    unsafe {
        let mut mem = MEMORYSTATUSEX { dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32, ..Default::default() };
        if GlobalMemoryStatusEx(&mut mem).is_ok() {
            info.mem_total = mem.ullTotalPhys;
            info.mem_used = mem.ullTotalPhys.saturating_sub(mem.ullAvailPhys);
        }
        let (mut idle, mut kernel, mut user) = (FILETIME::default(), FILETIME::default(), FILETIME::default());
        if GetSystemTimes(Some(&mut idle), Some(&mut kernel), Some(&mut user)).is_ok() {
            // Kernel time includes idle time.
            let total = ft(kernel) + ft(user);
            info.cpu = cpu_percent(total.saturating_sub(ft(idle)), total);
        }
        info.uptime_secs = GetTickCount64() / 1000;
        let drive: Vec<u16> = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".into()).encode_utf16().chain("\\".encode_utf16()).chain([0]).collect();
        let (mut free, mut total) = (0u64, 0u64);
        if GetDiskFreeSpaceExW(PCWSTR(drive.as_ptr()), None, Some(&mut total), Some(&mut free)).is_ok() {
            info.disk_total = total;
            info.disk_used = total.saturating_sub(free);
        }
    }
    info
}

#[cfg(not(windows))]
fn platform_pc_info() -> PcInfo {
    let read = |p: &str| std::fs::read_to_string(p).unwrap_or_default();
    let mut info = PcInfo {
        host: read("/etc/hostname").trim().to_string(),
        os: "Linux".into(),
        ..Default::default()
    };
    let meminfo = read("/proc/meminfo");
    let kb = |key: &str| -> u64 {
        meminfo
            .lines()
            .find(|l| l.starts_with(key))
            .and_then(|l| l.split_whitespace().nth(1))
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(0)
            * 1024
    };
    info.mem_total = kb("MemTotal:");
    info.mem_used = info.mem_total.saturating_sub(kb("MemAvailable:"));
    if let Some(line) = read("/proc/stat").lines().next() {
        let v: Vec<u64> = line.split_whitespace().skip(1).filter_map(|x| x.parse().ok()).collect();
        if v.len() >= 4 {
            let total: u64 = v.iter().sum();
            let idle = v[3] + v.get(4).copied().unwrap_or(0);
            info.cpu = cpu_percent(total - idle, total);
        }
    }
    info.uptime_secs = read("/proc/uptime").split_whitespace().next().and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0) as u64;
    #[cfg(target_os = "linux")]
    unsafe {
        let mut st: libc::statvfs = std::mem::zeroed();
        if libc::statvfs(c"/".as_ptr(), &mut st) == 0 {
            info.disk_total = st.f_blocks as u64 * st.f_frsize as u64;
            info.disk_used = info.disk_total.saturating_sub(st.f_bavail as u64 * st.f_frsize as u64);
        }
    }
    info
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_clipboard_history_keeps_the_newest_first_without_duplicates() {
        let mut l = VecDeque::new();
        assert!(remember_clip(&mut l, "a"));
        assert!(remember_clip(&mut l, "b"));
        assert!(!remember_clip(&mut l, "b"));
        assert!(remember_clip(&mut l, "a"));
        assert_eq!(l, ["a", "b"]);
        assert!(!remember_clip(&mut l, "   "));
        for i in 0..40 {
            remember_clip(&mut l, &i.to_string());
        }
        assert_eq!(l.len(), CLIP_MAX);
        assert_eq!(l.front().unwrap(), "39");
    }

    #[test]
    fn memory_goes_into_the_prompt_trimmed() {
        assert_eq!(memory_prompt(&[]), "");
        assert_eq!(memory_prompt(&["  ".into()]), "");
        let p = memory_prompt(&["Meu nome é Ana".into(), " gosto de rock ".into()]);
        assert!(p.contains("- Meu nome é Ana\n- gosto de rock"));
    }

    #[test]
    fn pc_info_reads_this_machine() {
        let a = pc_info();
        assert!(a.mem_total > 0 && a.mem_used <= a.mem_total);
        assert!(a.disk_total == 0 || a.disk_used <= a.disk_total);
        let b = pc_info();
        assert!((0.0..=100.0).contains(&b.cpu));
    }
}
