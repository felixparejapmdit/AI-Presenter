import { normalizeLayout } from '../deck';
import { classifyTier, recommendationsForTier } from '../modelCatalog';
import { SLIDE_SCHEMA, VISION_SYSTEM_PROMPT, scriptSystemPrompt, visionUserPrompt } from '../prompts';
import type { AiSlide, HardwareProfile, ImageAsset, LocalModel, OllamaStatus, Project, PullProgress, StreamChunk } from '../../types/deck';
import type { Bridge, SettingsMap } from './types';

const DB_NAME = 'vanguard-deck';
const STORES = { projects: 'projects', settings: 'settings', assets: 'assets' } as const;
const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
const MAX_SCRIPT_CHARS = 65_000;
const SCRIPT_TOO_LONG = 'This script is too long for the model to finish. Split it into smaller sections and generate them one at a time.';
const ACCEPTED_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp']);

function endpoint(): string {
  return (localStorage.getItem('vanguard.ollamaUrl') ?? 'http://127.0.0.1:11434').replace(/\/$/, '');
}

// --- IndexedDB -------------------------------------------------------------

let databasePromise: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
  if (!databasePromise) {
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        for (const store of Object.values(STORES)) {
          if (!db.objectStoreNames.contains(store)) db.createObjectStore(store);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('Could not open storage'));
    });
  }
  return databasePromise;
}

async function withStore<T>(store: string, mode: IDBTransactionMode, run: (objectStore: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(store, mode);
    const request = run(transaction.objectStore(store));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onerror = () => reject(transaction.error ?? new Error('Storage error'));
    transaction.onabort = () => reject(transaction.error ?? new Error('Storage aborted'));
  });
}

function requestEntries<T>(store: string): Promise<{ keys: IDBValidKey[]; values: T[] }> {
  return openDatabase().then(
    (db) =>
      new Promise((resolve, reject) => {
        const objectStore = db.transaction(store, 'readonly').objectStore(store);
        const keys = objectStore.getAllKeys();
        const values = objectStore.getAll();
        values.onsuccess = () => resolve({ keys: keys.result, values: values.result as T[] });
        values.onerror = () => reject(values.error ?? new Error('Storage error'));
      }),
  );
}

// --- Streaming -------------------------------------------------------------

async function readNdjson(response: Response, onLine: (line: Record<string, unknown>) => void): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buffered = '';
  const emit = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      parsed = null;
    }
    if (parsed) onLine(parsed);
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    let newline = buffered.indexOf('\n');
    while (newline >= 0) {
      emit(buffered.slice(0, newline));
      buffered = buffered.slice(newline + 1);
      newline = buffered.indexOf('\n');
    }
  }
  emit(buffered);
}

async function apiError(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  try {
    const parsed = JSON.parse(text) as { error?: string };
    if (parsed.error) return parsed.error;
  } catch {
    // Not JSON, so the raw body is used below.
  }
  return text.trim() || `Ollama returned HTTP ${response.status}.`;
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

// --- Tolerant slide parsing, mirroring parse_slides in ollama.rs -------------

function extractJson(raw: string): string | null {
  const text = raw.replace(/<think>[\s\S]*?<\/think>/g, '');
  const first = text.search(/[{[]/);
  const last = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
  return first >= 0 && last > first ? text.slice(first, last + 1) : null;
}

export function parseSlides(raw: string): AiSlide[] {
  const jsonText = extractJson(raw);
  if (!jsonText) throw new Error('The model did not return JSON.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error('The model returned invalid JSON.');
  }

  let items: unknown[];
  if (Array.isArray(parsed)) items = parsed;
  else if (parsed && typeof parsed === 'object') {
    const object = parsed as Record<string, unknown>;
    if (Array.isArray(object.slides)) items = object.slides;
    else if (object.refinedTitle || object.refined_title) items = [object];
    else throw new Error('The JSON did not contain any slides.');
  } else throw new Error('The JSON did not contain any slides.');

  const slides = items
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .map((item, index) => {
      const text = (...keys: string[]) => {
        for (const key of keys) {
          const value = item[key];
          if (typeof value === 'string') return value;
        }
        return '';
      };
      const rawSummary = item.executiveSummary ?? item.executive_summary;
      const summary = Array.isArray(rawSummary)
        ? rawSummary.filter((point): point is string => typeof point === 'string')
        : typeof rawSummary === 'string'
          ? rawSummary.split('\n')
          : [];
      const rawZones = Array.isArray(item.dropzones) ? item.dropzones : [];
      const layoutType = normalizeLayout(text('layoutType', 'layout_type', 'layout'));
      const title = text('refinedTitle', 'refined_title', 'title') || `Slide ${index + 1}`;
      return {
        slideNumber: index + 1,
        originalExcerpt: text('originalExcerpt', 'original_excerpt', 'excerpt'),
        refinedTitle: title,
        executiveSummary: summary.map((point) => point.replace(/^\s*(?:[-*]\s+|•\s*)/, '').replace(/\*\*/g, '').trim()).filter(Boolean).slice(0, 3),
        speakerNotes: text('speakerNotes', 'speaker_notes', 'notes'),
        layoutType,
        dropzones: rawZones
          .map((zone) => (typeof zone === 'string' ? zone : ((zone as { aiVisualPrompt?: string } | null)?.aiVisualPrompt ?? '')))
          .filter(Boolean)
          .map((aiVisualPrompt) => ({ aiVisualPrompt })),
      };
    });

  if (slides.length === 0) throw new Error('The model returned an empty deck.');
  return slides;
}

// --- Vision image preparation, mirroring prepare_vision_images ---------------

async function base64ToBitmap(base64: string): Promise<ImageBitmap> {
  const payload = base64.includes(',') ? base64.split(',')[1]! : base64;
  const binary = atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return createImageBitmap(new Blob([bytes]));
}

function canvasToBase64(canvas: HTMLCanvasElement): string {
  return canvas.toDataURL('image/jpeg', 0.85).split(',')[1] ?? '';
}

function drawFrom(bitmap: ImageBitmap, sx: number, sy: number, sw: number, sh: number, maxEdge: number): HTMLCanvasElement {
  const scale = Math.min(1, maxEdge / Math.max(sw, sh));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(sw * scale));
  canvas.height = Math.max(1, Math.round(sh * scale));
  canvas.getContext('2d')?.drawImage(bitmap, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  return canvas;
}

async function prepareVisionImages(base64: string, pinX: number, pinY: number) {
  const bitmap = await base64ToBitmap(base64);
  const { width, height } = bitmap;
  const cropW = Math.min(width, Math.max(128, Math.floor(width * 0.36)));
  const cropH = Math.min(height, Math.max(128, Math.floor(height * 0.36)));
  const left = Math.min(width - cropW, Math.max(0, Math.floor((pinX / 100) * width - cropW / 2)));
  const top = Math.min(height - cropH, Math.max(0, Math.floor((pinY / 100) * height - cropH / 2)));

  const crop = drawFrom(bitmap, left, top, cropW, cropH, 768);
  const full = drawFrom(bitmap, 0, 0, width, height, 1024);
  const context = full.getContext('2d');
  if (context) {
    context.strokeStyle = '#2383E2';
    context.lineWidth = Math.max(2, full.width / 160);
    context.beginPath();
    context.arc((pinX / 100) * full.width, (pinY / 100) * full.height, Math.max(6, Math.min(22, full.width / 40)), 0, Math.PI * 2);
    context.stroke();
  }

  const composite = document.createElement('canvas');
  composite.width = crop.width + full.width + 8;
  composite.height = Math.max(crop.height, full.height);
  const compositeContext = composite.getContext('2d');
  if (compositeContext) {
    compositeContext.fillStyle = '#ffffff';
    compositeContext.fillRect(0, 0, composite.width, composite.height);
    compositeContext.drawImage(crop, 0, 0);
    compositeContext.drawImage(full, crop.width + 8, 0);
  }
  bitmap.close();
  return { crop: canvasToBase64(crop), full: canvasToBase64(full), composite: canvasToBase64(composite) };
}

function cleanVisionText(raw: string): string {
  const cleaned = raw
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/[*`#]/g, '')
    .trim()
    .replace(/^"|"$/g, '')
    .trim();
  if (cleaned.length <= 320) return cleaned;
  const clipped = cleaned.slice(0, 320);
  const end = Math.max(clipped.lastIndexOf('.'), clipped.lastIndexOf('!'), clipped.lastIndexOf('?'));
  return end > 60 ? clipped.slice(0, end + 1) : `${clipped.trimEnd()}...`;
}

function webGlRenderer(): string {
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    const info = gl?.getExtension('WEBGL_debug_renderer_info');
    if (gl && info) return String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL));
  } catch {
    // Falls through to the generic name.
  }
  return 'Browser Accelerated Graphics';
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

// --- Bridge ----------------------------------------------------------------

export function createWebBridge(): Bridge {
  const pullListeners = new Set<(progress: PullProgress) => void>();
  const streamListeners = new Set<(chunk: StreamChunk) => void>();
  const pullControllers = new Map<string, AbortController>();
  const chatControllers = new Map<string, AbortController>();
  const objectUrls = new Map<string, string>();

  const assetKey = (projectId: string, storedName: string) => `${projectId}/${storedName}`;
  const emitPull = (progress: PullProgress) => pullListeners.forEach((listener) => listener(progress));
  const emitChunk = (chunk: StreamChunk) => streamListeners.forEach((listener) => listener(chunk));

  async function streamChat(requestId: string, body: unknown, signal: AbortSignal, rejectTruncated = false): Promise<string> {
    let response: Response;
    try {
      response = await fetch(`${endpoint()}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if (isAbort(error)) throw error;
      throw new Error('Ollama is not reachable. Start it, then try again.');
    }
    if (!response.ok) throw new Error(await apiError(response));

    let full = '';
    let failure: string | null = null;
    await readNdjson(response, (line) => {
      if (typeof line.error === 'string') failure = line.error;
      if (rejectTruncated && line.done_reason === 'length') failure = SCRIPT_TOO_LONG;
      const content = (line.message as { content?: string } | undefined)?.content;
      if (content) {
        full += content;
        emitChunk({ requestId, delta: content, done: false });
      }
    });
    if (failure) throw new Error(failure);
    emitChunk({ requestId, delta: '', done: true });
    return full;
  }

  function scriptRequest(model: string, script: string, persona: string, tone: string, format: unknown) {
    return {
      model,
      stream: true,
      think: false,
      format,
      options: { temperature: 0.3, num_ctx: Math.min(32768, Math.max(4096, Math.floor(script.length / 4) * 4 + 2048)) },
      messages: [
        { role: 'system', content: scriptSystemPrompt(persona, tone) },
        { role: 'user', content: `Raw script:\n\n${script}` },
      ],
    };
  }

  async function storeBlob(projectId: string, blob: Blob, fileName: string): Promise<ImageAsset> {
    if (blob.size === 0) throw new Error('The image is empty.');
    if (blob.size > MAX_IMAGE_BYTES) throw new Error('The image is larger than the 64 MB limit.');
    const mime = blob.type || 'image/png';
    if (!ACCEPTED_TYPES.has(mime)) throw new Error('Use a PNG, JPEG, WebP, GIF or BMP image.');

    let width = 0;
    let height = 0;
    try {
      const bitmap = await createImageBitmap(blob);
      width = bitmap.width;
      height = bitmap.height;
      bitmap.close();
    } catch {
      throw new Error('This image file appears to be corrupted.');
    }

    const hash = await sha256Hex(await blob.arrayBuffer());
    const storedName = `${hash}.${mime.split('/')[1]}`;
    const key = assetKey(projectId, storedName);
    await withStore(STORES.assets, 'readwrite', (store) => store.put(blob, key));
    if (!objectUrls.has(key)) objectUrls.set(key, URL.createObjectURL(blob));
    return { id: hash, fileName, storedName, mime, width, height, byteSize: blob.size, path: '' };
  }

  return {
    kind: 'web',
    canLaunchOllama: false,

    async getHardwareSpecs(): Promise<HardwareProfile> {
      const override = JSON.parse(localStorage.getItem('vanguard.hardwareOverride') ?? 'null') as {
        vramGb?: number;
        ramGb?: number;
        gpuName?: string;
        unified?: boolean;
      } | null;
      const nav = navigator as Navigator & { deviceMemory?: number };
      const totalRamGb = override?.ramGb ?? nav.deviceMemory ?? 8;
      const vramGb = override?.vramGb ?? 0;
      const unified = override?.unified ?? false;
      const effectiveMemoryGb = unified ? totalRamGb * 0.7 : vramGb >= 2 ? vramGb : totalRamGb * 0.45;
      const { tier, tierLevel } = classifyTier(effectiveMemoryGb);
      return {
        osName: 'browser',
        osVersion: navigator.userAgent.includes('Windows') ? 'Windows' : '',
        cpuArch: '',
        cpuBrand: `${navigator.hardwareConcurrency ?? 0} logical processors`,
        cpuCores: navigator.hardwareConcurrency ?? 0,
        totalRamGb,
        availableRamGb: totalRamGb,
        gpuName: override?.gpuName ?? webGlRenderer(),
        vramGb,
        availableVramGb: vramGb,
        effectiveMemoryGb: Math.round(effectiveMemoryGb * 10) / 10,
        isUnifiedMemory: unified,
        tier,
        tierLevel,
        detectionSource: 'browser',
        recommendations: recommendationsForTier(tierLevel),
      };
    },

    async checkOllamaStatus(): Promise<OllamaStatus> {
      const base = endpoint();
      try {
        const response = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(4000) });
        if (!response.ok) throw new Error('offline');
        const body = (await response.json()) as { models?: unknown[] };
        let version: string | null = null;
        try {
          const versionResponse = await fetch(`${base}/api/version`, { signal: AbortSignal.timeout(2000) });
          version = ((await versionResponse.json()) as { version?: string }).version ?? null;
        } catch {
          version = null;
        }
        return { online: true, installed: true, version, endpoint: base, modelCount: body.models?.length ?? 0 };
      } catch {
        // A browser cannot detect an installed binary, so the banner offers the download.
        return { online: false, installed: false, version: null, endpoint: base, modelCount: 0 };
      }
    },

    async listLocalModels(): Promise<LocalModel[]> {
      const response = await fetch(`${endpoint()}/api/tags`, { signal: AbortSignal.timeout(8000) });
      const body = (await response.json()) as {
        models?: {
          name: string;
          size?: number;
          digest?: string;
          modified_at?: string;
          capabilities?: string[];
          details?: { family?: string; parameter_size?: string; quantization_level?: string };
        }[];
      };
      return (body.models ?? []).map((model) => {
        const capabilities = model.capabilities ?? [];
        return {
          name: model.name,
          size: model.size ?? 0,
          digest: model.digest ?? '',
          modifiedAt: model.modified_at ?? '',
          family: model.details?.family ?? '',
          parameterSize: model.details?.parameter_size ?? '',
          quantization: model.details?.quantization_level ?? '',
          capabilities,
          isVision: capabilities.length > 0 ? capabilities.includes('vision') : /llava|moondream|vision|minicpm-v|-vl|vl:/.test(model.name),
        };
      });
    },

    launchOllama: async () => {
      throw new Error('Run "ollama serve" in a terminal to start the daemon.');
    },

    openExternal: async (url) => {
      window.open(url, '_blank', 'noopener');
    },

    async pullModel(model) {
      const controller = new AbortController();
      pullControllers.set(model, controller);
      emitPull({ model, status: 'starting', completed: 0, total: 0, percent: 0, bytesPerSecond: 0, done: false, cancelled: false, error: null });

      const layers = new Map<string, { completed: number; total: number }>();
      const samples: { time: number; bytes: number }[] = [];
      let lastEmit = 0;
      let lastStatus = '';

      const snapshot = (status: string): PullProgress => {
        let completed = 0;
        let total = 0;
        layers.forEach((layer) => {
          completed += layer.completed;
          total += layer.total;
        });
        const now = performance.now();
        samples.push({ time: now, bytes: completed });
        while (samples.length > 1 && now - samples[0]!.time > 4000) samples.shift();
        const first = samples[0]!;
        const elapsed = (now - first.time) / 1000;
        return {
          model,
          status,
          completed,
          total,
          percent: total > 0 ? (completed / total) * 100 : 0,
          bytesPerSecond: elapsed >= 0.2 ? (completed - first.bytes) / elapsed : 0,
          done: false,
          cancelled: false,
          error: null,
        };
      };

      const finish = (patch: Partial<PullProgress>) =>
        emitPull({ model, status: '', completed: 0, total: 0, percent: 0, bytesPerSecond: 0, done: true, cancelled: false, error: null, ...patch });

      try {
        const response = await fetch(`${endpoint()}/api/pull`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, name: model, stream: true }),
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(await apiError(response));

        await readNdjson(response, (line) => {
          if (typeof line.error === 'string') {
            throw new Error(line.error.includes('file does not exist') ? 'This model tag does not exist in the Ollama library.' : line.error);
          }
          const status = typeof line.status === 'string' ? line.status : '';
          if (typeof line.digest === 'string') {
            const layer = layers.get(line.digest) ?? { completed: 0, total: 0 };
            layer.completed = Math.max(layer.completed, Number(line.completed ?? 0));
            layer.total = Math.max(layer.total, Number(line.total ?? 0));
            layers.set(line.digest, layer);
          }
          const now = performance.now();
          if (status !== lastStatus || now - lastEmit >= 100) {
            lastStatus = status || lastStatus;
            lastEmit = now;
            emitPull(snapshot(lastStatus));
          }
        });
        finish({ status: 'success', percent: 100 });
      } catch (error) {
        if (isAbort(error)) {
          finish({ status: 'cancelled', cancelled: true });
          return;
        }
        const message = error instanceof TypeError ? 'Ollama is not reachable.' : (error as Error).message;
        finish({ status: 'error', error: message });
        throw new Error(message);
      } finally {
        pullControllers.delete(model);
      }
    },

    cancelPull: async (model) => {
      pullControllers.get(model)?.abort();
    },

    onPullProgress: async (listener) => {
      pullListeners.add(listener);
      return () => pullListeners.delete(listener);
    },

    async analyzeScript({ model, script, persona, tone, requestId }) {
      if (script.length > MAX_SCRIPT_CHARS) throw new Error(SCRIPT_TOO_LONG);
      const controller = new AbortController();
      chatControllers.set(requestId, controller);
      try {
        const raw = await streamChat(requestId, scriptRequest(model, script, persona, tone, SLIDE_SCHEMA), controller.signal, true);
        try {
          return parseSlides(raw);
        } catch (firstError) {
          const retry = scriptRequest(model, script, persona, tone, 'json');
          retry.options.temperature = 0.1;
          retry.messages.push({ role: 'user', content: 'Your previous reply could not be parsed. Reply again with only the JSON object described above.' });
          const rawRetry = await streamChat(requestId, retry, controller.signal, true);
          try {
            return parseSlides(rawRetry);
          } catch {
            throw new Error(`The model did not produce a usable deck (${(firstError as Error).message}). Try again or choose a different text model.`);
          }
        }
      } catch (error) {
        if (isAbort(error)) return null;
        throw error;
      } finally {
        chatControllers.delete(requestId);
      }
    },

    async analyzePin({ visionModel, imageBase64, pinX, pinY, userHint, requestId }) {
      const controller = new AbortController();
      chatControllers.set(requestId, controller);
      const request = (prompt: string, images: string[]) => ({
        model: visionModel,
        stream: true,
        think: false,
        options: { temperature: 0.2, num_predict: 160 },
        messages: [
          { role: 'system', content: VISION_SYSTEM_PROMPT },
          { role: 'user', content: prompt, images },
        ],
      });
      try {
        const images = await prepareVisionImages(imageBase64, pinX, pinY);
        let raw: string;
        try {
          raw = await streamChat(requestId, request(visionUserPrompt(pinX, pinY, userHint, false), [images.crop, images.full]), controller.signal);
        } catch (error) {
          if (isAbort(error) || !/one image|single image|multiple images|more than one/i.test((error as Error).message)) throw error;
          raw = await streamChat(requestId, request(visionUserPrompt(pinX, pinY, userHint, true), [images.composite]), controller.signal);
        }
        const text = cleanVisionText(raw);
        if (!text) throw new Error('The vision model returned an empty description. Try again.');
        return text;
      } catch (error) {
        if (isAbort(error)) return null;
        throw error;
      } finally {
        chatControllers.delete(requestId);
      }
    },

    cancelAnalysis: async (requestId) => {
      chatControllers.get(requestId)?.abort();
    },

    onStreamChunk: async (listener) => {
      streamListeners.add(listener);
      return () => streamListeners.delete(listener);
    },

    async loadProjects() {
      const { values } = await requestEntries<Project>(STORES.projects);
      return values.sort((a, b) => a.createdAt - b.createdAt);
    },

    async saveProject(project) {
      await withStore(STORES.projects, 'readwrite', (store) => store.put(project, project.id));
    },

    async deleteProject(projectId) {
      await withStore(STORES.projects, 'readwrite', (store) => store.delete(projectId));
      const prefix = `${projectId}/`;
      await withStore(STORES.assets, 'readwrite', (store) => store.delete(IDBKeyRange.bound(prefix, `${prefix}\u{ffff}`)));
      objectUrls.forEach((url, key) => {
        if (key.startsWith(prefix)) {
          URL.revokeObjectURL(url);
          objectUrls.delete(key);
        }
      });
    },

    async loadSettings() {
      const { keys, values } = await requestEntries<string>(STORES.settings);
      const settings: SettingsMap = {};
      keys.forEach((key, index) => {
        settings[String(key)] = values[index] ?? '';
      });
      return settings;
    },

    async saveSetting(key, value) {
      await withStore(STORES.settings, 'readwrite', (store) => store.put(value, key));
    },

    saveImage: storeBlob,

    pickImage(projectId) {
      return new Promise((resolve, reject) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/png,image/jpeg,image/webp,image/gif,image/bmp';
        input.onchange = () => {
          const file = input.files?.[0];
          if (file) storeBlob(projectId, file, file.name).then(resolve, reject);
          else resolve(null);
        };
        input.oncancel = () => resolve(null);
        input.click();
      });
    },

    async prepareAssets(project) {
      const assets = project.slides.flatMap((slide) => slide.dropzones.flatMap((zone) => (zone.image ? [zone.image] : [])));
      await Promise.all(
        assets.map(async (asset) => {
          const key = assetKey(project.id, asset.storedName);
          if (objectUrls.has(key)) return;
          const blob = await withStore<Blob | undefined>(STORES.assets, 'readonly', (store) => store.get(key));
          if (blob) objectUrls.set(key, URL.createObjectURL(blob));
        }),
      );
    },

    assetUrl: (projectId, asset) => objectUrls.get(assetKey(projectId, asset.storedName)) ?? '',

    async assetBase64(projectId, asset) {
      const blob = await withStore<Blob | undefined>(STORES.assets, 'readonly', (store) => store.get(assetKey(projectId, asset.storedName)));
      if (!blob) throw new Error('The image could not be found.');
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
        reader.onerror = () => reject(reader.error ?? new Error('Read failed'));
        reader.readAsDataURL(blob);
      });
    },

    async readClipboardImage() {
      try {
        const items = await navigator.clipboard.read();
        for (const item of items) {
          const type = item.types.find((candidate) => candidate.startsWith('image/'));
          if (type) return await item.getType(type);
        }
      } catch {
        // Clipboard permission denied or unavailable.
      }
      return null;
    },

    async saveExport(fileName, bytes) {
      const blob = new Blob([bytes as BlobPart]);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = fileName;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      return fileName;
    },

    async setFullscreen(enabled) {
      try {
        if (enabled && !document.fullscreenElement) await document.documentElement.requestFullscreen();
        if (!enabled && document.fullscreenElement) await document.exitFullscreen();
      } catch {
        // Browsers can refuse fullscreen. The presenter still fills the window.
      }
    },

    setWindowColor: async () => undefined,
    showWindow: async () => undefined,
    onCloseRequested: async () => () => undefined,
  };
}
