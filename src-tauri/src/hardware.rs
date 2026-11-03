//! RAM, CPU, Apple unified memory and dedicated VRAM detection.
//!
//! Every shell probe runs on a blocking worker with a deadline, never on the UI
//! thread, and never opens a console window on Windows.

use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::{mpsc, OnceLock};
use std::time::Duration;

use serde::Serialize;
use sysinfo::{CpuRefreshKind, MemoryRefreshKind, RefreshKind, System};

const GIB: f64 = 1_073_741_824.0;

/// Share of unified memory that Metal can wire for inference on Apple Silicon.
const UNIFIED_BUDGET: f32 = 0.70;
/// Share of system RAM treated as usable when inference falls back to the CPU.
const CPU_FALLBACK_BUDGET: f32 = 0.45;
/// Below this a GPU cannot usefully hold a model, so system RAM decides the tier.
const MIN_USEFUL_VRAM_GB: f32 = 2.0;

/// Tier boundaries in effective GB. PLAN.md leaves 16-24 GB undefined. 18 is the
/// lowest budget that holds the Tier 3 pair (7.8 GB vision + 9 GB text) and also
/// admits 32 GB Apple unified memory (32 x 0.70 = 22.4 GB).
const TIER_2_MIN_GB: f32 = 8.0;
const TIER_3_MIN_GB: f32 = 18.0;

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelRecommendation {
    pub id: String,
    pub display_name: String,
    pub role: String,
    pub size_gb: f32,
    pub reason: String,
    pub tier_level: u8,
    pub recommended: bool,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HardwareProfile {
    pub os_name: String,
    pub os_version: String,
    pub cpu_arch: String,
    pub cpu_brand: String,
    pub cpu_cores: usize,
    pub total_ram_gb: f32,
    pub available_ram_gb: f32,
    pub gpu_name: String,
    /// Physical dedicated VRAM, or the full unified pool on Apple Silicon.
    pub vram_gb: f32,
    /// Free VRAM where the driver reports it, otherwise the same as `vram_gb`.
    pub available_vram_gb: f32,
    /// Memory budget used for tiering and model recommendations.
    pub effective_memory_gb: f32,
    pub is_unified_memory: bool,
    pub tier: String,
    pub tier_level: u8,
    pub detection_source: String,
    pub recommendations: Vec<ModelRecommendation>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct GpuInfo {
    pub name: String,
    pub vram_gb: f32,
    pub free_vram_gb: Option<f32>,
    pub is_unified: bool,
    pub source: String,
}

struct StaticSpecs {
    cpu_brand: String,
    cpu_cores: usize,
    total_ram_gb: f32,
    gpu: GpuInfo,
}

static STATIC_SPECS: OnceLock<StaticSpecs> = OnceLock::new();

/// Blocking GPU probes can take seconds, so this runs on a worker thread.
#[tauri::command]
pub async fn get_hardware_specs() -> HardwareProfile {
    tauri::async_runtime::spawn_blocking(build_profile)
        .await
        .unwrap_or_else(|_| fallback_profile())
}

fn build_profile() -> HardwareProfile {
    let specs = STATIC_SPECS.get_or_init(probe_static_specs);

    // Only memory is re-read per call, which keeps the "live" banner cheap.
    let mut sys = System::new_with_specifics(
        RefreshKind::nothing().with_memory(MemoryRefreshKind::everything()),
    );
    sys.refresh_memory();
    let available_ram_gb = (sys.available_memory() as f64 / GIB) as f32;

    assemble_profile(specs, available_ram_gb)
}

fn probe_static_specs() -> StaticSpecs {
    let sys = System::new_with_specifics(
        RefreshKind::nothing()
            .with_memory(MemoryRefreshKind::everything())
            .with_cpu(CpuRefreshKind::everything()),
    );
    let cpu_brand = sys
        .cpus()
        .first()
        .map(|cpu| cpu.brand().trim().to_string())
        .filter(|brand| !brand.is_empty())
        .unwrap_or_else(|| "Generic Processor".to_string());
    let cpu_cores = sys.cpus().len();
    let total_ram_gb = (sys.total_memory() as f64 / GIB) as f32;
    let (gpu, total_ram_gb) = detect_platform_gpu(&cpu_brand, total_ram_gb);

    StaticSpecs {
        cpu_brand,
        cpu_cores,
        total_ram_gb,
        gpu,
    }
}

fn assemble_profile(specs: &StaticSpecs, available_ram_gb: f32) -> HardwareProfile {
    let effective = effective_memory_gb(&specs.gpu, specs.total_ram_gb);
    let (tier, tier_level) = classify_tier(effective);
    let available_vram = if specs.gpu.is_unified {
        available_ram_gb
    } else {
        specs.gpu.free_vram_gb.unwrap_or(specs.gpu.vram_gb)
    };

    HardwareProfile {
        os_name: std::env::consts::OS.to_string(),
        os_version: System::long_os_version().unwrap_or_default(),
        cpu_arch: std::env::consts::ARCH.to_string(),
        cpu_brand: specs.cpu_brand.clone(),
        cpu_cores: specs.cpu_cores,
        total_ram_gb: round_tenth(specs.total_ram_gb),
        available_ram_gb: round_tenth(available_ram_gb),
        gpu_name: specs.gpu.name.clone(),
        vram_gb: round_tenth(specs.gpu.vram_gb),
        available_vram_gb: round_tenth(available_vram),
        effective_memory_gb: round_tenth(effective),
        is_unified_memory: specs.gpu.is_unified,
        tier: tier.to_string(),
        tier_level,
        detection_source: specs.gpu.source.clone(),
        recommendations: build_recommendations(tier_level),
    }
}

fn fallback_profile() -> HardwareProfile {
    let specs = StaticSpecs {
        cpu_brand: "Generic Processor".to_string(),
        cpu_cores: 0,
        total_ram_gb: 0.0,
        gpu: unknown_gpu(),
    };
    assemble_profile(&specs, 0.0)
}

fn round_tenth(value: f32) -> f32 {
    (value * 10.0).round() / 10.0
}

pub fn effective_memory_gb(gpu: &GpuInfo, total_ram_gb: f32) -> f32 {
    if gpu.is_unified {
        total_ram_gb * UNIFIED_BUDGET
    } else if gpu.vram_gb >= MIN_USEFUL_VRAM_GB && !is_integrated_gpu(&gpu.name) {
        gpu.vram_gb
    } else {
        total_ram_gb * CPU_FALLBACK_BUDGET
    }
}

pub fn classify_tier(effective_gb: f32) -> (&'static str, u8) {
    if effective_gb >= TIER_3_MIN_GB {
        ("TIER 3: ULTRA", 3)
    } else if effective_gb >= TIER_2_MIN_GB {
        ("TIER 2: PRO", 2)
    } else {
        ("TIER 1: ENTRY", 1)
    }
}

fn is_integrated_gpu(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    let known = ["intel(r) hd", "intel(r) uhd", "intel hd", "intel uhd", "iris", "arc(tm) graphics", "vega "]
        .iter()
        .any(|marker| lower.contains(marker));
    // AMD names its APUs "Radeon 780M Graphics", and its discrete cards "Radeon RX 6600".
    known || (lower.contains("radeon") && lower.ends_with("graphics"))
}

fn unknown_gpu() -> GpuInfo {
    GpuInfo {
        name: "System Accelerated Graphics".to_string(),
        vram_gb: 0.0,
        free_vram_gb: None,
        is_unified: false,
        source: "none".to_string(),
    }
}

#[cfg(target_os = "macos")]
fn detect_platform_gpu(cpu_brand: &str, sysinfo_ram_gb: f32) -> (GpuInfo, f32) {
    let ram_gb = run_probe("sysctl", &["-n", "hw.memsize"], Duration::from_secs(4))
        .and_then(|text| parse_sysctl_memsize(&text))
        .unwrap_or(sysinfo_ram_gb);
    let gpu = run_probe("system_profiler", &["SPDisplaysDataType"], Duration::from_secs(15))
        .and_then(|text| parse_system_profiler(&text, ram_gb))
        .unwrap_or_else(|| {
            if cpu_brand.contains("Apple") {
                GpuInfo {
                    name: format!("{cpu_brand} Integrated Metal GPU"),
                    vram_gb: ram_gb,
                    free_vram_gb: None,
                    is_unified: true,
                    source: "cpu-brand".to_string(),
                }
            } else {
                unknown_gpu()
            }
        });
    (gpu, ram_gb)
}

#[cfg(target_os = "windows")]
fn detect_platform_gpu(_cpu_brand: &str, sysinfo_ram_gb: f32) -> (GpuInfo, f32) {
    (detect_windows_gpu(), sysinfo_ram_gb)
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn detect_platform_gpu(_cpu_brand: &str, sysinfo_ram_gb: f32) -> (GpuInfo, f32) {
    (probe_nvidia_smi().unwrap_or_else(unknown_gpu), sysinfo_ram_gb)
}

#[cfg(target_os = "windows")]
fn detect_windows_gpu() -> GpuInfo {
    if let Some(gpu) = probe_nvidia_smi() {
        return gpu;
    }

    // WMIC is removed from current Windows builds, so WMI is read via PowerShell.
    // Win32_VideoController.AdapterRAM is a uint32 and caps at 4 GB, so the
    // driver's 64-bit registry value is preferred whenever it exists.
    const SCRIPT: &str = r#"$ErrorActionPreference='SilentlyContinue';
Get-ChildItem 'HKLM:\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}' | ForEach-Object {
  $p = Get-ItemProperty $_.PSPath;
  if ($p.DriverDesc) { 'R|' + $p.DriverDesc + '|' + $p.'HardwareInformation.qwMemorySize' }
};
Get-CimInstance Win32_VideoController | ForEach-Object { 'W|' + $_.Name + '|' + $_.AdapterRAM }"#;

    if let Some(text) = run_probe(
        "powershell",
        &["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", SCRIPT],
        Duration::from_secs(12),
    ) {
        if let Some(gpu) = parse_windows_adapters(&text) {
            return gpu;
        }
    }

    probe_dxdiag().unwrap_or_else(unknown_gpu)
}

#[cfg(target_os = "windows")]
fn probe_dxdiag() -> Option<GpuInfo> {
    let path = std::env::temp_dir().join(format!("vanguard-dxdiag-{}.txt", std::process::id()));
    let path_text = path.to_string_lossy().to_string();
    run_probe("dxdiag", &["/whql:off", "/t", &path_text], Duration::from_secs(30));
    let bytes = std::fs::read(&path).ok()?;
    let _ = std::fs::remove_file(&path);
    parse_dxdiag(&String::from_utf8_lossy(&bytes))
}

#[cfg(not(target_os = "macos"))]
fn probe_nvidia_smi() -> Option<GpuInfo> {
    let text = run_probe(
        "nvidia-smi",
        &["--query-gpu=name,memory.total,memory.free", "--format=csv,noheader"],
        Duration::from_secs(6),
    )?;
    parse_nvidia_smi(&text)
}

/// Runs a probe with a hard deadline so a wedged driver tool cannot hang the app.
#[allow(dead_code)]
fn run_probe(program: &str, args: &[&str], timeout: Duration) -> Option<String> {
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = command.spawn().ok()?;
    let mut stdout = child.stdout.take()?;
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let mut buffer = Vec::new();
        let _ = stdout.read_to_end(&mut buffer);
        let _ = sender.send(buffer);
    });

    match receiver.recv_timeout(timeout) {
        Ok(buffer) => {
            let status = child.wait().ok()?;
            status
                .success()
                .then(|| String::from_utf8_lossy(&buffer).into_owned())
        }
        Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
            None
        }
    }
}

/// Parses `name, total, free` rows with or without unit suffixes and keeps the
/// GPU with the most VRAM.
pub fn parse_nvidia_smi(text: &str) -> Option<GpuInfo> {
    text.lines()
        .filter_map(|line| {
            let parts: Vec<&str> = line.split(',').map(str::trim).collect();
            let name = parts.first().filter(|n| !n.is_empty())?;
            let total_mb = parse_leading_number(parts.get(1)?)?;
            let free_mb = parts.get(2).and_then(|value| parse_leading_number(value));
            Some(GpuInfo {
                name: (*name).to_string(),
                vram_gb: total_mb / 1024.0,
                free_vram_gb: free_mb.map(|mb| mb / 1024.0),
                is_unified: false,
                source: "nvidia-smi".to_string(),
            })
        })
        .max_by(|a, b| a.vram_gb.total_cmp(&b.vram_gb))
}

fn parse_leading_number(text: &str) -> Option<f32> {
    let digits: String = text
        .trim()
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect();
    digits.parse().ok()
}

/// Parses the `R|name|bytes` and `W|name|bytes` rows from the PowerShell probe.
pub fn parse_windows_adapters(text: &str) -> Option<GpuInfo> {
    let mut registry: Vec<(String, f32)> = Vec::new();
    let mut wmi: Vec<(String, f32)> = Vec::new();

    for line in text.lines() {
        let mut parts = line.trim().splitn(3, '|');
        let (Some(kind), Some(name), Some(bytes)) = (parts.next(), parts.next(), parts.next()) else {
            continue;
        };
        let name = name.trim();
        let lower = name.to_ascii_lowercase();
        if name.is_empty() || lower.contains("basic display") || lower.contains("remote") {
            continue;
        }
        let gb = bytes.trim().parse::<f64>().map(|b| (b / GIB) as f32).unwrap_or(0.0);
        match kind {
            "R" => registry.push((name.to_string(), gb)),
            "W" => wmi.push((name.to_string(), gb)),
            _ => {}
        }
    }

    // The registry keeps entries for GPUs removed long ago. WMI lists only present devices.
    if !wmi.is_empty() {
        registry.retain(|(name, _)| wmi.iter().any(|(wmi_name, _)| wmi_name == name));
    }

    // A registry row with a missing qwMemorySize must not hide WMI's value.
    let vram_for = |name: &str, registry_gb: f32| -> f32 {
        if registry_gb > 0.0 {
            registry_gb
        } else {
            wmi.iter()
                .find(|(wmi_name, _)| wmi_name == name)
                .map(|(_, gb)| *gb)
                .unwrap_or(0.0)
        }
    };

    let mut adapters: Vec<(String, f32)> = registry
        .iter()
        .map(|(name, gb)| (name.clone(), vram_for(name, *gb)))
        .collect();
    for (name, gb) in &wmi {
        if !adapters.iter().any(|(existing, _)| existing == name) {
            adapters.push((name.clone(), *gb));
        }
    }

    adapters
        .into_iter()
        .max_by(|a, b| {
            // A discrete GPU outranks an integrated one reporting a larger pool.
            let a_rank = (!is_integrated_gpu(&a.0), a.1);
            let b_rank = (!is_integrated_gpu(&b.0), b.1);
            a_rank.0.cmp(&b_rank.0).then(a_rank.1.total_cmp(&b_rank.1))
        })
        .map(|(name, vram_gb)| GpuInfo {
            name,
            vram_gb,
            free_vram_gb: None,
            is_unified: false,
            source: "wmi".to_string(),
        })
}

/// DirectX diagnostic fallback. Reads the first display block.
pub fn parse_dxdiag(text: &str) -> Option<GpuInfo> {
    let mut name = None;
    let mut vram_mb = None;
    for line in text.lines() {
        let line = line.trim();
        if name.is_none() {
            if let Some(value) = line.strip_prefix("Card name:") {
                name = Some(value.trim().to_string());
            }
        }
        if vram_mb.is_none() {
            if let Some(value) = line.strip_prefix("Dedicated Memory:") {
                vram_mb = parse_leading_number(value);
            }
        }
    }
    Some(GpuInfo {
        name: name.filter(|n| !n.is_empty())?,
        vram_gb: vram_mb.unwrap_or(0.0) / 1024.0,
        free_vram_gb: None,
        is_unified: false,
        source: "dxdiag".to_string(),
    })
}

#[allow(dead_code)]
pub fn parse_sysctl_memsize(text: &str) -> Option<f32> {
    let bytes: f64 = text.trim().parse().ok()?;
    (bytes > 0.0).then(|| (bytes / GIB) as f32)
}

/// Parses `system_profiler SPDisplaysDataType`, detecting Apple Silicon and
/// reading discrete VRAM on Intel Macs.
#[allow(dead_code)]
pub fn parse_system_profiler(text: &str, total_ram_gb: f32) -> Option<GpuInfo> {
    let mut best: Option<GpuInfo> = None;
    let mut name: Option<String> = None;
    let mut vram: Option<f32> = None;

    let mut commit = |name: &mut Option<String>, vram: &mut Option<f32>| {
        if let Some(chipset) = name.take() {
            let is_apple = chipset.starts_with("Apple");
            let gpu = GpuInfo {
                vram_gb: if is_apple { total_ram_gb } else { vram.unwrap_or(0.0) },
                free_vram_gb: None,
                is_unified: is_apple,
                source: "system_profiler".to_string(),
                name: chipset,
            };
            if best.as_ref().map_or(true, |current| gpu.vram_gb > current.vram_gb) {
                best = Some(gpu);
            }
        }
        *vram = None;
    };

    for line in text.lines() {
        let line = line.trim();
        if let Some(value) = line.strip_prefix("Chipset Model:") {
            commit(&mut name, &mut vram);
            name = Some(value.trim().to_string());
        } else if line.starts_with("VRAM") {
            vram = line.split(':').nth(1).and_then(parse_size_to_gb);
        }
    }
    commit(&mut name, &mut vram);
    best
}

#[allow(dead_code)]
fn parse_size_to_gb(text: &str) -> Option<f32> {
    let value = parse_leading_number(text)?;
    let upper = text.to_ascii_uppercase();
    if upper.contains("GB") {
        Some(value)
    } else if upper.contains("MB") {
        Some(value / 1024.0)
    } else {
        None
    }
}

struct CatalogEntry {
    id: &'static str,
    display_name: &'static str,
    role: &'static str,
    size_gb: f32,
    tier_level: u8,
    reason: &'static str,
}

/// Sizes were read from the Ollama registry manifests. `qwen2.5vl:7b` replaces
/// the `qwen2.5-vl:14b` tag named in PLAN.md, which the registry answers with 404.
const CATALOG: &[CatalogEntry] = &[
    CatalogEntry { id: "moondream:1.8b", display_name: "Moondream 2 (1.8B Vision)", role: "vision", size_gb: 1.74, tier_level: 1, reason: "Ultra-fast UI and image pin analysis for lightweight machines." },
    CatalogEntry { id: "minicpm-v:8b", display_name: "MiniCPM-V 2.6 (8B Vision)", role: "vision", size_gb: 5.47, tier_level: 2, reason: "Superior OCR, chart reading and UI pin description accuracy." },
    CatalogEntry { id: "llava:7b", display_name: "LLaVA (7B Vision)", role: "vision", size_gb: 4.73, tier_level: 2, reason: "Dependable general purpose vision model with broad compatibility." },
    CatalogEntry { id: "llama3.2-vision:11b", display_name: "Llama 3.2 Vision (11B)", role: "vision", size_gb: 7.82, tier_level: 3, reason: "Flagship executive visual reasoning and diagram analysis." },
    CatalogEntry { id: "qwen2.5vl:7b", display_name: "Qwen 2.5 VL (7B Vision)", role: "vision", size_gb: 5.97, tier_level: 3, reason: "Precise document and interface reading with strong layout awareness." },
    CatalogEntry { id: "llama3.2:3b", display_name: "Llama 3.2 (3B Text)", role: "text", size_gb: 2.02, tier_level: 1, reason: "Responsive script structuring on 8 GB machines." },
    CatalogEntry { id: "qwen2.5:3b", display_name: "Qwen 2.5 (3B Text)", role: "text", size_gb: 1.93, tier_level: 1, reason: "Fast script-to-slide JSON structuring on low memory." },
    CatalogEntry { id: "llama3.1:8b", display_name: "Llama 3.1 (8B Text)", role: "text", size_gb: 4.92, tier_level: 2, reason: "Reliable narrative quality with moderate memory use." },
    CatalogEntry { id: "qwen2.5:7b", display_name: "Qwen 2.5 (7B Text)", role: "text", size_gb: 4.68, tier_level: 2, reason: "Balanced executive copywriting and reliable JSON slide generation." },
    CatalogEntry { id: "qwen2.5:14b", display_name: "Qwen 2.5 (14B Text)", role: "text", size_gb: 8.99, tier_level: 3, reason: "Near-cloud quality narrative restructuring for VIP pitches." },
    CatalogEntry { id: "deepseek-r1:14b", display_name: "DeepSeek R1 (14B Text)", role: "text", size_gb: 8.99, tier_level: 3, reason: "Deep reasoning for complex analytical storylines." },
];

pub fn build_recommendations(tier_level: u8) -> Vec<ModelRecommendation> {
    CATALOG
        .iter()
        .map(|entry| ModelRecommendation {
            id: entry.id.to_string(),
            display_name: entry.display_name.to_string(),
            role: entry.role.to_string(),
            size_gb: entry.size_gb,
            reason: entry.reason.to_string(),
            tier_level: entry.tier_level,
            recommended: entry.tier_level == tier_level,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gpu(name: &str, vram_gb: f32, is_unified: bool) -> GpuInfo {
        GpuInfo {
            name: name.to_string(),
            vram_gb,
            free_vram_gb: None,
            is_unified,
            source: "test".to_string(),
        }
    }

    #[test]
    fn tiers_cover_the_range_without_gaps() {
        assert_eq!(classify_tier(0.0).1, 1);
        assert_eq!(classify_tier(7.9).1, 1);
        assert_eq!(classify_tier(8.0).1, 2);
        assert_eq!(classify_tier(16.0).1, 2);
        assert_eq!(classify_tier(17.9).1, 2);
        assert_eq!(classify_tier(18.0).1, 3);
        assert_eq!(classify_tier(24.0).1, 3);
    }

    #[test]
    fn tier_names_match_plan_module_a() {
        assert_eq!(classify_tier(4.0).0, "TIER 1: ENTRY");
        assert_eq!(classify_tier(12.0).0, "TIER 2: PRO");
        assert_eq!(classify_tier(24.0).0, "TIER 3: ULTRA");
    }

    #[test]
    fn apple_32gb_unified_reaches_tier_3() {
        let effective = effective_memory_gb(&gpu("Apple M3 Max", 32.0, true), 32.0);
        assert!((effective - 22.4).abs() < 0.01);
        assert_eq!(classify_tier(effective).1, 3);
    }

    #[test]
    fn integrated_gpu_falls_back_to_system_ram() {
        // Mirrors the development machine: HD 630 with 8 GB RAM is Tier 1.
        let effective = effective_memory_gb(&gpu("Intel(R) HD Graphics 630", 1.0, false), 7.9);
        assert!((effective - 3.555).abs() < 0.01);
        assert_eq!(classify_tier(effective).1, 1);
    }

    #[test]
    fn integrated_gpu_with_large_reported_pool_is_not_trusted_as_vram() {
        let effective = effective_memory_gb(&gpu("Intel(R) UHD Graphics 770", 8.0, false), 16.0);
        assert!((effective - 7.2).abs() < 0.01);
    }

    #[test]
    fn amd_and_intel_integrated_names_are_recognized() {
        for name in ["AMD Radeon 780M Graphics", "AMD Radeon(TM) Graphics", "Radeon Vega 8 Graphics", "Intel(R) Arc(TM) Graphics", "Intel(R) UHD Graphics 770"] {
            assert!(is_integrated_gpu(name), "{name} is integrated");
        }
        for name in ["AMD Radeon RX 6600", "NVIDIA GeForce RTX 4090", "Intel(R) Arc(TM) A770"] {
            assert!(!is_integrated_gpu(name), "{name} is discrete");
        }
    }

    #[test]
    fn windows_ignores_registry_entries_for_removed_gpus() {
        let text = "R|NVIDIA GeForce RTX 4090|25769803776\nR|Intel(R) HD Graphics 630|1073741824\nW|Intel(R) HD Graphics 630|1073741824\n";
        let parsed = parse_windows_adapters(text).unwrap();
        assert_eq!(parsed.name, "Intel(R) HD Graphics 630");
    }

    #[test]
    fn discrete_vram_decides_the_tier() {
        let effective = effective_memory_gb(&gpu("NVIDIA GeForce RTX 4090", 24.0, false), 16.0);
        assert_eq!(effective, 24.0);
        assert_eq!(classify_tier(effective).1, 3);
    }

    #[test]
    fn nvidia_smi_parses_units_and_picks_largest_gpu() {
        let text = "NVIDIA GeForce GTX 1650, 4096 MiB, 3000 MiB\nNVIDIA GeForce RTX 4090, 24564 MiB, 20000 MiB\n";
        let parsed = parse_nvidia_smi(text).unwrap();
        assert_eq!(parsed.name, "NVIDIA GeForce RTX 4090");
        assert!((parsed.vram_gb - 23.99).abs() < 0.01);
        assert!((parsed.free_vram_gb.unwrap() - 19.53).abs() < 0.01);
    }

    #[test]
    fn nvidia_smi_parses_nounits_two_column_output() {
        let parsed = parse_nvidia_smi("Quadro RTX 5000, 16384\n").unwrap();
        assert_eq!(parsed.vram_gb, 16.0);
        assert_eq!(parsed.free_vram_gb, None);
    }

    #[test]
    fn nvidia_smi_rejects_garbage() {
        assert_eq!(parse_nvidia_smi(""), None);
        assert_eq!(parse_nvidia_smi("command failed"), None);
    }

    #[test]
    fn windows_registry_value_beats_the_4gb_wmi_cap() {
        let text = "R|NVIDIA GeForce RTX 3080|10737418240\nW|NVIDIA GeForce RTX 3080|4293918720\n";
        let parsed = parse_windows_adapters(text).unwrap();
        assert_eq!(parsed.name, "NVIDIA GeForce RTX 3080");
        assert_eq!(parsed.vram_gb, 10.0);
    }

    #[test]
    fn windows_missing_registry_value_uses_wmi() {
        let text = "R|Intel(R) HD Graphics 630|\nW|Intel(R) HD Graphics 630|1073741824\n";
        let parsed = parse_windows_adapters(text).unwrap();
        assert_eq!(parsed.vram_gb, 1.0);
    }

    #[test]
    fn windows_prefers_discrete_and_ignores_virtual_adapters() {
        let text = "W|Microsoft Basic Display Adapter|0\nR|Intel(R) UHD Graphics 770|8589934592\nR|AMD Radeon RX 6600|8000000000\nW|Microsoft Remote Display Adapter|0\n";
        let parsed = parse_windows_adapters(text).unwrap();
        assert_eq!(parsed.name, "AMD Radeon RX 6600");
    }

    #[test]
    fn dxdiag_reads_card_and_dedicated_memory() {
        let text = "  Card name: AMD Radeon RX 580\n  Display Memory: 16000 MB\n  Dedicated Memory: 8192 MB\n  Card name: Other\n";
        let parsed = parse_dxdiag(text).unwrap();
        assert_eq!(parsed.name, "AMD Radeon RX 580");
        assert_eq!(parsed.vram_gb, 8.0);
    }

    #[test]
    fn sysctl_memsize_converts_bytes() {
        assert_eq!(parse_sysctl_memsize("34359738368\n"), Some(32.0));
        assert_eq!(parse_sysctl_memsize("oops"), None);
    }

    #[test]
    fn system_profiler_detects_apple_silicon_unified_memory() {
        let text = "Graphics/Displays:\n\n    Apple M2 Pro:\n\n      Chipset Model: Apple M2 Pro\n      Type: GPU\n      Total Number of Cores: 19\n";
        let parsed = parse_system_profiler(text, 32.0).unwrap();
        assert!(parsed.is_unified);
        assert_eq!(parsed.vram_gb, 32.0);
    }

    #[test]
    fn system_profiler_reads_intel_mac_discrete_vram() {
        let text = "      Chipset Model: Intel UHD Graphics 630\n      VRAM (Dynamic, Max): 1536 MB\n      Chipset Model: AMD Radeon Pro 5500M\n      VRAM (Total): 8 GB\n";
        let parsed = parse_system_profiler(text, 16.0).unwrap();
        assert_eq!(parsed.name, "AMD Radeon Pro 5500M");
        assert_eq!(parsed.vram_gb, 8.0);
        assert!(!parsed.is_unified);
    }

    #[test]
    fn catalog_covers_every_tier_with_vision_and_text() {
        for tier in 1..=3u8 {
            let recs = build_recommendations(tier);
            let picks: Vec<_> = recs.iter().filter(|r| r.recommended).collect();
            assert!(picks.iter().any(|r| r.role == "vision"), "tier {tier} vision");
            assert!(picks.iter().any(|r| r.role == "text"), "tier {tier} text");
        }
    }

    #[test]
    fn catalog_lists_every_plan_model() {
        let ids: Vec<String> = build_recommendations(1).into_iter().map(|r| r.id).collect();
        for expected in [
            "moondream:1.8b", "llama3.2:3b", "qwen2.5:3b", "minicpm-v:8b", "llava:7b", "llama3.1:8b",
            "qwen2.5:7b", "llama3.2-vision:11b", "qwen2.5vl:7b", "qwen2.5:14b", "deepseek-r1:14b",
        ] {
            assert!(ids.iter().any(|id| id == expected), "missing {expected}");
        }
    }
}
