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
//!
//! Write paths that add or update provider models (`add_provider`, `upsert_profile`,
//! `update_provider_models`) force a network refresh first via [`ModelCatalog::load_fresh`]
//! so newly added entries pick up freshly published metadata, falling back to the cached
//! copy when models.dev is unreachable.

use crate::config::{ModelCost, ModelEntry};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

pub const MODELS_DEV_URL: &str = "https://models.dev/api.json";
pub const CACHE_TTL: Duration = Duration::from_secs(7 * 24 * 60 * 60);
const FETCH_TIMEOUT: Duration = Duration::from_secs(60);
/// Shorter budget for interactive write paths (add/update provider models): a user
/// saving a profile shouldn't stare at a blocked UI for a full minute when models.dev
/// is unreachable — fail fast and fall back to the cached catalog instead.
const FRESH_FETCH_TIMEOUT: Duration = Duration::from_secs(15);

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

        match fetch_models_dev(FETCH_TIMEOUT) {
            Ok(data) => {
                store_cache(&data);
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

    /// Load with a forced network refresh: always try models.dev first regardless of
    /// cache age, storing the fresh copy; on failure fall back to the cached catalog
    /// (any age), then to an empty catalog. Used by write paths that add or update
    /// provider models so new entries get the latest published metadata.
    pub fn load_fresh() -> Self {
        match fetch_models_dev(FRESH_FETCH_TIMEOUT) {
            Ok(data) => {
                store_cache(&data);
                Self { data: Some(data) }
            }
            Err(err) => {
                eprintln!(
                    "[pi-switch] warning: refresh of model catalog from {} failed ({}); \
                     falling back to cached data",
                    MODELS_DEV_URL, err
                );
                match read_json(&cache_path()) {
                    Some(data) => Self { data: Some(data) },
                    None => Self { data: None },
                }
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
        // models.dev carries the provider's advertised reasoning controls in
        // `reasoning_options` (e.g. `{type:"effort", values:["low","high","max"]}`
        // for deepseek-v4-flash). Translate them into pi's `thinkingLevelMap` so the
        // true effort range (including `max`) shows up in pi; explicit user maps and
        // explicitly-disabled reasoning always win.
        if entry.thinking_level_map.is_none() && entry.reasoning != Some(false) {
            if let Some(map) = thinking_level_map_from_meta(meta) {
                entry.thinking_level_map = Some(map);
            }
        }
        true
    }
}

/// Build a pi `thinkingLevelMap` from a models.dev entry's `reasoning_options`.
///
/// Every advertised effort value maps to the identically-named pi level; levels the
/// upstream does not list become `null` (hidden in pi's UI). `off` is only hidden
/// when the model cannot toggle thinking off (no `toggle` option and no `none`
/// effort value). Returns `None` when the catalog entry has no usable `effort`
/// option, leaving the entry's default off..high range untouched.
fn thinking_level_map_from_meta(meta: &Value) -> Option<Value> {
    let options = meta.get("reasoning_options")?.as_array()?;
    let mut has_toggle = false;
    let mut effort_values: Vec<String> = Vec::new();
    for option in options {
        match option.get("type").and_then(Value::as_str) {
            Some("toggle") => has_toggle = true,
            Some("effort") => {
                if let Some(values) = option.get("values").and_then(Value::as_array) {
                    effort_values = values
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect();
                }
            }
            _ => {}
        }
    }
    if effort_values.is_empty() {
        return None;
    }

    let mut map = serde_json::Map::new();
    for level in ["minimal", "low", "medium", "high", "xhigh", "max"] {
        let supported = effort_values.iter().any(|v| v == level);
        map.insert(
            level.to_string(),
            if supported {
                serde_json::Value::String(level.to_string())
            } else {
                serde_json::Value::Null
            },
        );
    }
    // `off` stays available via the provider's default mapping unless the model
    // cannot disable thinking.
    if !has_toggle && !effort_values.iter().any(|v| v == "none") {
        map.insert("off".to_string(), serde_json::Value::Null);
    }
    Some(serde_json::Value::Object(map))
}

impl ModelCatalog {
    /// Fill `entry.thinking_level_map` from the catalog's `reasoning_options` when
    /// the entry has no explicit map (explicit user values always win). Namespaced
    /// ids are resolved exactly first, then fall back to the bare model id. Returns
    /// `true` when a map was applied.
    pub fn fill_thinking_level_map(&self, entry: &mut ModelEntry) -> bool {
        if entry.thinking_level_map.is_some() || entry.reasoning == Some(false) {
            return false;
        }
        let mut meta = self.lookup(&entry.id);
        if meta.is_none() {
            if let Some((_, rest)) = entry.id.split_once('/') {
                meta = self.lookup(rest);
            }
        }
        let Some(meta) = meta else {
            return false;
        };
        let Some(map) = thinking_level_map_from_meta(meta) else {
            return false;
        };
        entry.thinking_level_map = Some(map);
        true
    }
}

/// pi-switch's generic placeholder signature — entries that still look like this are
/// treated as "unparameterized" and eligible for catalog enrichment. Only used by
/// tests now that [`enrich_entries_fresh`] covers the same case for all write paths.
#[cfg(test)]
pub fn is_unparameterized(entry: &ModelEntry) -> bool {
    has_default_window(entry) && entry.cost.is_none()
}

/// Whether the entry still carries pi-switch's default window signature
/// (contextWindow 128000 / maxTokens 16384 / input ["text"]). Entries matching
/// this came from an unparameterized source (e.g. the web UI's default model
/// shape) rather than explicit user values, so catalog values should win.
pub fn has_default_window(entry: &ModelEntry) -> bool {
    entry.input.len() == 1
        && entry.input[0] == "text"
        && entry.context_window == 128000
        && entry.max_tokens == 16384
}

/// Enrich one model entry from the opencode catalog, aligning every write path
/// with the CLI's 0/empty sentinel behaviour: entries still carrying the default
/// window signature are reset so catalog values fill context window, max output
/// tokens and input modalities too (not just cost/name/reasoning). Explicit
/// non-default values always win and are left untouched.
/// Enrich model entries on write paths that create or update models (add provider,
/// upsert, update models): always fetch the latest models.dev data first, falling back
/// to the on-disk cache when the network is unreachable. Explicit non-default values
/// always win. One fetch per call — pass the whole batch, don't loop per entry.
pub fn enrich_entries_fresh(entries: &mut [ModelEntry]) {
    let catalog = ModelCatalog::load_fresh();
    for entry in entries.iter_mut() {
        enrich_entry_with(entry, &catalog);
    }
}

fn enrich_entry_with(entry: &mut ModelEntry, catalog: &ModelCatalog) {
    if has_default_window(entry) {
        entry.context_window = 0;
        entry.max_tokens = 0;
        entry.input.clear();
    }
    catalog.enrich(entry);
    if entry.input.is_empty() {
        entry.input = vec!["text".to_string()];
    }
    if entry.context_window == 0 {
        entry.context_window = 128000;
    }
    if entry.max_tokens == 0 {
        entry.max_tokens = 16384;
    }
}

fn file_age(path: &Path) -> Option<Duration> {
    let meta = std::fs::metadata(path).ok()?;
    let modified = meta.modified().ok()?;
    std::time::SystemTime::now().duration_since(modified).ok()
}

/// Store the catalog data in the on-disk cache (best-effort; failures ignored).
fn store_cache(data: &Value) {
    let path = cache_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(&path, serde_json::to_vec(data).unwrap_or_default());
}

fn read_json(path: &Path) -> Option<Value> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn fetch_models_dev(timeout: Duration) -> Result<Value, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(timeout)
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
    fn batch_enrich_covers_sentinel_default_and_explicit_entries() {
        let catalog = catalog_with(sample_db());
        let mut entries = [
            // CLI sentinel shape (add_provider).
            ModelEntry {
                id: "gpt-5.6-luna".into(),
                input: Vec::new(),
                context_window: 0,
                max_tokens: 0,
                ..Default::default()
            },
            // Web UI default signature.
            ModelEntry {
                id: "gpt-5.6-luna".into(),
                input: vec!["text".into()],
                context_window: 128000,
                max_tokens: 16384,
                ..Default::default()
            },
            // Explicit values must survive untouched.
            ModelEntry {
                id: "gpt-5.6-luna".into(),
                input: vec!["text".into()],
                context_window: 200000,
                max_tokens: 8192,
                ..Default::default()
            },
        ];
        for entry in entries.iter_mut() {
            super::enrich_entry_with(entry, &catalog);
        }
        assert_eq!(entries[0].context_window, 1050000);
        assert_eq!(entries[0].input, vec!["text", "image"]);
        assert_eq!(entries[1].context_window, 1050000);
        assert_eq!(entries[1].max_tokens, 128000);
        assert_eq!(entries[2].context_window, 200000);
        assert_eq!(entries[2].max_tokens, 8192);
    }

    #[test]
    fn enrich_entry_with_fills_default_window_from_catalog() {
        let catalog = catalog_with(sample_db());
        // Web UI default shape: 128000/16384/["text"] with cost already filled by an
        // earlier enrich pass — context/maxTokens/input must still be upgraded from
        // the catalog, matching the CLI path.
        let mut entry = ModelEntry {
            id: "gpt-5.6-luna".into(),
            input: vec!["text".into()],
            context_window: 128000,
            max_tokens: 16384,
            cost: Some(ModelCost::default()),
            ..Default::default()
        };
        super::enrich_entry_with(&mut entry, &catalog);
        assert_eq!(entry.context_window, 1050000);
        assert_eq!(entry.max_tokens, 128000);
        assert_eq!(entry.input, vec!["text", "image"]);
        // Cost was already set — untouched by enrich.
        assert!(entry.cost.is_some());
    }

    #[test]
    fn enrich_entry_with_keeps_explicit_non_default_values() {
        let catalog = catalog_with(sample_db());
        let mut entry = ModelEntry {
            id: "gpt-5.6-luna".into(),
            input: vec!["text".into()],
            context_window: 200000,
            max_tokens: 8192,
            ..Default::default()
        };
        super::enrich_entry_with(&mut entry, &catalog);
        assert_eq!(entry.context_window, 200000);
        assert_eq!(entry.max_tokens, 8192);
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

    #[test]
    fn reasoning_options_build_thinking_level_map() {
        // deepseek-v4-flash: toggle + effort [low, high, max] (as models.dev reports).
        let catalog = catalog_with(json!({
            "opencode": {
                "id": "opencode",
                "models": {
                    "deepseek-v4-flash": {
                        "id": "deepseek-v4-flash",
                        "reasoning": true,
                        "reasoning_options": [
                            { "type": "toggle" },
                            { "type": "effort", "values": ["low", "high", "max"] }
                        ]
                    }
                }
            }
        }));
        let mut entry = ModelEntry {
            id: "deepseek-v4-flash".into(),
            reasoning: Some(true),
            ..Default::default()
        };
        assert!(catalog.enrich(&mut entry));
        let map = entry.thinking_level_map.expect("map filled");
        assert_eq!(map["minimal"], serde_json::Value::Null);
        assert_eq!(map["low"], "low");
        assert_eq!(map["medium"], serde_json::Value::Null);
        assert_eq!(map["high"], "high");
        assert_eq!(map["xhigh"], serde_json::Value::Null);
        assert_eq!(map["max"], "max");
        // toggle present → off stays available via the provider default mapping
        assert!(map.get("off").is_none());
    }

    #[test]
    fn effort_without_toggle_hides_off() {
        let catalog = catalog_with(json!({
            "openai": {
                "id": "openai",
                "models": {
                    "glm-5.2": {
                        "id": "glm-5.2",
                        "reasoning": true,
                        "reasoning_options": [
                            { "type": "effort", "values": ["high", "max"] }
                        ]
                    }
                }
            }
        }));
        let mut entry = ModelEntry {
            id: "glm-5.2".into(),
            reasoning: Some(true),
            ..Default::default()
        };
        assert!(catalog.enrich(&mut entry));
        let map = entry.thinking_level_map.expect("map filled");
        assert_eq!(map["off"], serde_json::Value::Null);
        assert_eq!(map["low"], serde_json::Value::Null);
        assert_eq!(map["max"], "max");
    }

    #[test]
    fn no_reasoning_options_leaves_map_unset() {
        let catalog = catalog_with(json!({
            "openai": {
                "id": "openai",
                "models": {
                    "deepseek-chat": {
                        "id": "deepseek-chat",
                        "reasoning": false
                    }
                }
            }
        }));
        let mut entry = ModelEntry {
            id: "deepseek-chat".into(),
            reasoning: Some(false),
            ..Default::default()
        };
        assert!(catalog.enrich(&mut entry));
        assert!(entry.thinking_level_map.is_none());
    }

    #[test]
    fn explicit_thinking_level_map_wins() {
        let catalog = catalog_with(json!({
            "opencode": {
                "id": "opencode",
                "models": {
                    "deepseek-v4-flash": {
                        "id": "deepseek-v4-flash",
                        "reasoning": true,
                        "reasoning_options": [
                            { "type": "effort", "values": ["low", "high", "max"] }
                        ]
                    }
                }
            }
        }));
        let mut entry = ModelEntry {
            id: "deepseek-v4-flash".into(),
            reasoning: Some(true),
            thinking_level_map: Some(serde_json::json!({ "high": "high" })),
            ..Default::default()
        };
        assert!(catalog.enrich(&mut entry));
        assert_eq!(
            entry.thinking_level_map,
            Some(serde_json::json!({ "high": "high" }))
        );
    }

    #[test]
    fn fill_thinking_level_map_resolves_namespaced_and_bare() {
        let catalog = catalog_with(json!({
            "opencode": {
                "id": "opencode",
                "models": {
                    "deepseek-v4-flash": {
                        "id": "deepseek-v4-flash",
                        "reasoning": true,
                        "reasoning_options": [
                            { "type": "effort", "values": ["low", "high", "max"] }
                        ]
                    }
                }
            }
        }));
        // Namespaced id matching the catalog provider.
        let mut entry = ModelEntry {
            id: "opencode/deepseek-v4-flash".into(),
            ..Default::default()
        };
        assert!(catalog.fill_thinking_level_map(&mut entry));
        assert_eq!(entry.thinking_level_map.as_ref().unwrap()["max"], "max");

        // Namespaced id with an unknown provider falls back to the bare id.
        let mut entry = ModelEntry {
            id: "custom-gateway/deepseek-v4-flash".into(),
            ..Default::default()
        };
        assert!(catalog.fill_thinking_level_map(&mut entry));
        assert_eq!(entry.thinking_level_map.as_ref().unwrap()["max"], "max");

        // No reasoning_options in the catalog → no map.
        let mut entry = ModelEntry {
            id: "no-such-model".into(),
            ..Default::default()
        };
        assert!(!catalog.fill_thinking_level_map(&mut entry));

        // Explicit map is never overwritten.
        let mut entry = ModelEntry {
            id: "opencode/deepseek-v4-flash".into(),
            thinking_level_map: Some(serde_json::json!({ "high": "high" })),
            ..Default::default()
        };
        assert!(!catalog.fill_thinking_level_map(&mut entry));
    }
}
