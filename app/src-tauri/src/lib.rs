use std::path::Path;
use std::process::{Command, Stdio};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::Emitter;
use tauri_plugin_opener::OpenerExt;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt};
use sha2::{Digest, Sha256};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use rand::RngCore;

/// Run an arbitrary shell (bash) command in the given working directory.
/// Returns {stdout, stderr, exit_code}. Output capped at ~8 KB each.
#[tauri::command]
fn shell_run(cmd: String, cwd: String) -> Result<serde_json::Value, String> {
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

/// Returns changed file list (git status --short) and a unified diff vs HEAD.
#[tauri::command]
fn git_diff(path: String) -> Result<serde_json::Value, String> {
    // Changed files (staged + unstaged + untracked)
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

    // Unified diff vs HEAD (falls back to empty string when no commits yet)
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

/// Revert a single file to the last committed state (`git checkout -- <file>`).
/// `path` is the workspace root, `file` is the relative path within it.
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

/// Percent-encode a string for use in a URL query parameter value.
fn pct_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for byte in s.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9'
            | b'-' | b'_' | b'.' | b'~' => out.push(byte as char),
            b => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

/// Start a Google OAuth2 PKCE flow:
///   1. Generate code verifier + challenge.
///   2. Bind a local TCP listener on a random port (redirect_uri).
///   3. Open the user's browser to the Google consent page.
///   4. Wait up to 3 min for the browser callback (HTTP GET with ?code=).
///   5. Return { code, code_verifier, redirect_uri } to the frontend
///      so it can exchange the code for tokens directly.
#[tauri::command]
async fn google_oauth(app: tauri::AppHandle, client_id: String) -> Result<serde_json::Value, String> {
    // 1. PKCE: random 64-byte verifier → base64url; challenge = BASE64URL(SHA256(verifier))
    let mut verifier_bytes = [0u8; 64];
    rand::thread_rng().fill_bytes(&mut verifier_bytes);
    let code_verifier = URL_SAFE_NO_PAD.encode(verifier_bytes);

    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(code_verifier.as_bytes()));

    // 2. Bind to OS-assigned port
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect_uri = format!("http://127.0.0.1:{}", port);

    // 3. Build auth URL and open browser
    let scopes = "https://www.googleapis.com/auth/drive.file \
                  https://www.googleapis.com/auth/presentations";
    let auth_url = format!(
        "https://accounts.google.com/o/oauth2/v2/auth\
         ?client_id={client_id}\
         &redirect_uri={}\
         &response_type=code\
         &scope={}\
         &code_challenge={challenge}\
         &code_challenge_method=S256\
         &access_type=offline\
         &prompt=consent",
        pct_encode(&redirect_uri),
        pct_encode(scopes),
    );
    app.opener()
        .open_url(&auth_url, None::<&str>)
        .map_err(|e| e.to_string())?;

    // 4. Accept the redirect (3-minute timeout)
    let (mut stream, _) = tokio::time::timeout(
        tokio::time::Duration::from_secs(180),
        listener.accept(),
    )
    .await
    .map_err(|_| "OAuth timed out — no response after 3 minutes".to_string())?
    .map_err(|e| e.to_string())?;

    // Read the HTTP GET request
    let mut buf = [0u8; 8192];
    let n = stream.read(&mut buf).await.map_err(|e| e.to_string())?;
    let request = String::from_utf8_lossy(&buf[..n]).into_owned();

    // Parse code= from the request path  (GET /?code=XXX&... HTTP/1.1)
    let code = request
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|path| {
            let idx = path.find("code=")?;
            let rest = &path[idx + 5..];
            let end = rest.find(|c: char| c == '&' || c == ' ').unwrap_or(rest.len());
            Some(rest[..end].to_string())
        })
        .ok_or_else(|| {
            let snippet = &request[..request.len().min(300)];
            format!("OAuth callback did not contain a code. Response: {snippet}")
        })?;

    // 5. Send a nice success page to the browser
    let body = "<html><body style='font-family:-apple-system,sans-serif;\
                text-align:center;padding:80px;background:#1e2127;color:#abb2bf'>\
                <h2 style='color:#98c379'>✓ Connected to Google</h2>\
                <p>You can close this tab and return to custom-tool.</p></body></html>";
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\
         Content-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(), body
    );
    stream.write_all(response.as_bytes()).await.ok();

    Ok(serde_json::json!({
        "code": code,
        "code_verifier": code_verifier,
        "redirect_uri": redirect_uri,
    }))
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

/// Build the app from source, streaming every output line to the frontend,
/// then copy to ~/Applications and relaunch. Events emitted:
///   update:log     { line: String }
///   update:success ()
///   update:error   { message: String }
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

    // Find the freshly built .app bundle
    let bundle_dir = format!("{}/app/src-tauri/target/release/bundle/macos", project_root);
    let app_path = std::fs::read_dir(&bundle_dir)
        .map_err(|e| e.to_string())?
        .flatten()
        .find(|e| e.path().extension().map(|x| x == "app").unwrap_or(false))
        .map(|e| e.path())
        .ok_or_else(|| "No .app bundle found after build".to_string())?;

    let install_dir = format!("{}/Applications", home);
    std::fs::create_dir_all(&install_dir).map_err(|e| e.to_string())?;
    let dest = format!("{}/custom-tool.app", install_dir);

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
        .plugin(tauri_plugin_http::init())
        .invoke_handler(tauri::generate_handler![git_init, git_diff, git_sync, git_checkout_file, shell_run, update_app, google_oauth, transcribe_audio])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

