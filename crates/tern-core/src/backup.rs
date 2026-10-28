//! A settings backup that carries accounts (Settings → Backup). The window writes the settings part; accounts and
//! their secrets are added here, so passwords never pass through the window, and the whole is sealed with a
//! passphrase the person chooses: PBKDF2-HMAC-SHA256 for the key, ChaCha20-Poly1305 for the contents. Both come from
//! `ring`, which is here for TLS already.

use anyhow::{anyhow, bail, Result};
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, CHACHA20_POLY1305, NONCE_LEN};
use ring::rand::{SecureRandom, SystemRandom};
use serde::{Deserialize, Serialize};
use std::num::NonZeroU32;

use crate::models::AccountConfig;
use crate::oauth::Tokens;

/// OWASP's 2023 figure for PBKDF2-HMAC-SHA256: about half a second on a laptop, once per export or import.
const ROUNDS: u32 = 600_000;
const SALT_LEN: usize = 16;
/// Said when the passphrase is wrong, or the file was changed after it was sealed: the two look the same.
pub const WRONG: &str = "That passphrase doesn't open this file.";

/// One account as the backup carries it: how to reach it and what it signs in with.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountBackup {
    pub config: AccountConfig,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tokens: Option<Tokens>,
}

/// What the sealed part holds: the window's settings file as it wrote it, and the accounts.
#[derive(Debug, Serialize, Deserialize)]
pub struct Contents {
    pub settings: serde_json::Value,
    pub accounts: Vec<AccountBackup>,
}

#[derive(Serialize, Deserialize)]
struct Sealed {
    kdf: String,
    rounds: u32,
    salt: String,
    nonce: String,
    data: String,
}

/// The file on disk. `tern` and `version` match the plain settings file so either is recognised as Tern's.
#[derive(Serialize, Deserialize)]
struct File {
    tern: String,
    version: u32,
    sealed: Sealed,
}

fn key(passphrase: &str, salt: &[u8], rounds: u32) -> Result<LessSafeKey> {
    let rounds = NonZeroU32::new(rounds).ok_or_else(|| anyhow!("That file isn't Tern settings."))?;
    let mut bytes = [0u8; 32];
    ring::pbkdf2::derive(ring::pbkdf2::PBKDF2_HMAC_SHA256, rounds, salt, passphrase.as_bytes(), &mut bytes);
    let key = UnboundKey::new(&CHACHA20_POLY1305, &bytes).map_err(|_| anyhow!("key"))?;
    Ok(LessSafeKey::new(key))
}

/// The backup as the text of a file, readable only with `passphrase`.
pub fn seal(contents: &Contents, passphrase: &str) -> Result<String> {
    if passphrase.chars().count() < 8 {
        bail!("Choose a passphrase of at least 8 characters.");
    }
    let random = SystemRandom::new();
    let mut salt = [0u8; SALT_LEN];
    let mut nonce = [0u8; NONCE_LEN];
    random.fill(&mut salt).map_err(|_| anyhow!("No randomness from the system"))?;
    random.fill(&mut nonce).map_err(|_| anyhow!("No randomness from the system"))?;
    let mut data = serde_json::to_vec(contents)?;
    key(passphrase, &salt, ROUNDS)?
        .seal_in_place_append_tag(Nonce::assume_unique_for_key(nonce), Aad::empty(), &mut data)
        .map_err(|_| anyhow!("Could not seal the file"))?;
    let file = File {
        tern: "settings".into(),
        version: 1,
        sealed: Sealed {
            kdf: "pbkdf2-sha256".into(),
            rounds: ROUNDS,
            salt: STANDARD.encode(salt),
            nonce: STANDARD.encode(nonce),
            data: STANDARD.encode(data),
        },
    };
    Ok(serde_json::to_string_pretty(&file)?)
}

/// The file is a sealed backup (it needs a passphrase), not plain settings.
pub fn is_sealed(text: &str) -> bool {
    serde_json::from_str::<File>(text).is_ok()
}

/// What a sealed backup holds, or why it can't be read.
pub fn open(text: &str, passphrase: &str) -> Result<Contents> {
    let file: File = serde_json::from_str(text).map_err(|_| anyhow!("That file isn't Tern settings."))?;
    if file.tern != "settings" || file.sealed.kdf != "pbkdf2-sha256" {
        bail!("That file isn't Tern settings.");
    }
    if file.version != 1 {
        bail!("That file comes from a newer Tern. Update Tern, then import it.");
    }
    let decode = |s: &str| STANDARD.decode(s).map_err(|_| anyhow!("That file isn't Tern settings."));
    let salt = decode(&file.sealed.salt)?;
    let nonce: [u8; NONCE_LEN] =
        decode(&file.sealed.nonce)?.try_into().map_err(|_| anyhow!("That file isn't Tern settings."))?;
    let mut data = decode(&file.sealed.data)?;
    let plain = key(passphrase, &salt, file.sealed.rounds)?
        .open_in_place(Nonce::assume_unique_for_key(nonce), Aad::empty(), &mut data)
        .map_err(|_| anyhow!(WRONG))?;
    serde_json::from_slice(plain).map_err(|_| anyhow!("That file isn't Tern settings."))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{Auth, Security};

    fn contents() -> Contents {
        Contents {
            settings: serde_json::json!({ "tern": "settings", "version": 1, "settings": { "theme": "dark" } }),
            accounts: vec![AccountBackup {
                config: AccountConfig {
                    email: "ada@example.com".into(),
                    display_name: "Ada".into(),
                    username: "ada".into(),
                    imap_host: "imap.example.com".into(),
                    imap_port: 993,
                    imap_security: Security::Tls,
                    smtp_host: "smtp.example.com".into(),
                    smtp_port: 587,
                    smtp_security: Security::Starttls,
                    auth: Auth::Password,
                },
                password: Some("hunter2 and more".into()),
                tokens: None,
            }],
        }
    }

    #[test]
    fn a_sealed_backup_opens_with_its_passphrase_only() {
        let text = seal(&contents(), "correct horse").unwrap();
        assert!(is_sealed(&text));
        assert!(!text.contains("hunter2"), "the password is in the file as written");
        assert!(!text.contains("ada@example.com"), "the address is in the file as written");
        let back = open(&text, "correct horse").unwrap();
        assert_eq!(back.accounts.len(), 1);
        assert_eq!(back.accounts[0].config.email, "ada@example.com");
        assert_eq!(back.accounts[0].config.smtp_security, Security::Starttls);
        assert_eq!(back.accounts[0].password.as_deref(), Some("hunter2 and more"));
        assert_eq!(back.settings, contents().settings);
        assert_eq!(open(&text, "correct horsE").unwrap_err().to_string(), WRONG);
    }

    #[test]
    fn a_changed_file_does_not_open() {
        let text = seal(&contents(), "correct horse").unwrap();
        let mut file: serde_json::Value = serde_json::from_str(&text).unwrap();
        let data = file["sealed"]["data"].as_str().unwrap().to_string();
        let mut bytes = STANDARD.decode(data).unwrap();
        bytes[3] ^= 1;
        file["sealed"]["data"] = STANDARD.encode(bytes).into();
        assert_eq!(open(&file.to_string(), "correct horse").unwrap_err().to_string(), WRONG);
    }

    #[test]
    fn plain_settings_and_short_passphrases_are_told_apart() {
        assert!(!is_sealed(r#"{"tern":"settings","version":1,"settings":{}}"#));
        assert!(seal(&contents(), "short").is_err());
        assert!(open("not json", "correct horse").is_err());
    }
}
