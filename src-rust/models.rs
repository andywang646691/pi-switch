//! Model metadata enrichment from the opencode public model database (models.dev).
//!
//! opencode (https://github.com/sst/opencode) uses the open-source model database at
//! <https://models.dev/api.json> internally. pi-switch mirrors that database locally so
//! that models added to a profile carry real parameters (context window, max output
//! tokens, input modalities, cost, reasoning) instead of pi's generic defaults.
//!
//! The database is cached at `~/.pi-switch/models-cache.json` and refreshed when it is
//! older than [`CACHE_TTL`]. If the network is unavailable the stale cache (or an empty
//! catalog) is used, degrading gracefully to pi defaults.

use crate::config::{ModelCost, ModelEntry};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

pub const MODELS_DEV_URL: &str = "https://models.dev/api.json";
pub const CACHE_TTL: Duration = Duration::from_secs(7 * 24 * 60 * 60);
const FETCH_TIMEOUT: Duration = Duration::from_secs(60);

/// Canonical providers preferred when the same bare model id exists under several
/// providers (e.g. `gpt-5.6-luna` under openai, vivgrid, azure, ...).
const PREFERRED_PROVIDERS: &[&str] = &[
    "openai",
    "anthropic",
    "google",
    "deepseek",
    "mistral",
    "meta",
    "xai",
    "alibaba",
    "moonshotai",
    "groq",
    "openrouter",
];

/// Input modalities pi-switch accepts (see `validate_provider_profile`): anything outside
/// this list is dropped during enrichment.
const ACCEPTED_INPUT: &[&str] = &["text", "image"];

pub fn catalog() -> &'static ModelCatalog {
    static CATALOG: OnceLock<ModelCatalog> = OnceLock::new();
    CATALOG.get_or_init(ModelCatalog::load)
}

fn cache_path() -> PathBuf {
    crate::config::config_dir().join("models-cache.json")
}

pub struct ModelCatalog {
    data: Option<Value>,
}

impl ModelCatalog {
    /// Load the catalog: cache-first, refresh when stale, graceful degradation.
    pub fn load() -> Self {
        let path = cache_path();
        let stale = file_age(&path).map(|age| age > CACHE_TTL).unwrap_or(true);

        if !stale {
            if let Some(data) = read_json(&path) {
                return Self { data: Some(data) };
            }
        }

        match fetch_models_dev() {
            Ok(data) => {
                if let Some(parent) = path.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                let _ = std::fs::write(&path, serde_json::to_vec(&data).unwrap_or_default());
                Self { data: Some(data) }
            }
            Err(err) => {
                if stale {
                    if let Some(data) = read_json(&path) {
                        return Self { data: Some(data) };
                    }
                }
                eprintln!(
                    "[pi-switch] warning: unable to fetch model catalog from {} ({}); \
                     models without cached metadata will use pi defaults",
                    MODELS_DEV_URL, err
                );
                Self { data: None }
            }
        }
    }

    /// Look up model metadata by id. Supports both namespaced ids (`provider/model`) and
    /// bare ids (resolved across providers, preferring canonical providers).
    pub fn lookup<'a>(&'a self, model_id: &str) -> Option<&'a Value> {
        let data = self.data.as_ref()?;
        let providers = data.as_object()?;

        // Namespaced id ("provider/model"): exact provider match first.
        if let Some((prefix, rest)) = model_id.split_once('/') {
            if let Some(provider) = providers.get(prefix) {
                if let Some(models) = provider.get("models").and_then(|m| m.as_object()) {
                    if let Some(entry) = models.get(rest) {
                        return Some(entry);
                    }
                    for (_mid, entry) in models {
                        if entry.get("id").and_then(Value::as_str) == Some(rest) {
                            return Some(entry);
                        }
                    }
                }
            }
        }

        // Bare id: collect matches, prefer canonical providers.
        let mut best: Option<(&str, &Value)> = None;
        for (provider_name, provider) in providers {
            let Some(models) = provider.get("models").and_then(|m| m.as_object()) else {
                continue;
            };
            for (mid, entry) in models {
                let matched =
                    mid == model_id || entry.get("id").and_then(Value::as_str) == Some(model_id);
                if !matched {
                    continue;
                }
                let replace = match best {
                    None => true,
                    Some((best_name, _)) => {
                        let rank = |n: &str| {
                            PREFERRED_PROVIDERS
                                .iter()
                                .position(|p| *p == n)
                                .map(|i| i as isize)
                                .unwrap_or(PREFERRED_PROVIDERS.len() as isize)
                        };
                        rank(provider_name) < rank(best_name)
                    }
                };
                if replace {
                    best = Some((provider_name, entry));
                }
            }
        }
        best.map(|(_, entry)| entry)
    }

    /// Fill unset model parameters from the catalog. Only fills fields that are still
    /// unset (None / 0 / empty) so explicit user values always win. Returns `true` when
    /// catalog metadata was found for the model id.
    pub fn enrich(&self, entry: &mut ModelEntry) -> bool {
        let Some(meta) = self.lookup(&entry.id) else {
            return false;
        };

        if entry.name.is_none() {
            entry.name = meta.get("name").and_then(Value::as_str).map(str::to_string);
        }
        if entry.reasoning.is_none() {
            entry.reasoning = meta.get("reasoning").and_then(Value::as_bool);
        }
        if let Some(limit) = meta.get("limit") {
            if entry.context_window == 0 {
                if let Some(ctx) = limit.get("context").and_then(Value::as_u64) {
                    if ctx > 0 {
                        entry.context_window = ctx.min(u32::MAX as u64) as u32;
                    }
                }
            }
            if entry.max_tokens == 0 {
                if let Some(out) = limit.get("output").and_then(Value::as_u64) {
                    if out > 0 {
                        entry.max_tokens = out.min(u32::MAX as u64) as u32;
                    }
                }
            }
        }
        if entry.input.is_empty() {
            if let Some(inputs) = meta
                .get("modalities")
                .and_then(|m| m.get("input"))
                .and_then(Value::as_array)
            {
                let mapped: Vec<String> = inputs
                    .iter()
                    .filter_map(Value::as_str)
                    .filter(|s| ACCEPTED_INPUT.contains(s))
                    .map(str::to_string)
                    .collect();
                if !mapped.is_empty() {
                    entry.input = mapped;
                }
            }
        }
        if entry.cost.is_none() {
            if let Some(cost) = meta.get("cost").and_then(Value::as_object) {
                entry.cost = Some(ModelCost {
                    input: cost.get("input").and_then(Value::as_f64).unwrap_or(0.0),
                    output: cost.get("output").and_then(Value::as_f64).unwrap_or(0.0),
                    cache_read: cost
                        .get("cache_read")
                        .and_then(Value::as_f64)
                        .unwrap_or(0.0),
                    cache_write: cost
                        .get("cache_write")
                        .and_then(Value::as_f64)
                        .unwrap_or(0.0),
                    ..Default::default()
                });
            }
        }
        true
    }
}

/// pi-switch's generic placeholder signature — entries that still look like this are
/// treated as "unparameterized" and eligible for catalog enrichment.
pub fn is_unparameterized(entry: &ModelEntry) -> bool {
    entry.input.len() == 1
        && entry.input[0] == "text"
        && entry.context_window == 128000
        && entry.max_tokens == 16384
        && entry.cost.is_none()
}

fn file_age(path: &Path) -> Option<Duration> {
    let meta = std::fs::metadata(path).ok()?;
    let modified = meta.modified().ok()?;
    std::time::SystemTime::now().duration_since(modified).ok()
}

fn read_json(path: &Path) -> Option<Value> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn fetch_models_dev() -> Result<Value, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(FETCH_TIMEOUT)
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(MODELS_DEV_URL)
        .send()
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    resp.json::<Value>().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn catalog_with(data: Value) -> ModelCatalog {
        ModelCatalog { data: Some(data) }
    }

    fn sample_db() -> Value {
        json!({
            "openai": {
                "id": "openai",
                "models": {
                    "gpt-5.6-luna": {
                        "id": "gpt-5.6-luna",
                        "name": "GPT-5.6 Luna",
                        "reasoning": true,
                        "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] },
                        "limit": { "context": 1050000, "output": 128000 },
                        "cost": { "input": 0.2, "output": 1.2, "cache_read": 0.02, "cache_write": 0.25 }
                    },
                    "gpt-image-2": {
                        "id": "gpt-image-2",
                        "modalities": { "input": ["text", "image"], "output": ["image"] },
                        "limit": { "context": 0, "output": 0 },
                        "cost": { "input": 5.0, "output": 30.0, "cache_read": 1.25 }
                    }
                }
            },
            "vivgrid": {
                "id": "vivgrid",
                "models": {
                    "gpt-5.6-luna": {
                        "id": "gpt-5.6-luna",
                        "name": "GPT 5.6 Luna (vivgrid)",
                        "modalities": { "input": ["text"] },
                        "limit": { "context": 900000, "output": 64000 },
                        "cost": { "input": 1.0, "output": 6.0 }
                    }
                }
            }
        })
    }

    #[test]
    fn bare_id_prefers_canonical_provider() {
        let catalog = catalog_with(sample_db());
        let meta = catalog.lookup("gpt-5.6-luna").expect("found");
        assert_eq!(
            meta.get("name").and_then(Value::as_str),
            Some("GPT-5.6 Luna")
        );
    }

    #[test]
    fn namespaced_id_resolves_exact_provider() {
        let catalog = catalog_with(sample_db());
        let meta = catalog.lookup("vivgrid/gpt-5.6-luna").expect("found");
        assert_eq!(
            meta.get("name").and_then(Value::as_str),
            Some("GPT 5.6 Luna (vivgrid)")
        );
    }

    #[test]
    fn missing_id_returns_none() {
        let catalog = catalog_with(sample_db());
        assert!(catalog.lookup("no-such-model").is_none());
    }

    #[test]
    fn enrich_fills_params_and_filters_input() {
        let catalog = catalog_with(sample_db());
        let mut entry = ModelEntry {
            id: "gpt-5.6-luna".into(),
            input: Vec::new(),
            context_window: 0,
            max_tokens: 0,
            ..Default::default()
        };
        assert!(catalog.enrich(&mut entry));
        assert_eq!(entry.name.as_deref(), Some("GPT-5.6 Luna"));
        assert_eq!(entry.context_window, 1050000);
        assert_eq!(entry.max_tokens, 128000);
        // "pdf" is dropped — pi-switch only accepts text/image.
        assert_eq!(entry.input, vec!["text", "image"]);
        assert_eq!(entry.reasoning, Some(true));
        let cost = entry.cost.expect("cost filled");
        assert_eq!(cost.input, 0.2);
        assert_eq!(cost.cache_write, 0.25);
    }

    #[test]
    fn enrich_keeps_zero_limit_models_at_defaults() {
        let catalog = catalog_with(sample_db());
        let mut entry = ModelEntry {
            id: "gpt-image-2".into(),
            input: Vec::new(),
            context_window: 0,
            max_tokens: 0,
            ..Default::default()
        };
        assert!(catalog.enrich(&mut entry));
        // Image model: catalog reports 0 limits — keep pi defaults.
        assert_eq!(entry.context_window, 0);
        assert_eq!(entry.max_tokens, 0);
        assert_eq!(entry.input, vec!["text", "image"]);
        assert_eq!(entry.cost.expect("cost").input, 5.0);
    }

    #[test]
    fn enrich_preserves_explicit_values() {
        let catalog = catalog_with(sample_db());
        let mut entry = ModelEntry {
            id: "gpt-5.6-luna".into(),
            input: vec!["text".into()],
            context_window: 200000,
            max_tokens: 8192,
            name: Some("My override".into()),
            ..Default::default()
        };
        assert!(catalog.enrich(&mut entry));
        assert_eq!(entry.context_window, 200000);
        assert_eq!(entry.max_tokens, 8192);
        assert_eq!(entry.name.as_deref(), Some("My override"));
        assert_eq!(entry.input, vec!["text"]);
    }

    #[test]
    fn is_unparameterized_detects_placeholder_entries() {
        let default_entry = ModelEntry {
            id: "x".into(),
            ..Default::default()
        };
        assert!(is_unparameterized(&default_entry));
        let mut enriched = default_entry.clone();
        enriched.context_window = 1050000;
        assert!(!is_unparameterized(&enriched));
        let with_cost = default_entry.clone();
        // cost filled → not unparameterized
        let mut with_cost = with_cost;
        with_cost.cost = Some(ModelCost::default());
        assert!(!is_unparameterized(&with_cost));
    }
}
