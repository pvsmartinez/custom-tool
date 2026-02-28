fn main() {
    // ── Load GitHub OAuth credentials from .env.local ─────────────────────
    // Secrets are NOT hardcoded in source — they live in .env.local (git-ignored).
    // build.rs reads the file and re-exports the values as compile-time env vars
    // so lib.rs can use env!("GITHUB_OAUTH_CLIENT_ID") etc.
    //
    // Resolution order:
    //   1. GITHUB_OAUTH_CLIENT_ID / GITHUB_OAUTH_CLIENT_SECRET already set in
    //      the shell environment (e.g. CI) → used as-is (no file needed).
    //   2. cafezin/.env.local  (root of the cafezin project, two levels up from src-tauri/)
    //   3. cafezin/app/.env.local  (Vite env file, adjacent to app/)
    //
    // Keys recognised in the .env.local file:
    //   GITHUB_OAUTH_CLIENT_ID      — GitHub OAuth App client_id  (scope: copilot)
    //   GITHUB_OAUTH_CLIENT_SECRET  — GitHub OAuth App client_secret
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap_or_default();
    let src_tauri = std::path::Path::new(&manifest_dir);
    // src-tauri/ → app/ → cafezin/
    let cafezin_root = src_tauri.parent().and_then(|p| p.parent());

    let env_files: Vec<std::path::PathBuf> = {
        let mut v = Vec::new();
        if let Some(root) = cafezin_root {
            v.push(root.join(".env.local"));
            v.push(root.join("app").join(".env.local"));
        }
        v
    };

    for env_file in &env_files {
        if let Ok(contents) = std::fs::read_to_string(env_file) {
            println!("cargo:rerun-if-changed={}", env_file.display());
            for line in contents.lines() {
                let line = line.trim();
                if line.starts_with('#') || line.is_empty() {
                    continue;
                }
                if let Some((key, val)) = line.split_once('=') {
                    let key = key.trim();
                    let val = val.trim().trim_matches('"').trim_matches('\'');
                    if matches!(key, "GITHUB_OAUTH_CLIENT_ID" | "GITHUB_OAUTH_CLIENT_SECRET") {
                        // Only set if not already provided via the shell environment
                        if std::env::var(key).is_err() {
                            println!("cargo:rustc-env={key}={val}");
                        }
                    }
                }
            }
        }
    }

    // ── iOS link flags ─────────────────────────────────────────────────────
    // libgit2 (vendored) needs zlib and iconv from the system SDK.
    // These are available on all iOS devices but not auto-linked by the linker.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("ios") {
        println!("cargo:rustc-link-lib=z");
        println!("cargo:rustc-link-lib=iconv");
    }

    tauri_build::build()
}
