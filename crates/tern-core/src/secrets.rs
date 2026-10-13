//! Passwords live in the system keychain: Credential Manager on Windows, the Secret Service (GNOME Keyring,
//! KWallet) on Linux, Keychain on macOS. Never in the database.

use anyhow::{Context, Result};

const SERVICE: &str = "tern-mail";

pub fn set_password(email: &str, password: &str) -> Result<()> {
    keyring::Entry::new(SERVICE, email)?
        .set_password(password)
        .context("Could not save the password to the system keychain")
}

pub fn password(email: &str) -> Result<String> {
    keyring::Entry::new(SERVICE, email)?
        .get_password()
        .with_context(|| format!("No saved password for {email}"))
}

pub fn delete_password(email: &str) -> Result<()> {
    keyring::Entry::new(SERVICE, email)?.delete_credential()?;
    Ok(())
}
