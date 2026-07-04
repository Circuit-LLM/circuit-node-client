// lib.rs — the Circuit Node desktop host.
//
// This is a THIN native shell around the existing circuit-node-client. It does the things a
// browser tab can't: supervise the node as a background service, live in the system tray,
// fire OS notifications, launch on login, and talk to the node's local API from the Rust side
// (so the webview never fights CORS). Everything the node actually does — join the GPU
// inference mesh, host agents for the CPU agent cloud, earn, update — is still the node-client;
// the app drives it through its localhost API. The command-line install is unaffected.
//
// Data model:
//   - The node-client runs as a bundled, self-contained sidecar binary (bun-compiled).
//   - It reads its two shipped assets from CIRCUIT_NODE_ASSETS (a read-only resource dir).
//   - It writes config + identity + cache to CIRCUIT_NODE_HOME (a writable per-user dir).
// That split is what lets a sidecar live inside a signed, read-only app bundle.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::path::BaseDirectory;
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

const APP_VERSION: &str = env!("CARGO_PKG_VERSION");
const GITHUB_RELEASES: &str = "https://api.github.com/repos/Circuit-LLM/circuit-node-client/releases/latest";
// Consecutive-crash backstop: after this many restarts in a row the host stops respawning and
// surfaces a terminal "can't start" state, instead of looping forever (matches the client's own
// MAX_RESTARTS spirit — the host must not defeat it by endlessly respawning fresh processes).
const MAX_RESTARTS: u32 = 6;

// ── Shared state ────────────────────────────────────────────────────────────────
struct NodeState {
    port: u16,
    home: PathBuf,
    assets: PathBuf,
    child: Mutex<Option<CommandChild>>,
    shutting_down: AtomicBool,
    running: AtomicBool,
    restarts: AtomicU32,
    gave_up: AtomicBool,
    manual_restart: AtomicBool,
    http: reqwest::Client,
}

#[derive(Serialize, Clone)]
struct NodeInfo {
    port: u16,
    running: bool,
    restarts: u32,
    app_version: String,
    home: String,
}

#[derive(Serialize, Clone)]
struct ApiResponse {
    status: u16,
    ok: bool,
    body: Value,
}

#[derive(Serialize, Clone)]
struct UpdateInfo {
    current: String,
    latest: Option<String>,
    available: bool,
    url: Option<String>,
    notes: Option<String>,
    error: Option<String>,
}

// ── Sidecar supervision ─────────────────────────────────────────────────────────
// Spawn the node-client sidecar and keep it alive. On an unexpected exit we restart with a
// short backoff (unless the app is quitting), and notify the operator the node dropped —
// a node is supposed to survive crashes and reboots.
fn spawn_sidecar(app: AppHandle) {
    let state = app.state::<NodeState>();
    let cmd = match app.shell().sidecar("circuit-node") {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[host] cannot locate sidecar: {e}");
            return;
        }
    };
    let cmd = cmd
        .args(["start"])
        .env("CIRCUIT_NODE_ASSETS", state.assets.to_string_lossy().to_string())
        .env("CIRCUIT_NODE_HOME", state.home.to_string_lossy().to_string());

    let (mut rx, child) = match cmd.spawn() {
        Ok(pair) => pair,
        Err(e) => {
            eprintln!("[host] sidecar spawn failed: {e}");
            return;
        }
    };
    *state.child.lock().unwrap() = Some(child);
    state.running.store(true, Ordering::SeqCst);
    let _ = app.emit("node-status", node_info(&state));

    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => print!("{}", String::from_utf8_lossy(&bytes)),
                CommandEvent::Stderr(bytes) => eprint!("{}", String::from_utf8_lossy(&bytes)),
                CommandEvent::Error(err) => eprintln!("[host] sidecar error: {err}"),
                CommandEvent::Terminated(payload) => {
                    let st = app2.state::<NodeState>();
                    st.running.store(false, Ordering::SeqCst);
                    *st.child.lock().unwrap() = None;
                    let _ = app2.emit("node-status", node_info(&st));
                    if st.shutting_down.load(Ordering::SeqCst) {
                        break;
                    }
                    let n = st.restarts.fetch_add(1, Ordering::SeqCst) + 1;
                    if n > MAX_RESTARTS {
                        // Give up rather than loop forever (defeating the client's own backstop and
                        // spamming a notification every few seconds). Surface a terminal state.
                        eprintln!("[host] sidecar failed {n} times — giving up until manual restart");
                        st.gave_up.store(true, Ordering::SeqCst);
                        let _ = app2.emit("node-failed", ());
                        notify(&app2, "Circuit Node can't start",
                               "The node stopped repeatedly. Open the app and use Restart node, or check the logs.");
                        break;
                    }
                    // Notify only on the first crash of a burst, and never for a user-requested
                    // restart (that's expected, not a scary "node dropped"). Capped-linear backoff.
                    let manual = st.manual_restart.swap(false, Ordering::SeqCst);
                    if n == 1 && !manual {
                        notify(&app2, "Circuit Node stopped", "The node dropped — restarting…");
                    }
                    let delay = std::cmp::min(30, 3 * n as u64);
                    eprintln!("[host] sidecar exited (code {:?}) — restart #{n} in {delay}s", payload.code);
                    let app3 = app2.clone();
                    tauri::async_runtime::spawn(async move {
                        tokio::time::sleep(std::time::Duration::from_secs(delay)).await;
                        if !app3.state::<NodeState>().shutting_down.load(Ordering::SeqCst) {
                            spawn_sidecar(app3);
                        }
                    });
                    break;
                }
                _ => {}
            }
        }
    });
}

fn node_info(state: &NodeState) -> NodeInfo {
    NodeInfo {
        port: state.port,
        running: state.running.load(Ordering::SeqCst),
        restarts: state.restarts.load(Ordering::SeqCst),
        app_version: APP_VERSION.to_string(),
        home: state.home.to_string_lossy().to_string(),
    }
}

// ── Config seed ─────────────────────────────────────────────────────────────────
// On first run, seed CIRCUIT_NODE_HOME/config/client.json from the shipped example, pinning
// the port and turning the client's own auto-update OFF: the app uses manual, button-driven
// updates (a bundled sidecar can't self-replace its code inside a read-only app bundle).
fn seed_config(state: &NodeState) -> std::io::Result<()> {
    let cfg_dir = state.home.join("config");
    let cfg = cfg_dir.join("client.json");
    if cfg.exists() {
        return Ok(()); // respect the operator's existing config (and its pinned port)
    }
    std::fs::create_dir_all(&cfg_dir)?;
    // The shipped example is required — seeding an empty config would leave the node with no
    // registry URL. Fail loudly instead of silently writing a broken config.
    let example = state.assets.join("config").join("client.example.json");
    let raw = std::fs::read_to_string(&example)?;
    let mut v: Value = serde_json::from_str(&raw)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    if !v.get("node").map_or(false, |n| n.is_object()) {
        v["node"] = json!({});
    }
    v["node"]["apiPort"] = json!(state.port);
    if !v.get("updates").map_or(false, |u| u.is_object()) {
        v["updates"] = json!({});
    }
    v["updates"]["autoUpdate"] = json!(false); // manual updates — the app never self-applies
    let s = serde_json::to_string_pretty(&v)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
    std::fs::write(&cfg, s)
}

// The node.apiPort already pinned in a seeded config — the single source of truth for the port.
fn read_config_port(cfg_path: &std::path::Path) -> Option<u16> {
    let s = std::fs::read_to_string(cfg_path).ok()?;
    let v: Value = serde_json::from_str(&s).ok()?;
    v.get("node")?.get("apiPort")?.as_u64().map(|n| n as u16)
}

// First bindable port at/above 19000 — used ONLY when seeding a fresh config. A desktop box
// almost always gets 19000, but never fail to launch because something already holds it.
fn resolve_port() -> u16 {
    for p in 19000u16..19025 {
        if std::net::TcpListener::bind(("127.0.0.1", p)).is_ok() {
            return p;
        }
    }
    19000
}

// Blocking /health probe used at startup to decide adopt-vs-spawn.
fn node_healthy(port: u16) -> bool {
    tauri::async_runtime::block_on(async move {
        reqwest::Client::new()
            .get(format!("http://127.0.0.1:{port}/health"))
            .timeout(std::time::Duration::from_secs(2))
            .send()
            .await
            .map(|r| r.status().is_success())
            .unwrap_or(false)
    })
}

// ── Native helpers ──────────────────────────────────────────────────────────────
fn notify(app: &AppHandle, title: &str, body: &str) {
    let _ = app
        .notification()
        .builder()
        .title(title)
        .body(body)
        .show();
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn semver_gt(a: &str, b: &str) -> bool {
    let parse = |s: &str| -> (u64, u64, u64) {
        let clean = s.trim_start_matches('v');
        let mut it = clean.split(|c: char| c == '.' || c == '-' || c == '+');
        let n = |o: Option<&str>| o.and_then(|x| x.parse::<u64>().ok()).unwrap_or(0);
        (n(it.next()), n(it.next()), n(it.next()))
    };
    parse(a) > parse(b)
}

// ── Commands (callable from the webview) ────────────────────────────────────────
#[tauri::command]
fn node_info_cmd(state: State<NodeState>) -> NodeInfo {
    node_info(&state)
}

// Proxy a request to the local node API from the Rust side — no CORS, and the webview never
// needs to know the port or hold the admin token (localhost is auto-trusted by the node).
#[tauri::command]
async fn node_api(
    state: State<'_, NodeState>,
    method: String,
    path: String,
    body: Option<Value>,
) -> Result<ApiResponse, String> {
    // Must be an absolute path on the local node. Rejecting non-'/' prefixes stops a compromised
    // renderer turning "127.0.0.1:PORT" into userinfo (e.g. path="@evil.com/..") to reach off-host;
    // the client is also built with redirect::none so a hostile 3xx can't bounce it away.
    if !path.starts_with('/') {
        return Err("path must start with '/'".into());
    }
    let url = format!("http://127.0.0.1:{}{}", state.port, path);
    let m = method.to_uppercase();
    let mut req = match m.as_str() {
        "GET" => state.http.get(&url),
        "POST" => state.http.post(&url),
        "PUT" => state.http.put(&url),
        "DELETE" => state.http.delete(&url),
        _ => return Err(format!("unsupported method {m}")),
    };
    if let Some(b) = body {
        req = req.json(&b);
    }
    let resp = req.send().await.map_err(|e| e.to_string())?;
    let status = resp.status().as_u16();
    let ok = resp.status().is_success();
    let text = resp.text().await.unwrap_or_default();
    let body = serde_json::from_str(&text).unwrap_or_else(|_| json!({ "raw": text }));
    Ok(ApiResponse { status, ok, body })
}

// Shared by the command and the tray. Resets the crash counter + give-up state (so a manual
// restart always gets a fresh set of attempts), marks the next termination as expected (no scary
// notification), and respawns — spawning fresh if the node had given up or was adopted.
fn do_restart(app: &AppHandle) {
    let st = app.state::<NodeState>();
    st.restarts.store(0, Ordering::SeqCst);
    st.gave_up.store(false, Ordering::SeqCst);
    st.manual_restart.store(true, Ordering::SeqCst);
    let child = st.child.lock().unwrap().take();
    match child {
        Some(c) => {
            let _ = c.kill(); // Terminated handler respawns with counters reset
        }
        None => spawn_sidecar(app.clone()), // stopped / gave-up / adopted → spawn fresh
    }
}

#[tauri::command]
fn restart_node(app: AppHandle) {
    do_restart(&app);
}

#[tauri::command]
async fn check_app_update(state: State<'_, NodeState>) -> Result<UpdateInfo, String> {
    let mut info = UpdateInfo {
        current: APP_VERSION.to_string(),
        latest: None,
        available: false,
        url: None,
        notes: None,
        error: None,
    };
    let resp = state
        .http
        .get(GITHUB_RELEASES)
        .header("User-Agent", format!("circuit-node-desktop/{APP_VERSION}"))
        .header("Accept", "application/vnd.github+json")
        .send()
        .await;
    match resp {
        Ok(r) if r.status().is_success() => {
            let v: Value = r.json().await.map_err(|e| e.to_string())?;
            let tag = v.get("tag_name").and_then(|t| t.as_str()).unwrap_or("");
            let latest = tag.trim_start_matches('v').to_string();
            if !latest.is_empty() {
                info.available = semver_gt(&latest, APP_VERSION);
                info.latest = Some(latest);
                info.url = v.get("html_url").and_then(|u| u.as_str()).map(String::from);
                info.notes = v
                    .get("body")
                    .and_then(|b| b.as_str())
                    .map(|s| s.chars().take(400).collect());
            }
        }
        Ok(r) if r.status().as_u16() == 404 => { /* no releases yet — up to date */ }
        Ok(r) => info.error = Some(format!("GitHub HTTP {}", r.status().as_u16())),
        Err(e) => info.error = Some(e.to_string()),
    }
    Ok(info)
}

#[tauri::command]
fn open_url(app: AppHandle, url: String) -> Result<(), String> {
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
fn notify_cmd(app: AppHandle, title: String, body: String) {
    notify(&app, &title, &body);
}

#[tauri::command]
fn get_autostart(app: AppHandle) -> bool {
    app.autolaunch().is_enabled().unwrap_or(false)
}

#[tauri::command]
fn set_autostart(app: AppHandle, enabled: bool) -> Result<(), String> {
    let mgr = app.autolaunch();
    if enabled {
        mgr.enable().map_err(|e| e.to_string())
    } else {
        mgr.disable().map_err(|e| e.to_string())
    }
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    let state = app.state::<NodeState>();
    state.shutting_down.store(true, Ordering::SeqCst);
    if let Some(child) = state.child.lock().unwrap().take() {
        let _ = child.kill();
    }
    app.exit(0);
}

// ── Tray ────────────────────────────────────────────────────────────────────────
fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Circuit Node", true, None::<&str>)?;
    let restart = MenuItem::with_id(app, "restart", "Restart node", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &restart, &sep, &quit])?;

    TrayIconBuilder::with_id("main-tray")
        .icon(app.default_window_icon().unwrap().clone())
        .tooltip("Circuit Node")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main(app),
            "restart" => do_restart(app),
            "quit" => quit_app(app.clone()),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(&tray.app_handle().clone());
            }
        })
        .build(app)?;
    Ok(())
}

// ── Entry ─────────────────────────────────────────────────────────────────────
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // single-instance MUST be the first plugin — focus the running window instead of a 2nd node.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main(app);
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
        .invoke_handler(tauri::generate_handler![
            node_info_cmd,
            node_api,
            restart_node,
            check_app_update,
            open_url,
            notify_cmd,
            get_autostart,
            set_autostart,
            quit_app
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let home = handle
                .path()
                .app_data_dir()
                .expect("app data dir")
                .join("node");
            let assets = handle
                .path()
                .resolve("node-client-assets", BaseDirectory::Resource)
                .expect("bundled node-client assets");
            std::fs::create_dir_all(&home).ok();

            // Port: the seeded config is the single source of truth. Read it back if present;
            // only pick a fresh free port when there's no config yet. This keeps the host and the
            // sidecar in lockstep across restarts (they used to diverge whenever the free-port
            // landscape changed between runs).
            let cfg_path = home.join("config").join("client.json");
            let port = read_config_port(&cfg_path).unwrap_or_else(resolve_port);

            let state = NodeState {
                port,
                home,
                assets,
                child: Mutex::new(None),
                shutting_down: AtomicBool::new(false),
                running: AtomicBool::new(false),
                restarts: AtomicU32::new(0),
                gave_up: AtomicBool::new(false),
                manual_restart: AtomicBool::new(false),
                http: reqwest::Client::builder()
                    .timeout(std::time::Duration::from_secs(100))
                    .redirect(reqwest::redirect::Policy::none()) // node_api must not be redirected off-host
                    .build()
                    .expect("http client"),
            };
            if let Err(e) = seed_config(&state) {
                eprintln!("[host] WARNING: could not seed config: {e} — the node may fail to start");
            }

            // Adopt a node already serving on this port (an orphan from a hard-quit/panic, or a
            // CLI-run node) instead of spawning a duplicate that would fight over the port + PID file.
            let already = node_healthy(port);
            app.manage(state);
            build_tray(&handle)?;
            if already {
                eprintln!("[host] node already serving on :{port} — adopting it (no duplicate spawn)");
                let st = handle.state::<NodeState>();
                st.running.store(true, Ordering::SeqCst);
                let _ = handle.emit("node-status", node_info(&st));
            } else {
                spawn_sidecar(handle.clone());
            }

            // Autostart launches with --minimized: stay in the tray instead of popping a window on
            // login (a node is a background service). The user opens it from the tray when needed.
            if std::env::args().any(|a| a == "--minimized") {
                if let Some(w) = handle.get_webview_window("main") {
                    let _ = w.hide();
                }
            }
            Ok(())
        })
        // Close = hide to tray (a node should keep running). Quit is explicit (tray → Quit).
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Circuit Node")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                let st = app.state::<NodeState>();
                st.shutting_down.store(true, Ordering::SeqCst);
                // Take the child in its own statement so the MutexGuard drops before `st` does.
                let child = st.child.lock().unwrap().take();
                if let Some(child) = child {
                    let _ = child.kill();
                }
            }
        });
}
