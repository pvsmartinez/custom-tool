use std::path::Path;
#[cfg(not(any(feature = "mas", target_os = "ios")))]
use std::process::Command;
// Stdio is only needed by update_app which is desktop-only
#[cfg(not(target_os = "ios"))]
use std::process::Stdio;
#[cfg(desktop)]
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::Emitter;
use tauri_plugin_opener::OpenerExt;
use tokio::io::AsyncBufReadExt;


/// Opens the webview DevTools inspector (debug builds only).
#[tauri::command]
fn open_devtools(webview_window: tauri::WebviewWindow) {
    #[cfg(debug_assertions)]
    webview_window.open_devtools();
    #[cfg(not(debug_assertions))]
    let _ = webview_window; // no-op in release builds
}

// ── shell_run ─────────────────────────────────────────────────────────────────
// CLI variant: desktop dev builds (local, PC, Linux)
#[cfg(not(any(feature = "mas", target_os = "ios")))]
#[tauri::command]
fn shell_run(cmd: String, cwd: String) -> Result<serde_json::Value, String> {
    let home = std::env::var("HOME").unwrap_or_default();
    if home.is_empty() || !cwd.starts_with(&home) {
        return Err(format!("shell_run: cwd must be within $HOME (rejected: {cwd})"));
    }
    let output = Command::new("bash")
        .args(["-c", &cmd])
        .current_dir(&cwd)
        .output()
        .map_err(|e| e.to_string())?;

    let cap = |bytes: &[u8]| -> String {
        let s = String::from_utf8_lossy(bytes);
        if s.chars().count() > 8_000 {
            format!("{}\n\n[… output truncated]", s.chars().take(8_000).collect::<String>())
        } else {
            s.to_string()
        }
    };

    Ok(serde_json::json!({
        "stdout":    cap(&output.stdout),
        "stderr":    cap(&output.stderr),
        "exit_code": output.status.code().unwrap_or(-1),
    }))
}

// Store/sandbox variant: App Sandbox and iOS do not allow arbitrary shell execution
#[cfg(any(feature = "mas", target_os = "ios"))]
#[tauri::command]
fn shell_run(_cmd: String, _cwd: String) -> Result<serde_json::Value, String> {
    Err("shell_run is not available in App Store / iOS builds".into())
}

// ── git commands ──────────────────────────────────────────────────────────────
// Each command has two variants selected at compile-time:
//   • not(mas | ios)  → wraps the system `git` CLI (dev builds, Linux, Windows)
//   • mas | ios       → pure-Rust via libgit2 (App Store / iOS sandbox)

// git_init ────────────────────────────────────────────────────────────────────
#[cfg(not(any(feature = "mas", target_os = "ios")))]
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

#[cfg(any(feature = "mas", target_os = "ios"))]
#[tauri::command]
fn git_init(path: String) -> Result<String, String> {
    git_native::git_init(path)
}

// git_diff ────────────────────────────────────────────────────────────────────
#[cfg(not(any(feature = "mas", target_os = "ios")))]
#[tauri::command]
fn git_diff(path: String) -> Result<serde_json::Value, String> {
    let status_out = Command::new("git")
        .args(["status", "--short"])
        .current_dir(&path)
        .output()
        .map_err(|e| e.to_string())?;
    let files: Vec<String> = String::from_utf8_lossy(&status_out.stdout)
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| l.to_string())
        .collect();

    let diff_out = Command::new("git")
        .args(["diff", "HEAD"])
        .current_dir(&path)
        .output()
        .map_err(|e| e.to_string())?;
    let diff = if diff_out.status.success() {
        String::from_utf8_lossy(&diff_out.stdout).to_string()
    } else {
        String::new()
    };

    Ok(serde_json::json!({ "files": files, "diff": diff }))
}

#[cfg(any(feature = "mas", target_os = "ios"))]
#[tauri::command]
fn git_diff(path: String) -> Result<serde_json::Value, String> {
    git_native::git_diff(path)
}

// git_sync ────────────────────────────────────────────────────────────────────
#[cfg(not(any(feature = "mas", target_os = "ios")))]
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
    let _ = Command::new("git")
        .args(["commit", "-m", &message, "--allow-empty"])
        .current_dir(&path)
        .output();
    run(&["push", "origin", "HEAD"]).unwrap_or(());
    Ok("synced".into())
}

#[cfg(any(feature = "mas", target_os = "ios"))]
#[tauri::command]
fn git_sync(path: String, message: String) -> Result<String, String> {
    git_native::git_sync(path, message)
}

// git_get_remote ──────────────────────────────────────────────────────────────
#[cfg(not(any(feature = "mas", target_os = "ios")))]
#[tauri::command]
fn git_get_remote(path: String) -> Result<String, String> {
    let out = Command::new("git")
        .args(["remote", "get-url", "origin"])
        .current_dir(&path)
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err("no remote".into())
    }
}

#[cfg(any(feature = "mas", target_os = "ios"))]
#[tauri::command]
fn git_get_remote(path: String) -> Result<String, String> {
    git_native::git_get_remote(path)
}

// git_checkout_file ───────────────────────────────────────────────────────────
#[cfg(not(any(feature = "mas", target_os = "ios")))]
#[tauri::command]
fn git_checkout_file(path: String, file: String) -> Result<String, String> {
    let out = Command::new("git")
        .args(["checkout", "--", &file])
        .current_dir(&path)
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok("reverted".into())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).to_string())
    }
}

#[cfg(any(feature = "mas", target_os = "ios"))]
#[tauri::command]
fn git_checkout_file(path: String, file: String) -> Result<String, String> {
    git_native::git_checkout_file(path, file)
}

// ── Native git2 implementations (MAS / iOS) ───────────────────────────────────
// Compiled only when feature = "mas" OR target_os = "ios".
// Uses libgit2 (vendored) — no external `git` binary required.
#[cfg(any(feature = "mas", target_os = "ios"))]
mod git_native {
    use git2::{build::CheckoutBuilder, IndexAddOption, PushOptions,
               RemoteCallbacks, Repository, RepositoryInitOptions, Signature};

    pub fn git_init(path: String) -> Result<String, String> {
        if std::path::Path::new(&path).join(".git").exists() {
            return Ok("already_initialized".into());
        }
        let mut opts = RepositoryInitOptions::new();
        opts.initial_head("main");
        Repository::init_opts(&path, &opts).map_err(|e| e.to_string())?;
        Ok("initialized".into())
    }

    pub fn git_diff(path: String) -> Result<serde_json::Value, String> {
        let repo = Repository::open(&path).map_err(|e| e.to_string())?;

        let statuses = repo.statuses(None).map_err(|e| e.to_string())?;
        let files: Vec<String> = statuses
            .iter()
            .filter(|e| !e.status().is_empty() && e.status() != git2::Status::CURRENT)
            .filter_map(|e| {
                let s = e.status();
                let flag = if s.contains(git2::Status::WT_NEW)
                             || s.contains(git2::Status::INDEX_NEW)
                {
                    "?? "
                } else if s.contains(git2::Status::INDEX_MODIFIED)
                           || s.contains(git2::Status::WT_MODIFIED)
                {
                    " M "
                } else if s.contains(git2::Status::INDEX_DELETED)
                           || s.contains(git2::Status::WT_DELETED)
                {
                    " D "
                } else {
                    "   "
                };
                Some(format!("{}{}", flag, e.path().unwrap_or("")))
            })
            .collect();

        // Unified diff vs HEAD
        let diff_text = repo
            .head()
            .ok()
            .and_then(|h| h.peel_to_commit().ok())
            .and_then(|c| c.tree().ok())
            .and_then(|tree| {
                repo.diff_tree_to_workdir_with_index(Some(&tree), None).ok()
            })
            .map(|d| {
                let mut out = String::new();
                let _ = d.print(git2::DiffFormat::Patch, |_, _, line| {
                    let origin = line.origin();
                    // Include all patch lines; B = Binary (skip)
                    if origin != 'B' {
                        out.push(origin);
                        out.push_str(std::str::from_utf8(line.content()).unwrap_or(""));
                    }
                    true
                });
                out
            })
            .unwrap_or_default();

        Ok(serde_json::json!({ "files": files, "diff": diff_text }))
    }

    pub fn git_sync(path: String, message: String) -> Result<String, String> {
        let repo = Repository::open(&path).map_err(|e| e.to_string())?;

        // Stage all changes
        let mut index = repo.index().map_err(|e| e.to_string())?;
        index
            .add_all(["*"].iter(), IndexAddOption::DEFAULT, None)
            .map_err(|e| e.to_string())?;
        index.write().map_err(|e| e.to_string())?;

        // Commit
        let tree_id = index.write_tree().map_err(|e| e.to_string())?;
        let tree = repo.find_tree(tree_id).map_err(|e| e.to_string())?;
        let sig = repo
            .signature()
            .or_else(|_| Signature::now("Cafezin", "cafezin@local"))
            .map_err(|e| e.to_string())?;
        let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
        let parents: Vec<&git2::Commit> = parent.iter().collect();
        repo.commit(Some("HEAD"), &sig, &sig, &message, &tree, &parents)
            .map_err(|e| e.to_string())?;

        // Push best-effort (uses SSH agent / system credential helper)
        if let Ok(mut remote) = repo.find_remote("origin") {
            let mut callbacks = RemoteCallbacks::new();
            callbacks.credentials(|_url, username, allowed| {
                if allowed.contains(git2::CredentialType::SSH_KEY) {
                    git2::Cred::ssh_key_from_agent(username.unwrap_or("git"))
                } else if allowed.contains(git2::CredentialType::DEFAULT) {
                    git2::Cred::default()
                } else {
                    Err(git2::Error::from_str("no credential method available"))
                }
            });
            let mut push_opts = PushOptions::new();
            push_opts.remote_callbacks(callbacks);
            // Detect current branch name
            let branch = repo
                .head()
                .ok()
                .and_then(|h| h.shorthand().map(|s| s.to_string()))
                .unwrap_or_else(|| "main".to_string());
            let refspec = format!("refs/heads/{branch}:refs/heads/{branch}");
            let _ = remote.push(&[&refspec], Some(&mut push_opts)); // best-effort
        }

        Ok("synced".into())
    }

    pub fn git_get_remote(path: String) -> Result<String, String> {
        let repo = Repository::open(&path).map_err(|e| e.to_string())?;
        let remote = repo
            .find_remote("origin")
            .map_err(|_| "no remote".to_string())?;
        Ok(remote.url().unwrap_or("").to_string())
    }

    pub fn git_checkout_file(path: String, file: String) -> Result<String, String> {
        let repo = Repository::open(&path).map_err(|e| e.to_string())?;
        let mut opts = CheckoutBuilder::new();
        opts.path(&file).force();
        repo.checkout_head(Some(&mut opts))
            .map_err(|e| e.to_string())?;
        Ok("reverted".into())
    }
}


/// Returns the distribution channel so the frontend can adapt its update UI.
/// "dev"  → local dev build / sideload / non-store build (script-based update)
/// "mas"  → Mac App Store (cargo feature `mas`)
/// "ios"  → iOS App Store
#[tauri::command]
fn build_channel() -> &'static str {
    if cfg!(target_os = "ios") { "ios" }
    else if cfg!(feature = "mas") { "mas" }
    else { "dev" }
}

/// Transcribe a base64-encoded audio blob (webm/ogg/mp4) via Groq's Whisper endpoint.
/// Returns the transcript text, or an error string.
#[tauri::command]
async fn transcribe_audio(audio_base64: String, mime_type: String, api_key: String) -> Result<String, String> {
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    let audio_bytes = STANDARD.decode(&audio_base64).map_err(|e| format!("base64 decode: {e}"))?;

    let ext = if mime_type.contains("webm") { "webm" }
               else if mime_type.contains("ogg") { "ogg" }
               else if mime_type.contains("mp4") { "mp4" }
               else { "webm" };
    let filename = format!("audio.{ext}");

    let part = reqwest::multipart::Part::bytes(audio_bytes)
        .file_name(filename)
        .mime_str(&mime_type).map_err(|e| e.to_string())?;
    let form = reqwest::multipart::Form::new()
        .part("file", part)
        .text("model", "whisper-large-v3-turbo")
        .text("response_format", "text");

    let client = reqwest::Client::new();
    let res = client
        .post("https://api.groq.com/openai/v1/audio/transcriptions")
        .bearer_auth(&api_key)
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;

    let status = res.status();
    let body = res.text().await.map_err(|e| e.to_string())?;
    if status.is_success() {
        Ok(body.trim().to_string())
    } else {
        Err(format!("Groq API error {status}: {body}"))
    }
}

/// Stub for iOS — App Store handles updates.
#[cfg(target_os = "ios")]
#[tauri::command]
async fn update_app(_app: tauri::AppHandle, _project_root: String) -> Result<(), String> {
    Err("update_app is not available on iOS — updates come through the App Store".into())
}

/// Build the app from source, streaming every output line to the frontend,
/// then copy to ~/Applications and relaunch. Events emitted:
///   update:log     { line: String }
///   update:success ()
///   update:error   { message: String }
#[cfg(not(target_os = "ios"))]
#[tauri::command]
async fn update_app(app: tauri::AppHandle, project_root: String) -> Result<(), String> {
    let emit_log = |line: &str| { let _ = app.emit("update:log", line.to_string()); };

    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    let cargo_bin = format!("{}/.cargo/bin", home);
    let app_dir   = format!("{}/app", project_root);

    let build_cmd = format!(
        r#"
        export PATH="{cargo_bin}:/usr/local/bin:/usr/local/opt/node@20/bin:/opt/homebrew/bin:/opt/homebrew/opt/node@20/bin:/usr/bin:/bin:$PATH"
        export NVM_DIR="{home}/.nvm"
        [ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh" --no-use
        cd '{app_dir}'
        npm run tauri build -- --bundles app 2>&1
        "#
    );

    emit_log("▸ Starting incremental build…");
    emit_log("");

    // Remove stale .app bundles from a previous build so the post-build search
    // always finds exactly one — the freshly produced one.
    let bundle_dir = format!("{}/app/src-tauri/target/release/bundle/macos", project_root);
    if std::path::Path::new(&bundle_dir).exists() {
        if let Ok(entries) = std::fs::read_dir(&bundle_dir) {
            for entry in entries.flatten() {
                if entry.path().extension().map(|x| x == "app").unwrap_or(false) {
                    let _ = std::fs::remove_dir_all(entry.path());
                }
            }
        }
    }

    let mut child = tokio::process::Command::new("bash")
        .arg("-c")
        .arg(&build_cmd)
        .stdout(Stdio::piped())
        .spawn()
        .map_err(|e| { let _ = app.emit("update:error", e.to_string()); e.to_string() })?;

    // Stream stdout line by line to the frontend
    if let Some(stdout) = child.stdout.take() {
        let mut reader = tokio::io::BufReader::new(stdout).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            emit_log(&line);
        }
    }

    let status = child.wait().await.map_err(|e| e.to_string())?;

    if !status.success() {
        let msg = "Build failed — see log above.".to_string();
        let _ = app.emit("update:error", &msg);
        return Err(msg);
    }

    emit_log("");
    emit_log("▸ Build succeeded — installing…");

    // Find the freshly built .app bundle — pick newest by mtime as a safety net
    let app_path = std::fs::read_dir(&bundle_dir)
        .map_err(|e| e.to_string())?
        .flatten()
        .filter(|e| e.path().extension().map(|x| x == "app").unwrap_or(false))
        .max_by_key(|e| e.metadata().and_then(|m| m.modified()).ok())
        .map(|e| e.path())
        .ok_or_else(|| "No .app bundle found after build".to_string())?;

    let install_dir = format!("{}/Applications", home);
    std::fs::create_dir_all(&install_dir).map_err(|e| e.to_string())?;
    let dest = format!("{}/Cafezin.app", install_dir);

    let _ = std::fs::remove_dir_all(&dest);
    let cp_status = tokio::process::Command::new("cp")
        .args(["-R", app_path.to_str().unwrap_or_default(), &dest])
        .status()
        .await
        .map_err(|e| e.to_string())?;

    if !cp_status.success() {
        let msg = format!("Failed to copy .app to {}", dest);
        let _ = app.emit("update:error", &msg);
        return Err(msg);
    }

    emit_log(&format!("▸ Installed to {}", dest));
    emit_log("");
    emit_log("✓  Done! Relaunching…");

    // Signal success — frontend shows countdown, then we relaunch
    let _ = app.emit("update:success", ());
    tokio::time::sleep(tokio::time::Duration::from_millis(3200)).await;

    // Relaunch via a detached shell so the new instance is fully independent
    // before this process exits. `open -n` forces a new instance even if one
    // is already running; the shell is double-forked so it outlives us.
    tokio::process::Command::new("bash")
        .arg("-c")
        .arg(format!("sleep 0.5 && open -n '{}' &", dest))
        .spawn()
        .map_err(|e| e.to_string())?;

    tokio::time::sleep(tokio::time::Duration::from_millis(800)).await;
    std::process::exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // ── Native macOS menu bar (desktop only) ───────────────
            #[cfg(desktop)]
            {
                // Label changes based on build channel:
                // dev → "Update Cafezin…" (triggers in-app build script)
                // mas → "Open App Store…"  (opens the store page)
                let update_label = if cfg!(feature = "mas") {
                    "Open App Store\u{2026}"
                } else {
                    "Update Cafezin\u{2026}"
                };
                let update_item = MenuItem::with_id(
                    app, "update_app", update_label, true, Some("cmd+shift+u")
                )?;
                let settings_item = MenuItem::with_id(
                    app, "settings", "Settings\u{2026}", true, Some("cmd+,")
                )?;
                let separator = PredefinedMenuItem::separator(app)?;
                let separator2 = PredefinedMenuItem::separator(app)?;
                let hide      = PredefinedMenuItem::hide(app, None)?;
                let hide_others = PredefinedMenuItem::hide_others(app, None)?;
                let quit      = PredefinedMenuItem::quit(app, Some("Quit Cafezin"))?;

                let app_menu = Submenu::with_items(
                    app, "Cafezin", true,
                    &[&update_item, &settings_item, &separator, &hide, &hide_others, &separator2, &quit],
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
                app.on_menu_event(move |_app, event: tauri::menu::MenuEvent| {
                    match event.id().as_ref() {
                        "update_app" => { let _ = handle.emit("menu-update-app", ()); }
                        "settings"   => { let _ = handle.emit("menu-settings", ()); }
                        _ => {}
                    }
                });
            }

            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .invoke_handler(tauri::generate_handler![git_init, git_diff, git_sync, git_checkout_file, git_get_remote, shell_run, update_app, transcribe_audio, open_devtools, build_channel])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

