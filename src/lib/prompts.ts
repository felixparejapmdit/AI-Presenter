/**
 * Browser-mode copies of the prompts in src-tauri/src/ollama.rs. The desktop app sends
 * the Rust versions. These exist so browser mode behaves the same way.
 */

export const SLIDE_SCHEMA = {
  type: 'object',
  properties: {
    slides: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          slideNumber: { type: 'integer' },
          originalExcerpt: { type: 'string' },
          refinedTitle: { type: 'string' },
          executiveSummary: { type: 'array', items: { type: 'string' } },
          speakerNotes: { type: 'string' },
          layoutType: { type: 'string', enum: ['single-visual', 'split-comparison', 'multi-grid', 'statement-only'] },
          dropzones: {
            type: 'array',
            items: {
              type: 'object',
              properties: { aiVisualPrompt: { type: 'string' } },
              required: ['aiVisualPrompt'],
            },
          },
        },
        required: ['slideNumber', 'originalExcerpt', 'refinedTitle', 'executiveSummary', 'speakerNotes', 'layoutType', 'dropzones'],
      },
    },
  },
  required: ['slides'],
};

export function scriptSystemPrompt(persona: string, tone: string): string {
  return `You are a senior presentation strategist preparing a VIP client deck.
Audience: ${persona}. Tone: ${tone}.
Convert the raw script into a sequence of slides, in the original order, using only facts from the script.
Respond with a single JSON object of the form {"slides": [...]}. Every slide has:
- slideNumber: integer starting at 1
- originalExcerpt: the exact raw text this slide came from
- refinedTitle: a client-friendly, high-impact headline of at most 10 words
- executiveSummary: an array of 2 to 3 crisp talking points
- speakerNotes: a refined verbal script for the presenter
- layoutType: "single-visual" for one key image, "split-comparison" for before/after or two options, "multi-grid" for three or four related visuals, "statement-only" for a pure message with no image
- dropzones: one object per image with an aiVisualPrompt describing the screenshot, chart or mockup to drop there. Use 1 for single-visual, 2 for split-comparison, 3 or 4 for multi-grid, and 0 for statement-only.
Write 3 to 10 slides depending on the script length.
Use plain professional language. Never use emojis or decorative symbols.`;
}

export const VISION_SYSTEM_PROMPT =
  'You explain details in screenshots, charts and architecture diagrams to senior clients. Describe only what is visible. Reply with one or two short, client-friendly sentences in plain text. Do not use markdown, lists or emojis.';

export function visionUserPrompt(pinX: number, pinY: number, hint: string, composite: boolean): string {
  const framing = composite
    ? 'This image shows a close-up of the pinned detail on the left and the full picture on the right, where a blue ring marks the detail.'
    : 'The first image is a close-up of the pinned detail. The second is the full picture, where a blue ring marks the detail.';
  const context = hint.trim() ? ` Context from the presenter: ${hint.trim()}.` : '';
  return `${framing} The pin sits ${pinX.toFixed(0)}% from the left and ${pinY.toFixed(0)}% from the top.${context} Explain what this specific element, chart spike or architectural detail shows and why it matters.`;
}
