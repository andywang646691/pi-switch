//! Upstream recovery monitor (runs inside the proxy process).
//!
//! When every node of a failover chain is circuit-open ("all upstreams
//! broken"), the monitor enters watch mode: it periodically probes the broken
//! nodes with a lightweight health request and clears a node's circuit the
//! moment it answers healthily. Each recovery appends one JSON line to
//! `~/.pi-switch/recovery.jsonl` — the pi extension watches that file and sends
//! a "continue" user message so pi retries the interrupted request.
//!
//! Scope: the monitor never touches request routing; it only reacts to circuit
//! state that the proxy itself wrote, and its recovery transition is identical
//! to the proxy's own successful half-open probe (see `clear_circuit`).

use std::collections::HashSet;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde_json::Value;

use crate::config::{load_config, MonitorSettings, PiSwitchConfig, ProxySettings};
use crate::proxy::{is_node_broken, CircuitStateStore};

// ─── Failover chains ─────────────────────────────────────────────────────────

/// Collect every failover chain from the config:
///  1. `settings.proxy.rules[].providers` — one chain per rule
///  2. legacy `settings.proxy.failover` — the global chain
///  3. fallback `[settings.proxy.target]` when neither exists
///  4. every other routable single profile (`proxy != true` and non-empty
///     `exposedModels`) as a single-node chain — so a provider used without any
///     failover rule still gets monitored when it trips the circuit breaker.
///
/// Profiles already covered by a rule/legacy chain are skipped in step 4: a
/// single broken node inside a multi-node chain does not mean the gateway is
/// down (failover keeps serving), so it must not trigger watch mode on its own.
/// Identical chains are deduplicated.
pub fn extract_chains(config: &PiSwitchConfig) -> Vec<Vec<String>> {
    let proxy: &ProxySettings = &config.settings.proxy;
    let mut chains: Vec<Vec<String>> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    for rule in &proxy.rules {
        push_chain(&mut chains, &mut seen, &rule.providers);
    }
    if !proxy.failover.is_empty() {
        push_chain(&mut chains, &mut seen, &proxy.failover);
    } else if let Some(target) = &proxy.target {
        push_chain(&mut chains, &mut seen, std::slice::from_ref(target));
    }

    let covered: HashSet<String> = chains.iter().flatten().cloned().collect();
    for (name, profile) in &config.profiles {
        if covered.contains(name.as_str()) {
            continue;
        }
        if profile
            .get("proxy")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            continue;
        }
        let routable = profile
            .get("exposedModels")
            .and_then(Value::as_array)
            .map(|arr| !arr.is_empty())
            .unwrap_or(false);
        if routable {
            push_chain(&mut chains, &mut seen, std::slice::from_ref(name));
        }
    }

    chains
}

fn push_chain(chains: &mut Vec<Vec<String>>, seen: &mut HashSet<String>, chain: &[String]) {
    let names: Vec<String> = chain
        .iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    if names.is_empty() {
        return;
    }
    if seen.insert(names.join("\u{0}")) {
        chains.push(names);
    }
}

/// The chains whose every node is circuit-open right now.
pub fn broken_chains(config: &PiSwitchConfig, circuit: &CircuitStateStore) -> Vec<Vec<String>> {
    extract_chains(config)
        .into_iter()
        .filter(|chain| chain.iter().all(|name| is_node_broken(name, circuit)))
        .collect()
}

// ─── Health probe ────────────────────────────────────────────────────────────

/// Build the probe request for one profile: GET {baseUrl}{probePath}.
/// OpenAI-compatible upstreams use `Authorization: Bearer`; Anthropic uses
/// `x-api-key`; custom `profile.headers` are merged; `$ENV` values in
/// apiKey/header values are resolved. Returns an empty URL when the profile is
/// not probeable (no baseUrl).
pub fn build_probe(profile: &Value, probe_path: &str) -> (String, HeaderMap) {
    let base = profile
        .get("baseUrl")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim_end_matches('/')
        .to_string();
    let api_key = crate::config::resolve_env(
        profile.get("apiKey").and_then(Value::as_str).unwrap_or(""),
    );
    let api = profile.get("api").and_then(Value::as_str).unwrap_or("");
    let is_anthropic = api.to_lowercase().contains("anthropic");

    let mut headers = HeaderMap::new();
    if let Some(custom) = profile.get("headers").and_then(Value::as_object) {
        for (k, v) in custom {
            let Some(value) = v.as_str() else { continue };
            let (Ok(kh), Ok(vh)) = (
                HeaderName::from_bytes(k.as_bytes()),
                HeaderValue::from_str(&crate::config::resolve_env(value)),
            ) else {
                continue;
            };
            headers.insert(kh, vh);
        }
    }

    if is_anthropic {
        if !api_key.is_empty() {
            if let Ok(v) = HeaderValue::from_str(&api_key) {
                headers.insert("x-api-key", v);
            }
        }
        if !headers.contains_key("anthropic-version") {
            headers.insert("anthropic-version", HeaderValue::from_static("2023-06-01"));
        }
    } else if !api_key.is_empty() {
        if let Ok(v) = HeaderValue::from_str(&format!("Bearer {api_key}")) {
            headers.insert("authorization", v);
        }
    }

    let path = if probe_path.starts_with('/') {
        probe_path.to_string()
    } else {
        format!("/{probe_path}")
    };
    (format!("{base}{path}"), headers)
}

/// Probe one upstream: any 2xx response counts as healthy; network errors,
/// timeouts and non-2xx statuses count as unavailable.
async fn probe_healthy(url: &str, headers: &HeaderMap, timeout_ms: u64) -> bool {
    if !url.starts_with("http") {
        return false;
    }
    let client = reqwest::Client::new();
    let send = client.get(url).headers(headers.clone()).send();
    match tokio::time::timeout(Duration::from_millis(timeout_ms), send).await {
        Ok(Ok(resp)) => resp.status().is_success(),
        _ => false,
    }
}

// ─── Recovery events ─────────────────────────────────────────────────────────

pub fn recovery_log_path() -> std::path::PathBuf {
    // 测试重定向到 per-process 临时目录, 不污染真实 ~/.pi-switch
    #[cfg(test)]
    {
        crate::proxy::init_test_state_dir().join("recovery.jsonl")
    }
    #[cfg(not(test))]
    {
        crate::config::config_dir().join("recovery.jsonl")
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// Append one recovery event (JSON line). `conversations` are the session ids
/// whose requests failed during the outage (see `CircuitEntry.affected_conversations`)
/// — the pi extension only sends a "continue" for sessions named here, so failures
/// caused by other (non-pi) clients never trigger a spurious retry. The file is
/// trimmed to the last 200 lines when it grows past 1 MB so it stays a cheap
/// tail-poll target.
pub fn append_recovery_event(provider: &str, chain: &[String], conversations: &[String]) {
    let line = serde_json::json!({
        "ts": now_ms(),
        "provider": provider,
        "chain": chain,
        "conversations": conversations,
    });
    let path = recovery_log_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    use std::io::Write;
    let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    else {
        return;
    };
    let _ = writeln!(file, "{line}");
    drop(file);

    if let Ok(meta) = std::fs::metadata(&path) {
        if meta.len() > 1_000_000 {
            if let Ok(text) = std::fs::read_to_string(&path) {
                let lines: Vec<&str> = text.lines().collect();
                let tail = lines.len().saturating_sub(200);
                let trimmed = lines[tail..].join("\n") + "\n";
                let _ = std::fs::write(&path, trimmed);
            }
        }
    }
}

// ─── Monitor loop ────────────────────────────────────────────────────────────

/// Background task spawned by the proxy process. Reloads the config on every
/// tick so `settings.proxy.monitor.*` edits apply without a restart.
pub async fn run_monitor_loop() {
    loop {
        let seconds = load_config()
            .map(|c| c.settings.proxy.monitor.probe_interval_seconds.max(1))
            .unwrap_or(15);
        tokio::time::sleep(Duration::from_secs(seconds)).await;

        let config = match load_config() {
            Ok(c) => c,
            Err(_) => continue, // config mid-write; retry next tick
        };
        let settings: MonitorSettings = config.settings.proxy.monitor.clone();
        if !settings.enabled {
            continue;
        }
        // Circuits cannot be open while the breaker itself is disabled.
        if !config.settings.proxy.circuit_breaker.enabled {
            continue;
        }
        monitor_tick(&config, &settings).await;
    }
}

/// One monitoring pass: for every fully-broken chain, probe the broken nodes
/// concurrently and recover (clear circuit + emit event) the ones that answer
/// healthily.
pub async fn monitor_tick(config: &PiSwitchConfig, settings: &MonitorSettings) {
    let circuit = crate::proxy::read_circuit_state().await;
    let broken = broken_chains(config, &circuit);
    if broken.is_empty() {
        return;
    }

    // 收集待探测节点 (去重), 并发探测, 避免 N 个节点串行等待超时
    let mut probed: HashSet<String> = HashSet::new();
    let mut tasks: Vec<(String, Vec<String>, String, HeaderMap)> = Vec::new();
    for chain in &broken {
        for name in chain {
            if !is_node_broken(name, &circuit) || !probed.insert(name.clone()) {
                continue;
            }
            let Some(profile) = config.profiles.get(name) else {
                continue;
            };
            let (url, headers) = build_probe(profile, &settings.probe_path);
            if url.is_empty() {
                continue;
            }
            tasks.push((name.clone(), chain.clone(), url, headers));
        }
    }

    let results = futures_util::future::join_all(tasks.into_iter().map(
        |(name, chain, url, headers)| async move {
            let healthy = probe_healthy(&url, &headers, settings.probe_timeout_ms).await;
            (name, chain, healthy)
        },
    ))
    .await;

    for (name, chain, healthy) in results {
        if healthy {
            let (was_open, conversations) = crate::proxy::clear_circuit(&name).await;
            if was_open {
                append_recovery_event(&name, &chain, &conversations);
            }
        }
    }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn profile(exposed: &[&str]) -> Value {
        let mut p = json!({
            "api": "openai-completions",
            "apiKey": "sk-test",
            "baseUrl": "https://up.example.com/v1",
        });
        if !exposed.is_empty() {
            p["exposedModels"] = json!(exposed);
        }
        p
    }

    fn config_with(
        rules: Vec<(Vec<&str>, Vec<&str>)>,
        failover: Option<Vec<&str>>,
        target: Option<&str>,
        profiles: Vec<(&str, Value)>,
    ) -> PiSwitchConfig {
        let mut config = PiSwitchConfig::default();
        for (name, p) in profiles {
            config.profiles.insert(name.to_string(), p);
        }
        config.settings.proxy.rules = rules
            .into_iter()
            .map(|(m, providers)| crate::config::FailoverRule {
                name: None,
                r#match: crate::config::RuleMatch {
                    model_prefix: m.first().map(|s| s.to_string()),
                    model_contains: m.get(1).map(|s| s.to_string()),
                },
                providers: providers.into_iter().map(|s| s.to_string()).collect(),
            })
            .collect();
        config.settings.proxy.failover = failover
            .map(|v| v.into_iter().map(String::from).collect::<Vec<_>>())
            .unwrap_or_default();
        config.settings.proxy.target = target.map(String::from);
        config
    }

    #[test]
    fn extract_chains_collects_rule_chains_in_order() {
        let config = config_with(
            vec![(vec![], vec!["a", "b"]), (vec![], vec!["c"])],
            None,
            None,
            vec![],
        );
        assert_eq!(extract_chains(&config), vec![vec!["a", "b"], vec!["c"]]);
    }

    #[test]
    fn extract_chains_falls_back_to_legacy_failover_then_target() {
        let via_failover = config_with(vec![], Some(vec!["a", "b"]), None, vec![]);
        assert_eq!(extract_chains(&via_failover), vec![vec!["a", "b"]]);

        let via_target = config_with(vec![], None, Some("a"), vec![]);
        assert_eq!(extract_chains(&via_target), vec![vec!["a"]]);

        let empty = PiSwitchConfig::default();
        assert!(extract_chains(&empty).is_empty());
    }

    #[test]
    fn extract_chains_deduplicates_and_drops_empties() {
        let config = config_with(
            vec![(vec![], vec!["a", "b"]), (vec![], vec!["a", "b"])],
            Some(vec!["a", "b"]),
            None,
            vec![],
        );
        assert_eq!(extract_chains(&config), vec![vec!["a", "b"]]);

        let empties = config_with(vec![(vec![], vec![]), (vec![], vec!["  "])], None, None, vec![]);
        assert!(extract_chains(&empties).is_empty());
    }

    #[test]
    fn extract_chains_adds_single_node_chains_for_routable_profiles() {
        let config = config_with(
            vec![],
            None,
            None,
            vec![
                ("congee", profile(&["gpt-x"])),
                ("yiapi", profile(&["gpt-y"])),
            ],
        );
        assert_eq!(
            extract_chains(&config),
            vec![vec!["congee"], vec!["yiapi"]]
        );
    }

    #[test]
    fn extract_chains_skips_proxy_profiles_and_unexposed_profiles() {
        let mut gw = profile(&["g"]);
        gw["proxy"] = json!(true);
        let config = config_with(
            vec![],
            None,
            None,
            vec![("gw", gw), ("plain", profile(&[]))],
        );
        assert!(extract_chains(&config).is_empty());
    }

    #[test]
    fn extract_chains_skips_profiles_already_covered_by_a_chain() {
        let config = config_with(
            vec![(vec![], vec!["a", "b"])],
            None,
            None,
            vec![("a", profile(&["m"])), ("b", profile(&["m"])), ("c", profile(&["m"]))],
        );
        assert_eq!(extract_chains(&config), vec![vec!["a", "b"], vec!["c"]]);
    }

    #[test]
    fn extract_chains_skips_covered_profiles_in_legacy_chain() {
        let config = config_with(
            vec![],
            Some(vec!["a", "b"]),
            None,
            vec![("a", profile(&["m"])), ("b", profile(&["m"]))],
        );
        assert_eq!(extract_chains(&config), vec![vec!["a", "b"]]);
    }

    #[test]
    fn broken_chains_only_reports_fully_open_chains() {
        let config = config_with(
            vec![(vec![], vec!["a", "b"]), (vec![], vec!["c"])],
            None,
            None,
            vec![("a", profile(&["m"])), ("b", profile(&["m"])), ("c", profile(&["m"]))],
        );
        let mut circuit = CircuitStateStore::default();
        circuit.providers.insert(
            "a".into(),
            crate::proxy::CircuitEntry {
                failures: 3,
                opened_at: Some(1000),
                last_failure_at: Some(1000),
                last_error: Some("HTTP 503".into()),
                last_success_at: None,
                affected_conversations: vec![],
            },
        );
        // only "a" open -> ["a","b"] not fully broken; "c" healthy
        assert!(broken_chains(&config, &circuit).is_empty());

        circuit.providers.insert(
            "b".into(),
            crate::proxy::CircuitEntry {
                failures: 3,
                opened_at: Some(2000),
                last_failure_at: Some(2000),
                last_error: Some("HTTP 503".into()),
                last_success_at: None,
                affected_conversations: vec![],
            },
        );
        let broken = broken_chains(&config, &circuit);
        assert_eq!(broken, vec![vec!["a", "b"]]);
    }

    #[test]
    fn build_probe_uses_bearer_auth_for_openai() {
        let (url, headers) = build_probe(&profile(&["m"]), "/models");
        assert_eq!(url, "https://up.example.com/v1/models");
        assert_eq!(
            headers.get("authorization").unwrap().to_str().unwrap(),
            "Bearer sk-test"
        );
        assert!(headers.get("x-api-key").is_none());
    }

    #[test]
    fn build_probe_uses_x_api_key_for_anthropic_and_normalizes_path() {
        let mut p = profile(&["m"]);
        p["api"] = json!("anthropic-messages");
        p["apiKey"] = json!("sk-ant-1");
        let (url, headers) = build_probe(&p, "models");
        assert_eq!(url, "https://up.example.com/v1/models");
        assert_eq!(headers.get("x-api-key").unwrap().to_str().unwrap(), "sk-ant-1");
        assert_eq!(
            headers.get("anthropic-version").unwrap().to_str().unwrap(),
            "2023-06-01"
        );
        assert!(headers.get("authorization").is_none());
    }

    #[test]
    fn build_probe_merges_custom_headers_and_resolves_env() {
        std::env::set_var("WATCHDOG_TEST_KEY", "secret-1");
        let mut p = profile(&["m"]);
        p["headers"] = json!({ "X-Custom": "yes", "x-extra": "${WATCHDOG_TEST_KEY}" });
        let (_url, headers) = build_probe(&p, "/models");
        assert_eq!(headers.get("x-custom").unwrap().to_str().unwrap(), "yes");
        assert_eq!(headers.get("x-extra").unwrap().to_str().unwrap(), "secret-1");
    }

    #[test]
    fn recovery_event_includes_affected_conversations() {
        // 指向测试状态目录, 不污染真实 ~/.pi-switch
        let dir = crate::proxy::init_test_state_dir();
        let path = dir.join("recovery.jsonl");
        let _ = std::fs::remove_file(&path);
        // 生产代码的 recovery_log_path 使用同一 state_dir (测试重定向)
        append_recovery_event("up-a", &["up-a", "up-b"].map(String::from), &["sess-1", "sess-2"].map(String::from));
        append_recovery_event("up-c", &["up-c"].map(String::from), &[]);

        let text = std::fs::read_to_string(&path).expect("recovery log written");
        let lines: Vec<serde_json::Value> = text
            .lines()
            .map(|l| serde_json::from_str(l).expect("valid json line"))
            .collect();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0]["provider"], "up-a");
        assert_eq!(lines[0]["chain"], json!(["up-a", "up-b"]));
        assert_eq!(lines[0]["conversations"], json!(["sess-1", "sess-2"]));
        // 无受影响会话时仍写入空数组: watchdog 侧据此不触发 continue
        assert_eq!(lines[1]["conversations"], json!([]));
    }

    #[test]
    fn build_probe_leaves_missing_baseurl_unusable() {
        let p = json!({ "api": "openai-completions", "apiKey": "k" });
        let (url, _headers) = build_probe(&p, "/models");
        assert!(!url.starts_with("http"));
    }
}
