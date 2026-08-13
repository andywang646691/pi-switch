//! Raw request/response capture log.
//!
//! Unlike `requests.log` (per-request metadata + usage), this JSONL file stores
//! the *raw* client request and the *raw* upstream response for every upstream
//! attempt, so request/response pairs can be analyzed byte-for-byte. It is
//! consumed **only** by the Web UI (`/api/rawlogs*`); the CLI and TUI never
//! read it.
//!
//! Layout: one JSON object per line, newest appended last. Each entry is
//! self-contained: the client request (denormalized) plus one upstream
//! attempt. Failover attempts against the same client request share a
//! `requestId` so the UI can group them.
//!
//! Bodies are capped (default 2 MiB, configurable via
//! `settings.proxy.rawLog.maxBodyBytes`) so long streams cannot balloon
//! memory or disk; capped bodies are flagged `bodyTruncated`.
//!
//! Only the newest [`MAX_RAW_ENTRIES`] entries are retained — older entries
//! are dropped on append — so the file size stays bounded no matter how long
//! the proxy runs.

use crate::config;
use serde_json::{json, Value};
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

pub const RAW_LOG_FILE: &str = "raw-requests.log";

/// How many entries the raw log keeps at most (newest wins). Kept small so
/// the file stays small and every read stays fast — the Web UI only ever
/// shows the latest page anyway.
pub const MAX_RAW_ENTRIES: usize = 10;

/// Serializes tests that read/write the raw log file so parallel test threads
/// cannot interleave entries and break count/ordering assertions.
#[cfg(test)]
pub(crate) static RAW_LOG_TEST_LOCK: Mutex<()> = Mutex::new(());

// ─── Settings ────────────────────────────────────────────

fn settings() -> config::RawLogSettings {
    config::load_config()
        .map(|c| c.settings.proxy.raw_log)
        .unwrap_or_default()
}

/// Whether raw capture is currently enabled (checked per request).
pub fn enabled() -> bool {
    settings().enabled
}

/// The per-body capture cap in bytes (always at least 1 KiB so a configured
/// value of 0 cannot make captures useless).
pub fn max_body_bytes() -> usize {
    settings().max_body_bytes.max(1024)
}

// ─── Path / id helpers ───────────────────────────────────

/// Where proxy runtime state lives. Tests redirect to a per-process temp dir
/// (shared with `proxy::init_test_state_dir`) so unit tests never pollute the
/// real `~/.pi-switch` directory.
fn state_dir() -> PathBuf {
    #[cfg(test)]
    {
        crate::proxy::init_test_state_dir().clone()
    }
    #[cfg(not(test))]
    {
        config::config_dir()
    }
}

fn raw_log_path() -> PathBuf {
    state_dir().join(RAW_LOG_FILE)
}

fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339()
}

static ID_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Monotonic-ish id: wall-clock millis + a per-process counter, unique enough
/// for local log entries.
pub fn new_id() -> String {
    let millis = chrono::Utc::now().timestamp_millis();
    let seq = ID_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{millis}-{seq}")
}

// ─── Body capping ────────────────────────────────────────

/// Keep the head of `s` up to `max` bytes on a UTF-8 boundary. Returns the
/// capped string and whether anything was dropped.
pub fn cap_str(s: &str, max: usize) -> (String, bool) {
    if s.len() <= max {
        return (s.to_string(), false);
    }
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    (s[..end].to_string(), true)
}

/// Keep the head of `bytes` up to `max` bytes. Returns the capped bytes and
/// whether anything was dropped.
pub fn cap_bytes(bytes: &[u8], max: usize) -> (Vec<u8>, bool) {
    if bytes.len() <= max {
        return (bytes.to_vec(), false);
    }
    (bytes[..max].to_vec(), true)
}

// ─── Append ──────────────────────────────────────────────

/// Serialize `entry` and append it to `raw-requests.log` (creating the file
/// and parent directory as needed). Synchronous: callable from stream teardown
/// paths where awaiting is not possible. Concurrent streams are serialized so
/// lines never interleave.
pub fn append_raw_entry(entry: &Value) {
    static RAW_LOG_LOCK: Mutex<()> = Mutex::new(());
    let _guard = RAW_LOG_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    let log_path = raw_log_path();
    if let Some(parent) = log_path.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    if let Ok(json) = serde_json::to_string(entry) {
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
        {
            let _ = writeln!(file, "{json}");
        }
    }
    trim_to_latest(MAX_RAW_ENTRIES);
}

/// Drop all but the newest `max` entries by rewriting the file. Best-effort:
/// if the rewrite fails the file simply keeps more entries than the cap (the
/// next successful append retries the trim).
fn trim_to_latest(max: usize) {
    let entries = read_entries();
    if entries.len() <= max {
        return;
    }
    let keep = &entries[entries.len() - max..];
    let log_path = raw_log_path();
    if let Ok(mut file) = std::fs::File::create(&log_path) {
        for entry in keep {
            if let Ok(json) = serde_json::to_string(entry) {
                let _ = writeln!(file, "{json}");
            }
        }
    }
}

// ─── Reading (Web UI only) ───────────────────────────────

/// Parse every entry in the raw log, oldest first. Malformed/empty lines are
/// skipped. Reads the whole file — fine for a local tool; bodies are capped so
/// the file stays bounded in practice.
fn read_entries() -> Vec<Value> {
    let Ok(text) = std::fs::read_to_string(raw_log_path()) else {
        return Vec::new();
    };
    text.lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .collect()
}

/// Total number of entries in the log.
pub fn count() -> usize {
    read_entries().len()
}

/// List entries newest-first (the file order is chronological, so we reverse),
/// `limit` of them starting at `offset`. Bodies are stripped from the payload —
/// only metadata plus byte sizes are returned, so listing stays cheap even when
/// entries hold multi-megabyte bodies.
pub fn list(limit: usize, offset: usize) -> Vec<Value> {
    read_entries()
        .into_iter()
        .rev()
        .skip(offset)
        .take(limit)
        .map(meta_of)
        .collect()
}

/// Fetch one full entry (with bodies) by its id.
pub fn get(id: &str) -> Option<Value> {
    read_entries()
        .into_iter()
        .rev()
        .find(|entry| entry.get("id").and_then(|v| v.as_str()) == Some(id))
}

/// Delete all raw log entries. Returns how many were removed.
pub fn clear() -> usize {
    let n = count();
    let _ = std::fs::remove_file(raw_log_path());
    n
}

/// Strip bodies from an entry, replacing each with its byte size so the UI can
/// show "how much was captured" without shipping the bytes on every list call.
fn meta_of(mut entry: Value) -> Value {
    for key in ["client", "attempt"] {
        if let Some(obj) = entry.get_mut(key).and_then(|v| v.as_object_mut()) {
            let bytes = obj
                .remove("body")
                .and_then(|b| b.as_str().map(|s| s.len()))
                .unwrap_or(0);
            obj.insert("bodyBytes".to_string(), json!(bytes));
        }
    }
    entry
}

// ─── Capture structs ─────────────────────────────────────

/// Hop-by-hop / framing headers that add no analytic value and can differ from
/// what actually went on the wire — skipped in captures.
fn is_skippable_header(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    matches!(
        lower.as_str(),
        "host"
            | "connection"
            | "content-length"
            | "transfer-encoding"
            | "upgrade"
            | "keep-alive"
            | "te"
            | "trailer"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "proxy-connection"
    ) || lower.starts_with("proxy-")
}

/// Header values that would leak credentials into the raw log if stored
/// verbatim — masked in captures (scheme kept, value redacted).
fn mask_header_value(name: &str, value: &str) -> String {
    let lower = name.to_ascii_lowercase();
    if matches!(lower.as_str(), "authorization" | "x-api-key" | "cookie" | "set-cookie") {
        match value.split_whitespace().next() {
            Some(scheme) if !scheme.eq_ignore_ascii_case("cookie") => format!("{scheme} ***"),
            _ => "***".to_string(),
        }
    } else {
        value.to_string()
    }
}

/// Build a JSON object from ordered (name, value) pairs.
fn header_object(headers: &[(String, String)]) -> Value {
    let mut map = serde_json::Map::new();
    for (name, value) in headers {
        map.insert(name.clone(), json!(value));
    }
    Value::Object(map)
}

/// Captureable headers from an axum request: hop-by-hop filtered, secrets
/// masked.
pub fn capture_request_headers(headers: &axum::http::HeaderMap) -> Vec<(String, String)> {
    headers
        .iter()
        .filter(|(name, _)| !is_skippable_header(name.as_str()))
        .map(|(name, value)| {
            let value = value.to_str().unwrap_or_default().to_string();
            (name.as_str().to_string(), mask_header_value(name.as_str(), &value))
        })
        .collect()
}

/// Captureable headers from a reqwest upstream response: hop-by-hop filtered,
/// secrets masked.
pub fn capture_response_headers(headers: &reqwest::header::HeaderMap) -> Vec<(String, String)> {
    headers
        .iter()
        .filter(|(name, _)| !is_skippable_header(name.as_str()))
        .map(|(name, value)| {
            let value = value.to_str().unwrap_or_default().to_string();
            (name.as_str().to_string(), mask_header_value(name.as_str(), &value))
        })
        .collect()
}

/// The raw client request, captured once per incoming request and denormalized
/// into every attempt entry (streaming tees write entries asynchronously, so
/// entries must be self-contained).
#[derive(Clone)]
pub struct RawClientCapture {
    /// Shared by every attempt entry of the same incoming request.
    pub request_id: String,
    /// When the request was received.
    pub ts: String,
    pub method: String,
    pub path: String,
    /// Hop-by-hop filtered, secrets masked.
    pub headers: Vec<(String, String)>,
    /// Raw body, capped.
    pub body: String,
    pub body_truncated: bool,
}

impl RawClientCapture {
    /// Capture the client request when raw logging is enabled; `None` when
    /// disabled so the hot path pays nothing.
    pub fn capture(
        uri: &axum::http::Uri,
        headers: &axum::http::HeaderMap,
        raw_body: &str,
    ) -> Option<Self> {
        if !enabled() {
            return None;
        }
        let (body, body_truncated) = cap_str(raw_body, max_body_bytes());
        Some(Self {
            request_id: new_id(),
            ts: now_rfc3339(),
            method: "POST".to_string(),
            path: uri.path().to_string(),
            headers: capture_request_headers(headers),
            body,
            body_truncated,
        })
    }
}

/// One upstream attempt: provider + URL + response metadata + raw body.
pub struct RawAttempt {
    pub provider: String,
    pub url: String,
    pub status: Option<u16>,
    pub ok: bool,
    pub headers: Vec<(String, String)>,
    pub body: String,
    pub body_truncated: bool,
    pub error: Option<String>,
}

/// Build the full JSON entry for one upstream attempt.
pub fn attempt_entry(client: &RawClientCapture, attempt: RawAttempt) -> Value {
    let attempt_body_bytes = attempt.body.len();
    json!({
        "id": new_id(),
        "requestId": client.request_id,
        "ts": now_rfc3339(),
        "ok": attempt.ok,
        "error": attempt.error,
        "client": {
            "ts": client.ts,
            "method": client.method,
            "path": client.path,
            "headers": header_object(&client.headers),
            "body": client.body,
            "bodyTruncated": client.body_truncated,
            "bodyBytes": client.body.len(),
        },
        "attempt": {
            "provider": attempt.provider,
            "url": attempt.url,
            "status": attempt.status,
            "ok": attempt.ok,
            "headers": header_object(&attempt.headers),
            "body": attempt.body,
            "bodyTruncated": attempt.body_truncated,
            "bodyBytes": attempt_body_bytes,
            "error": attempt.error,
        },
    })
}

/// Entry for a request that never reached an upstream (no route, conversion
/// failure, or exhausted candidates without a response).
pub fn error_entry(client: &RawClientCapture, error: &str) -> Value {
    json!({
        "id": new_id(),
        "requestId": client.request_id,
        "ts": now_rfc3339(),
        "ok": false,
        "error": error,
        "client": {
            "ts": client.ts,
            "method": client.method,
            "path": client.path,
            "headers": header_object(&client.headers),
            "body": client.body,
            "bodyTruncated": client.body_truncated,
            "bodyBytes": client.body.len(),
        },
        "attempt": null,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cap_str_keeps_head_on_utf8_boundary() {
        let s = "héllo wörld";
        let (capped, truncated) = cap_str(s, 5);
        assert!(truncated);
        assert!(capped.len() <= 5);
        assert!(capped.is_char_boundary(capped.len()));
        assert_eq!(capped, s[..capped.len()]);
    }

    #[test]
    fn cap_str_short_string_is_untouched() {
        let (capped, truncated) = cap_str("abc", 10);
        assert_eq!(capped, "abc");
        assert!(!truncated);
    }

    #[test]
    fn cap_bytes_cuts_at_limit() {
        let (capped, truncated) = cap_bytes(b"abcdef", 3);
        assert_eq!(capped, b"abc");
        assert!(truncated);
        let (capped, truncated) = cap_bytes(b"abc", 3);
        assert_eq!(capped, b"abc");
        assert!(!truncated);
    }

    #[test]
    fn request_headers_are_filtered_and_masked() {
        let mut headers = axum::http::HeaderMap::new();
        headers.insert("authorization", "Bearer super-secret".parse().unwrap());
        headers.insert("host", "127.0.0.1:43112".parse().unwrap());
        headers.insert("content-type", "application/json".parse().unwrap());
        headers.insert("x-conversation-id", "conv-1".parse().unwrap());
        let captured = capture_request_headers(&headers);
        let map: std::collections::HashMap<_, _> = captured.into_iter().collect();
        assert_eq!(map.get("authorization").unwrap(), "Bearer ***");
        assert_eq!(map.get("content-type").unwrap(), "application/json");
        assert_eq!(map.get("x-conversation-id").unwrap(), "conv-1");
        assert!(!map.contains_key("host"));
    }

    #[test]
    fn capture_respects_disabled_setting() {
        // Default settings have capture enabled; the capture itself does not
        // depend on the real config file (settings() reads it, so this test
        // only exercises the cap/capture logic via a fake uri).
        let uri: axum::http::Uri = "/v1/chat/completions".parse().unwrap();
        let mut headers = axum::http::HeaderMap::new();
        headers.insert("content-type", "application/json".parse().unwrap());
        // In tests the config dir is the real one; guard against a missing
        // config by using the default-enabled path. Skip if disabled.
        let capture = RawClientCapture::capture(&uri, &headers, "{\"model\":\"x\"}");
        if super::enabled() {
            let capture = capture.expect("capture when enabled");
            assert_eq!(capture.path, "/v1/chat/completions");
            assert_eq!(capture.body, "{\"model\":\"x\"}");
            assert!(!capture.body_truncated);
        } else {
            assert!(capture.is_none());
        }
    }

    #[test]
    fn entry_roundtrip_through_file() {
        let _guard = RAW_LOG_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let dir = crate::proxy::init_test_state_dir();
        let path = dir.join(RAW_LOG_FILE);
        let _ = std::fs::remove_file(&path);

        let uri: axum::http::Uri = "/v1/chat/completions".parse().unwrap();
        let mut headers = axum::http::HeaderMap::new();
        headers.insert("authorization", "Bearer sk-test".parse().unwrap());
        let client = RawClientCapture::capture(&uri, &headers, "{\"model\":\"m\"}")
            .expect("capture should be enabled by default");
        let attempt = RawAttempt {
            provider: "p1".to_string(),
            url: "https://upstream/v1/chat/completions".to_string(),
            status: Some(200),
            ok: true,
            headers: vec![("content-type".to_string(), "application/json".to_string())],
            body: "{\"id\":\"resp-1\"}".to_string(),
            body_truncated: false,
            error: None,
        };
        append_raw_entry(&attempt_entry(&client, attempt));
        append_raw_entry(&error_entry(&client, "no_route"));

        assert_eq!(count(), 2);
        let listed = list(10, 0);
        assert_eq!(listed.len(), 2);
        // Newest first.
        assert!(listed[0]["attempt"].is_null());
        assert!(listed[1]["attempt"]["status"] == json!(200));
        // Bodies stripped in list, sizes kept.
        assert!(listed[1]["client"].get("body").is_none());
        assert_eq!(listed[1]["client"]["bodyBytes"], json!(13));

        let full = get(listed[1]["id"].as_str().unwrap()).unwrap();
        assert_eq!(full["client"]["body"], "{\"model\":\"m\"}");
        assert_eq!(full["client"]["headers"]["authorization"], "Bearer ***");
        assert_eq!(full["attempt"]["body"], "{\"id\":\"resp-1\"}");

        assert_eq!(clear(), 2);
        assert_eq!(count(), 0);
    }

    #[test]
    fn append_keeps_only_latest_ten_entries() {
        let _guard = RAW_LOG_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let dir = crate::proxy::init_test_state_dir();
        let path = dir.join(RAW_LOG_FILE);
        let _ = std::fs::remove_file(&path);

        let client = RawClientCapture {
            request_id: "r1".to_string(),
            ts: "2026-08-13T00:00:00Z".to_string(),
            method: "POST".to_string(),
            path: "/v1/chat/completions".to_string(),
            headers: vec![],
            body: "{}".to_string(),
            body_truncated: false,
        };
        for i in 0..12 {
            append_raw_entry(&error_entry(&client, &format!("e{i}")));
        }

        assert_eq!(count(), MAX_RAW_ENTRIES);
        let listed = list(100, 0);
        assert_eq!(listed.len(), MAX_RAW_ENTRIES);
        // Newest first: e11 newest, e0/e1 were dropped.
        assert_eq!(listed[0]["error"], "e11");
        assert_eq!(listed.last().unwrap()["error"], "e2");

        assert_eq!(clear(), MAX_RAW_ENTRIES);
    }
}
