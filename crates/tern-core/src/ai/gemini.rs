//! Google's Gemini models through the Gemini API (`streamGenerateContent` over plain HTTPS), with the person's own
//! key from Google AI Studio.

use std::io::{BufRead, BufReader};

use anyhow::{bail, Context, Result};
use serde_json::{json, Value};

use super::providers::{self, Provider};
use super::{Completion, Model, Request};

const API: &str = "https://generativelanguage.googleapis.com/v1beta";
const MAX_TOKENS: u32 = 16_000;

pub struct Gemini;

impl Model for Gemini {
    fn complete(&self, req: &Request, on_text: &mut dyn FnMut(&str)) -> Result<Completion> {
        let key = providers::key(Provider::Gemini, None)?;
        let mut res = providers::agent()
            .post(&format!("{API}/models/{}:streamGenerateContent?alt=sse", req.model))
            .header("x-goog-api-key", &key)
            .header("content-type", "application/json")
            .send(body(req).to_string())
            .map_err(providers::unreachable(Provider::Gemini))?;
        let status = res.status().as_u16();
        if status != 200 {
            let text = res.body_mut().read_to_string().unwrap_or_default();
            let v: Value = serde_json::from_str(&text).unwrap_or_default();
            bail!(providers::refused(
                Provider::Gemini,
                status,
                v["error"]["message"].as_str().unwrap_or("").trim(),
                &req.model
            ));
        }
        read_stream(BufReader::new(res.into_body().into_reader()), on_text)
    }
}

fn body(req: &Request) -> Value {
    json!({
        "systemInstruction": { "parts": [{ "text": req.system }] },
        "contents": [{ "role": "user", "parts": [{ "text": req.user }] }],
        "generationConfig": { "maxOutputTokens": MAX_TOKENS },
    })
}

fn read_stream(reader: impl BufRead, on_text: &mut dyn FnMut(&str)) -> Result<Completion> {
    let mut text = String::new();
    let mut finish = String::new();
    let mut tokens = 0;
    for line in reader.lines() {
        let line = line.context("The answer from Google broke off. Try again.")?;
        let Some(data) = line.strip_prefix("data:").map(str::trim) else { continue };
        let Ok(chunk) = serde_json::from_str::<Value>(data) else { continue };
        if let Some(message) = chunk["error"]["message"].as_str() {
            bail!("Google stopped answering: {message}");
        }
        if chunk["promptFeedback"]["blockReason"].is_string() {
            bail!("The model declined to answer this one.");
        }
        if let Some(total) = chunk["usageMetadata"]["totalTokenCount"].as_i64() {
            tokens = total;
        }
        let candidate = &chunk["candidates"][0];
        for part in candidate["content"]["parts"].as_array().into_iter().flatten() {
            // A thinking model's thoughts, when it shares them, are not the answer.
            if part["thought"].as_bool() == Some(true) {
                continue;
            }
            if let Some(t) = part["text"].as_str() {
                on_text(t);
                text.push_str(t);
            }
        }
        if let Some(f) = candidate["finishReason"].as_str() {
            finish = f.to_string();
        }
    }
    match finish.as_str() {
        "" => bail!("The answer from Google broke off. Try again."),
        "STOP" | "MAX_TOKENS" => Ok(Completion { text, tokens }),
        _ => bail!("The model declined to answer this one."),
    }
}

/// The Gemini text models the key can use: not speech, pictures, embeddings or live audio.
pub(super) fn models(key: &str) -> Result<Vec<(String, String)>> {
    let v = providers::get_json(
        Provider::Gemini,
        &format!("{API}/models?pageSize=1000"),
        &[("x-goog-api-key", key)],
        "",
    )?;
    let mut list: Vec<(String, String)> = v["models"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|m| {
            m["supportedGenerationMethods"]
                .as_array()
                .is_some_and(|ms| ms.iter().any(|x| x == "generateContent"))
        })
        .filter_map(|m| {
            let id = m["name"].as_str()?.strip_prefix("models/")?.to_string();
            let name = m["displayName"].as_str().unwrap_or(&id).to_string();
            text_model(&id).then_some((id, name))
        })
        .collect();
    list.sort_by(|a, b| b.0.cmp(&a.0));
    Ok(list)
}

fn text_model(id: &str) -> bool {
    const NOT: &[&str] = &["tts", "image", "embedding", "live", "audio", "aqa", "robotics", "computer-use"];
    id.starts_with("gemini") && !NOT.iter().any(|n| id.contains(n))
}

pub(super) fn test(key: &str, model: &str) -> Result<String> {
    let v = providers::get_json(
        Provider::Gemini,
        &format!("{API}/models/{model}"),
        &[("x-goog-api-key", key)],
        model,
    )?;
    Ok(v["displayName"].as_str().unwrap_or(model).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn canned(s: &'static str) -> impl BufRead {
        BufReader::new(s.as_bytes())
    }

    #[test]
    fn a_stream_reads_as_its_text_without_thoughts() {
        let stream = "data: {\"candidates\":[{\"content\":{\"role\":\"model\",\"parts\":[{\"text\":\"plan\",\"thought\":true},{\"text\":\"Hi \"}]}}]}\r\n\r\n\
data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"Ana.\"}]},\"finishReason\":\"STOP\"}],\"usageMetadata\":{\"promptTokenCount\":80,\"candidatesTokenCount\":5,\"totalTokenCount\":85}}\r\n\r\n";
        let mut seen = String::new();
        let done = read_stream(canned(stream), &mut |t| seen.push_str(t)).unwrap();
        assert_eq!((done.text.as_str(), seen.as_str(), done.tokens), ("Hi Ana.", "Hi Ana.", 85));
    }

    #[test]
    fn blocks_and_cut_streams_are_errors() {
        let blocked = "data: {\"promptFeedback\":{\"blockReason\":\"SAFETY\"}}\n";
        assert!(read_stream(canned(blocked), &mut |_| {}).unwrap_err().to_string().contains("declined"));
        let safety = "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"Pa\"}]},\"finishReason\":\"SAFETY\"}]}\n";
        assert!(read_stream(canned(safety), &mut |_| {}).is_err());
        let cut = "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"Half\"}]}}]}\n";
        assert!(read_stream(canned(cut), &mut |_| {}).unwrap_err().to_string().contains("broke off"));
    }

    #[test]
    fn the_request_carries_the_system_prompt_apart() {
        let b = body(&Request {
            provider: Provider::Gemini,
            model: "gemini-flash-latest".into(),
            system: "sys",
            user: "hi".into(),
        });
        assert_eq!(b["systemInstruction"]["parts"][0]["text"], "sys");
        assert_eq!(b["contents"][0]["parts"][0]["text"], "hi");
    }

    #[test]
    fn only_text_models_are_listed() {
        assert!(
            text_model("gemini-3.8-flash")
                && text_model("gemini-flash-latest")
                && text_model("gemini-4-argon")
        );
        for id in
            ["gemini-3.1-flash-tts-preview", "gemini-embedding-001", "gemini-2.5-flash-image", "imagen-4"]
        {
            assert!(!text_model(id), "{id}");
        }
    }
}
