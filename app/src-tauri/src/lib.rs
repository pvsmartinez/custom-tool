#[cfg(not(any(feature = "mas", target_os = "ios")))]
use std::process::Command;
// Stdio is only needed by update_app which is desktop-only
#[cfg(not(target_os = "ios"))]
use std::process::Stdio;
#[cfg(desktop)]
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::Emitter;
use tauri_plugin_deep_link::DeepLinkExt;
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

// ── git_cli — CLI/shell variant (dev builds, Linux, Windows) ─────────────────
// Compiled only for non-MAS, non-iOS targets. Uses the system `git` binary.
#[cfg(not(any(feature = "mas", target_os = "ios")))]
mod git_cli {
    use std::path::Path;
    use std::process::Command;

    pub fn git_init(path: String) -> Result<String, String> {
        if Path::new(&path).join(".git").exists() {
            return Ok("already_initialized".into());
        }
        let output = Command::new("git")
            .args(["init", "-b", "main"])
            .current_dir(&path)
            .output()
            .map_err(|e| e.to_string())?;
        if output.status.success() { Ok("initialized".into()) }
        else { Err(String::from_utf8_lossy(&output.stderr).to_string()) }
    }

    pub fn git_diff(path: String) -> Result<serde_json::Value, String> {
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
        } else { String::new() };
        Ok(serde_json::json!({ "files": files, "diff": diff }))
    }

    pub fn git_sync(path: String, message: String) -> Result<String, String> {
        let run = |args: &[&str]| -> Result<(), String> {
            let out = Command::new("git").args(args).current_dir(&path)
                .output().map_err(|e| e.to_string())?;
            if out.status.success() { Ok(()) }
            else { Err(String::from_utf8_lossy(&out.stderr).to_string()) }
        };
        run(&["add", "-A"])?;
        let _ = Command::new("git")
            .args(["commit", "-m", &message, "--allow-empty"])
            .current_dir(&path).output();
        run(&["push", "origin", "HEAD"]).unwrap_or(());
        Ok("synced".into())
    }

    pub fn git_get_remote(path: String) -> Result<String, String> {
        let out = Command::new("git")
            .args(["remote", "get-url", "origin"])
            .current_dir(&path).output()
            .map_err(|e| e.to_string())?;
        if out.status.success() {
            Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
        } else { Err("no remote".into()) }
    }

    pub fn git_set_remote(path: String, url: String) -> Result<String, String> {
        // Try "add" first; fall back to "set-url" if origin already exists.
        let add = Command::new("git")
            .args(["remote", "add", "origin", &url])
            .current_dir(&path).output()
            .map_err(|e| e.to_string())?;
        if add.status.success() {
            return Ok("added".into());
        }
        let set = Command::new("git")
            .args(["remote", "set-url", "origin", &url])
            .current_dir(&path).output()
            .map_err(|e| e.to_string())?;
        if set.status.success() { Ok("updated".into()) }
        else { Err(String::from_utf8_lossy(&set.stderr).to_string()) }
    }

    pub fn git_clone(url: String, path: String, _token: Option<String>, branch: Option<String>) -> Result<String, String> {
        if std::path::Path::new(&path).join(".git").exists() {
            return Ok("already_cloned".into());
        }
        let mut args = vec!["clone"];
        // Temporary storage so the borrow lives long enough
        let branch_arg;
        if let Some(ref b) = branch {
            args.push("--branch");
            branch_arg = b.as_str();
            args.push(branch_arg);
        }
        args.push(&url);
        args.push(&path);
        let out = Command::new("git")
            .args(&args)
            .output()
            .map_err(|e| e.to_string())?;
        if out.status.success() { Ok("cloned".into()) }
        else { Err(String::from_utf8_lossy(&out.stderr).to_string()) }
    }

    pub fn git_pull(path: String, _token: Option<String>) -> Result<String, String> {
        let out = Command::new("git")
            .args(["pull", "--ff-only"])
            .current_dir(&path)
            .output()
            .map_err(|e| e.to_string())?;
        if out.status.success() { Ok("pulled".into()) }
        else { Err(String::from_utf8_lossy(&out.stderr).to_string()) }
    }

    pub fn git_checkout_file(path: String, file: String) -> Result<String, String> {
        let out = Command::new("git")
            .args(["checkout", "--", &file])
            .current_dir(&path).output()
            .map_err(|e| e.to_string())?;
        if out.status.success() { Ok("reverted".into()) }
        else { Err(String::from_utf8_lossy(&out.stderr).to_string()) }
    }

    pub fn git_checkout_branch(path: String, branch: String, token: Option<String>) -> Result<String, String> {
        // Fetch the latest from origin (so the branch exists locally if it's new)
        let _ = Command::new("git")
            .args(["fetch", "origin", &branch])
            .current_dir(&path)
            .output();
        // Checkout and reset to origin/<branch>
        let out = Command::new("git")
            .args(["checkout", "-B", &branch, &format!("origin/{branch}")])
            .current_dir(&path)
            .output()
            .map_err(|e| e.to_string())?;
        let _ = token; // token unused in CLI variant (credential helper handles auth)
        if out.status.success() { Ok("switched".into()) }
        else { Err(String::from_utf8_lossy(&out.stderr).to_string()) }
    }
}

// ── git_native — libgit2 variant (MAS / iOS sandbox) ─────────────────────────
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
            let mut tried = false;
            callbacks.credentials(move |_url, username, allowed| {
                if tried { return Err(git2::Error::from_str("authentication failed")); }
                tried = true;
                if allowed.contains(git2::CredentialType::SSH_KEY) {
                    git2::Cred::ssh_key_from_agent(username.unwrap_or("git"))
                } else if allowed.contains(git2::CredentialType::DEFAULT) {
                    git2::Cred::default()
                } else {
                    Err(git2::Error::from_str("no credential method available"))
                }
            });
            callbacks.certificate_check(|_cert, _valid| {
                Ok(git2::CertificateCheckStatus::CertificateOk)
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

    pub fn git_set_remote(path: String, url: String) -> Result<String, String> {
        let repo = Repository::open(&path).map_err(|e| e.to_string())?;
        // Delete then re-add so the call is always idempotent.
        let _ = repo.remote_delete("origin");
        repo.remote("origin", &url).map_err(|e| e.to_string())?;
        Ok("set".into())
    }

    pub fn git_clone(url: String, path: String, token: Option<String>, branch: Option<String>) -> Result<String, String> {
        // Idempotent: if the destination is already a valid git repo, skip the clone.
        if std::path::Path::new(&path).join(".git").exists() {
            return Ok("already_cloned".into());
        }
        let mut callbacks = RemoteCallbacks::new();
        // `tried` prevents the libgit2 credential loop: if called more than once
        // it means the first attempt failed — bail immediately instead of looping.
        if let Some(tok) = token {
            let mut tried = false;
            callbacks.credentials(move |_url, _username, allowed| {
                if tried { return Err(git2::Error::from_str("authentication failed")); }
                tried = true;
                if allowed.contains(git2::CredentialType::USER_PASS_PLAINTEXT) {
                    git2::Cred::userpass_plaintext("oauth2", &tok)
                } else {
                    git2::Cred::default()
                }
            });
        } else {
            let mut tried = false;
            callbacks.credentials(move |_url, username, allowed| {
                if tried { return Err(git2::Error::from_str("authentication failed")); }
                tried = true;
                if allowed.contains(git2::CredentialType::SSH_KEY) {
                    git2::Cred::ssh_key_from_agent(username.unwrap_or("git"))
                } else {
                    git2::Cred::default()
                }
            });
        }
        callbacks.certificate_check(|_cert, _valid| {
            Ok(git2::CertificateCheckStatus::CertificateOk)
        });
        let mut fetch_opts = git2::FetchOptions::new();
        fetch_opts.remote_callbacks(callbacks);
        let mut builder = git2::build::RepoBuilder::new();
        builder.fetch_options(fetch_opts);
        if let Some(ref b) = branch {
            if !b.is_empty() {
                builder.branch(b);
            }
        }
        builder.clone(&url, std::path::Path::new(&path)).map_err(|e| e.to_string())?;
        Ok("cloned".into())
    }

    pub fn git_pull(path: String, token: Option<String>) -> Result<String, String> {
        let repo = Repository::open(&path).map_err(|e| e.to_string())?;

        // Guard: detached HEAD or unborn branch (empty repo) — nothing to pull
        let head = match repo.head() {
            Ok(h) => h,
            Err(_) => return Ok("up_to_date".into()), // empty / unborn branch
        };
        if head.is_branch() == false {
            return Err("HEAD is detached — resolve on desktop".into());
        }
        let branch_name = head.shorthand().unwrap_or("main").to_string();

        let mut remote = repo.find_remote("origin").map_err(|e| e.to_string())?;
        let mut callbacks = RemoteCallbacks::new();
        if let Some(tok) = token {
            let mut tried = false;
            callbacks.credentials(move |_url, _username, allowed| {
                if tried { return Err(git2::Error::from_str("authentication failed")); }
                tried = true;
                if allowed.contains(git2::CredentialType::USER_PASS_PLAINTEXT) {
                    git2::Cred::userpass_plaintext("oauth2", &tok)
                } else {
                    git2::Cred::default()
                }
            });
        } else {
            let mut tried = false;
            callbacks.credentials(move |_url, username, allowed| {
                if tried { return Err(git2::Error::from_str("authentication failed")); }
                tried = true;
                if allowed.contains(git2::CredentialType::SSH_KEY) {
                    git2::Cred::ssh_key_from_agent(username.unwrap_or("git"))
                } else {
                    git2::Cred::default()
                }
            });
        }
        callbacks.certificate_check(|_cert, _valid| {
            Ok(git2::CertificateCheckStatus::CertificateOk)
        });
        let mut fetch_opts = git2::FetchOptions::new();
        fetch_opts.remote_callbacks(callbacks);
        remote.fetch(&[branch_name.as_str()], Some(&mut fetch_opts), None)
            .map_err(|e| e.to_string())?;

        let remote_ref = format!("refs/remotes/origin/{branch_name}");
        let remote_oid = repo.find_reference(&remote_ref)
            .map_err(|e| e.to_string())?
            .target()
            .ok_or_else(|| "remote ref has no target".to_string())?;
        let fetch_commit = repo.find_annotated_commit(remote_oid).map_err(|e| e.to_string())?;

        let (analysis, _) = repo.merge_analysis(&[&fetch_commit]).map_err(|e| e.to_string())?;
        if analysis.is_up_to_date() {
            return Ok("up_to_date".into());
        }
        if analysis.is_fast_forward() {
            let refname = format!("refs/heads/{branch_name}");
            let mut reference = repo.find_reference(&refname).map_err(|e| e.to_string())?;
            reference.set_target(fetch_commit.id(), "Fast-forward pull").map_err(|e| e.to_string())?;
            repo.set_head(&refname).map_err(|e| e.to_string())?;
            repo.checkout_head(Some(git2::build::CheckoutBuilder::default().force()))
                .map_err(|e| e.to_string())?;
            return Ok("pulled".into());
        }
        Err("Cannot fast-forward — resolve conflicts no desktop".into())
    }

    pub fn git_checkout_file(path: String, file: String) -> Result<String, String> {
        let repo = Repository::open(&path).map_err(|e| e.to_string())?;
        let mut checkout = CheckoutBuilder::new();
        checkout.force().path(&file);
        repo.checkout_head(Some(&mut checkout)).map_err(|e| e.to_string())?;
        Ok("reverted".into())
    }

    pub fn git_checkout_branch(path: String, branch: String, token: Option<String>) -> Result<String, String> {
        let repo = Repository::open(&path).map_err(|e| e.to_string())?;

        // Fetch the branch from origin first
        let mut remote = repo.find_remote("origin").map_err(|e| e.to_string())?;
        let mut callbacks = RemoteCallbacks::new();
        if let Some(tok) = token {
            let mut tried = false;
            callbacks.credentials(move |_url, _username, allowed| {
                if tried { return Err(git2::Error::from_str("authentication failed")); }
                tried = true;
                if allowed.contains(git2::CredentialType::USER_PASS_PLAINTEXT) {
                    git2::Cred::userpass_plaintext("oauth2", &tok)
                } else { git2::Cred::default() }
            });
        } else {
            let mut tried = false;
            callbacks.credentials(move |_url, username, allowed| {
                if tried { return Err(git2::Error::from_str("authentication failed")); }
                tried = true;
                if allowed.contains(git2::CredentialType::SSH_KEY) {
                    git2::Cred::ssh_key_from_agent(username.unwrap_or("git"))
                } else { git2::Cred::default() }
            });
        }
        callbacks.certificate_check(|_cert, _valid| Ok(git2::CertificateCheckStatus::CertificateOk));
        let mut fetch_opts = git2::FetchOptions::new();
        fetch_opts.remote_callbacks(callbacks);
        // best-effort fetch — branch may already be present
        let _ = remote.fetch(&[branch.as_str()], Some(&mut fetch_opts), None);

        // Find the remote tracking commit
        let remote_ref = format!("refs/remotes/origin/{branch}");
        let remote_oid = repo.find_reference(&remote_ref)
            .map_err(|e| e.to_string())?
            .target()
            .ok_or_else(|| "remote ref has no target".to_string())?;
        let target_commit = repo.find_commit(remote_oid).map_err(|e| e.to_string())?;

        // Create or reset the local branch to that commit
        repo.branch(&branch, &target_commit, true).map_err(|e| e.to_string())?;

        // Set HEAD and checkout working tree
        let refname = format!("refs/heads/{branch}");
        repo.set_head(&refname).map_err(|e| e.to_string())?;
        repo.checkout_head(Some(CheckoutBuilder::new().force()))
            .map_err(|e| e.to_string())?;

        Ok("switched".into())
    }

}

// ── Compile-time routing: dev/Linux → git_cli, MAS/iOS → git_native ──────────────────
// A single `use` alias lets the Tauri command wrappers below reference
// `git::git_init` etc. without any per-function #[cfg] duplication.
#[cfg(not(any(feature = "mas", target_os = "ios")))]
use git_cli as git;
#[cfg(any(feature = "mas", target_os = "ios"))]
use git_native as git;

// ── Workspace helpers ───────────────────────────────────────────────────────
/// Returns the canonical (symlink-resolved) path of an existing directory.
/// On iOS, documentDir() returns /var/mobile/... but the Tauri FS scope is
/// built with canonicalized /private/var/mobile/... paths. For files that
/// don't exist yet, tauri-plugin-fs can't canonicalize them, so they fail
/// the scope check even though they're under $DOCUMENT/**.
/// Fix: canonicalize the workspace root (which DOES exist) and derive all
/// child paths from it — they'll have /private/var/... and match the scope.
#[tauri::command]
fn canonicalize_path(path: String) -> Result<String, String> {
    std::fs::canonicalize(&path)
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|e| e.to_string())
}

/// Creates <workspace_path>/cafezin/ (and parents) using std::fs directly,
/// bypassing tauri-plugin-fs scope for the initial mkdir.
#[tauri::command]
fn ensure_config_dir(workspace_path: String) -> Result<(), String> {
    let dir = std::path::Path::new(&workspace_path).join("cafezin");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())
}

// ── Tauri command dispatchers (one per git command, no duplication) ───────────────
#[tauri::command]
fn git_init(path: String) -> Result<String, String> { git::git_init(path) }
#[tauri::command]
fn git_diff(path: String) -> Result<serde_json::Value, String> { git::git_diff(path) }
#[tauri::command]
fn git_sync(path: String, message: String) -> Result<String, String> { git::git_sync(path, message) }
#[tauri::command]
fn git_get_remote(path: String) -> Result<String, String> { git::git_get_remote(path) }
#[tauri::command]
fn git_set_remote(path: String, url: String) -> Result<String, String> { git::git_set_remote(path, url) }
#[tauri::command]
fn git_checkout_file(path: String, file: String) -> Result<String, String> { git::git_checkout_file(path, file) }
#[tauri::command]
async fn git_checkout_branch(path: String, branch: String, token: Option<String>) -> Result<String, String> {
    tokio::task::spawn_blocking(move || git::git_checkout_branch(path, branch, token))
        .await
        .map_err(|e| e.to_string())?
}
// git_clone and git_pull are async to prevent blocking the tokio runtime.
// On iOS the OS watchdog kills the process if the main/async thread is blocked
// for more than ~few seconds during a network operation.
#[tauri::command]
async fn git_clone(url: String, path: String, token: Option<String>, branch: Option<String>) -> Result<String, String> {
    tokio::task::spawn_blocking(move || git::git_clone(url, path, token, branch))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn git_pull(path: String, token: Option<String>) -> Result<String, String> {
    tokio::task::spawn_blocking(move || git::git_pull(path, token))
        .await
        .map_err(|e| e.to_string())?
}


// ── GitHub Device Flow (credentials stay in Rust, never exposed to the renderer) ──────────────

// Credentials are injected at compile time from cafezin/.env.local (git-ignored).
// See build.rs — it reads the file and emits `cargo:rustc-env=GITHUB_OAUTH_CLIENT_*`.
// To set up: copy .env.local.example → .env.local and fill in your OAuth App values.
const GITHUB_CLIENT_ID: &str = env!("GITHUB_OAUTH_CLIENT_ID");
const GITHUB_CLIENT_SECRET: &str = env!("GITHUB_OAUTH_CLIENT_SECRET");

#[derive(serde::Serialize, serde::Deserialize)]
pub struct DeviceFlowInit {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub expires_in: u64,
    pub interval: u64,
}

#[derive(serde::Serialize, serde::Deserialize)]
pub struct DeviceFlowPollResult {
    pub access_token: Option<String>,
    pub error: Option<String>,
    pub error_description: Option<String>,
}

/// Step 1: Request a user_code / device_code pair from GitHub.
/// The client_id stays in Rust — the renderer receives only the display data.
#[tauri::command]
async fn github_device_flow_init() -> Result<DeviceFlowInit, String> {
    let client = reqwest::Client::new();
    let res = client
        .post("https://github.com/login/device/code")
        .header("Accept", "application/json")
        .json(&serde_json::json!({ "client_id": GITHUB_CLIENT_ID, "scope": "copilot" }))
        .send()
        .await
        .map_err(|e| format!("device flow init request failed: {e}"))?;
    if !res.status().is_success() {
        let status = res.status().as_u16();
        let body = res.text().await.unwrap_or_default();
        return Err(format!("Device flow init failed ({status}): {body}"));
    }
    res.json::<DeviceFlowInit>().await.map_err(|e| format!("device flow init parse error: {e}"))
}

/// Step 2: Poll for the access token. The client secret stays in Rust.
#[tauri::command]
async fn github_device_flow_poll(device_code: String) -> Result<DeviceFlowPollResult, String> {
    let client = reqwest::Client::new();
    let res = client
        .post("https://github.com/login/oauth/access_token")
        .header("Accept", "application/json")
        .json(&serde_json::json!({
            "client_id":     GITHUB_CLIENT_ID,
            "client_secret": GITHUB_CLIENT_SECRET,
            "device_code":   device_code,
            "grant_type":    "urn:ietf:params:oauth:grant-type:device_code",
        }))
        .send()
        .await
        .map_err(|e| format!("device flow poll request failed: {e}"))?;
    res.json::<DeviceFlowPollResult>().await.map_err(|e| format!("device flow poll parse error: {e}"))
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
        .text("language", "pt")
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
        .setup(|app| {            // ── Deep link handler — OAuth callback (cafezin://auth/callback) ────
            {
                let handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    for url in event.urls() {
                        let url_str = url.to_string();
                        // Only forward auth callbacks to the webview
                        if url_str.starts_with("cafezin://auth/") || url_str.starts_with("cafezin://") {
                            let _ = handle.emit("auth-callback", url_str);
                        }
                    }
                });
                // On desktop, also register the scheme so the OS knows to open this app
                #[cfg(desktop)]
                let _ = app.deep_link().register("cafezin");
            }
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
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .invoke_handler(tauri::generate_handler![canonicalize_path, ensure_config_dir, git_init, git_diff, git_sync, git_checkout_file, git_checkout_branch, git_get_remote, git_set_remote, git_clone, git_pull, shell_run, update_app, transcribe_audio, open_devtools, build_channel, github_device_flow_init, github_device_flow_poll])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

