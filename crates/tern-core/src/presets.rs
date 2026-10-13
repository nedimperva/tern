use serde::Serialize;

use crate::models::Security;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preset {
    pub imap_host: String,
    pub imap_port: u16,
    pub imap_security: Security,
    pub smtp_host: String,
    pub smtp_port: u16,
    pub smtp_security: Security,
    /// Something the person has to know before the password will work.
    pub note: Option<&'static str>,
}

/// Server settings for well-known providers, and a guess for everything else.
/// TODO: Mozilla ISPDB / autoconfig lookups, and SRV records (RFC 6186).
pub fn for_email(email: &str) -> Option<Preset> {
    let domain = email.rsplit_once('@')?.1.to_lowercase();
    let known = |imap: &str, smtp: &str, smtp_port: u16, note: Option<&'static str>| Preset {
        imap_host: imap.into(),
        imap_port: 993,
        imap_security: Security::Tls,
        smtp_host: smtp.into(),
        smtp_port,
        smtp_security: security_for_smtp_port(smtp_port),
        note,
    };
    Some(match domain.as_str() {
        "gmail.com" | "googlemail.com" => known(
            "imap.gmail.com",
            "smtp.gmail.com",
            465,
            Some("Gmail needs an app password (Google Account → Security → App passwords)."),
        ),
        "outlook.com" | "hotmail.com" | "live.com" | "msn.com" => known(
            "outlook.office365.com",
            "smtp-mail.outlook.com",
            587,
            Some("Microsoft accounts no longer accept passwords over IMAP; they need OAuth (not built yet)."),
        ),
        "icloud.com" | "me.com" | "mac.com" => known(
            "imap.mail.me.com",
            "smtp.mail.me.com",
            587,
            Some("iCloud needs an app-specific password (appleid.apple.com)."),
        ),
        "yahoo.com" | "ymail.com" => {
            known("imap.mail.yahoo.com", "smtp.mail.yahoo.com", 465, Some("Yahoo needs an app password."))
        }
        "fastmail.com" | "fastmail.fm" => {
            known("imap.fastmail.com", "smtp.fastmail.com", 465, Some("Fastmail needs an app password."))
        }
        "gmx.com" | "gmx.net" | "gmx.de" => known("imap.gmx.com", "mail.gmx.com", 587, None),
        _ => Preset {
            imap_host: format!("imap.{domain}"),
            imap_port: 993,
            imap_security: Security::Tls,
            smtp_host: format!("smtp.{domain}"),
            smtp_port: 465,
            smtp_security: Security::Tls,
            note: None,
        },
    })
}

/// The usual pairing: 465 is SMTP over TLS, 587 (and anything else) is submission with STARTTLS.
fn security_for_smtp_port(port: u16) -> Security {
    if port == 465 {
        Security::Tls
    } else {
        Security::Starttls
    }
}
