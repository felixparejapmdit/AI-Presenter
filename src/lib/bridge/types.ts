import type {
  AiSlide,
  AnalyzePinArgs,
  AnalyzeScriptArgs,
  HardwareProfile,
  ImageAsset,
  LocalModel,
  OllamaStatus,
  Project,
  PullProgress,
  StreamChunk,
} from '../../types/deck';

export type Unsubscribe = () => void;
export type SettingsMap = Record<string, string>;

export interface ExportFilter {
  name: string;
  extensions: string[];
}

/**
 * Everything the interface needs from the host. The desktop app implements it over
 * Tauri commands. The browser implementation lets the same interface run and be tested
 * against a real or mocked Ollama without a native shell.
 */
export interface Bridge {
  readonly kind: 'tauri' | 'web';
  readonly canLaunchOllama: boolean;

  // Hardware and daemon
  getHardwareSpecs(): Promise<HardwareProfile>;
  checkOllamaStatus(): Promise<OllamaStatus>;
  listLocalModels(): Promise<LocalModel[]>;
  launchOllama(): Promise<void>;
  openExternal(url: string): Promise<void>;

  // Models
  pullModel(model: string): Promise<void>;
  cancelPull(model: string): Promise<void>;
  onPullProgress(listener: (progress: PullProgress) => void): Promise<Unsubscribe>;

  // AI pipelines. Both resolve to null when cancelled.
  analyzeScript(args: AnalyzeScriptArgs): Promise<AiSlide[] | null>;
  analyzePin(args: AnalyzePinArgs): Promise<string | null>;
  cancelAnalysis(requestId: string): Promise<void>;
  onStreamChunk(listener: (chunk: StreamChunk) => void): Promise<Unsubscribe>;

  // Persistence
  loadProjects(): Promise<Project[]>;
  saveProject(project: Project): Promise<void>;
  deleteProject(projectId: string): Promise<void>;
  loadSettings(): Promise<SettingsMap>;
  saveSetting(key: string, value: string): Promise<void>;

  // Assets
  saveImage(projectId: string, blob: Blob, fileName: string): Promise<ImageAsset>;
  pickImage(projectId: string): Promise<ImageAsset | null>;
  /** Makes every asset in a project resolvable through assetUrl. */
  prepareAssets(project: Project): Promise<void>;
  assetUrl(projectId: string, asset: ImageAsset): string;
  assetBase64(projectId: string, asset: ImageAsset): Promise<string>;
  readClipboardImage(): Promise<Blob | null>;

  // Export and window
  saveExport(fileName: string, bytes: Uint8Array, filter: ExportFilter): Promise<string | null>;
  setFullscreen(enabled: boolean): Promise<void>;
  setWindowColor(color: string): Promise<void>;
  showWindow(): Promise<void>;
  /** Runs before the window closes. The window closes once the handler settles. */
  onCloseRequested(handler: () => Promise<void>): Promise<Unsubscribe>;
}
