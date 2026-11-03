export type LayoutType = 'single-visual' | 'split-comparison' | 'multi-grid' | 'statement-only';

export const LAYOUT_TYPES: LayoutType[] = ['single-visual', 'split-comparison', 'multi-grid', 'statement-only'];

export const PERSONAS = ['C-Suite Executive', 'Technical Stakeholder', 'Design Review', 'Investor Pitch'] as const;
export type AudiencePersona = (typeof PERSONAS)[number];

export const TONES = ['Concise & Direct', 'Persuasive', 'Analytical'] as const;
export type Tone = (typeof TONES)[number];

export type LeaderStyle = 'elbow' | 'bezier';
export type ThemeMode = 'light' | 'dark' | 'system';

/** Coordinates are normalized percentages (0 to 100) of the image rectangle. */
export interface PinAnnotation {
  id: string;
  index: number;
  anchorXPercent: number;
  anchorYPercent: number;
  /** Top-left corner of the callout card. */
  calloutXPercent: number;
  calloutYPercent: number;
  title: string;
  description: string;
}

export interface ImageAsset {
  id: string;
  fileName: string;
  /** Name inside the project assets directory, or the IndexedDB key in browser mode. */
  storedName: string;
  mime: string;
  width: number;
  height: number;
  byteSize: number;
  /** Absolute path on disk. Empty in browser mode. */
  path: string;
}

export interface Dropzone {
  id: string;
  aiVisualPrompt: string;
  image: ImageAsset | null;
  pins: PinAnnotation[];
}

export interface Slide {
  id: string;
  slideNumber: number;
  originalExcerpt: string;
  refinedTitle: string;
  executiveSummary: string[];
  speakerNotes: string;
  layoutType: LayoutType;
  dropzones: Dropzone[];
}

export interface Project {
  id: string;
  name: string;
  script: string;
  persona: AudiencePersona;
  tone: Tone;
  slides: Slide[];
  createdAt: number;
  updatedAt: number;
}

export interface ModelRecommendation {
  id: string;
  displayName: string;
  role: 'vision' | 'text';
  sizeGb: number;
  reason: string;
  tierLevel: number;
  recommended: boolean;
}

export interface HardwareProfile {
  osName: string;
  osVersion: string;
  cpuArch: string;
  cpuBrand: string;
  cpuCores: number;
  totalRamGb: number;
  availableRamGb: number;
  gpuName: string;
  vramGb: number;
  availableVramGb: number;
  effectiveMemoryGb: number;
  isUnifiedMemory: boolean;
  tier: string;
  tierLevel: number;
  detectionSource: string;
  recommendations: ModelRecommendation[];
}

/** The plan refers to this shape as both HardwareSpecs and HardwareProfile. */
export type HardwareSpecs = HardwareProfile;

export interface OllamaStatus {
  online: boolean;
  installed: boolean;
  version: string | null;
  endpoint: string;
  modelCount: number;
}

export interface LocalModel {
  name: string;
  size: number;
  digest: string;
  modifiedAt: string;
  family: string;
  parameterSize: string;
  quantization: string;
  capabilities: string[];
  isVision: boolean;
}

export interface PullProgress {
  model: string;
  status: string;
  completed: number;
  total: number;
  percent: number;
  bytesPerSecond: number;
  done: boolean;
  cancelled: boolean;
  error: string | null;
}

export interface StreamChunk {
  requestId: string;
  delta: string;
  done: boolean;
}

/** Slide shape returned by the AI pipeline, before ids are assigned. */
export interface AiSlide {
  slideNumber: number;
  originalExcerpt: string;
  refinedTitle: string;
  executiveSummary: string[];
  speakerNotes: string;
  layoutType: string;
  dropzones: { aiVisualPrompt: string }[];
}

export interface AnalyzeScriptArgs {
  model: string;
  script: string;
  persona: string;
  tone: string;
  requestId: string;
}

export interface AnalyzePinArgs {
  visionModel: string;
  imageBase64: string;
  pinX: number;
  pinY: number;
  userHint: string;
  requestId: string;
}
