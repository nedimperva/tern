fn main() {
    google_client();
    tauri_build::build()
}

/// Bakes the Google desktop client into the app for "Continue with Google". Release builds take it from the
/// TERN_GOOGLE_CLIENT_ID and TERN_GOOGLE_CLIENT_SECRET environment variables (repo secrets); a local build falls
/// back to `secrets/google-client.json`, which git ignores. Without either, the app offers passwords only. A
/// desktop client's secret is not secret (Google says so for installed apps): PKCE protects the sign-in.
fn google_client() {
    println!("cargo:rerun-if-env-changed=TERN_GOOGLE_CLIENT_ID");
    println!("cargo:rerun-if-env-changed=TERN_GOOGLE_CLIENT_SECRET");
    println!("cargo:rerun-if-env-changed=TERN_NO_UPDATES");
    println!("cargo:rerun-if-changed=../secrets/google-client.json");
    let from_env = std::env::var("TERN_GOOGLE_CLIENT_ID").ok().filter(|id| !id.is_empty());
    let (id, secret) = match from_env {
        Some(id) => (id, std::env::var("TERN_GOOGLE_CLIENT_SECRET").unwrap_or_default()),
        None => {
            let Ok(json) = std::fs::read_to_string("../secrets/google-client.json") else { return };
            let Ok(file) = serde_json::from_str::<serde_json::Value>(&json) else { return };
            let field = |k: &str| file["installed"][k].as_str().unwrap_or_default().to_string();
            (field("client_id"), field("client_secret"))
        }
    };
    if !id.is_empty() {
        println!("cargo:rustc-env=TERN_GOOGLE_CLIENT_ID={id}");
        println!("cargo:rustc-env=TERN_GOOGLE_CLIENT_SECRET={secret}");
    }
}
