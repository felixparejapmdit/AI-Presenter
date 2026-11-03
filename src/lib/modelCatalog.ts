import type { ModelRecommendation } from '../types/deck';

type CatalogEntry = Omit<ModelRecommendation, 'recommended'>;

/** Browser-mode copy of the catalog in hardware.rs. A unit test keeps the two in sync. */
export const MODEL_CATALOG: CatalogEntry[] = [
  { id: 'moondream:1.8b', displayName: 'Moondream 2 (1.8B Vision)', role: 'vision', sizeGb: 1.74, tierLevel: 1, reason: 'Ultra-fast UI and image pin analysis for lightweight machines.' },
  { id: 'minicpm-v:8b', displayName: 'MiniCPM-V 2.6 (8B Vision)', role: 'vision', sizeGb: 5.47, tierLevel: 2, reason: 'Superior OCR, chart reading and UI pin description accuracy.' },
  { id: 'llava:7b', displayName: 'LLaVA (7B Vision)', role: 'vision', sizeGb: 4.73, tierLevel: 2, reason: 'Dependable general purpose vision model with broad compatibility.' },
  { id: 'llama3.2-vision:11b', displayName: 'Llama 3.2 Vision (11B)', role: 'vision', sizeGb: 7.82, tierLevel: 3, reason: 'Flagship executive visual reasoning and diagram analysis.' },
  { id: 'qwen2.5vl:7b', displayName: 'Qwen 2.5 VL (7B Vision)', role: 'vision', sizeGb: 5.97, tierLevel: 3, reason: 'Precise document and interface reading with strong layout awareness.' },
  { id: 'llama3.2:3b', displayName: 'Llama 3.2 (3B Text)', role: 'text', sizeGb: 2.02, tierLevel: 1, reason: 'Responsive script structuring on 8 GB machines.' },
  { id: 'qwen2.5:3b', displayName: 'Qwen 2.5 (3B Text)', role: 'text', sizeGb: 1.93, tierLevel: 1, reason: 'Fast script-to-slide JSON structuring on low memory.' },
  { id: 'llama3.1:8b', displayName: 'Llama 3.1 (8B Text)', role: 'text', sizeGb: 4.92, tierLevel: 2, reason: 'Reliable narrative quality with moderate memory use.' },
  { id: 'qwen2.5:7b', displayName: 'Qwen 2.5 (7B Text)', role: 'text', sizeGb: 4.68, tierLevel: 2, reason: 'Balanced executive copywriting and reliable JSON slide generation.' },
  { id: 'qwen2.5:14b', displayName: 'Qwen 2.5 (14B Text)', role: 'text', sizeGb: 8.99, tierLevel: 3, reason: 'Near-cloud quality narrative restructuring for VIP pitches.' },
  { id: 'deepseek-r1:14b', displayName: 'DeepSeek R1 (14B Text)', role: 'text', sizeGb: 8.99, tierLevel: 3, reason: 'Deep reasoning for complex analytical storylines.' },
];

export function recommendationsForTier(tierLevel: number): ModelRecommendation[] {
  return MODEL_CATALOG.map((entry) => ({ ...entry, recommended: entry.tierLevel === tierLevel }));
}

export function classifyTier(effectiveGb: number): { tier: string; tierLevel: number } {
  if (effectiveGb >= 18) return { tier: 'TIER 3: ULTRA', tierLevel: 3 };
  if (effectiveGb >= 8) return { tier: 'TIER 2: PRO', tierLevel: 2 };
  return { tier: 'TIER 1: ENTRY', tierLevel: 1 };
}
