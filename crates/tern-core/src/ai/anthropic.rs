//! Claude through Anthropic's Messages API, over HTTPS on the same rustls and platform verifier as everything
//! else. There is no official Rust SDK, so this is the plain HTTP API: one streamed request per ask. The key is the
//! person's own, read from the keyring only when a request is about to go.

use std::io::{BufRead, BufReader};

use anyhow::{bail, Context, Result};
use serde_json::{json, Value};

use super::providers::{self, Provider};
use super::{Completion, Model, Request};

/// The models offered in Settings → AI, best first.
pub const MODELS: &[(&str, &str)] = &[
    ("claude-opus-5-5", "Claude Opus 5.5"),
    ("claude-sonnet-5-5", "Claude Sonnet 5.5"),
    ("claude-haiku-5-5", "Claude Haiku 5.5"),
];

const API: &str = "https://api.anthropic.com/v1";
const VERSION: &str = "2026-10-21";
/// Server-side fallback: when a model's safety classifier declines a harmless request (mail about security, a
/// lab report), the API runs it again on the model Anthropic recommends for that case, in the same call.
const FALLBACK_BETA: &str = "server-side-fallback-2026-07-01";
const MAX_TOKENS: u32 = 16_000;

/// Claude, with the key from the keyring.
pub struct Anthropic;

impl Model for Anthropic {
    fn complete(&self, req: &Request, on_text: &mut dyn FnMut(&str)) -> Result<Completion> {
        let key = providers::key(Provider::Anthropic, None)?;
        let mut call = providers::agent()
            .post(&format!("{API}/messages"))
            .header("x-api-key", &key)
            .header("anthropic-version", VERSION)
            .header("content-type", "application/json");
        if falls_back(&req.model) {
            call = call.header("anthropic-beta", FALLBACK_BETA);
        }
        let mut res =
            call.send(body(req).to_string()).map_err(providers::unreachable(Provider::Anthropic))?;
        let status = res.status().as_u16();
        if status != 200 {
            let text = res.body_mut().read_to_string().unwrap_or_default();
            bail!(refused(status, &text, &req.model));
        }
        read_stream(BufReader::new(res.into_body().into_reader()), on_text)
    }
}

/// Whether the key works and may use the model; its name if so. Costs nothing: it reads the model's entry.
pub(super) fn test(key: &str, model: &str) -> Result<String> {
    let v = providers::get_json(
        Provider::Anthropic,
        &format!("{API}/models/{model}"),
        &[("x-api-key", key), ("anthropic-version", VERSION)],
        model,
    )?;
    Ok(v["display_name"].as_str().unwrap_or(model).to_string())
}

/// Haiku has no server-side fallback; Opus and Sonnet take the "default" one.
fn falls_back(model: &str) -> bool {
    !model.contains("haiku")
}

fn body(req: &Request) -> Value {
    let mut body = json!({
        "model": req.model,
        "max_tokens": MAX_TOKENS,
        "stream": true,
        "system": req.system,
        "messages": [{ "role": "user", "content": req.user }],
        // Summaries and rewrites are short, everyday work: little thinking, quick answers, fewer tokens.
        "output_config": { "effort": "low" },
    });
    if falls_back(&req.model) {
        body["fallbacks"] = json!("default");
    }
    body
}

/// What to tell the person when Anthropic said no. Its overloaded status (529) is its own.
fn refused(status: u16, body: &str, model: &str) -> String {
    let v: Value = serde_json::from_str(body).unwrap_or_default();
    providers::refused(
        Provider::Anthropic,
        status,
        v["error"]["message"].as_str().unwrap_or("").trim(),
        model,
    )
}

/// The answer from the server-sent events of a streamed reply. Text deltas go out as they come; across a
/// fallback the next model carries on from what was already written, so the text simply continues.
fn read_stream(reader: impl BufRead, on_text: &mut dyn FnMut(&str)) -> Result<Completion> {
    let mut text = String::new();
    let mut input = 0;
    let mut output = 0;
    let mut stop = String::new();
    for line in reader.lines() {
        let line = line.context("The answer from Anthropic broke off. Try again.")?;
        let Some(data) = line.strip_prefix("data:") else { continue };
        let Ok(event) = serde_json::from_str::<Value>(data.trim()) else { continue };
        match event["type"].as_str().unwrap_or("") {
            "message_start" => {
                let usage = &event["message"]["usage"];
                input = ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"]
                    .iter()
                    .map(|k| usage[*k].as_i64().unwrap_or(0))
                    .sum::<i64>()
                    .max(input);
            }
            "content_block_delta" if event["delta"]["type"] == "text_delta" => {
                if let Some(t) = event["delta"]["text"].as_str() {
                    on_text(t);
                    text.push_str(t);
                }
            }
            "message_delta" => {
                if let Some(s) = event["delta"]["stop_reason"].as_str() {
                    stop = s.to_string();
                }
                output = event["usage"]["output_tokens"].as_i64().unwrap_or(output);
            }
            "error" => {
                let message = event["error"]["message"].as_str().unwrap_or("unknown error");
                if event["error"]["type"] == "overloaded_error" {
                    bail!("Anthropic is busy. Try again in a moment.");
                }
                bail!("Anthropic stopped answering: {message}");
            }
            "message_stop" => break,
            _ => {}
        }
    }
    if stop == "refusal" {
        bail!("Claude declined to answer this one.");
    }
    if stop.is_empty() {
        bail!("The answer from Anthropic broke off. Try again.");
    }
    Ok(Completion { text, tokens: input + output })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn canned(s: &'static str) -> impl BufRead {
        BufReader::new(s.as_bytes())
    }

    const STREAM: &str = "event: message_start\n\
data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_1\",\"model\":\"claude-opus-5-5\",\"usage\":{\"input_tokens\":900,\"cache_read_input_tokens\":100,\"output_tokens\":1}}}\n\n\
event: content_block_start\n\
data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"thinking\",\"thinking\":\"\"}}\n\n\
event: content_block_start\n\
data: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n\
event: content_block_delta\n\
data: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"text_delta\",\"text\":\"Ana needs \"}}\n\n\
event: content_block_start\n\
data: {\"type\":\"content_block_start\",\"index\":2,\"content_block\":{\"type\":\"fallback\",\"from\":{\"model\":\"claude-opus-5-5\"},\"to\":{\"model\":\"claude-opus-4-8\"}}}\n\n\
event: content_block_delta\n\
data: {\"type\":\"content_block_delta\",\"index\":3,\"delta\":{\"type\":\"text_delta\",\"text\":\"the deck.\"}}\n\n\
event: message_delta\n\
data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":40}}\n\n\
event: message_stop\n\
data: {\"type\":\"message_stop\"}\n\n";

    #[test]
    fn a_stream_reads_as_its_text_and_tokens_even_across_a_fallback() {
        let mut seen = Vec::new();
        let done = read_stream(canned(STREAM), &mut |t| seen.push(t.to_string())).unwrap();
        assert_eq!(done.text, "Ana needs the deck.");
        assert_eq!(seen, ["Ana needs ", "the deck."]);
        assert_eq!(done.tokens, 1_040);
    }

    #[test]
    fn refusals_errors_and_cut_streams_are_errors() {
        let refusal =
            "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"Par\"}}\n\
data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"refusal\"},\"usage\":{\"output_tokens\":3}}\n\
data: {\"type\":\"message_stop\"}\n";
        assert!(read_stream(canned(refusal), &mut |_| {}).unwrap_err().to_string().contains("declined"));
        let error = "data: {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"Overloaded\"}}\n";
        assert!(read_stream(canned(error), &mut |_| {}).unwrap_err().to_string().contains("busy"));
        let cut = "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"Half\"}}\n";
        assert!(read_stream(canned(cut), &mut |_| {}).unwrap_err().to_string().contains("broke off"));
    }

    #[test]
    fn the_request_asks_for_a_stream_with_fallback_where_there_is_one() {
        let req = Request {
            provider: Provider::Anthropic,
            model: "claude-opus-5-5".into(),
            system: "sys",
            user: "hi".into(),
        };
        let b = body(&req);
        assert_eq!((b["stream"].as_bool(), b["fallbacks"].as_str()), (Some(true), Some("default")));
        assert_eq!(b["output_config"]["effort"], "low");
        assert!(b.get("temperature").is_none() && b.get("thinking").is_none());
        let haiku = body(&Request { model: "claude-haiku-5-5".into(), ..req });
        assert!(haiku.get("fallbacks").is_none(), "Haiku has no server-side fallback");
    }

    #[test]
    fn refusals_say_what_to_do() {
        assert!(refused(401, "", "m").contains("API key"));
        assert!(refused(404, "", "claude-x").contains("claude-x"));
        assert!(refused(529, "", "m").contains("busy"));
        let bad =
            r#"{"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long"}}"#;
        assert_eq!(refused(400, bad, "m"), "Anthropic refused the request: prompt is too long");
    }
}
