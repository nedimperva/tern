//! OpenAI's models through the Chat Completions API (plain HTTPS, streamed), with the person's own key.

use std::io::{BufRead, BufReader};

use anyhow::{bail, Context, Result};
use serde_json::{json, Value};

use super::providers::{self, Provider};
use super::{Completion, Model, Request};

const API: &str = "https://api.openai.com/v1";
const MAX_TOKENS: u32 = 16_000;

pub struct OpenAi;

impl Model for OpenAi {
    fn complete(&self, req: &Request, on_text: &mut dyn FnMut(&str)) -> Result<Completion> {
        let key = providers::key(Provider::Openai, None)?;
        let mut res = providers::agent()
            .post(&format!("{API}/chat/completions"))
            .header("authorization", &format!("Bearer {key}"))
            .header("content-type", "application/json")
            .send(body(req).to_string())
            .map_err(providers::unreachable(Provider::Openai))?;
        let status = res.status().as_u16();
        if status != 200 {
            let text = res.body_mut().read_to_string().unwrap_or_default();
            let v: Value = serde_json::from_str(&text).unwrap_or_default();
            bail!(providers::refused(
                Provider::Openai,
                status,
                v["error"]["message"].as_str().unwrap_or("").trim(),
                &req.model
            ));
        }
        read_stream(BufReader::new(res.into_body().into_reader()), on_text)
    }
}

fn body(req: &Request) -> Value {
    // No temperature or reasoning settings: newer models refuse ones they don't take, and the defaults suit short
    // everyday writing. `max_completion_tokens` is the cap every current model accepts.
    json!({
        "model": req.model,
        "stream": true,
        "stream_options": { "include_usage": true },
        "max_completion_tokens": MAX_TOKENS,
        "messages": [
            { "role": "system", "content": req.system },
            { "role": "user", "content": req.user },
        ],
    })
}

fn read_stream(reader: impl BufRead, on_text: &mut dyn FnMut(&str)) -> Result<Completion> {
    let mut text = String::new();
    let mut refusal = String::new();
    let mut finish = String::new();
    let mut tokens = 0;
    let mut done = false;
    for line in reader.lines() {
        let line = line.context("The answer from OpenAI broke off. Try again.")?;
        let Some(data) = line.strip_prefix("data:").map(str::trim) else { continue };
        if data == "[DONE]" {
            done = true;
            break;
        }
        let Ok(chunk) = serde_json::from_str::<Value>(data) else { continue };
        if let Some(message) = chunk["error"]["message"].as_str() {
            bail!("OpenAI stopped answering: {message}");
        }
        if let Some(total) = chunk["usage"]["total_tokens"].as_i64() {
            tokens = total;
        }
        for choice in chunk["choices"].as_array().into_iter().flatten() {
            let delta = &choice["delta"];
            if let Some(t) = delta["content"].as_str() {
                on_text(t);
                text.push_str(t);
            }
            if let Some(r) = delta["refusal"].as_str() {
                refusal.push_str(r);
            }
            if let Some(f) = choice["finish_reason"].as_str() {
                finish = f.to_string();
            }
        }
    }
    if !refusal.is_empty() || finish == "content_filter" {
        bail!("The model declined to answer this one.");
    }
    if !done && finish.is_empty() {
        bail!("The answer from OpenAI broke off. Try again.");
    }
    Ok(Completion { text, tokens })
}

/// The chat models the key can use, newest names first: not speech, pictures, embeddings or moderation.
pub(super) fn models(key: &str) -> Result<Vec<(String, String)>> {
    let auth = format!("Bearer {key}");
    let v = providers::get_json(Provider::Openai, &format!("{API}/models"), &[("authorization", &auth)], "")?;
    let mut ids: Vec<String> = v["data"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|m| m["id"].as_str())
        .filter(|id| chat_model(id))
        .map(String::from)
        .collect();
    ids.sort_by(|a, b| b.cmp(a));
    Ok(ids.into_iter().map(|id| (id.clone(), id)).collect())
}

fn chat_model(id: &str) -> bool {
    let chat = id.starts_with("gpt-") || id.starts_with("chatgpt-") || {
        let mut c = id.chars();
        c.next() == Some('o') && c.next().is_some_and(|d| d.is_ascii_digit())
    };
    const NOT: &[&str] = &[
        "audio",
        "realtime",
        "tts",
        "transcribe",
        "image",
        "search",
        "embedding",
        "moderation",
        "instruct",
        "codex",
    ];
    chat && !NOT.iter().any(|n| id.contains(n))
}

pub(super) fn test(key: &str, model: &str) -> Result<String> {
    let auth = format!("Bearer {key}");
    let v = providers::get_json(
        Provider::Openai,
        &format!("{API}/models/{model}"),
        &[("authorization", &auth)],
        model,
    )?;
    Ok(v["id"].as_str().unwrap_or(model).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn canned(s: &'static str) -> impl BufRead {
        BufReader::new(s.as_bytes())
    }

    #[test]
    fn a_stream_reads_as_its_text_and_tokens() {
        let stream =
            "data: {\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"\"}}]}\n\n\
data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Hi \"}}]}\n\n\
data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Ana.\"},\"finish_reason\":\"stop\"}]}\n\n\
data: {\"choices\":[],\"usage\":{\"prompt_tokens\":90,\"completion_tokens\":10,\"total_tokens\":100}}\n\n\
data: [DONE]\n\n";
        let mut seen = String::new();
        let done = read_stream(canned(stream), &mut |t| seen.push_str(t)).unwrap();
        assert_eq!((done.text.as_str(), seen.as_str(), done.tokens), ("Hi Ana.", "Hi Ana.", 100));
    }

    #[test]
    fn refusals_filters_and_cut_streams_are_errors() {
        let refusal = "data: {\"choices\":[{\"delta\":{\"refusal\":\"I can't\"},\"finish_reason\":\"stop\"}]}\ndata: [DONE]\n";
        assert!(read_stream(canned(refusal), &mut |_| {}).unwrap_err().to_string().contains("declined"));
        let filtered =
            "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"content_filter\"}]}\ndata: [DONE]\n";
        assert!(read_stream(canned(filtered), &mut |_| {}).is_err());
        let cut = "data: {\"choices\":[{\"delta\":{\"content\":\"Half\"}}]}\n";
        assert!(read_stream(canned(cut), &mut |_| {}).unwrap_err().to_string().contains("broke off"));
    }

    #[test]
    fn the_request_streams_with_a_cap_and_no_sampling_settings() {
        let b = body(&Request { model: "gpt-6-sol".into(), system: "sys", user: "hi".into() });
        assert_eq!(b["stream"], true);
        assert_eq!(b["stream_options"]["include_usage"], true);
        assert_eq!(b["messages"][0]["role"], "system");
        assert!(b.get("temperature").is_none() && b.get("max_tokens").is_none());
    }

    #[test]
    fn only_chat_models_are_listed() {
        for id in ["gpt-6-sol", "gpt-6.1-sol", "gpt-5.5", "o3", "chatgpt-4o-latest"] {
            assert!(chat_model(id), "{id}");
        }
        for id in [
            "gpt-4o-realtime-preview",
            "gpt-image-1",
            "text-embedding-3-large",
            "whisper-1",
            "omni-moderation",
            "dall-e-3",
        ] {
            assert!(!chat_model(id), "{id}");
        }
    }
}
