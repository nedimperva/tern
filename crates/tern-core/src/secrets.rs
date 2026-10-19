//! Passwords live in the system keychain: Credential Manager on Windows, the Secret Service (GNOME Keyring,
//! KWallet) on Linux, Keychain on macOS. Never in the database.

use anyhow::{Context, Result};

const SERVICE: &str = "tern-mail";

pub fn set_password(email: &str, password: &str) -> Result<()> {
    keyring::Entry::new(SERVICE, email).and_then(|entry| entry.set_password(password)).map_err(|e| {
        let advice = advice(&e);
        anyhow::Error::new(e).context(advice)
    })
}

/// What to tell someone whose keychain refused a password. On Linux the usual cause is that no Secret Service is
/// running, or its "login" collection does not exist or is locked: not a Tern bug, and fixable with one install.
fn advice(e: &keyring::Error) -> &'static str {
    match e {
        keyring::Error::PlatformFailure(_) | keyring::Error::NoStorageAccess(_) if cfg!(target_os = "linux") => {
            "No keyring answered, so the password can't be saved. Tern keeps passwords in the Secret Service: \
             install and unlock one, for example with `sudo pacman -S gnome-keyring seahorse` (Arch, Omarchy) or \
             `sudo apt install gnome-keyring seahorse`, then sign out and in again. Passwords and Keys (seahorse) \
             should show an unlocked \"Login\" keyring"
        }
        _ => "Could not save the password to the system keychain",
    }
}

pub fn password(email: &str) -> Result<String> {
    keyring::Entry::new(SERVICE, email)?
        .get_password()
        .with_context(|| format!("No saved password for {email}"))
}

/// OAuth tokens for an account (`oauth::Tokens`, as JSON), under `<email>/oauth` beside any password.
pub fn set_tokens(email: &str, tokens: &crate::oauth::Tokens) -> Result<()> {
    keyring::Entry::new(SERVICE, &format!("{email}/oauth"))?
        .set_password(&serde_json::to_string(tokens)?)
        .map_err(|e| {
            let advice = advice(&e);
            anyhow::Error::new(e).context(advice)
        })
}

pub fn tokens(email: &str) -> Result<crate::oauth::Tokens> {
    let json = keyring::Entry::new(SERVICE, &format!("{email}/oauth"))?
        .get_password()
        .with_context(|| format!("No saved sign-in for {email}"))?;
    Ok(serde_json::from_str(&json)?)
}

/// What one sign-in proves itself with.
#[derive(Clone)]
pub enum Credential {
    Password(String),
    /// An OAuth access token, sent with XOAUTH2.
    Token(String),
}

/// Where an account's sign-in comes from. Google tokens last about an hour, so a long-running worker asks for a
/// credential at every connect rather than holding one.
#[derive(Clone)]
pub enum Login {
    /// A password known up front: a test, or a new account before it is saved.
    Password(String),
    /// What the keychain holds for the address: Google tokens once the account signed in with Google (refreshed
    /// as they run out), else the password. Reading it at each connect means a fresh sign-in takes effect without
    /// restarting the worker.
    Keychain {
        email: String,
        /// None in a build without a Google client: then only passwords work.
        google: Option<crate::oauth::Provider>,
        /// One refresh at a time per account; the worker and the inbox watcher connect at the same moment.
        refreshing: std::sync::Arc<tokio::sync::Mutex<()>>,
    },
}

impl Login {
    pub fn keychain(email: &str, google: Option<crate::oauth::Provider>) -> Self {
        Login::Keychain { email: email.into(), google, refreshing: Default::default() }
    }

    pub async fn credential(&self) -> Result<Credential> {
        let (email, google, refreshing) = match self {
            Login::Password(p) => return Ok(Credential::Password(p.clone())),
            Login::Keychain { email, google, refreshing } => (email, google, refreshing),
        };
        let (Some(google), Ok(_)) = (google, tokens(email)) else {
            return Ok(Credential::Password(password(email)?));
        };
        let _one = refreshing.lock().await;
        // Read again under the lock: whoever held it may have just refreshed.
        let saved = tokens(email)?;
        if saved.fresh(crate::store::now()) {
            return Ok(Credential::Token(saved.access_token));
        }
        let Some(refresh) = saved.refresh_token.clone() else {
            return Err(crate::oauth::Revoked("no refresh token was kept".into()).into());
        };
        let google = google.clone();
        let mut fresh =
            tokio::task::spawn_blocking(move || crate::oauth::refresh(&google, &refresh)).await??;
        fresh.email = fresh.email.or(saved.email);
        set_tokens(email, &fresh)?;
        Ok(Credential::Token(fresh.access_token))
    }

    /// The server refused the access token before it should have run out (Google can end one early): the next
    /// `credential` refreshes it.
    pub fn token_refused(&self) {
        if let Login::Keychain { email, .. } = self {
            if let Ok(mut saved) = tokens(email) {
                saved.expires_at = 0;
                let _ = set_tokens(email, &saved);
            }
        }
    }
}

pub fn delete_tokens(email: &str) -> Result<()> {
    keyring::Entry::new(SERVICE, &format!("{email}/oauth"))?.delete_credential()?;
    Ok(())
}

pub fn delete_password(email: &str) -> Result<()> {
    keyring::Entry::new(SERVICE, email)?.delete_credential()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_missing_keyring_says_how_to_get_one() {
        let e = keyring::Error::PlatformFailure("no such collection: login".into());
        let advice = super::advice(&e);
        if cfg!(target_os = "linux") {
            assert!(advice.contains("gnome-keyring"), "{advice}");
        } else {
            assert_eq!(advice, "Could not save the password to the system keychain");
        }
        assert_eq!(
            super::advice(&keyring::Error::NoEntry),
            "Could not save the password to the system keychain"
        );
    }
}
