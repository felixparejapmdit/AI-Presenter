export type DiffKind = 'same' | 'added' | 'removed';

export interface DiffToken {
  kind: DiffKind;
  text: string;
}

function tokenize(text: string): string[] {
  return text.match(/\s+|[^\s]+/g) ?? [];
}

const MAX_CELLS = 4_000_000;

/** Word-level LCS diff powering the AI refinement view in the Script Studio. */
export function diffWords(before: string, after: string): DiffToken[] {
  const a = tokenize(before);
  const b = tokenize(after);

  if (a.length * b.length > MAX_CELLS) {
    // Beyond this size a full comparison would stall the UI, so show a plain replacement.
    return [
      { kind: 'removed', text: before },
      { kind: 'added', text: after },
    ];
  }

  const width = b.length + 1;
  const table = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        a[i] === b[j]
          ? table[(i + 1) * width + j + 1]! + 1
          : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
    }
  }

  const tokens: DiffToken[] = [];
  const push = (kind: DiffKind, text: string) => {
    const last = tokens[tokens.length - 1];
    if (last && last.kind === kind) last.text += text;
    else tokens.push({ kind, text });
  };

  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      push('same', a[i]!);
      i += 1;
      j += 1;
    } else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) {
      push('removed', a[i]!);
      i += 1;
    } else {
      push('added', b[j]!);
      j += 1;
    }
  }
  while (i < a.length) push('removed', a[i++]!);
  while (j < b.length) push('added', b[j++]!);
  return tokens;
}
