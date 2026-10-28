//! The AI providers a person can pick in Settings → AI, each answering with the person's own key, kept in the
//! keyring (service `tern-mail`, entry `ai/<provider>`) and read only when a request is about to go.

use std::time::Duration;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use super::{anthropic, gemini, openai, Model};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    #[default]
    Anthropic,
    Openai,
    Gemini,
}

impl Provider {
    /// Who receives the mail, as the privacy sheet and errors say it.
    pub fn name(self) -> &'static str {
        match self {
            Provider::Anthropic => "Anthropic",
            Provider::Openai => "OpenAI",
            Provider::Gemini => "Google",
        }
    }

    fn entry(self) -> &'static str {
        match self {
            Provider::Anthropic => "ai/anthropic",
            Provider::Openai => "ai/openai",
            Provider::Gemini => "ai/gemini",
        }
    }

    /// The model picked until the person picks one. OpenAI's and Google's lineups change often, so Settings lists
    /// what the key can use; these are only where the list starts.
    pub fn default_model(self) -> &'static str {
        match self {
            Provider::Anthropic => anthropic::MODELS[0].0,
            Provider::Openai => "gpt-6-sol",
            Provider::Gemini => "gemini-flash-latest",
        }
    }

    /// The quick, cheap model for short everyday work (summaries, suggested replies).
    pub fn small_model(self) -> &'static str {
        match self {
            Provider::Anthropic => "claude-haiku-5-5",
            Provider::Openai => "gpt-6-luna",
            Provider::Gemini => "gemini-flash-latest",
        }
    }

    pub fn model(self) -> Box<dyn Model + Send + Sync> {
        match self {
            Provider::Anthropic => Box::new(anthropic::Anthropic),
            Provider::Openai => Box::new(openai::OpenAi),
            Provider::Gemini => Box::new(gemini::Gemini),
        }
    }
}

/// Sends each request to the provider it names.
pub struct Router;

impl Model for Router {
    fn complete(&self, req: &super::Request, on_text: &mut dyn FnMut(&str)) -> Result<super::Completion> {
        req.provider.model().complete(req, on_text)
    }
}

pub fn set_key(p: Provider, key: &str) -> Result<()> {
    keyring::Entry::new("tern-mail", p.entry())?
        .set_password(key.trim())
        .context("Could not save the key to the system keychain")
}

impl Provider {
    pub const ALL: [Provider; 3] = [Provider::Anthropic, Provider::Openai, Provider::Gemini];
}

/// The saved key, for a sealed backup (`backup`); requests read it through `key`.
pub fn saved_key(p: Provider) -> Option<String> {
    keyring::Entry::new("tern-mail", p.entry()).and_then(|e| e.get_password()).ok()
}

pub fn has_key(p: Provider) -> bool {
    keyring::Entry::new("tern-mail", p.entry()).and_then(|e| e.get_password()).is_ok()
}

pub fn delete_key(p: Provider) -> Result<()> {
    match keyring::Entry::new("tern-mail", p.entry())?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.into()),
    }
}

/// The key typed in Settings (for Test before saving), else the saved one.
pub(super) fn key(p: Provider, typed: Option<&str>) -> Result<String> {
    if let Some(k) = typed.map(str::trim).filter(|k| !k.is_empty()) {
        return Ok(k.to_string());
    }
    keyring::Entry::new("tern-mail", p.entry())?
        .get_password()
        .map_err(|_| anyhow::anyhow!("Add your {} API key in Settings → AI.", p.name()))
}

/// What Settings → AI lists for the provider: (id, name), the default first when the key can use it.
pub fn models(p: Provider, key: Option<&str>) -> Result<Vec<(String, String)>> {
    let mut list = match p {
        Provider::Anthropic => {
            return Ok(anthropic::MODELS
                .iter()
                .map(|(id, name)| (id.to_string(), name.to_string()))
                .collect())
        }
        Provider::Openai => openai::models(&self::key(p, key)?)?,
        Provider::Gemini => gemini::models(&self::key(p, key)?)?,
    };
    if let Some(i) = list.iter().position(|(id, _)| id == p.default_model()) {
        let default = list.remove(i);
        list.insert(0, default);
    }
    Ok(list)
}

/// Settings → AI → Test: whether the key works and may use the model; the model's name if so. Costs nothing.
pub fn test(p: Provider, key: Option<&str>, model: &str) -> Result<String> {
    let key = self::key(p, key)?;
    match p {
        Provider::Anthropic => anthropic::test(&key, model),
        Provider::Openai => openai::test(&key, model),
        Provider::Gemini => gemini::test(&key, model),
    }
}

/// HTTPS on the same rustls and platform verifier as the rest of Tern. Statuses come back as answers, so each
/// provider can say what went wrong in words.
pub(super) fn agent() -> ureq::Agent {
    let tls = ureq::tls::TlsConfig::builder().root_certs(ureq::tls::RootCerts::PlatformVerifier).build();
    ureq::Agent::config_builder()
        .tls_config(tls)
        .https_only(true)
        .http_status_as_error(false)
        .timeout_connect(Some(Duration::from_secs(15)))
        // A model may think before its first word; the answer itself then streams for as long as it takes.
        .timeout_recv_response(Some(Duration::from_secs(180)))
        .user_agent("Tern")
        .build()
        .into()
}

pub(super) fn unreachable(p: Provider) -> impl Fn(ureq::Error) -> anyhow::Error {
    move |e| {
        anyhow::Error::new(e)
            .context(format!("Could not reach {}. Check the connection and try again.", p.name()))
    }
}

/// What to tell the person when a provider said no, from its status and its own message.
pub(super) fn refused(p: Provider, status: u16, message: &str, model: &str) -> String {
    let name = p.name();
    let lower = message.to_ascii_lowercase();
    match status {
        401 => format!("{name} refused the API key. Check it in Settings → AI."),
        // Google answers a bad key with 400 or 403 and says so in the message.
        400 | 403 if lower.contains("api key") => {
            format!("{name} refused the API key. Check it in Settings → AI.")
        }
        403 => format!("This API key may not do that: {message}"),
        404 => format!("This API key can't use {model}. Pick another model in Settings → AI."),
        429 if lower.contains("quota") || lower.contains("billing") || lower.contains("credit") => {
            format!("This {name} key has used up its quota or credit. Check your account with {name}.")
        }
        429 => format!("{name} is limiting requests on this key right now. Try again in a minute."),
        500..=599 if status == 503 || status == 529 || lower.contains("overload") => {
            format!("{name} is busy. Try again in a moment.")
        }
        500..=599 => format!("{name} had a problem answering. Try again in a moment."),
        _ if message.is_empty() => format!("{name} refused the request ({status})."),
        _ => format!("{name} refused the request: {message}"),
    }
}

/// A GET that answers JSON, for model lists and Test.
pub(super) fn get_json(
    p: Provider,
    url: &str,
    headers: &[(&str, &str)],
    model: &str,
) -> Result<serde_json::Value> {
    let mut call = agent().get(url);
    for (name, value) in headers {
        call = call.header(*name, *value);
    }
    let mut res = call.call().map_err(unreachable(p))?;
    let status = res.status().as_u16();
    let text = res.body_mut().read_to_string().unwrap_or_default();
    let v: serde_json::Value = serde_json::from_str(&text).unwrap_or_default();
    if status != 200 {
        anyhow::bail!(refused(p, status, v["error"]["message"].as_str().unwrap_or("").trim(), model));
    }
    Ok(v)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refusals_say_what_to_do_whoever_said_no() {
        assert!(refused(Provider::Openai, 401, "", "m").contains("OpenAI refused the API key"));
        assert!(refused(Provider::Gemini, 400, "API key not valid. Please pass a valid API key.", "m")
            .contains("API key"));
        assert!(refused(Provider::Openai, 429, "You exceeded your current quota", "m").contains("quota"));
        assert!(refused(Provider::Gemini, 429, "Too many requests", "m").contains("limiting"));
        assert!(refused(Provider::Gemini, 503, "", "m").contains("busy"));
        assert!(refused(Provider::Openai, 404, "", "gpt-x").contains("gpt-x"));
    }

    #[test]
    fn settings_saved_before_providers_stay_on_anthropic() {
        let s: super::super::AiSettings =
            serde_json::from_str(r#"{"enabled":true,"model":"claude-opus-5-5"}"#).unwrap();
        assert_eq!(s.provider, Provider::Anthropic);
        let p: Provider = serde_json::from_str("\"openai\"").unwrap();
        assert_eq!(p, Provider::Openai);
    }
}
