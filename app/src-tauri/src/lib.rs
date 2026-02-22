use std::path::Path;
use std::process::Command;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::Emitter;

/// Initialize a git repository at the given path (no-op if already a repo).
#[tauri::command]
fn git_init(path: String) -> Result<String, String> {
    let p = Path::new(&path);
    if p.join(".git").exists() {
        return Ok("already_initialized".into());
    }
    let output = Command::new("git")
        .args(["init", "-b", "main"])
        .current_dir(&path)
        .output()
        .map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok("initialized".into())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

/// Quick "add all + commit" for a workspace (mirrors sync.sh but from inside the app).
#[tauri::command]
fn git_sync(path: String, message: String) -> Result<String, String> {
    let run = |args: &[&str]| -> Result<(), String> {
        let out = Command::new("git")
            .args(args)
            .current_dir(&path)
            .output()
            .map_err(|e| e.to_string())?;
        if out.status.success() { Ok(()) }
        else { Err(String::from_utf8_lossy(&out.stderr).to_string()) }
    };
    run(&["add", "-A"])?;
    // Allow empty commits (nothing staged is fine)
    let _ = Command::new("git")
        .args(["commit", "-m", &message, "--allow-empty"])
        .current_dir(&path)
        .output();
    run(&["push", "origin", "HEAD"])
        .unwrap_or(()); // push is best-effort (no remote = ok)
    Ok("synced".into())
}

/// Build the app from source, copy it to ~/Applications, relaunch and exit.
/// Called by the in-app Update button. The project_root is embedded at
/// build time via Vite's define (see vite.config.ts).
#[tauri::command]
async fn update_app(project_root: String) -> Result<String, String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    let cargo_bin = format!("{}/.cargo/bin", home);
    let app_dir = format!("{}/app", project_root);

    // Incremental tauri build — only produce .app, not .dmg
    let build_cmd = format!(
        "export PATH=\"{}:$PATH\" && cd '{}' && npm run tauri build -- --bundles app",
        cargo_bin, app_dir
    );

    let status = tokio::process::Command::new("bash")
        .arg("-c")
        .arg(&build_cmd)
        .status()
        .await
        .map_err(|e| e.to_string())?;

    if !status.success() {
        return Err("Build failed — check the terminal for details.".into());
    }

    // Find the freshly built .app bundle
    let bundle_dir = format!("{}/app/src-tauri/target/release/bundle/macos", project_root);
    let app_path = std::fs::read_dir(&bundle_dir)
        .map_err(|e| e.to_string())?
        .flatten()
        .find(|e| e.path().extension().map(|x| x == "app").unwrap_or(false))
        .map(|e| e.path())
        .ok_or_else(|| "No .app bundle found after build".to_string())?;

    // Install to ~/Applications (no sudo needed)
    let install_dir = format!("{}/Applications", home);
    std::fs::create_dir_all(&install_dir).map_err(|e| e.to_string())?;
    let dest = format!("{}/custom-tool.app", install_dir);

    let _ = std::fs::remove_dir_all(&dest); // remove old version
    tokio::process::Command::new("cp")
        .args(["-R", app_path.to_str().unwrap_or_default(), &dest])
        .status()
        .await
        .map_err(|e| e.to_string())?;

    // Relaunch new version, then exit this process
    tokio::process::Command::new("open")
        .arg(&dest)
        .spawn()
        .map_err(|e| e.to_string())?;

    tokio::time::sleep(tokio::time::Duration::from_millis(800)).await;
    std::process::exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // ── Native macOS menu bar ───────────────────────────────
            let update_item = MenuItem::with_id(
                app, "update_app", "Update custom-tool\u{2026}", true, Some("cmd+shift+u")
            )?;
            let separator = PredefinedMenuItem::separator(app)?;
            let hide      = PredefinedMenuItem::hide(app, None)?;
            let hide_others = PredefinedMenuItem::hide_others(app, None)?;
            let quit      = PredefinedMenuItem::quit(app, Some("Quit custom-tool"))?;

            let app_menu = Submenu::with_items(
                app, "custom-tool", true,
                &[&update_item, &separator, &hide, &hide_others, &separator, &quit],
            )?;

            // Standard Edit menu so copy/paste/undo work normally
            let undo       = PredefinedMenuItem::undo(app, None)?;
            let redo       = PredefinedMenuItem::redo(app, None)?;
            let sep2       = PredefinedMenuItem::separator(app)?;
            let cut        = PredefinedMenuItem::cut(app, None)?;
            let copy       = PredefinedMenuItem::copy(app, None)?;
            let paste      = PredefinedMenuItem::paste(app, None)?;
            let select_all = PredefinedMenuItem::select_all(app, None)?;
            let edit_menu  = Submenu::with_items(
                app, "Edit", true,
                &[&undo, &redo, &sep2, &cut, &copy, &paste, &select_all],
            )?;

            let menu = Menu::with_items(app, &[&app_menu, &edit_menu])?;
            app.set_menu(menu)?;

            // Emit to the webview so the frontend can respond
            let handle = app.handle().clone();
            app.on_menu_event(move |_app, event| {
                if event.id().as_ref() == "update_app" {
                    let _ = handle.emit("menu-update-app", ());
                }
            });

            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![git_init, git_sync, update_app])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

