//! Bridge to the local Ollama daemon: health checks, model pulls, and the JSON
//! and vision chat pipelines. Progress and tokens reach the UI as Tauri events,
//! rate limited here so a fast download cannot flood the webview.

use std::collections::HashMap;
use std::io::Cursor;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::Engine;
use futures_util::future::{AbortHandle, Abortable};
use image::metadata::Orientation;
use image::{DynamicImage, GenericImage, GenericImageView, ImageDecoder, ImageFormat, Rgb, RgbImage};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_shell::ShellExt;
use tokio_stream::StreamExt;

pub const DEFAULT_ENDPOINT: &str = "http://127.0.0.1:11434";
pub const PULL_EVENT: &str = "ollama://pull-progress";
/// PLAN.md names the event both ways (section 2 and phase 2), so both are emitted.
pub const PULL_EVENT_ALIAS: &str = "ollama-pull-progress";
pub const STREAM_EVENT: &str = "ollama://stream-chunk";

const PULL_EMIT_INTERVAL: Duration = Duration::from_millis(100);
const STREAM_EMIT_INTERVAL: Duration = Duration::from_millis(50);
const SPEED_WINDOW: Duration = Duration::from_secs(4);
const MAX_VISION_EDGE: u32 = 1024;
const MAX_DESCRIPTION_CHARS: usize = 320;
/// About 16,000 tokens, half of the largest context window this app requests.
const MAX_SCRIPT_CHARS: usize = 65_000;
const SCRIPT_TOO_LONG: &str = "This script is too long for the model to finish. Split it into smaller sections and generate them one at a time.";

pub struct OllamaState {
    client: reqwest::Client,
    endpoint: String,
    pulls: Mutex<HashMap<String, AbortHandle>>,
    analyses: Mutex<HashMap<String, AbortHandle>>,
}

impl OllamaState {
    pub fn new() -> Self {
        let endpoint = std::env::var("VANGUARD_OLLAMA_URL")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| DEFAULT_ENDPOINT.to_string())
            .trim_end_matches('/')
            .to_string();
        // A system proxy must never intercept traffic to the loopback daemon.
        // There is deliberately no overall timeout: CPU inference can take minutes.
        let client = reqwest::Client::builder()
            .no_proxy()
            .connect_timeout(Duration::from_secs(3))
            .build()
            .expect("reqwest client");
        Self {
            client,
            endpoint,
            pulls: Mutex::new(HashMap::new()),
            analyses: Mutex::new(HashMap::new()),
        }
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.endpoint, path)
    }
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OllamaStatus {
    pub online: bool,
    pub installed: bool,
    pub version: Option<String>,
    pub endpoint: String,
    pub model_count: usize,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LocalModel {
    pub name: String,
    pub size: u64,
    pub digest: String,
    pub modified_at: String,
    pub family: String,
    pub parameter_size: String,
    pub quantization: String,
    pub capabilities: Vec<String>,
    pub is_vision: bool,
}

#[derive(Debug, Serialize, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PullProgress {
    pub model: String,
    pub status: String,
    pub completed: u64,
    pub total: u64,
    pub percent: f64,
    pub bytes_per_second: f64,
    pub done: bool,
    pub cancelled: bool,
    pub error: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StreamChunk {
    pub request_id: String,
    pub delta: String,
    pub done: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AiDropzone {
    pub ai_visual_prompt: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AiSlide {
    pub slide_number: u32,
    pub original_excerpt: String,
    pub refined_title: String,
    pub executive_summary: Vec<String>,
    pub speaker_notes: String,
    pub layout_type: String,
    pub dropzones: Vec<AiDropzone>,
}

// ---------------------------------------------------------------------------
// Daemon lifecycle
// ---------------------------------------------------------------------------

fn ollama_executable_name() -> &'static str {
    if cfg!(windows) {
        "ollama.exe"
    } else {
        "ollama"
    }
}

/// GUI apps launched from Finder or Explorer often inherit a minimal PATH, so the
/// standard install locations are checked as well.
fn find_ollama_binary() -> Option<PathBuf> {
    let name = ollama_executable_name();
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }

    let mut known: Vec<PathBuf> = Vec::new();
    if cfg!(windows) {
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            known.push(PathBuf::from(local).join("Programs").join("Ollama").join(name));
        }
        if let Some(program_files) = std::env::var_os("ProgramFiles") {
            known.push(PathBuf::from(program_files).join("Ollama").join(name));
        }
    } else {
        known.push(PathBuf::from("/usr/local/bin/ollama"));
        known.push(PathBuf::from("/opt/homebrew/bin/ollama"));
        known.push(PathBuf::from("/Applications/Ollama.app/Contents/Resources/ollama"));
    }
    known.into_iter().find(|candidate| candidate.is_file())
}

/// Pings GET /api/tags. Offline is a normal result here, never an error, so the
/// 5 second poll stays quiet.
#[tauri::command]
pub async fn check_ollama_status(state: State<'_, OllamaState>) -> Result<OllamaStatus, String> {
    let offline = || OllamaStatus {
        online: false,
        installed: find_ollama_binary().is_some(),
        version: None,
        endpoint: state.endpoint.clone(),
        model_count: 0,
    };

    let response = state
        .client
        .get(state.url("/api/tags"))
        .timeout(Duration::from_secs(4))
        .send()
        .await;
    let Ok(response) = response else {
        return Ok(offline());
    };
    if !response.status().is_success() {
        return Ok(offline());
    }
    let model_count = response
        .json::<Value>()
        .await
        .ok()
        .and_then(|body| body.get("models").and_then(Value::as_array).map(Vec::len))
        .unwrap_or(0);

    let version = match state
        .client
        .get(state.url("/api/version"))
        .timeout(Duration::from_secs(2))
        .send()
        .await
    {
        Ok(response) => response
            .json::<Value>()
            .await
            .ok()
            .and_then(|body| body.get("version").and_then(Value::as_str).map(str::to_string)),
        Err(_) => None,
    };

    Ok(OllamaStatus {
        online: true,
        // A reachable daemon proves it is installed even if the binary is hidden.
        installed: true,
        version,
        endpoint: state.endpoint.clone(),
        model_count,
    })
}

#[tauri::command]
pub async fn launch_ollama_serve(app: AppHandle) -> Result<(), String> {
    let binary = find_ollama_binary().ok_or_else(|| "Ollama is not installed.".to_string())?;
    let (mut events, child) = app
        .shell()
        .command(binary.to_string_lossy().to_string())
        .args(["serve"])
        .spawn()
        .map_err(|e| format!("Could not start Ollama: {e}"))?;

    // Draining the output keeps the child's pipes from filling up. The daemon is
    // left running when the app exits, matching how Ollama normally runs.
    tauri::async_runtime::spawn(async move {
        let _child = child;
        while events.recv().await.is_some() {}
    });
    Ok(())
}

// ---------------------------------------------------------------------------
// Local models
// ---------------------------------------------------------------------------

/// Used only for daemons too old to report capabilities.
pub fn name_suggests_vision(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    ["llava", "bakllava", "moondream", "vision", "minicpm-v", "-vl", "vl:", "qwen2.5vl", "granite3.2-vision"]
        .iter()
        .any(|marker| lower.contains(marker))
}

pub fn parse_models(body: &Value) -> Vec<LocalModel> {
    body.get("models")
        .and_then(Value::as_array)
        .map(|models| {
            models
                .iter()
                .filter_map(|model| {
                    let name = model.get("name").or_else(|| model.get("model"))?.as_str()?.to_string();
                    let details = model.get("details");
                    let detail = |key: &str| -> String {
                        details
                            .and_then(|d| d.get(key))
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string()
                    };
                    let capabilities: Vec<String> = model
                        .get("capabilities")
                        .and_then(Value::as_array)
                        .map(|caps| caps.iter().filter_map(|c| c.as_str().map(str::to_string)).collect())
                        .unwrap_or_default();
                    let is_vision = if capabilities.is_empty() {
                        name_suggests_vision(&name)
                    } else {
                        capabilities.iter().any(|c| c == "vision")
                    };
                    Some(LocalModel {
                        size: model.get("size").and_then(Value::as_u64).unwrap_or(0),
                        digest: model.get("digest").and_then(Value::as_str).unwrap_or_default().to_string(),
                        modified_at: model.get("modified_at").and_then(Value::as_str).unwrap_or_default().to_string(),
                        family: detail("family"),
                        parameter_size: detail("parameter_size"),
                        quantization: detail("quantization_level"),
                        capabilities,
                        is_vision,
                        name,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

#[tauri::command]
pub async fn list_local_models(state: State<'_, OllamaState>) -> Result<Vec<LocalModel>, String> {
    let response = state
        .client
        .get(state.url("/api/tags"))
        .timeout(Duration::from_secs(8))
        .send()
        .await
        .map_err(|_| "Ollama is not reachable.".to_string())?;
    let body: Value = response.json().await.map_err(|e| e.to_string())?;
    Ok(parse_models(&body))
}

// ---------------------------------------------------------------------------
// NDJSON streaming
// ---------------------------------------------------------------------------

/// Reassembles newline-delimited JSON from arbitrary network chunk boundaries.
#[derive(Default)]
pub struct NdjsonBuffer {
    pending: Vec<u8>,
}

impl NdjsonBuffer {
    pub fn push(&mut self, chunk: &[u8]) -> Vec<Value> {
        self.pending.extend_from_slice(chunk);
        let mut values = Vec::new();
        while let Some(position) = self.pending.iter().position(|byte| *byte == b'\n') {
            let line: Vec<u8> = self.pending.drain(..=position).collect();
            if let Some(value) = parse_json_line(&line) {
                values.push(value);
            }
        }
        values
    }

    /// Flushes a final line that arrived without a trailing newline.
    pub fn finish(&mut self) -> Option<Value> {
        let line = std::mem::take(&mut self.pending);
        parse_json_line(&line)
    }
}

fn parse_json_line(line: &[u8]) -> Option<Value> {
    let text = std::str::from_utf8(line).ok()?.trim();
    if text.is_empty() {
        return None;
    }
    serde_json::from_str(text).ok()
}

// ---------------------------------------------------------------------------
// Model pull
// ---------------------------------------------------------------------------

/// Turns per-layer pull events into one aggregate progress reading. Ollama resets
/// `completed` for every layer, so bytes must be tracked per digest to keep the
/// bar and the speed reading from jumping backwards.
pub struct PullTracker {
    model: String,
    layers: HashMap<String, (u64, u64)>,
    samples: Vec<(Instant, u64)>,
    last_emit: Option<Instant>,
    last_status: String,
}

impl PullTracker {
    pub fn new(model: &str) -> Self {
        Self {
            model: model.to_string(),
            layers: HashMap::new(),
            samples: Vec::new(),
            last_emit: None,
            last_status: String::new(),
        }
    }

    /// Returns the payload to emit, or None when rate limiting drops this update.
    /// A change of status always passes so short phases remain visible.
    pub fn update(&mut self, line: &Value, now: Instant) -> Option<PullProgress> {
        let status = line.get("status").and_then(Value::as_str).unwrap_or("").to_string();
        if let Some(digest) = line.get("digest").and_then(Value::as_str) {
            let total = line.get("total").and_then(Value::as_u64).unwrap_or(0);
            let completed = line.get("completed").and_then(Value::as_u64).unwrap_or(0);
            let entry = self.layers.entry(digest.to_string()).or_insert((0, total));
            entry.0 = entry.0.max(completed);
            entry.1 = entry.1.max(total);
        }

        let status_changed = status != self.last_status && !status.is_empty();
        let due = self
            .last_emit
            .map_or(true, |previous| now.duration_since(previous) >= PULL_EMIT_INTERVAL);
        if !status_changed && !due {
            return None;
        }
        if !status.is_empty() {
            self.last_status = status;
        }
        self.last_emit = Some(now);
        Some(self.snapshot(now))
    }

    pub fn snapshot(&mut self, now: Instant) -> PullProgress {
        let completed: u64 = self.layers.values().map(|(c, _)| *c).sum();
        let total: u64 = self.layers.values().map(|(_, t)| *t).sum();

        self.samples.push((now, completed));
        self.samples.retain(|(time, _)| now.duration_since(*time) <= SPEED_WINDOW);
        let bytes_per_second = match self.samples.first() {
            Some((first_time, first_bytes)) => {
                let elapsed = now.duration_since(*first_time).as_secs_f64();
                if elapsed >= 0.2 {
                    completed.saturating_sub(*first_bytes) as f64 / elapsed
                } else {
                    0.0
                }
            }
            None => 0.0,
        };

        PullProgress {
            model: self.model.clone(),
            status: self.last_status.clone(),
            completed,
            total,
            percent: if total > 0 { completed as f64 / total as f64 * 100.0 } else { 0.0 },
            bytes_per_second,
            done: false,
            cancelled: false,
            error: None,
        }
    }
}

fn emit_pull(app: &AppHandle, payload: &PullProgress) {
    let _ = app.emit(PULL_EVENT, payload);
    let _ = app.emit(PULL_EVENT_ALIAS, payload);
}

async fn run_pull(app: &AppHandle, state: &OllamaState, model: &str) -> Result<(), String> {
    let response = state
        .client
        .post(state.url("/api/pull"))
        .json(&json!({ "model": model, "name": model, "stream": true }))
        .send()
        .await
        .map_err(|_| "Ollama is not reachable.".to_string())?;

    if !response.status().is_success() {
        return Err(read_api_error(response).await);
    }

    let mut tracker = PullTracker::new(model);
    let mut buffer = NdjsonBuffer::default();
    let mut stream = response.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("The download was interrupted: {e}"))?;
        for line in buffer.push(&chunk) {
            handle_pull_line(app, &mut tracker, &line)?;
        }
    }
    if let Some(line) = buffer.finish() {
        handle_pull_line(app, &mut tracker, &line)?;
    }
    Ok(())
}

fn handle_pull_line(app: &AppHandle, tracker: &mut PullTracker, line: &Value) -> Result<(), String> {
    if let Some(error) = line.get("error").and_then(Value::as_str) {
        return Err(friendly_pull_error(error));
    }
    if let Some(payload) = tracker.update(line, Instant::now()) {
        emit_pull(app, &payload);
    }
    Ok(())
}

pub fn friendly_pull_error(error: &str) -> String {
    if error.contains("file does not exist") || error.contains("not found") {
        "This model tag does not exist in the Ollama library.".to_string()
    } else {
        error.to_string()
    }
}

/// Streams a pull via `ollama://pull-progress` and resolves once it has finished.
#[tauri::command]
pub async fn pull_model_stream(
    app: AppHandle,
    state: State<'_, OllamaState>,
    model_name: String,
) -> Result<(), String> {
    let (abort, registration) = AbortHandle::new_pair();
    {
        let mut pulls = state.pulls.lock().map_err(|e| e.to_string())?;
        if pulls.contains_key(&model_name) {
            return Err(format!("{model_name} is already downloading."));
        }
        pulls.insert(model_name.clone(), abort);
    }

    emit_pull(
        &app,
        &PullProgress {
            model: model_name.clone(),
            status: "starting".to_string(),
            ..PullProgress::default()
        },
    );

    let outcome = Abortable::new(run_pull(&app, &state, &model_name), registration).await;
    if let Ok(mut pulls) = state.pulls.lock() {
        pulls.remove(&model_name);
    }

    let mut terminal = PullProgress {
        model: model_name.clone(),
        done: true,
        ..PullProgress::default()
    };
    let result = match outcome {
        Ok(Ok(())) => {
            terminal.status = "success".to_string();
            terminal.percent = 100.0;
            Ok(())
        }
        Ok(Err(message)) => {
            terminal.status = "error".to_string();
            terminal.error = Some(message.clone());
            Err(message)
        }
        Err(_) => {
            terminal.status = "cancelled".to_string();
            terminal.cancelled = true;
            Ok(())
        }
    };
    emit_pull(&app, &terminal);
    result
}

#[tauri::command]
pub fn cancel_model_pull(state: State<'_, OllamaState>, model_name: String) -> Result<bool, String> {
    let pulls = state.pulls.lock().map_err(|e| e.to_string())?;
    Ok(pulls.get(&model_name).map(AbortHandle::abort).is_some())
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

async fn read_api_error(response: reqwest::Response) -> String {
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    let message = serde_json::from_str::<Value>(&body)
        .ok()
        .and_then(|value| value.get("error").and_then(Value::as_str).map(str::to_string))
        .unwrap_or(body);
    if message.trim().is_empty() {
        format!("Ollama returned HTTP {status}.")
    } else {
        message
    }
}

/// Streams a chat completion, forwarding tokens in rate limited batches. Script requests
/// set `reject_truncated`, because a deck cut off by the context window cannot be used.
/// Vision requests do not, since their token limit is an intentional length cap.
async fn stream_chat(
    app: &AppHandle,
    state: &OllamaState,
    request_id: &str,
    body: Value,
    reject_truncated: bool,
) -> Result<String, String> {
    let response = state
        .client
        .post(state.url("/api/chat"))
        .json(&body)
        .send()
        .await
        .map_err(|_| "Ollama is not reachable. Start it, then try again.".to_string())?;
    if !response.status().is_success() {
        return Err(read_api_error(response).await);
    }

    let mut full = String::new();
    let mut unsent = String::new();
    let mut truncated = false;
    let mut last_emit = Instant::now();
    let mut buffer = NdjsonBuffer::default();
    let mut stream = response.bytes_stream();

    let consume = |line: Value, full: &mut String, unsent: &mut String, truncated: &mut bool| -> Result<(), String> {
        if let Some(error) = line.get("error").and_then(Value::as_str) {
            return Err(error.to_string());
        }
        if let Some(content) = line.pointer("/message/content").and_then(Value::as_str) {
            full.push_str(content);
            unsent.push_str(content);
        }
        if line.get("done_reason").and_then(Value::as_str) == Some("length") {
            *truncated = true;
        }
        Ok(())
    };

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("The response was interrupted: {e}"))?;
        for line in buffer.push(&chunk) {
            consume(line, &mut full, &mut unsent, &mut truncated)?;
        }
        if !unsent.is_empty() && last_emit.elapsed() >= STREAM_EMIT_INTERVAL {
            let delta = std::mem::take(&mut unsent);
            let _ = app.emit(STREAM_EVENT, StreamChunk { request_id: request_id.to_string(), delta, done: false });
            last_emit = Instant::now();
        }
    }
    if let Some(line) = buffer.finish() {
        consume(line, &mut full, &mut unsent, &mut truncated)?;
    }
    let _ = app.emit(
        STREAM_EVENT,
        StreamChunk { request_id: request_id.to_string(), delta: unsent, done: true },
    );
    if truncated && reject_truncated {
        return Err(SCRIPT_TOO_LONG.to_string());
    }
    Ok(full)
}

/// Runs work that `cancel_analysis` can abort. Returns Ok(None) when cancelled.
async fn run_cancellable<F, T>(state: &OllamaState, request_id: &str, work: F) -> Result<Option<T>, String>
where
    F: std::future::Future<Output = Result<T, String>>,
{
    let (abort, registration) = AbortHandle::new_pair();
    if let Ok(mut analyses) = state.analyses.lock() {
        analyses.insert(request_id.to_string(), abort);
    }
    let outcome = Abortable::new(work, registration).await;
    if let Ok(mut analyses) = state.analyses.lock() {
        analyses.remove(request_id);
    }
    match outcome {
        Ok(result) => result.map(Some),
        Err(_) => Ok(None),
    }
}

#[tauri::command]
pub fn cancel_analysis(state: State<'_, OllamaState>, request_id: String) -> Result<bool, String> {
    let analyses = state.analyses.lock().map_err(|e| e.to_string())?;
    Ok(analyses.get(&request_id).map(AbortHandle::abort).is_some())
}

// ---------------------------------------------------------------------------
// Script to slides
// ---------------------------------------------------------------------------

pub fn slide_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "slides": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "slideNumber": { "type": "integer" },
                        "originalExcerpt": { "type": "string" },
                        "refinedTitle": { "type": "string" },
                        "executiveSummary": { "type": "array", "items": { "type": "string" } },
                        "speakerNotes": { "type": "string" },
                        "layoutType": {
                            "type": "string",
                            "enum": ["single-visual", "split-comparison", "multi-grid", "statement-only"]
                        },
                        "dropzones": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": { "aiVisualPrompt": { "type": "string" } },
                                "required": ["aiVisualPrompt"]
                            }
                        }
                    },
                    "required": [
                        "slideNumber", "originalExcerpt", "refinedTitle", "executiveSummary",
                        "speakerNotes", "layoutType", "dropzones"
                    ]
                }
            }
        },
        "required": ["slides"]
    })
}

pub fn script_system_prompt(persona: &str, tone: &str) -> String {
    format!(
        "You are a senior presentation strategist preparing a VIP client deck.\n\
         Audience: {persona}. Tone: {tone}.\n\
         Convert the raw script into a sequence of slides, in the original order, using only facts from the script.\n\
         Respond with a single JSON object of the form {{\"slides\": [...]}}. Every slide has:\n\
         - slideNumber: integer starting at 1\n\
         - originalExcerpt: the exact raw text this slide came from\n\
         - refinedTitle: a client-friendly, high-impact headline of at most 10 words\n\
         - executiveSummary: an array of 2 to 3 crisp talking points\n\
         - speakerNotes: a refined verbal script for the presenter\n\
         - layoutType: \"single-visual\" for one key image, \"split-comparison\" for before/after or two options, \"multi-grid\" for three or four related visuals, \"statement-only\" for a pure message with no image\n\
         - dropzones: one object per image with an aiVisualPrompt describing the screenshot, chart or mockup to drop there. Use 1 for single-visual, 2 for split-comparison, 3 or 4 for multi-grid, and 0 for statement-only.\n\
         Write 3 to 10 slides depending on the script length.\n\
         Use plain professional language. Never use emojis or decorative symbols."
    )
}

fn script_context_size(script: &str) -> u32 {
    // Roughly 4 characters per token. The reply echoes the script as excerpts and rewrites
    // it as notes and summaries, so it can be about three times the size of the input.
    let estimated = (script.len() / 4) as u32 * 4 + 2048;
    estimated.clamp(4096, 32768)
}

pub fn build_script_request(model: &str, script: &str, persona: &str, tone: &str, format: Value) -> Value {
    json!({
        "model": model,
        "stream": true,
        "think": false,
        "format": format,
        "options": { "temperature": 0.3, "num_ctx": script_context_size(script) },
        "messages": [
            { "role": "system", "content": script_system_prompt(persona, tone) },
            { "role": "user", "content": format!("Raw script:\n\n{script}") }
        ]
    })
}

/// Removes emoji and pictographs from model output. The system prompt forbids
/// them, but the no-emoji rule must hold even when a model ignores the prompt.
pub fn strip_emoji(text: &str) -> String {
    let filtered: String = text
        .chars()
        .filter(|c| {
            let code = *c as u32;
            !matches!(code,
                0x200D | 0xFE0E | 0xFE0F | 0x20E3
                | 0x2190..=0x21FF
                | 0x2300..=0x23FF
                | 0x2460..=0x24FF
                | 0x25A0..=0x27BF
                | 0x2900..=0x297F
                | 0x2B00..=0x2BFF
                | 0x3030 | 0x303D | 0x3297 | 0x3299
                | 0x1F000..=0x1FAFF
                | 0xE0020..=0xE007F)
        })
        .collect();

    let mut output = String::with_capacity(filtered.len());
    let mut previous_space = false;
    for c in filtered.chars() {
        let is_space = c == ' ' || c == '\t';
        if !(is_space && previous_space) {
            output.push(c);
        }
        previous_space = is_space;
    }
    output.trim().to_string()
}

/// Removes reasoning blocks and markdown fences, then isolates the JSON payload.
pub fn extract_json_text(raw: &str) -> Option<String> {
    let mut text = raw.to_string();
    while let (Some(start), Some(end)) = (text.find("<think>"), text.find("</think>")) {
        if end < start {
            break;
        }
        text.replace_range(start..end + "</think>".len(), "");
    }
    let first = text.find(['{', '['])?;
    let last = text.rfind(['}', ']'])?;
    (last > first).then(|| text[first..=last].to_string())
}

fn string_field(value: &Value, keys: &[&str]) -> String {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_str))
        .map(strip_emoji)
        .unwrap_or_default()
}

fn clean_point(point: &str) -> String {
    let trimmed = point.trim();
    let mut chars = trimmed.chars();
    let body = match chars.next() {
        Some('\u{2022}') => chars.as_str().trim_start(),
        Some('-' | '*') if chars.clone().next().is_some_and(char::is_whitespace) => chars.as_str().trim_start(),
        _ => trimmed,
    };
    strip_emoji(&body.replace("**", ""))
}

fn summary_points(value: &Value) -> Vec<String> {
    let raw = value.get("executiveSummary").or_else(|| value.get("executive_summary"));
    let points: Vec<String> = match raw {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|item| match item {
                Value::String(text) => Some(clean_point(text)),
                other => other.get("text").and_then(Value::as_str).map(clean_point),
            })
            .collect(),
        Some(Value::String(text)) => text.lines().map(clean_point).collect(),
        _ => Vec::new(),
    };
    points.into_iter().filter(|point| !point.is_empty()).take(3).collect()
}

pub fn normalize_layout(value: &str) -> &'static str {
    match value.trim().to_ascii_lowercase().replace('_', "-").as_str() {
        "single-visual" | "single" => "single-visual",
        "split-comparison" | "split" | "comparison" => "split-comparison",
        "multi-grid" | "grid" | "multi" => "multi-grid",
        "statement-only" | "statement" => "statement-only",
        _ => "single-visual",
    }
}

fn dropzone_count_range(layout: &str) -> (usize, usize) {
    match layout {
        "single-visual" => (1, 1),
        "split-comparison" => (2, 2),
        "multi-grid" => (3, 4),
        _ => (0, 0),
    }
}

fn normalize_dropzones(value: &Value, layout: &str, title: &str) -> Vec<AiDropzone> {
    let raw = value.get("dropzones").and_then(Value::as_array);
    let mut prompts: Vec<String> = raw
        .map(|items| {
            items
                .iter()
                .filter_map(|item| match item {
                    Value::String(text) => Some(strip_emoji(text)),
                    other => ["aiVisualPrompt", "ai_visual_prompt", "prompt"]
                        .iter()
                        .find_map(|key| other.get(*key).and_then(Value::as_str))
                        .map(strip_emoji),
                })
                .filter(|prompt| !prompt.is_empty())
                .collect()
        })
        .unwrap_or_default();

    let (minimum, maximum) = dropzone_count_range(layout);
    prompts.truncate(maximum);
    while prompts.len() < minimum {
        prompts.push(format!("Drop a screenshot, chart or mockup that supports: {title}"));
    }
    prompts.into_iter().map(|ai_visual_prompt| AiDropzone { ai_visual_prompt }).collect()
}

/// Accepts the shapes models actually return and enforces the slide contract.
pub fn parse_slides(raw: &str) -> Result<Vec<AiSlide>, String> {
    let json_text = extract_json_text(raw).ok_or("The model did not return JSON.")?;
    let parsed: Value = serde_json::from_str(&json_text).map_err(|e| format!("Invalid JSON: {e}"))?;

    let items: Vec<Value> = match &parsed {
        Value::Array(items) => items.clone(),
        Value::Object(map) => {
            if let Some(Value::Array(items)) = map.get("slides") {
                items.clone()
            } else if map.contains_key("refinedTitle") || map.contains_key("refined_title") {
                vec![parsed.clone()]
            } else {
                return Err("The JSON did not contain any slides.".to_string());
            }
        }
        _ => return Err("The JSON did not contain any slides.".to_string()),
    };

    let slides: Vec<AiSlide> = items
        .iter()
        .filter(|item| item.is_object())
        .enumerate()
        .map(|(index, item)| {
            let refined_title = {
                let title = string_field(item, &["refinedTitle", "refined_title", "title"]);
                if title.is_empty() {
                    format!("Slide {}", index + 1)
                } else {
                    title
                }
            };
            let layout_type = normalize_layout(&string_field(item, &["layoutType", "layout_type", "layout"]));
            AiSlide {
                slide_number: index as u32 + 1,
                original_excerpt: string_field(item, &["originalExcerpt", "original_excerpt", "excerpt"]),
                executive_summary: summary_points(item),
                speaker_notes: string_field(item, &["speakerNotes", "speaker_notes", "notes"]),
                layout_type: layout_type.to_string(),
                dropzones: normalize_dropzones(item, layout_type, &refined_title),
                refined_title,
            }
        })
        .collect();

    if slides.is_empty() {
        return Err("The model returned an empty deck.".to_string());
    }
    Ok(slides)
}

async fn generate_slides(
    app: &AppHandle,
    state: &OllamaState,
    request_id: &str,
    model: &str,
    script: &str,
    persona: &str,
    tone: &str,
) -> Result<Vec<AiSlide>, String> {
    let schema_request = build_script_request(model, script, persona, tone, slide_schema());
    let raw = match stream_chat(app, state, request_id, schema_request, true).await {
        Ok(raw) => raw,
        Err(message) if is_format_rejection(&message) => {
            // Daemons older than 0.5 reject a schema object but accept "json".
            let plain = build_script_request(model, script, persona, tone, json!("json"));
            stream_chat(app, state, request_id, plain, true).await?
        }
        Err(message) => return Err(message),
    };

    match parse_slides(&raw) {
        Ok(slides) => Ok(slides),
        Err(first_error) => {
            // One repair attempt: small models occasionally break the structure.
            let mut retry = build_script_request(model, script, persona, tone, json!("json"));
            retry["options"]["temperature"] = json!(0.1);
            retry["messages"]
                .as_array_mut()
                .expect("messages array")
                .push(json!({
                    "role": "user",
                    "content": "Your previous reply could not be parsed. Reply again with only the JSON object described above."
                }));
            let raw_retry = stream_chat(app, state, request_id, retry, true).await?;
            parse_slides(&raw_retry).map_err(|_| {
                format!("The model did not produce a usable deck ({first_error}). Try again or choose a different text model.")
            })
        }
    }
}

pub fn is_format_rejection(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("invalid format") || lower.contains("format must be") || lower.contains("cannot unmarshal")
}

/// Returns None when the user cancelled.
#[tauri::command]
pub async fn analyze_script_to_slides(
    app: AppHandle,
    state: State<'_, OllamaState>,
    model: String,
    script: String,
    persona: String,
    tone: String,
    request_id: String,
) -> Result<Option<Vec<AiSlide>>, String> {
    if script.trim().is_empty() {
        return Err("Add a script before generating slides.".to_string());
    }
    if script.len() > MAX_SCRIPT_CHARS {
        return Err(SCRIPT_TOO_LONG.to_string());
    }
    let work = generate_slides(&app, &state, &request_id, &model, &script, &persona, &tone);
    run_cancellable(&state, &request_id, work).await
}

// ---------------------------------------------------------------------------
// Vision
// ---------------------------------------------------------------------------

pub struct VisionImages {
    pub crop: String,
    pub full: String,
    pub composite: String,
}

fn encode_jpeg(image: &DynamicImage) -> Result<String, String> {
    let mut bytes = Cursor::new(Vec::new());
    DynamicImage::ImageRgb8(image.to_rgb8())
        .write_to(&mut bytes, ImageFormat::Jpeg)
        .map_err(|e| e.to_string())?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes.into_inner()))
}

/// Pins are placed on the image as displayed, which honors EXIF orientation, so the pixels
/// must be rotated the same way or a crop would come from the wrong part of a phone photo.
fn decode_upright(bytes: &[u8]) -> image::ImageResult<DynamicImage> {
    let mut decoder = image::ImageReader::new(Cursor::new(bytes)).with_guessed_format()?.into_decoder()?;
    let orientation = decoder.orientation().unwrap_or(Orientation::NoTransforms);
    let mut decoded = DynamicImage::from_decoder(decoder)?;
    decoded.apply_orientation(orientation);
    Ok(decoded)
}

/// Pixel bounds of the region around a pin, at least 128px and clamped to the image.
pub fn crop_bounds(width: u32, height: u32, pin_x: f32, pin_y: f32) -> (u32, u32, u32, u32) {
    let crop_w = ((width as f32 * 0.36) as u32).max(128).min(width);
    let crop_h = ((height as f32 * 0.36) as u32).max(128).min(height);
    let center_x = (pin_x.clamp(0.0, 100.0) / 100.0 * width as f32) as i64;
    let center_y = (pin_y.clamp(0.0, 100.0) / 100.0 * height as f32) as i64;
    let left = (center_x - crop_w as i64 / 2).clamp(0, (width - crop_w) as i64) as u32;
    let top = (center_y - crop_h as i64 / 2).clamp(0, (height - crop_h) as i64) as u32;
    (left, top, crop_w, crop_h)
}

fn draw_marker(image: &mut RgbImage, center_x: i64, center_y: i64, radius: i64) {
    let (width, height) = image.dimensions();
    let thickness = (radius / 4).max(2);
    for y in (center_y - radius - 1)..=(center_y + radius + 1) {
        for x in (center_x - radius - 1)..=(center_x + radius + 1) {
            if x < 0 || y < 0 || x >= width as i64 || y >= height as i64 {
                continue;
            }
            let distance = (((x - center_x).pow(2) + (y - center_y).pow(2)) as f64).sqrt() as i64;
            if distance <= radius && distance >= radius - thickness {
                image.put_pixel(x as u32, y as u32, Rgb([35, 131, 226]));
            }
        }
    }
}

/// Builds the close-up, the marked full image and a single-image composite for
/// models that accept only one image. Everything is bounded to keep inference fast.
pub fn prepare_vision_images(image_base64: &str, pin_x: f32, pin_y: f32) -> Result<VisionImages, String> {
    let payload = image_base64.split_once(',').map_or(image_base64, |(_, data)| data);
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload.trim())
        .map_err(|_| "The image data could not be decoded.".to_string())?;
    let source = decode_upright(&bytes).map_err(|_| "The image could not be read.".to_string())?;
    let (width, height) = source.dimensions();

    let (left, top, crop_w, crop_h) = crop_bounds(width, height, pin_x, pin_y);
    let crop = source
        .crop_imm(left, top, crop_w, crop_h)
        .resize(768, 768, image::imageops::FilterType::Triangle);

    let scaled = if width.max(height) > MAX_VISION_EDGE {
        source.resize(MAX_VISION_EDGE, MAX_VISION_EDGE, image::imageops::FilterType::Triangle)
    } else {
        source
    };
    let mut marked = scaled.to_rgb8();
    let (scaled_w, scaled_h) = marked.dimensions();
    draw_marker(
        &mut marked,
        (pin_x / 100.0 * scaled_w as f32) as i64,
        (pin_y / 100.0 * scaled_h as f32) as i64,
        (scaled_w.max(scaled_h) as i64 / 40).clamp(6, 22),
    );
    let marked = DynamicImage::ImageRgb8(marked);

    let (crop_w_px, crop_h_px) = crop.dimensions();
    let (marked_w, marked_h) = marked.dimensions();
    let mut composite = RgbImage::from_pixel(crop_w_px + marked_w + 8, crop_h_px.max(marked_h), Rgb([255, 255, 255]));
    composite.copy_from(&crop.to_rgb8(), 0, 0).map_err(|e| e.to_string())?;
    composite.copy_from(&marked.to_rgb8(), crop_w_px + 8, 0).map_err(|e| e.to_string())?;

    Ok(VisionImages {
        crop: encode_jpeg(&crop)?,
        full: encode_jpeg(&marked)?,
        composite: encode_jpeg(&DynamicImage::ImageRgb8(composite))?,
    })
}

pub const VISION_SYSTEM_PROMPT: &str = "You explain details in screenshots, charts and architecture diagrams to senior clients. Describe only what is visible. Reply with one or two short, client-friendly sentences in plain text. Do not use markdown, lists or emojis.";

pub fn vision_user_prompt(pin_x: f32, pin_y: f32, user_hint: &str, composite: bool) -> String {
    let framing = if composite {
        "This image shows a close-up of the pinned detail on the left and the full picture on the right, where a blue ring marks the detail."
    } else {
        "The first image is a close-up of the pinned detail. The second is the full picture, where a blue ring marks the detail."
    };
    let hint = user_hint.trim();
    let context = if hint.is_empty() {
        String::new()
    } else {
        format!(" Context from the presenter: {hint}.")
    };
    format!(
        "{framing} The pin sits {pin_x:.0}% from the left and {pin_y:.0}% from the top.{context} Explain what this specific element, chart spike or architectural detail shows and why it matters."
    )
}

fn build_vision_request(model: &str, prompt: String, images: Vec<&str>) -> Value {
    json!({
        "model": model,
        "stream": true,
        "think": false,
        "options": { "temperature": 0.2, "num_predict": 160 },
        "messages": [
            { "role": "system", "content": VISION_SYSTEM_PROMPT },
            { "role": "user", "content": prompt, "images": images }
        ]
    })
}

pub fn is_multi_image_rejection(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("one image") || lower.contains("single image") || lower.contains("multiple images") || lower.contains("more than one")
}

pub fn clean_vision_text(raw: &str) -> String {
    let mut text = raw.to_string();
    while let (Some(start), Some(end)) = (text.find("<think>"), text.find("</think>")) {
        if end < start {
            break;
        }
        text.replace_range(start..end + "</think>".len(), "");
    }
    let cleaned = strip_emoji(&text.replace(['*', '`', '#'], ""));
    let cleaned = cleaned.trim().trim_matches('"').trim();
    if cleaned.chars().count() <= MAX_DESCRIPTION_CHARS {
        return cleaned.to_string();
    }
    let clipped: String = cleaned.chars().take(MAX_DESCRIPTION_CHARS).collect();
    match clipped.rfind(['.', '!', '?']) {
        Some(end) if end > 60 => clipped[..=end].to_string(),
        _ => format!("{}...", clipped.trim_end()),
    }
}

#[allow(clippy::too_many_arguments)]
async fn describe_pin(
    app: &AppHandle,
    state: &OllamaState,
    request_id: &str,
    model: &str,
    image_base64: String,
    pin_x: f32,
    pin_y: f32,
    user_hint: &str,
) -> Result<String, String> {
    let images = tauri::async_runtime::spawn_blocking(move || prepare_vision_images(&image_base64, pin_x, pin_y))
        .await
        .map_err(|e| e.to_string())??;

    let dual = build_vision_request(
        model,
        vision_user_prompt(pin_x, pin_y, user_hint, false),
        vec![&images.crop, &images.full],
    );
    let raw = match stream_chat(app, state, request_id, dual, false).await {
        Ok(raw) => raw,
        Err(message) if is_multi_image_rejection(&message) => {
            let single = build_vision_request(
                model,
                vision_user_prompt(pin_x, pin_y, user_hint, true),
                vec![&images.composite],
            );
            stream_chat(app, state, request_id, single, false).await?
        }
        Err(message) => return Err(message),
    };

    let text = clean_vision_text(&raw);
    if text.is_empty() {
        Err("The vision model returned an empty description. Try again.".to_string())
    } else {
        Ok(text)
    }
}

/// Crops around the pin, sends crop and full image to the vision model and
/// returns a client-friendly description. Returns None when cancelled.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn analyze_image_pin(
    app: AppHandle,
    state: State<'_, OllamaState>,
    vision_model: String,
    image_base64: String,
    pin_x: f32,
    pin_y: f32,
    user_hint: String,
    request_id: String,
) -> Result<Option<String>, String> {
    let work = describe_pin(&app, &state, &request_id, &vision_model, image_base64, pin_x, pin_y, &user_hint);
    run_cancellable(&state, &request_id, work).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_base64(width: u32, height: u32) -> String {
        let image = RgbImage::from_pixel(width, height, Rgb([200, 210, 220]));
        let mut bytes = Cursor::new(Vec::new());
        DynamicImage::ImageRgb8(image).write_to(&mut bytes, ImageFormat::Png).unwrap();
        base64::engine::general_purpose::STANDARD.encode(bytes.into_inner())
    }

    fn decoded_dimensions(encoded: &str) -> (u32, u32) {
        let bytes = base64::engine::general_purpose::STANDARD.decode(encoded).unwrap();
        image::load_from_memory(&bytes).unwrap().dimensions()
    }

    #[test]
    fn ndjson_buffer_handles_split_and_joined_chunks() {
        let mut buffer = NdjsonBuffer::default();
        assert!(buffer.push(b"{\"a\":").is_empty());
        let values = buffer.push(b"1}\n{\"a\":2}\n{\"a\"");
        assert_eq!(values, vec![json!({"a":1}), json!({"a":2})]);
        assert!(buffer.push(b":3}").is_empty());
        assert_eq!(buffer.finish(), Some(json!({"a":3})));
    }

    #[test]
    fn ndjson_buffer_skips_blank_and_invalid_lines() {
        let mut buffer = NdjsonBuffer::default();
        assert_eq!(buffer.push(b"\n  \nnot json\n{\"ok\":true}\r\n"), vec![json!({"ok":true})]);
    }

    #[test]
    fn pull_tracker_aggregates_layers_without_going_backwards() {
        let mut tracker = PullTracker::new("m");
        let start = Instant::now();
        tracker.update(&json!({"status":"pulling a","digest":"a","total":1000,"completed":1000}), start);
        let progress = tracker
            .update(&json!({"status":"pulling b","digest":"b","total":1000,"completed":0}), start + Duration::from_secs(1))
            .unwrap();
        assert_eq!(progress.completed, 1000);
        assert_eq!(progress.total, 2000);
        assert_eq!(progress.percent, 50.0);
    }

    #[test]
    fn pull_tracker_computes_speed_over_the_window() {
        let mut tracker = PullTracker::new("m");
        let start = Instant::now();
        tracker.update(&json!({"status":"pulling a","digest":"a","total":10000,"completed":0}), start);
        let progress = tracker
            .update(&json!({"status":"pulling a","digest":"a","total":10000,"completed":4000}), start + Duration::from_secs(2))
            .unwrap();
        assert!((progress.bytes_per_second - 2000.0).abs() < 1.0);
    }

    #[test]
    fn pull_tracker_rate_limits_but_never_drops_status_changes() {
        let mut tracker = PullTracker::new("m");
        let start = Instant::now();
        let line = json!({"status":"pulling a","digest":"a","total":100,"completed":1});
        assert!(tracker.update(&line, start).is_some());
        assert!(tracker.update(&line, start + Duration::from_millis(10)).is_none());
        assert!(tracker.update(&json!({"status":"verifying sha256 digest"}), start + Duration::from_millis(20)).is_some());
        assert!(tracker.update(&line, start + Duration::from_millis(30)).is_some());
    }

    #[test]
    fn parse_models_reads_capabilities_and_falls_back_to_the_name() {
        let body = json!({"models":[
            {"name":"moondream:latest","size":1738451197,"digest":"x","capabilities":["completion","vision"],"details":{"family":"phi2","parameter_size":"1B","quantization_level":"Q4_0"}},
            {"name":"llama3.2:3b","capabilities":["completion","tools"]},
            {"name":"llava:7b"},
            {"name":"qwen2.5:7b"}
        ]});
        let models = parse_models(&body);
        assert_eq!(models.len(), 4);
        assert!(models[0].is_vision);
        assert_eq!(models[0].family, "phi2");
        assert!(!models[1].is_vision);
        assert!(models[2].is_vision);
        assert!(!models[3].is_vision);
    }

    #[test]
    fn strip_emoji_removes_pictographs_and_keeps_text() {
        assert_eq!(strip_emoji("Revenue \u{1F680} up 40% \u{2705}"), "Revenue up 40%");
        assert_eq!(strip_emoji("Caf\u{e9} \u{2014} r\u{e9}sum\u{e9}"), "Caf\u{e9} \u{2014} r\u{e9}sum\u{e9}");
        assert_eq!(strip_emoji("\u{1F468}\u{200D}\u{1F4BB} team"), "team");
    }

    #[test]
    fn extract_json_strips_reasoning_and_fences() {
        let raw = "<think>hmm {not json}</think>\n```json\n{\"slides\":[]}\n```\nDone";
        assert_eq!(extract_json_text(raw).unwrap(), "{\"slides\":[]}");
        assert_eq!(extract_json_text("no json here"), None);
    }

    #[test]
    fn parse_slides_accepts_a_well_formed_deck() {
        let raw = json!({"slides":[{
            "slideNumber":1,"originalExcerpt":"raw","refinedTitle":"Title",
            "executiveSummary":["One","Two"],"speakerNotes":"Say this",
            "layoutType":"split-comparison",
            "dropzones":[{"aiVisualPrompt":"Before"},{"aiVisualPrompt":"After"}]
        }]}).to_string();
        let slides = parse_slides(&raw).unwrap();
        assert_eq!(slides[0].refined_title, "Title");
        assert_eq!(slides[0].dropzones.len(), 2);
    }

    #[test]
    fn parse_slides_repairs_the_shapes_models_really_return() {
        let raw = json!([{
            "title":"Launch \u{1F680}",
            "executive_summary":"- First point\n- Second point",
            "layout":"grid",
            "dropzones":["Chart"],
            "slideNumber":9
        }]).to_string();
        let slides = parse_slides(&raw).unwrap();
        assert_eq!(slides[0].refined_title, "Launch");
        assert_eq!(slides[0].slide_number, 1);
        assert_eq!(slides[0].layout_type, "multi-grid");
        assert_eq!(slides[0].executive_summary, vec!["First point", "Second point"]);
        assert_eq!(slides[0].dropzones.len(), 3);
    }

    #[test]
    fn parse_slides_enforces_dropzones_per_layout() {
        let raw = json!({"slides":[
            {"refinedTitle":"A","layoutType":"statement-only","dropzones":[{"aiVisualPrompt":"x"}]},
            {"refinedTitle":"B","layoutType":"single-visual","dropzones":[{"aiVisualPrompt":"x"},{"aiVisualPrompt":"y"}]},
            {"refinedTitle":"C","layoutType":"unknown"}
        ]}).to_string();
        let slides = parse_slides(&raw).unwrap();
        assert_eq!(slides[0].dropzones.len(), 0);
        assert_eq!(slides[1].dropzones.len(), 1);
        assert_eq!(slides[2].layout_type, "single-visual");
        assert_eq!(slides[2].dropzones.len(), 1);
    }

    #[test]
    fn parse_slides_rejects_unusable_output() {
        assert!(parse_slides("sorry, I cannot help").is_err());
        assert!(parse_slides("{\"slides\":[]}").is_err());
        assert!(parse_slides("{\"message\":\"hello\"}").is_err());
    }

    #[test]
    fn schema_requires_every_field_in_module_b() {
        let schema = slide_schema();
        let required = schema.pointer("/properties/slides/items/required").unwrap().as_array().unwrap();
        for key in ["slideNumber", "originalExcerpt", "refinedTitle", "executiveSummary", "speakerNotes", "layoutType", "dropzones"] {
            assert!(required.iter().any(|v| v == key), "missing {key}");
        }
    }

    #[test]
    fn prompts_carry_persona_and_tone_and_no_emoji() {
        let prompt = script_system_prompt("Investor Pitch", "Persuasive");
        assert!(prompt.contains("Investor Pitch"));
        assert!(prompt.contains("Persuasive"));
        assert_eq!(strip_emoji(&prompt), prompt.trim());
        assert_eq!(strip_emoji(VISION_SYSTEM_PROMPT), VISION_SYSTEM_PROMPT);
    }

    #[test]
    fn crop_stays_inside_the_image_at_the_corners() {
        for (x, y) in [(0.0, 0.0), (100.0, 100.0), (100.0, 0.0), (50.0, 50.0)] {
            let (left, top, w, h) = crop_bounds(1000, 500, x, y);
            assert!(left + w <= 1000 && top + h <= 500, "{x},{y}");
        }
        assert_eq!(crop_bounds(1000, 500, 50.0, 50.0), (320, 160, 360, 180));
    }

    #[test]
    fn crop_handles_images_smaller_than_the_minimum() {
        assert_eq!(crop_bounds(40, 30, 50.0, 50.0), (0, 0, 40, 30));
    }

    #[test]
    fn vision_images_are_bounded_and_well_formed() {
        let images = prepare_vision_images(&sample_base64(2400, 1200), 80.0, 20.0).unwrap();
        let (full_w, full_h) = decoded_dimensions(&images.full);
        assert_eq!((full_w, full_h), (1024, 512));
        let (crop_w, crop_h) = decoded_dimensions(&images.crop);
        assert!(crop_w <= 768 && crop_h <= 768);
        let (composite_w, _) = decoded_dimensions(&images.composite);
        assert_eq!(composite_w, crop_w + full_w + 8);
    }

    #[test]
    fn vision_images_accept_data_urls_and_reject_garbage() {
        let data_url = format!("data:image/png;base64,{}", sample_base64(64, 64));
        assert!(prepare_vision_images(&data_url, 50.0, 50.0).is_ok());
        assert!(prepare_vision_images("not base64!!", 50.0, 50.0).is_err());
    }

    #[test]
    fn vision_images_are_decoded_upright() {
        let rotated = crate::storage::jpeg_with_orientation(800, 400, 6);
        let encoded = base64::engine::general_purpose::STANDARD.encode(rotated);
        let images = prepare_vision_images(&encoded, 50.0, 50.0).unwrap();
        let (width, height) = decoded_dimensions(&images.full);
        assert!(height > width, "displayed as portrait, got {width}x{height}");
    }

    #[test]
    fn talking_points_keep_negative_figures_and_lose_real_bullets() {
        assert_eq!(clean_point("-12% revenue year over year"), "-12% revenue year over year");
        assert_eq!(clean_point("- Churn fell"), "Churn fell");
        assert_eq!(clean_point("* Churn fell"), "Churn fell");
        assert_eq!(clean_point("\u{2022}Churn fell"), "Churn fell");
        assert_eq!(clean_point("**Churn** fell"), "Churn fell");
    }

    #[test]
    fn context_window_leaves_room_for_the_rewritten_deck() {
        assert_eq!(script_context_size("short"), 4096);
        // 12,000 input tokens is 16,000 characters of script at 4 characters per token.
        assert!(script_context_size(&"x".repeat(16_000)) >= 16_000 * 3 / 4);
        assert_eq!(script_context_size(&"x".repeat(MAX_SCRIPT_CHARS)), 32768);
    }

    #[test]
    fn multi_image_rejection_is_detected() {
        assert!(is_multi_image_rejection("this model only supports one image while more than one image requested"));
        assert!(!is_multi_image_rejection("model not found"));
    }

    #[test]
    fn vision_text_is_cleaned_and_clipped_at_a_sentence() {
        assert_eq!(clean_vision_text("<think>x</think> **Revenue** spikes \u{1F680}."), "Revenue spikes .");
        let long = format!("{}. {}", "a".repeat(200), "b".repeat(400));
        let clipped = clean_vision_text(&long);
        assert!(clipped.chars().count() <= MAX_DESCRIPTION_CHARS);
        assert!(clipped.ends_with('.'));
    }

    #[test]
    fn friendly_error_for_missing_tags() {
        assert!(friendly_pull_error("pull model manifest: file does not exist").contains("does not exist"));
        assert_eq!(friendly_pull_error("disk full"), "disk full");
    }
}
