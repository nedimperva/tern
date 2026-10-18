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
