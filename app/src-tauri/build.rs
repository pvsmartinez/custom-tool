fn main() {
    // On iOS, libgit2 (vendored) needs zlib and iconv from the system SDK.
    // These are available on all iOS devices but not auto-linked by the linker.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("ios") {
        println!("cargo:rustc-link-lib=z");
        println!("cargo:rustc-link-lib=iconv");
    }

    tauri_build::build()
}
