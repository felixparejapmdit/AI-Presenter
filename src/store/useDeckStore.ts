import { create } from 'zustand';
import { bridge } from '../lib/bridge';
import type { SettingsMap, Unsubscribe } from '../lib/bridge/types';
import { blankSlide, createProject, fitDropzones, renumberPins, renumberSlides, slidesFromAi, slidesFromOutline } from '../lib/deck';
import { clampAnchorPercent, placeCallout } from '../lib/leader';
import { createId, frameThrottle, stripEmoji, waitForIdle } from '../lib/utils';
import { toast, useToastStore } from './useToastStore';
import type {
  AudiencePersona,
  Dropzone,
  HardwareProfile,
  ImageAsset,
  LayoutType,
  LeaderStyle,
  LocalModel,
  OllamaStatus,
  PinAnnotation,
  Project,
  PullProgress,
  Slide,
  ThemeMode,
  Tone,
} from '../types/deck';

const SAVE_DEBOUNCE_MS = 500;
const SAVE_RETRY_MS = 4000;
const CLOSE_FLUSH_LIMIT_MS = 3000;
const POLL_INTERVAL_MS = 5000;
const HISTORY_LIMIT = 100;
const COALESCE_WINDOW_MS = 1200;

export type SaveState = 'saved' | 'pending' | 'saving' | 'error';
export type MobilePane = 'script' | 'slides';
export type PinJobOutcome = 'done' | 'cancelled' | 'failed' | 'skipped';

export interface PullState extends PullProgress {
  startedAt: number;
}

export interface AnalysisState {
  running: boolean;
  requestId: string | null;
  live: string;
  error: string | null;
  source: 'ai' | 'outline' | null;
}

export interface ExportJob {
  format: 'pdf' | 'pptx';
  current: number;
  total: number;
}

export interface UpdateCheck {
  running: boolean;
  current: string | null;
  done: number;
  total: number;
}

interface DeckState {
  ready: boolean;
  projects: Project[];
  activeProjectId: string | null;
  saveState: SaveState;
  past: Project[];
  future: Project[];

  theme: ThemeMode;
  leaderStyle: LeaderStyle;
  sidebarCollapsed: boolean;
  splitPercent: number;
  mobilePane: MobilePane;

  hardware: HardwareProfile | null;
  ollama: OllamaStatus | null;
  models: LocalModel[];
  activeTextModel: string | null;
  activeVisionModel: string | null;
  pulls: Record<string, PullState>;
  updateCheck: UpdateCheck;
  launching: boolean;

  analysis: AnalysisState;
  pinJobs: Record<string, { requestId: string; live: string }>;
  importingZones: Record<string, true>;

  modelManagerOpen: boolean;
  presenterOpen: boolean;
  presenterIndex: number;
  focusZone: { slideId: string; zoneId: string } | null;
  scrollTarget: { slideId: string; nonce: number } | null;
  exportJob: ExportJob | null;

  bootstrap: () => Promise<void>;
  flushSaves: () => Promise<void>;

  createProject: (name?: string) => void;
  renameProject: (id: string, name: string) => void;
  deleteProject: (id: string) => Promise<void>;
  setActiveProject: (id: string) => void;
  undo: () => void;
  redo: () => void;

  setScript: (script: string) => void;
  setPersona: (persona: AudiencePersona) => void;
  setTone: (tone: Tone) => void;
  analyzeScript: () => Promise<void>;
  cancelAnalysis: () => Promise<void>;
  buildFromOutline: () => void;

  addSlide: (afterId?: string) => void;
  deleteSlide: (id: string) => void;
  moveSlide: (id: string, direction: -1 | 1) => void;
  updateSlide: (id: string, patch: Partial<Pick<Slide, 'refinedTitle' | 'speakerNotes' | 'executiveSummary'>>) => void;
  setLayout: (id: string, layout: LayoutType) => void;
  requestScrollTo: (slideId: string) => void;

  ingestImage: (slideId: string, zoneId: string, blob: Blob, fileName: string, projectId?: string) => Promise<void>;
  ingestFiles: (slideId: string, zoneId: string, files: File[]) => Promise<void>;
  pickImage: (slideId: string, zoneId: string) => Promise<void>;
  removeImage: (slideId: string, zoneId: string) => void;
  updateZonePrompt: (slideId: string, zoneId: string, prompt: string) => void;

  addPin: (slideId: string, zoneId: string, x: number, y: number) => string;
  commitPinPosition: (slideId: string, zoneId: string, pinId: string, patch: Partial<Pick<PinAnnotation, 'anchorXPercent' | 'anchorYPercent' | 'calloutXPercent' | 'calloutYPercent'>>) => void;
  updatePinText: (slideId: string, zoneId: string, pinId: string, patch: Partial<Pick<PinAnnotation, 'title' | 'description'>>) => void;
  deletePin: (slideId: string, zoneId: string, pinId: string) => void;
  resetPins: (slideId: string, zoneId: string) => void;
  describePin: (slideId: string, zoneId: string, pinId: string, projectId?: string) => Promise<PinJobOutcome>;
  inspectImage: (slideId: string, zoneId: string) => Promise<void>;
  cancelPinJob: (pinId: string) => Promise<void>;

  setTheme: (theme: ThemeMode) => void;
  setLeaderStyle: (style: LeaderStyle) => void;
  toggleSidebar: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setSplitPercent: (percent: number) => void;
  setMobilePane: (pane: MobilePane) => void;

  refreshStatus: () => Promise<void>;
  refreshModels: () => Promise<void>;
  refreshHardware: () => Promise<void>;
  launchOllama: () => Promise<void>;
  setActiveTextModel: (model: string) => void;
  setActiveVisionModel: (model: string) => void;
  pullModel: (model: string) => Promise<void>;
  cancelPull: (model: string) => Promise<void>;
  checkForUpdates: () => Promise<void>;

  setModelManagerOpen: (open: boolean) => void;
  openPresenter: (index?: number) => void;
  closePresenter: () => void;
  setPresenterIndex: (index: number) => void;
  setFocusZone: (zone: { slideId: string; zoneId: string } | null) => void;
  exportDeck: (format: 'pdf' | 'pptx') => Promise<void>;
}

export function resolvedTheme(theme: ThemeMode): 'light' | 'dark' {
  if (theme === 'system') return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  return theme;
}

function applyTheme(theme: ThemeMode) {
  const value = resolvedTheme(theme);
  document.documentElement.setAttribute('data-theme', value);
  try {
    localStorage.setItem('vanguard.theme', theme);
  } catch {
    // Storage may be unavailable. The theme still applies for this session.
  }
  void bridge.setWindowColor(value === 'dark' ? '#191919' : '#FFFFFF').catch(() => undefined);
}

let settingsQueue: Promise<unknown> = Promise.resolve();

/**
 * Writes run one at a time, in order. Concurrent IPC calls can reach SQLite out of order, so
 * toggling something twice in quick succession could otherwise save the older value.
 */
function persistSetting(key: string, value: string) {
  settingsQueue = settingsQueue.then(() => bridge.saveSetting(key, value)).catch(() => undefined);
}

/**
 * Ollama reveals each layer's size only when that layer starts, so its running total grows
 * mid-download. Using the size already known from the catalog or the installed copy keeps
 * the bar accurate from the first byte.
 */
function expectedPullBytes(state: DeckState, model: string): number {
  const catalog = state.hardware?.recommendations.find((entry) => entry.id === model);
  if (catalog) return catalog.sizeGb * 1e9;
  return state.models.find((entry) => entry.name === model)?.size ?? 0;
}

function pickDefaultModel(models: LocalModel[], hardware: HardwareProfile | null, role: 'text' | 'vision'): string | null {
  const candidates = role === 'vision' ? models.filter((model) => model.isVision) : models;
  if (candidates.length === 0) return null;
  const recommended = hardware?.recommendations.filter((entry) => entry.role === role && entry.recommended) ?? [];
  for (const entry of recommended) {
    if (candidates.some((model) => model.name === entry.id)) return entry.id;
  }
  const preferred = role === 'text' ? candidates.filter((model) => !model.isVision) : candidates;
  const pool = preferred.length > 0 ? preferred : candidates;
  return [...pool].sort((a, b) => a.size - b.size)[0]!.name;
}

// --- Autosave ---------------------------------------------------------------

const dirtyProjects = new Set<string>();
let saveTimer: number | null = null;
let saveInFlight: Promise<void> | null = null;
let saveFailing = false;

function scheduleSave(projectId: string) {
  dirtyProjects.add(projectId);
  if (useDeckStore.getState().saveState !== 'pending') useDeckStore.setState({ saveState: 'pending' });
  if (saveTimer !== null) window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveTimer = null;
    // Serialization waits for idle time, so it never competes with typing or dragging.
    void waitForIdle().then(runSave);
  }, SAVE_DEBOUNCE_MS);
}

async function runSave(): Promise<void> {
  if (saveInFlight) {
    await saveInFlight;
    if (dirtyProjects.size === 0) return;
  }
  const ids = [...dirtyProjects];
  dirtyProjects.clear();
  if (ids.length === 0) return;

  useDeckStore.setState({ saveState: 'saving' });
  saveInFlight = (async () => {
    try {
      for (const id of ids) {
        // Read fresh for each project, so one deleted mid-save is not written back.
        const project = useDeckStore.getState().projects.find((candidate) => candidate.id === id);
        if (project) await bridge.saveProject(project);
      }
      saveFailing = false;
      useDeckStore.setState({ saveState: dirtyProjects.size > 0 ? 'pending' : 'saved' });
    } catch (error) {
      const remaining = useDeckStore.getState().projects;
      ids.filter((id) => remaining.some((project) => project.id === id)).forEach((id) => dirtyProjects.add(id));
      useDeckStore.setState({ saveState: 'error' });
      // One message per outage. Retries continue quietly until a save succeeds.
      if (!saveFailing) toast.error(`Could not save your work. Retrying automatically. ${errorMessage(error)}`);
      saveFailing = true;
      if (saveTimer === null) {
        saveTimer = window.setTimeout(() => {
          saveTimer = null;
          void runSave();
        }, SAVE_RETRY_MS);
      }
    } finally {
      saveInFlight = null;
    }
  })();
  await saveInFlight;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Unexpected error';
}

// --- History ----------------------------------------------------------------

let lastCoalesceKey: string | null = null;
let lastCoalesceAt = 0;

interface MutateOptions {
  /** Whether this change can be undone. A key merges rapid edits into one undo step. */
  history?: boolean | string;
}

function mutateProject(projectId: string | null, recipe: (project: Project) => Project, options: MutateOptions = {}) {
  const state = useDeckStore.getState();
  const current = state.projects.find((project) => project.id === projectId);
  if (!current) return;
  const next = recipe(current);
  if (next === current) return;
  const stamped = { ...next, updatedAt: Date.now() };

  let { past, future } = state;
  // History belongs to the project on screen. Background work applies without an entry.
  if (options.history && projectId === state.activeProjectId) {
    const key = typeof options.history === 'string' ? options.history : null;
    const now = Date.now();
    const merge = key !== null && key === lastCoalesceKey && now - lastCoalesceAt < COALESCE_WINDOW_MS;
    if (!merge) {
      past = [...past.slice(-(HISTORY_LIMIT - 1)), current];
      useToastStore.getState().dismissUndoable();
    }
    future = [];
    lastCoalesceKey = key;
    lastCoalesceAt = now;
  }

  useDeckStore.setState({
    projects: state.projects.map((project) => (project.id === stamped.id ? stamped : project)),
    past,
    future,
  });
  scheduleSave(stamped.id);
}

function mutateActive(recipe: (project: Project) => Project, options: MutateOptions = {}) {
  mutateProject(useDeckStore.getState().activeProjectId, recipe, options);
}

function mapSlide(project: Project, slideId: string, recipe: (slide: Slide) => Slide): Project {
  let changed = false;
  const slides = project.slides.map((slide) => {
    if (slide.id !== slideId) return slide;
    const next = recipe(slide);
    if (next !== slide) changed = true;
    return next;
  });
  return changed ? { ...project, slides } : project;
}

function mapZone(project: Project, slideId: string, zoneId: string, recipe: (zone: Dropzone) => Dropzone): Project {
  return mapSlide(project, slideId, (slide) => {
    let changed = false;
    const dropzones = slide.dropzones.map((zone) => {
      if (zone.id !== zoneId) return zone;
      const next = recipe(zone);
      if (next !== zone) changed = true;
      return next;
    });
    return changed ? { ...slide, dropzones } : slide;
  });
}

function findZone(state: DeckState, slideId: string, zoneId: string, projectId: string | null = state.activeProjectId): { project: Project; slide: Slide; zone: Dropzone } | null {
  const project = state.projects.find((candidate) => candidate.id === projectId);
  const slide = project?.slides.find((candidate) => candidate.id === slideId);
  const zone = slide?.dropzones.find((candidate) => candidate.id === zoneId);
  return project && slide && zone ? { project, slide, zone } : null;
}

// --- Streaming --------------------------------------------------------------

const liveBuffers = new Map<string, string>();
const stopRequests = new Set<string>();

const flushLive = frameThrottle<void>(() => {
  const state = useDeckStore.getState();
  const patch: Partial<DeckState> = {};

  const { analysis } = state;
  if (analysis.requestId) {
    const live = liveBuffers.get(analysis.requestId);
    if (live !== undefined && live !== analysis.live) patch.analysis = { ...analysis, live };
  }

  let jobsChanged = false;
  const pinJobs = { ...state.pinJobs };
  for (const [pinId, job] of Object.entries(state.pinJobs)) {
    const live = liveBuffers.get(job.requestId);
    if (live !== undefined && live !== job.live) {
      pinJobs[pinId] = { ...job, live };
      jobsChanged = true;
    }
  }
  if (jobsChanged) patch.pinJobs = pinJobs;
  if (Object.keys(patch).length > 0) useDeckStore.setState(patch);
});

const autoPicked = { text: false, vision: false };
const pullOutcomes = new Map<string, 'ok' | 'failed' | 'cancelled'>();

let subscriptions: Unsubscribe[] = [];
let bootstrapPromise: Promise<void> | null = null;
let pollTimer: number | null = null;

// --- Store ------------------------------------------------------------------

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export const useDeckStore = create<DeckState>((set, get) => ({
  ready: false,
  projects: [],
  activeProjectId: null,
  saveState: 'saved',
  past: [],
  future: [],

  theme: 'system',
  leaderStyle: 'elbow',
  sidebarCollapsed: false,
  splitPercent: 38,
  mobilePane: 'script',

  hardware: null,
  ollama: null,
  models: [],
  activeTextModel: null,
  activeVisionModel: null,
  pulls: {},
  updateCheck: { running: false, current: null, done: 0, total: 0 },
  launching: false,

  analysis: { running: false, requestId: null, live: '', error: null, source: null },
  pinJobs: {},
  importingZones: {},

  modelManagerOpen: false,
  presenterOpen: false,
  presenterIndex: 0,
  focusZone: null,
  scrollTarget: null,
  exportJob: null,

  bootstrap() {
    // StrictMode mounts twice in development, so every caller shares one run.
    bootstrapPromise ??= runBootstrap();
    return bootstrapPromise;
  },

  async flushSaves() {
    if (saveTimer !== null) {
      window.clearTimeout(saveTimer);
      saveTimer = null;
    }
    await runSave();
    await settingsQueue;
  },

  createProject(name) {
    const project = createProject(name ?? 'Untitled deck');
    useToastStore.getState().dismissUndoable();
    set({
      projects: [...get().projects, project],
      activeProjectId: project.id,
      past: [],
      future: [],
      mobilePane: 'script',
    });
    persistSetting('activeProjectId', project.id);
    scheduleSave(project.id);
  },

  renameProject(id, name) {
    const trimmed = name.trim();
    if (!trimmed) return;
    set({
      projects: get().projects.map((project) => (project.id === id ? { ...project, name: trimmed, updatedAt: Date.now() } : project)),
    });
    scheduleSave(id);
  },

  async deleteProject(id) {
    const { projects, activeProjectId } = get();
    const remaining = projects.filter((project) => project.id !== id);
    if (remaining.length === 0) {
      const replacement = createProject('Untitled deck');
      remaining.push(replacement);
      scheduleSave(replacement.id);
    }
    const nextActive = activeProjectId === id ? remaining[remaining.length - 1]!.id : activeProjectId;
    dirtyProjects.delete(id);
    set({ projects: remaining, activeProjectId: nextActive, past: activeProjectId === id ? [] : get().past, future: activeProjectId === id ? [] : get().future });
    if (nextActive) persistSetting('activeProjectId', nextActive);
    useToastStore.getState().dismissUndoable();
    try {
      // A write already in progress must finish first, or it would restore the project.
      await saveInFlight;
      await bridge.deleteProject(id);
    } catch (error) {
      toast.error(`Could not remove the project files: ${errorMessage(error)}`);
    }
  },

  setActiveProject(id) {
    if (get().activeProjectId === id) return;
    useToastStore.getState().dismissUndoable();
    set({ activeProjectId: id, past: [], future: [] });
    persistSetting('activeProjectId', id);
  },

  undo() {
    const { past, future, projects, activeProjectId } = get();
    const previous = past[past.length - 1];
    const current = projects.find((project) => project.id === activeProjectId);
    if (!previous || !current) return;
    lastCoalesceKey = null;
    useToastStore.getState().dismissUndoable();
    // History covers the deck. Script, persona, tone and name are never rolled back.
    set({
      past: past.slice(0, -1),
      future: [current, ...future].slice(0, HISTORY_LIMIT),
      projects: projects.map((project) => (project.id === current.id ? { ...project, slides: previous.slides, updatedAt: Date.now() } : project)),
    });
    scheduleSave(current.id);
  },

  redo() {
    const { past, future, projects, activeProjectId } = get();
    const next = future[0];
    const current = projects.find((project) => project.id === activeProjectId);
    if (!next || !current) return;
    lastCoalesceKey = null;
    useToastStore.getState().dismissUndoable();
    set({
      past: [...past, current],
      future: future.slice(1),
      projects: projects.map((project) => (project.id === current.id ? { ...project, slides: next.slides, updatedAt: Date.now() } : project)),
    });
    scheduleSave(current.id);
  },

  setScript(script) {
    mutateActive((project) => (project.script === script ? project : { ...project, script }));
  },

  setPersona(persona) {
    mutateActive((project) => ({ ...project, persona }));
  },

  setTone(tone) {
    mutateActive((project) => ({ ...project, tone }));
  },

  async analyzeScript() {
    const state = get();
    if (state.analysis.running) return;
    const project = state.projects.find((candidate) => candidate.id === state.activeProjectId);
    if (!project) return;

    if (!project.script.trim()) {
      set({ analysis: { ...state.analysis, error: 'Add a script before generating slides.' } });
      return;
    }
    if (!state.ollama?.online) {
      set({ analysis: { ...state.analysis, error: 'Ollama is offline. Start it, or use Build from outline to continue without AI.' } });
      return;
    }
    if (!state.activeTextModel) {
      set({ analysis: { ...state.analysis, error: 'Choose a text model first. Install one from Settings & AI Engine.' } });
      return;
    }

    const requestId = createId();
    liveBuffers.set(requestId, '');
    set({ analysis: { running: true, requestId, live: '', error: null, source: 'ai' }, mobilePane: 'script' });

    try {
      const result = await bridge.analyzeScript({
        model: state.activeTextModel,
        script: project.script,
        persona: project.persona,
        tone: project.tone,
        requestId,
      });
      flushLive.flush();
      if (result === null) {
        set({ analysis: { running: false, requestId: null, live: '', error: null, source: null } });
        toast.info('Analysis cancelled.');
        return;
      }
      const slides = slidesFromAi(result);
      const count = `${slides.length} slide${slides.length === 1 ? '' : 's'}`;
      const target = get().projects.find((candidate) => candidate.id === project.id);
      const done = { running: false, requestId: null, live: '', error: null, source: 'ai' as const };

      if (!target) {
        set({ analysis: { ...done, source: null } });
      } else if (get().activeProjectId === target.id) {
        const replaced = target.slides.length > 0;
        mutateActive((current) => ({ ...current, slides }), { history: true });
        set({ analysis: done, mobilePane: 'slides' });
        if (replaced) toast.undoable(`Generated ${count}. Your previous slides were replaced.`, () => get().undo());
        else toast.success(`Generated ${count}.`);
      } else if (target.slides.length === 0) {
        mutateProject(target.id, (current) => ({ ...current, slides }));
        set({ analysis: done });
        toast.success(`Generated ${count} for ${target.name}.`);
      } else {
        // Replacing slides in a project that is not on screen could destroy pin work
        // with no way to undo it, so the result becomes a new project instead.
        const draft: Project = { ...createProject(`${target.name} (new draft)`), script: target.script, persona: target.persona, tone: target.tone, slides };
        set({ projects: [...get().projects, draft], analysis: done });
        scheduleSave(draft.id);
        toast.success(`Analysis finished. Saved ${count} as "${draft.name}".`);
      }
    } catch (error) {
      set({ analysis: { running: false, requestId: null, live: '', error: errorMessage(error), source: null } });
    } finally {
      liveBuffers.delete(requestId);
    }
  },

  async cancelAnalysis() {
    const { analysis } = get();
    if (analysis.requestId) await bridge.cancelAnalysis(analysis.requestId);
  },

  buildFromOutline() {
    const project = get().projects.find((candidate) => candidate.id === get().activeProjectId);
    if (!project) return;
    if (!project.script.trim()) {
      set({ analysis: { ...get().analysis, error: 'Add a script before generating slides.' } });
      return;
    }
    const slides = slidesFromOutline(project.script);
    mutateActive((current) => ({ ...current, slides }), { history: true });
    set({ analysis: { running: false, requestId: null, live: '', error: null, source: 'outline' }, mobilePane: 'slides' });
    toast.success(`Built ${slides.length} slide${slides.length === 1 ? '' : 's'} from your outline.`);
  },

  addSlide(afterId) {
    mutateActive(
      (project) => {
        const slide = blankSlide();
        const index = afterId ? project.slides.findIndex((candidate) => candidate.id === afterId) : project.slides.length - 1;
        const slides = [...project.slides];
        slides.splice(index + 1, 0, slide);
        return { ...project, slides: renumberSlides(slides) };
      },
      { history: true },
    );
  },

  deleteSlide(id) {
    mutateActive((project) => ({ ...project, slides: renumberSlides(project.slides.filter((slide) => slide.id !== id)) }), { history: true });
    toast.undoable('Slide deleted.', () => get().undo());
  },

  moveSlide(id, direction) {
    mutateActive(
      (project) => {
        const index = project.slides.findIndex((slide) => slide.id === id);
        const target = index + direction;
        if (index < 0 || target < 0 || target >= project.slides.length) return project;
        const slides = [...project.slides];
        [slides[index], slides[target]] = [slides[target]!, slides[index]!];
        return { ...project, slides: renumberSlides(slides) };
      },
      { history: true },
    );
  },

  updateSlide(id, patch) {
    const field = Object.keys(patch)[0] ?? '';
    mutateActive((project) => mapSlide(project, id, (slide) => ({ ...slide, ...patch })), { history: `slide:${id}:${field}` });
  },

  setLayout(id, layout) {
    const before = get().projects.find((project) => project.id === get().activeProjectId)?.slides.find((slide) => slide.id === id);
    const lostImages = before ? before.dropzones.filter((zone) => zone.image).length - fitDropzones(before.dropzones, layout, '').filter((zone) => zone.image).length : 0;
    mutateActive(
      (project) =>
        mapSlide(project, id, (slide) => ({
          ...slide,
          layoutType: layout,
          dropzones: fitDropzones(slide.dropzones, layout, slide.refinedTitle),
        })),
      { history: true },
    );
    if (lostImages > 0) toast.undoable(`${lostImages} image${lostImages === 1 ? '' : 's'} removed by this layout.`, () => get().undo());
  },

  requestScrollTo(slideId) {
    set({ scrollTarget: { slideId, nonce: Date.now() }, mobilePane: 'slides' });
  },

  async ingestImage(slideId, zoneId, blob, fileName, projectId = get().activeProjectId ?? undefined) {
    if (!projectId) return;
    set({ importingZones: { ...get().importingZones, [zoneId]: true } });
    try {
      const asset = await bridge.saveImage(projectId, blob, fileName);
      mutateProject(projectId, (project) => mapZone(project, slideId, zoneId, (zone) => ({ ...zone, image: asset })), { history: true });
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      const { [zoneId]: _done, ...rest } = get().importingZones;
      set({ importingZones: rest });
    }
  },

  async ingestFiles(slideId, zoneId, files) {
    const images = files.filter((file) => file.type.startsWith('image/'));
    if (images.length === 0) {
      toast.error('Use a PNG, JPEG, WebP, GIF or BMP image.');
      return;
    }
    const projectId = get().activeProjectId ?? undefined;
    await get().ingestImage(slideId, zoneId, images[0]!, images[0]!.name, projectId);

    // Extra files flow into the remaining empty zones of the same slide.
    const project = get().projects.find((candidate) => candidate.id === projectId);
    const empty = project?.slides.find((slide) => slide.id === slideId)?.dropzones.filter((zone) => !zone.image && zone.id !== zoneId) ?? [];
    for (let index = 1; index < images.length && index - 1 < empty.length; index += 1) {
      await get().ingestImage(slideId, empty[index - 1]!.id, images[index]!, images[index]!.name, projectId);
    }
  },

  async pickImage(slideId, zoneId) {
    const projectId = get().activeProjectId;
    if (!projectId) return;
    try {
      const asset: ImageAsset | null = await bridge.pickImage(projectId);
      if (asset) mutateProject(projectId, (project) => mapZone(project, slideId, zoneId, (zone) => ({ ...zone, image: asset })), { history: true });
    } catch (error) {
      toast.error(errorMessage(error));
    }
  },

  removeImage(slideId, zoneId) {
    mutateActive((project) => mapZone(project, slideId, zoneId, (zone) => ({ ...zone, image: null, pins: [] })), { history: true });
    toast.undoable('Image removed.', () => get().undo());
  },

  updateZonePrompt(slideId, zoneId, prompt) {
    mutateActive((project) => mapZone(project, slideId, zoneId, (zone) => ({ ...zone, aiVisualPrompt: prompt })), { history: `zone:${zoneId}` });
  },

  addPin(slideId, zoneId, x, y) {
    const id = createId();
    const anchorXPercent = clampAnchorPercent(x);
    const anchorYPercent = clampAnchorPercent(y);
    const callout = placeCallout(anchorXPercent, anchorYPercent, findZone(get(), slideId, zoneId)?.zone.pins ?? []);
    mutateActive(
      (project) =>
        mapZone(project, slideId, zoneId, (zone) => ({
          ...zone,
          pins: [
            ...zone.pins,
            {
              id,
              index: zone.pins.length + 1,
              anchorXPercent,
              anchorYPercent,
              calloutXPercent: callout.x,
              calloutYPercent: callout.y,
              title: `Key Detail ${zone.pins.length + 1}`,
              description: '',
            },
          ],
        })),
      { history: true },
    );
    return id;
  },

  commitPinPosition(slideId, zoneId, pinId, patch) {
    mutateActive(
      (project) =>
        mapZone(project, slideId, zoneId, (zone) => ({
          ...zone,
          pins: zone.pins.map((pin) => (pin.id === pinId ? { ...pin, ...patch } : pin)),
        })),
      { history: true },
    );
  },

  updatePinText(slideId, zoneId, pinId, patch) {
    const field = Object.keys(patch)[0] ?? '';
    mutateActive(
      (project) =>
        mapZone(project, slideId, zoneId, (zone) => ({
          ...zone,
          pins: zone.pins.map((pin) => (pin.id === pinId ? { ...pin, ...patch } : pin)),
        })),
      { history: `pin:${pinId}:${field}` },
    );
  },

  deletePin(slideId, zoneId, pinId) {
    mutateActive(
      (project) =>
        mapZone(project, slideId, zoneId, (zone) => ({
          ...zone,
          pins: renumberPins(zone.pins.filter((pin) => pin.id !== pinId)),
        })),
      { history: true },
    );
  },

  resetPins(slideId, zoneId) {
    const count = findZone(get(), slideId, zoneId)?.zone.pins.length ?? 0;
    if (count === 0) return;
    mutateActive((project) => mapZone(project, slideId, zoneId, (zone) => ({ ...zone, pins: [] })), { history: true });
    toast.undoable(`${count} pin${count === 1 ? '' : 's'} cleared.`, () => get().undo());
  },

  async describePin(slideId, zoneId, pinId, projectId = get().activeProjectId ?? undefined) {
    const state = get();
    const found = findZone(state, slideId, zoneId, projectId);
    const pin = found?.zone.pins.find((candidate) => candidate.id === pinId);
    if (!found || !pin || !found.zone.image || state.pinJobs[pinId]) return 'skipped';

    if (!state.ollama?.online) {
      toast.error('Ollama is offline. Start it to use AI Vision.');
      return 'failed';
    }
    if (!state.activeVisionModel) {
      toast.error('Choose a vision model first. Install one from Settings & AI Engine.');
      set({ modelManagerOpen: true });
      return 'failed';
    }

    const requestId = createId();
    liveBuffers.set(requestId, '');
    stopRequests.delete(pinId);
    set({ pinJobs: { ...get().pinJobs, [pinId]: { requestId, live: '' } } });

    try {
      const imageBase64 = await bridge.assetBase64(found.project.id, found.zone.image);
      // The native request does not exist yet at this point, so a stop is checked here.
      if (stopRequests.has(pinId)) return 'cancelled';

      const isDefaultTitle = /^Key Detail \d+$/.test(pin.title);
      const hintParts = [found.slide.refinedTitle, isDefaultTitle ? '' : pin.title].filter(Boolean);
      const description = await bridge.analyzePin({
        visionModel: state.activeVisionModel,
        imageBase64,
        pinX: pin.anchorXPercent,
        pinY: pin.anchorYPercent,
        userHint: hintParts.join(', '),
        requestId,
      });
      if (description === null) return 'cancelled';

      const clean = stripEmoji(description);
      mutateProject(
        found.project.id,
        (project) =>
          mapZone(project, slideId, zoneId, (zone) => ({
            ...zone,
            pins: zone.pins.map((candidate) => (candidate.id === pinId ? { ...candidate, description: clean } : candidate)),
          })),
        { history: true },
      );
      return 'done';
    } catch (error) {
      toast.error(`AI Vision could not describe this pin: ${errorMessage(error)}`);
      return 'failed';
    } finally {
      liveBuffers.delete(requestId);
      stopRequests.delete(pinId);
      const { [pinId]: _done, ...rest } = get().pinJobs;
      set({ pinJobs: rest });
    }
  },

  async inspectImage(slideId, zoneId) {
    const projectId = get().activeProjectId ?? undefined;
    let found = findZone(get(), slideId, zoneId, projectId);
    if (!found?.zone.image) return;

    // With no pins yet, a centered pin gives the overview somewhere to live.
    if (found.zone.pins.length === 0) {
      const id = get().addPin(slideId, zoneId, 50, 50);
      get().updatePinText(slideId, zoneId, id, { title: 'Overview' });
      found = findZone(get(), slideId, zoneId, projectId);
    }
    const targets = found?.zone.pins.filter((pin) => !pin.description.trim()) ?? [];
    if (targets.length === 0) {
      toast.info('Every pin already has a description. Use the sparkle icon on a callout to redo one.');
      return;
    }
    for (const pin of targets) {
      const outcome = await get().describePin(slideId, zoneId, pin.id, projectId);
      // Stopping one pin stops the batch, and one error is enough to report.
      if (outcome === 'cancelled' || outcome === 'failed') break;
    }
  },

  async cancelPinJob(pinId) {
    const job = get().pinJobs[pinId];
    if (!job) return;
    stopRequests.add(pinId);
    await bridge.cancelAnalysis(job.requestId);
  },

  setTheme(theme) {
    applyTheme(theme);
    set({ theme });
    persistSetting('theme', theme);
  },

  setLeaderStyle(style) {
    set({ leaderStyle: style });
    persistSetting('leaderStyle', style);
  },

  toggleSidebar() {
    get().setSidebarCollapsed(!get().sidebarCollapsed);
  },

  setSidebarCollapsed(collapsed) {
    set({ sidebarCollapsed: collapsed });
    persistSetting('sidebarCollapsed', String(collapsed));
  },

  setSplitPercent(percent) {
    set({ splitPercent: percent });
    persistSetting('splitPercent', String(percent));
  },

  setMobilePane(pane) {
    set({ mobilePane: pane });
  },

  async refreshStatus() {
    const previous = get().ollama;
    let status: OllamaStatus;
    try {
      status = await bridge.checkOllamaStatus();
    } catch {
      status = { online: false, installed: previous?.installed ?? false, version: null, endpoint: previous?.endpoint ?? '', modelCount: 0 };
    }
    // Replacing state with an identical value would repaint subscribers every 5 seconds.
    if (!sameJson(previous, status)) set({ ollama: status });
    if (status.online && (!previous?.online || previous.modelCount !== status.modelCount)) {
      await get().refreshModels();
    }
    if (!status.online && get().models.length > 0) set({ models: [] });
  },

  async refreshModels() {
    let models: LocalModel[];
    try {
      models = await bridge.listLocalModels();
    } catch {
      return;
    }
    const state = get();
    const patch: Partial<DeckState> = {};
    if (!sameJson(state.models, models)) patch.models = models;

    // Automatic picks are kept apart from the user's choices and are re-evaluated. Hardware
    // details can arrive after the model list, and a pick made without them must not outlive
    // their arrival. They are remembered only so the pills show a name at once on launch.
    const textValid = state.activeTextModel && models.some((model) => model.name === state.activeTextModel);
    if ((!textValid || autoPicked.text) && models.length > 0) {
      const pick = pickDefaultModel(models, state.hardware, 'text');
      autoPicked.text = true;
      if (pick !== state.activeTextModel) {
        patch.activeTextModel = pick;
        if (pick) persistSetting('autoTextModel', pick);
      }
    }
    const visionValid = state.activeVisionModel && models.some((model) => model.name === state.activeVisionModel && model.isVision);
    if ((!visionValid || autoPicked.vision) && models.length > 0) {
      const pick = pickDefaultModel(models, state.hardware, 'vision');
      autoPicked.vision = true;
      if (pick !== state.activeVisionModel) {
        patch.activeVisionModel = pick;
        if (pick) persistSetting('autoVisionModel', pick);
      }
    }
    if (Object.keys(patch).length > 0) set(patch);
  },

  async refreshHardware() {
    try {
      const hardware = await bridge.getHardwareSpecs();
      if (!sameJson(get().hardware, hardware)) {
        set({ hardware });
        if (autoPicked.text || autoPicked.vision) await get().refreshModels();
      }
    } catch (error) {
      toast.error(`Could not read hardware details: ${errorMessage(error)}`);
    }
  },

  async launchOllama() {
    set({ launching: true });
    try {
      await bridge.launchOllama();
      // The daemon takes a moment to bind its port, so check a few times soon after.
      for (let attempt = 0; attempt < 8; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 700));
        await get().refreshStatus();
        if (get().ollama?.online) break;
      }
      if (get().ollama?.online) toast.success('Ollama is running.');
      else toast.error('Ollama did not start. Open it from your applications menu.');
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      set({ launching: false });
    }
  },

  setActiveTextModel(model) {
    autoPicked.text = false;
    set({ activeTextModel: model });
    persistSetting('activeTextModel', model);
  },

  setActiveVisionModel(model) {
    autoPicked.vision = false;
    set({ activeVisionModel: model });
    persistSetting('activeVisionModel', model);
  },

  async pullModel(model) {
    if (get().pulls[model]) return;
    set({
      pulls: {
        ...get().pulls,
        [model]: { model, status: 'starting', completed: 0, total: 0, percent: 0, bytesPerSecond: 0, done: false, cancelled: false, error: null, startedAt: Date.now() },
      },
    });
    pullOutcomes.delete(model);
    try {
      await bridge.pullModel(model);
      if (!pullOutcomes.has(model)) pullOutcomes.set(model, 'ok');
    } catch (error) {
      pullOutcomes.set(model, 'failed');
      const { [model]: _failed, ...rest } = get().pulls;
      set({ pulls: rest });
      toast.error(`Could not download ${model}: ${errorMessage(error)}`);
    }
  },

  async cancelPull(model) {
    pullOutcomes.set(model, 'cancelled');
    await bridge.cancelPull(model);
  },

  async checkForUpdates() {
    if (get().updateCheck.running) return;
    const { models, ollama } = get();
    if (!ollama?.online) {
      toast.error('Ollama is offline. Start it to check for updates.');
      return;
    }
    if (models.length === 0) {
      toast.info('No models are installed yet.');
      return;
    }

    const before = new Map(models.map((model) => [model.name, model.digest]));
    set({ updateCheck: { running: true, current: null, done: 0, total: models.length } });
    let index = 0;
    let failed = 0;
    let stopped = false;
    for (const model of models) {
      set({ updateCheck: { running: true, current: model.name, done: index, total: models.length } });
      await get().pullModel(model.name);
      index += 1;
      const outcome = pullOutcomes.get(model.name);
      if (outcome === 'failed') failed += 1;
      if (outcome === 'cancelled') {
        stopped = true;
        break;
      }
    }
    await get().refreshModels();
    const changed = get().models.filter((model) => before.has(model.name) && before.get(model.name) !== model.digest);
    set({ updateCheck: { running: false, current: null, done: 0, total: 0 } });

    const updated = changed.length > 0 ? `Updated ${changed.map((model) => model.name).join(', ')}. ` : '';
    if (stopped) toast.info(`${updated}Update check stopped.`);
    else if (failed > 0) toast.error(`${updated}Could not check ${failed} of ${models.length} models. Check your connection and try again.`);
    else if (changed.length > 0) toast.success(updated.trim());
    else toast.success('All models are up to date.');
  },

  setModelManagerOpen(open) {
    set({ modelManagerOpen: open });
    if (open) void get().refreshHardware();
  },

  openPresenter(index = 0) {
    const project = get().projects.find((candidate) => candidate.id === get().activeProjectId);
    if (!project || project.slides.length === 0) {
      toast.info('Generate or add a slide before presenting.');
      return;
    }
    set({ presenterOpen: true, presenterIndex: Math.min(index, project.slides.length - 1), focusZone: null, modelManagerOpen: false });
    void bridge.setFullscreen(true).catch(() => undefined);
  },

  closePresenter() {
    set({ presenterOpen: false });
    void bridge.setFullscreen(false).catch(() => undefined);
  },

  setPresenterIndex(index) {
    set({ presenterIndex: index });
  },

  setFocusZone(zone) {
    set({ focusZone: zone });
  },

  async exportDeck(format) {
    const state = get();
    if (state.exportJob) return;
    const project = state.projects.find((candidate) => candidate.id === state.activeProjectId);
    if (!project || project.slides.length === 0) {
      toast.info('Generate or add a slide before exporting.');
      return;
    }
    set({ exportJob: { format, current: 0, total: project.slides.length } });
    try {
      const { exportDeck } = await import('../lib/export');
      const saved = await exportDeck(project, format, get().leaderStyle, (current, total) => {
        set({ exportJob: { format, current, total } });
      });
      if (saved) toast.success(`Exported ${saved.split(/[\\/]/).pop() ?? saved}.`);
    } catch (error) {
      toast.error(`Export failed: ${errorMessage(error)}`);
    } finally {
      set({ exportJob: null });
    }
  },
}));

async function runBootstrap(): Promise<void> {
  const { getState: get, setState: set } = useDeckStore;

  let settings: SettingsMap = {};
  let projects: Project[] = [];
  try {
    [settings, projects] = await Promise.all([bridge.loadSettings(), bridge.loadProjects()]);
  } catch (error) {
    toast.error(`Could not load saved projects: ${errorMessage(error)}`);
  }

  if (projects.length === 0) {
    const first = createProject('Untitled deck');
    projects = [first];
    void bridge.saveProject(first).catch(() => undefined);
  }

  const storedActive = settings.activeProjectId;
  const activeProject = projects.find((project) => project.id === storedActive) ?? projects[projects.length - 1]!;
  await Promise.all(projects.map((project) => bridge.prepareAssets(project).catch(() => undefined)));

  const storedTheme = settings.theme as ThemeMode | undefined;
  const bootTheme = localStorage.getItem('vanguard.theme') as ThemeMode | null;
  const theme: ThemeMode = storedTheme ?? bootTheme ?? 'system';
  applyTheme(theme);

  await Promise.race([
    Promise.all(['400 14px "Inter Variable"', '600 14px "Inter Variable"'].map((font) => document.fonts.load(font))),
    new Promise((resolve) => setTimeout(resolve, 1200)),
  ]).catch(() => undefined);

  autoPicked.text = !settings.activeTextModel;
  autoPicked.vision = !settings.activeVisionModel;

  const narrow = window.innerWidth < 1000;
  const split = Number(settings.splitPercent);
  set({
    projects,
    activeProjectId: activeProject.id,
    theme,
    leaderStyle: settings.leaderStyle === 'bezier' ? 'bezier' : 'elbow',
    sidebarCollapsed: narrow || settings.sidebarCollapsed === 'true',
    splitPercent: split >= 24 && split <= 70 ? split : 38,
    activeTextModel: settings.activeTextModel || settings.autoTextModel || null,
    activeVisionModel: settings.activeVisionModel || settings.autoVisionModel || null,
    ready: true,
  });

  subscriptions.forEach((unsubscribe) => unsubscribe());
  subscriptions = await Promise.all([
    bridge.onPullProgress((progress) => {
      const current = get().pulls[progress.model];
      if (progress.done) {
        // A failed or cancelled pull stays visible through the toast the action raises.
        const { [progress.model]: _finished, ...rest } = get().pulls;
        set({ pulls: rest });
        void get().refreshModels();
        return;
      }
      const total = Math.max(progress.total, expectedPullBytes(get(), progress.model));
      // The bar only ever moves forward, whatever the layer order turns out to be.
      const percent = Math.max(current?.percent ?? 0, total > 0 ? (progress.completed / total) * 100 : 0);
      set({
        pulls: {
          ...get().pulls,
          [progress.model]: { ...progress, total, percent, startedAt: current?.startedAt ?? Date.now() },
        },
      });
    }),
    bridge.onStreamChunk((chunk) => {
      if (!chunk.delta) return;
      liveBuffers.set(chunk.requestId, (liveBuffers.get(chunk.requestId) ?? '') + chunk.delta);
      flushLive.push();
    }),
  ]);

  // Network probes run in the background and never delay the first interactive frame.
  void get().refreshHardware();
  void get().refreshStatus();
  if (pollTimer !== null) window.clearInterval(pollTimer);
  pollTimer = window.setInterval(() => void get().refreshStatus(), POLL_INTERVAL_MS);

  // Waits for pending edits before the window goes away, with a limit so that a stuck
  // write can never make the window impossible to close.
  subscriptions.push(
    await bridge.onCloseRequested(async () => {
      await Promise.race([get().flushSaves(), new Promise((resolve) => setTimeout(resolve, CLOSE_FLUSH_LIMIT_MS))]).catch(() => undefined);
    }),
  );
  window.addEventListener('pagehide', () => void get().flushSaves());
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (get().theme === 'system') applyTheme('system');
  });
}

export function selectActiveProject(state: DeckState): Project | null {
  return state.projects.find((project) => project.id === state.activeProjectId) ?? null;
}
