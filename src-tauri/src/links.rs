//! Where a navigation may go. Mail is shown in frames that run no scripts, and WebKitGTK runs none of Tern's
//! listeners in them either, so a click on a link in mail is never seen by the window: the frame just starts loading
//! the page (which its rules leave dark). WebKit asks before every navigation, a frame's too; this answers. Tern's
//! own pages stay, a web address goes to the person's browser and a `mailto:` link becomes a new message, and the
//! frame stays on the mail.

use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Manager, Url, Wry};
use tauri_plugin_opener::OpenerExt;

/// Tern's own pages, and what a mail frame is made of.
fn own(url: &Url) -> bool {
    match url.scheme() {
        "tauri" | "ipc" | "asset" | "about" | "data" | "blob" => true,
        "http" | "https" => {
            matches!(url.host_str(), Some("localhost" | "tauri.localhost" | "ipc.localhost" | "127.0.0.1"))
        }
        _ => false,
    }
}

pub fn plugin() -> TauriPlugin<Wry> {
    Builder::new("links")
        .on_navigation(|webview, url| {
            if own(url) {
                return true;
            }
            let app = webview.app_handle();
            match url.scheme() {
                "http" | "https" => {
                    if let Err(e) = app.opener().open_url(url.as_str(), None::<&str>) {
                        log::warn!("could not open {url} in the browser: {e}");
                    }
                }
                "mailto" => crate::desktop::open_links(app, &[url.to_string()]),
                _ => log::info!("left a {} link alone", url.scheme()),
            }
            false
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::own;
    use tauri::Url;

    #[test]
    fn only_terns_own_pages_load_in_the_window() {
        let ok = |s: &str| own(&Url::parse(s).unwrap());
        assert!(ok("about:srcdoc") && ok("http://localhost:1420/") && ok("tauri://localhost/index.html"));
        assert!(ok("http://tauri.localhost/") && ok("data:text/html,x"));
        assert!(
            !ok("https://ko-fi.com/manage/notifications")
                && !ok("mailto:a@x.com")
                && !ok("http://localhost.evil.com/")
        );
    }
}
