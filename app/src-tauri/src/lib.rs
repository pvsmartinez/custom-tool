use std::path::Path;
use std::process::Command;

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![git_init, git_sync])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

