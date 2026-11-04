//! Todoist (package 17 G, `docs/research/todoist.md`): tasks made from mail, with the person's own API token, kept in
//! the keyring as `todoist`. What goes is what the task box shows: the title, the day as typed, the project, the
//! label, and one line naming the mail (who sent it and its subject). Never the mail's text. A task is created from
//! the outbox after the undo window, like every other change. Blocking: call it from `spawn_blocking`.

use std::time::Duration;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

/// The keyring entry (service `tern-mail`) that holds the token.
pub const KEY: &str = "todoist";
const API: &str = "https://api.todoist.com/api/v1";

/// A task as it goes to Todoist.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NewTask {
    pub content: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub description: String,
    /// As the person typed it ("fri", "tomorrow 9am"): Todoist reads it in their language and time zone.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub due_string: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub labels: Vec<String>,
}

/// A project to put tasks in.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    /// The account's Inbox project, where a task without one goes.
    #[serde(default, alias = "inbox_project")]
    pub inbox: bool,
}

/// Todoist said no (a 4xx: the token is wrong or revoked, or the task was refused): trying again cannot change it.
#[derive(Debug)]
pub struct Refused(pub u16);

impl std::fmt::Display for Refused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self.0 {
            401 | 403 => write!(f, "Todoist refused the token. Connect again in Settings → Todoist"),
            code => write!(f, "Todoist refused the task (HTTP {code})"),
        }
    }
}

impl std::error::Error for Refused {}

/// The link that opens a task in Todoist.
pub fn task_url(id: &str) -> String {
    format!("https://app.todoist.com/app/task/{id}")
}

pub fn projects(token: &str) -> Result<Vec<Project>> {
    projects_at(&client(), API, token)
}

/// Creates the task; returns its id.
pub fn create(token: &str, task: &NewTask) -> Result<String> {
    create_at(&client(), API, token, task)
}

/// Ticks the task off in Todoist (`done`), or opens it again.
pub fn set_done(token: &str, id: &str, done: bool) -> Result<()> {
    set_done_at(&client(), API, token, id, done)
}

/// Where a task stands in Todoist now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskState {
    Open,
    Done,
    /// Deleted in Todoist (or never there): the conversation drops it.
    Gone,
}

pub fn state(token: &str, id: &str) -> Result<TaskState> {
    state_at(&client(), API, token, id)
}

fn set_done_at(agent: &ureq::Agent, api: &str, token: &str, id: &str, done: bool) -> Result<()> {
    let what = if done { "close" } else { "reopen" };
    let response = agent
        .post(&format!("{api}/tasks/{id}/{what}"))
        .header("Authorization", &format!("Bearer {token}"))
        .send_empty()
        .context("Could not reach Todoist")?;
    answer(response).map(|_| ())
}

fn state_at(agent: &ureq::Agent, api: &str, token: &str, id: &str) -> Result<TaskState> {
    #[derive(Deserialize)]
    struct Task {
        #[serde(default)]
        checked: bool,
        #[serde(default)]
        is_completed: bool,
        #[serde(default)]
        is_deleted: bool,
    }
    let response = agent
        .get(&format!("{api}/tasks/{id}"))
        .header("Authorization", &format!("Bearer {token}"))
        .call()
        .context("Could not reach Todoist")?;
    if response.status().as_u16() == 404 {
        return Ok(TaskState::Gone);
    }
    let task: Task = serde_json::from_str(&answer(response)?)?;
    Ok(if task.is_deleted {
        TaskState::Gone
    } else if task.checked || task.is_completed {
        TaskState::Done
    } else {
        TaskState::Open
    })
}

fn client() -> ureq::Agent {
    let tls = ureq::tls::TlsConfig::builder().root_certs(ureq::tls::RootCerts::PlatformVerifier).build();
    agent().tls_config(tls).https_only(true).build().into()
}

fn agent() -> ureq::config::ConfigBuilder<ureq::typestate::AgentScope> {
    ureq::Agent::config_builder()
        .http_status_as_error(false)
        .timeout_global(Some(Duration::from_secs(30)))
        .user_agent("Tern")
}

/// The body of a good answer, else the error it stands for.
fn answer(mut response: ureq::http::Response<ureq::Body>) -> Result<String> {
    let code = response.status().as_u16();
    match code {
        200..=299 => Ok(response.body_mut().read_to_string()?),
        400..=499 if code != 429 => Err(Refused(code).into()),
        _ => anyhow::bail!("Todoist had a problem (HTTP {code})"),
    }
}

fn projects_at(agent: &ureq::Agent, api: &str, token: &str) -> Result<Vec<Project>> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Page {
        Paged { results: Vec<Raw>, next_cursor: Option<String> },
        Plain(Vec<Raw>),
    }
    #[derive(Deserialize)]
    struct Raw {
        id: String,
        name: String,
        #[serde(default)]
        inbox_project: bool,
        #[serde(default)]
        is_inbox_project: bool,
    }
    let mut all = Vec::new();
    let mut cursor: Option<String> = None;
    // A few pages at most: nobody keeps thousands of projects.
    for _ in 0..10 {
        let mut url = format!("{api}/projects?limit=200");
        if let Some(c) = &cursor {
            url.push_str("&cursor=");
            url.push_str(c);
        }
        let response = agent
            .get(&url)
            .header("Authorization", &format!("Bearer {token}"))
            .call()
            .context("Could not reach Todoist")?;
        let (raws, next) = match serde_json::from_str::<Page>(&answer(response)?)? {
            Page::Paged { results, next_cursor } => (results, next_cursor),
            Page::Plain(raws) => (raws, None),
        };
        all.extend(raws.into_iter().map(|r| Project {
            id: r.id,
            name: r.name,
            inbox: r.inbox_project || r.is_inbox_project,
        }));
        match next {
            Some(c) if !c.is_empty() => cursor = Some(c),
            _ => break,
        }
    }
    Ok(all)
}

fn create_at(agent: &ureq::Agent, api: &str, token: &str, task: &NewTask) -> Result<String> {
    #[derive(Deserialize)]
    struct Created {
        id: String,
    }
    let response = agent
        .post(&format!("{api}/tasks"))
        .header("Authorization", &format!("Bearer {token}"))
        .header("Content-Type", "application/json")
        .send(serde_json::to_string(task)?)
        .context("Could not reach Todoist")?;
    Ok(serde_json::from_str::<Created>(&answer(response)?)?.id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    /// Answers each request in turn with `replies` (status, body); returns what was asked.
    fn serve(replies: Vec<(&'static str, &'static str)>) -> (String, std::thread::JoinHandle<Vec<String>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let api = format!("http://{}/api/v1", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let mut asked = Vec::new();
            for (status, body) in replies {
                let (mut s, _) = listener.accept().unwrap();
                let mut got = Vec::new();
                let mut buf = [0; 4096];
                loop {
                    let n = s.read(&mut buf).unwrap();
                    got.extend_from_slice(&buf[..n]);
                    let text = String::from_utf8_lossy(&got);
                    if let Some(end) = text.find("\r\n\r\n") {
                        let len = text
                            .lines()
                            .find_map(|l| {
                                l.to_ascii_lowercase()
                                    .strip_prefix("content-length:")
                                    .map(|v| v.trim().to_string())
                            })
                            .and_then(|v| v.parse::<usize>().ok())
                            .unwrap_or(0);
                        if got.len() >= end + 4 + len {
                            break;
                        }
                    }
                    if n == 0 {
                        break;
                    }
                }
                let reply = format!(
                    "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                s.write_all(reply.as_bytes()).unwrap();
                asked.push(String::from_utf8(got).unwrap());
            }
            asked
        });
        (api, server)
    }

    #[test]
    fn creates_a_task_with_only_what_the_box_holds() {
        let (api, server) = serve(vec![("200 OK", r#"{"id":"6X7rM8997g3RQmvh","content":"Send the deck"}"#)]);
        let task = NewTask {
            content: "Send the deck".into(),
            description: "From Ada Lovelace · Q3 offsite".into(),
            due_string: Some("fri".into()),
            project_id: None,
            labels: vec!["mail".into()],
        };
        let id = create_at(&agent().build().into(), &api, "secret", &task).unwrap();
        assert_eq!(id, "6X7rM8997g3RQmvh");
        let sent = &server.join().unwrap()[0];
        assert!(sent.starts_with("POST /api/v1/tasks HTTP/1.1\r\n"), "{sent}");
        assert!(sent.to_ascii_lowercase().contains("authorization: bearer secret"));
        let body: serde_json::Value = serde_json::from_str(sent.split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!(
            body,
            serde_json::json!({"content": "Send the deck", "description": "From Ada Lovelace · Q3 offsite",
                               "due_string": "fri", "labels": ["mail"]}),
            "no empty fields, nothing else"
        );
    }

    #[test]
    fn reads_projects_page_by_page() {
        let (api, server) = serve(vec![
            ("200 OK", r#"{"results":[{"id":"1","name":"Inbox","inbox_project":true}],"next_cursor":"abc"}"#),
            ("200 OK", r#"{"results":[{"id":"2","name":"Work"}],"next_cursor":null}"#),
        ]);
        let found = projects_at(&agent().build().into(), &api, "secret").unwrap();
        let names: Vec<_> = found.iter().map(|p| (p.name.as_str(), p.inbox)).collect();
        assert_eq!(names, [("Inbox", true), ("Work", false)]);
        let asked = server.join().unwrap();
        assert!(asked[1].starts_with("GET /api/v1/projects?limit=200&cursor=abc "), "{}", asked[1]);
    }

    #[test]
    fn ticks_off_and_reads_back_a_task() {
        let (api, server) = serve(vec![
            ("204 No Content", ""),
            ("204 No Content", ""),
            ("200 OK", r#"{"id":"7","checked":true}"#),
            ("200 OK", r#"{"id":"7","checked":false}"#),
            ("404 Not Found", "{}"),
        ]);
        let agent: ureq::Agent = agent().build().into();
        set_done_at(&agent, &api, "secret", "7", true).unwrap();
        set_done_at(&agent, &api, "secret", "7", false).unwrap();
        assert_eq!(state_at(&agent, &api, "secret", "7").unwrap(), TaskState::Done);
        assert_eq!(state_at(&agent, &api, "secret", "7").unwrap(), TaskState::Open);
        assert_eq!(state_at(&agent, &api, "secret", "7").unwrap(), TaskState::Gone);
        let asked = server.join().unwrap();
        assert!(asked[0].starts_with("POST /api/v1/tasks/7/close "), "{}", asked[0]);
        assert!(asked[1].starts_with("POST /api/v1/tasks/7/reopen "), "{}", asked[1]);
        assert!(asked[2].starts_with("GET /api/v1/tasks/7 "), "{}", asked[2]);
    }

    #[test]
    fn a_wrong_token_is_permanent_and_a_busy_server_is_not() {
        let (api, server) = serve(vec![
            ("401 Unauthorized", "{}"),
            ("429 Too Many Requests", "{}"),
            ("503 Service Unavailable", "{}"),
        ]);
        let agent: ureq::Agent = agent().build().into();
        assert!(projects_at(&agent, &api, "x").unwrap_err().is::<Refused>());
        assert!(!projects_at(&agent, &api, "x").unwrap_err().is::<Refused>());
        assert!(!projects_at(&agent, &api, "x").unwrap_err().is::<Refused>());
        server.join().unwrap();
    }
}
