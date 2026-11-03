import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { SAMPLE_SCRIPT } from '../../lib/deck';
import { diffWords } from '../../lib/diff';
import { cn, modKey } from '../../lib/utils';
import { selectActiveProject, useDeckStore } from '../../store/useDeckStore';
import { PERSONAS, TONES, type AudiencePersona, type Tone } from '../../types/deck';
import { AppIcon } from '../ui/AppIcon';
import { Select } from '../ui/Select';

interface SlashCommand {
  id: string;
  label: string;
  hint: string;
  icon: string;
  run: (insert: (text: string) => void) => void;
}

const SLASH_COMMANDS: SlashCommand[] = [
  { id: 'heading', label: 'Section heading', hint: 'Starts a new topic', icon: 'lucide:heading-2', run: (insert) => insert('## ') },
  { id: 'bullet', label: 'Bullet point', hint: 'A talking point', icon: 'lucide:list', run: (insert) => insert('- ') },
  { id: 'break', label: 'Slide break', hint: 'Separates two slides', icon: 'lucide:minus', run: (insert) => insert('\n') },
  { id: 'sample', label: 'Insert sample script', hint: 'See how it works', icon: 'lucide:file-text', run: (insert) => insert(SAMPLE_SCRIPT) },
  { id: 'analyze', label: 'Analyze & Generate Slides', hint: 'Runs the local AI', icon: 'lucide:sparkles', run: () => void useDeckStore.getState().analyzeScript() },
  { id: 'present', label: 'Present', hint: `${modKey}+Enter`, icon: 'lucide:play', run: () => useDeckStore.getState().openPresenter() },
];

/** Measures the caret inside a textarea with a mirror element, which is what lets the slash menu open at the caret. */
function caretCoordinates(textarea: HTMLTextAreaElement, position: number): { left: number; top: number; height: number } {
  const mirror = document.createElement('div');
  const style = getComputedStyle(textarea);
  for (const property of ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'padding', 'border', 'boxSizing', 'whiteSpace', 'wordWrap', 'wordBreak'] as const) {
    mirror.style[property] = style[property];
  }
  mirror.style.position = 'absolute';
  mirror.style.visibility = 'hidden';
  mirror.style.whiteSpace = 'pre-wrap';
  mirror.style.overflowWrap = 'break-word';
  mirror.style.width = `${textarea.clientWidth}px`;
  mirror.textContent = textarea.value.slice(0, position);
  const marker = document.createElement('span');
  marker.textContent = '\u{200b}';
  mirror.append(marker);
  document.body.append(mirror);
  const box = textarea.getBoundingClientRect();
  const result = {
    left: box.left + marker.offsetLeft - textarea.scrollLeft,
    top: box.top + marker.offsetTop - textarea.scrollTop,
    height: marker.offsetHeight,
  };
  mirror.remove();
  return result;
}

export function ScriptStudioPane() {
  const script = useDeckStore((state) => selectActiveProject(state)?.script ?? '');
  const persona = useDeckStore((state) => selectActiveProject(state)?.persona ?? 'C-Suite Executive');
  const tone = useDeckStore((state) => selectActiveProject(state)?.tone ?? 'Concise & Direct');
  const slideCount = useDeckStore((state) => selectActiveProject(state)?.slides.length ?? 0);
  const projectId = useDeckStore((state) => state.activeProjectId);
  const running = useDeckStore((state) => state.analysis.running);
  const error = useDeckStore((state) => state.analysis.error);
  const online = useDeckStore((state) => state.ollama?.online ?? false);
  const textModel = useDeckStore((state) => state.activeTextModel);

  const [view, setView] = useState<'script' | 'diff'>('script');
  const [slash, setSlash] = useState<{ start: number; query: string; left: number; top: number; index: number } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const store = useDeckStore.getState;

  useEffect(() => {
    setView('script');
    setSlash(null);
  }, [projectId]);

  useEffect(() => {
    if (slideCount === 0 && view === 'diff') setView('script');
  }, [slideCount, view]);

  const commands = useMemo(() => {
    if (!slash) return [];
    const query = slash.query.toLowerCase();
    return SLASH_COMMANDS.filter((command) => command.label.toLowerCase().includes(query));
  }, [slash]);

  // Keep the menu on screen, measured before paint so it does not jump.
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu || !slash) return;
    const rect = menu.getBoundingClientRect();
    const overflowY = rect.bottom - (window.innerHeight - 8);
    const overflowX = rect.right - (window.innerWidth - 8);
    if (overflowY > 0) menu.style.top = `${slash.top - rect.height - 28}px`;
    if (overflowX > 0) menu.style.left = `${slash.left - overflowX}px`;
  });

  const updateSlash = (value: string, caret: number) => {
    const lineStart = value.lastIndexOf('\n', caret - 1) + 1;
    const line = value.slice(lineStart, caret);
    const textarea = textareaRef.current;
    if (line.startsWith('/') && !line.includes(' ') && textarea) {
      const coordinates = caretCoordinates(textarea, lineStart);
      setSlash((current) => ({
        start: lineStart,
        query: line.slice(1),
        left: coordinates.left,
        top: coordinates.top + coordinates.height + 4,
        index: current?.start === lineStart ? current.index : 0,
      }));
    } else if (slash) {
      setSlash(null);
    }
  };

  const runCommand = (command: SlashCommand) => {
    const textarea = textareaRef.current;
    if (!textarea || !slash) return;
    const caret = textarea.selectionStart;
    const before = script.slice(0, slash.start);
    const after = script.slice(caret);
    const insert = (text: string) => {
      // The caret is placed in the same tick as the text. Waiting for the next frame would
      // pull it back over anything typed in between.
      flushSync(() => store().setScript(before + text + after));
      const position = before.length + text.length;
      textarea.focus();
      textarea.setSelectionRange(position, position);
    };
    setSlash(null);
    if (command.id === 'analyze' || command.id === 'present') store().setScript(before + after);
    command.run(insert);
  };

  const onEditorKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!slash || commands.length === 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setSlash({ ...slash, index: Math.min(commands.length - 1, slash.index + 1) });
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setSlash({ ...slash, index: Math.max(0, slash.index - 1) });
    } else if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      runCommand(commands[Math.min(slash.index, commands.length - 1)]!);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setSlash(null);
    }
  };

  const wordCount = useMemo(() => (script.trim() ? script.trim().split(/\s+/).length : 0), [script]);

  return (
    <section aria-label="Script studio" data-testid="script-pane" className="flex h-full min-w-0 flex-col bg-surface">
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <Select<AudiencePersona>
          value={persona}
          options={PERSONAS.map((value) => ({ value, label: value }))}
          onChange={(value) => store().setPersona(value)}
          label="Audience persona"
          icon="lucide:users"
          testId="persona-select"
          className="min-w-[150px] flex-1"
        />
        <Select<Tone>
          value={tone}
          options={TONES.map((value) => ({ value, label: value }))}
          onChange={(value) => store().setTone(value)}
          label="Tone"
          icon="lucide:sliders-horizontal"
          testId="tone-select"
          className="min-w-[140px] flex-1"
        />
      </header>

      {slideCount > 0 && (
        <div role="tablist" aria-label="Script view" className="flex shrink-0 gap-1 border-b border-line px-3 py-1">
          <ViewTab label="Script" icon="lucide:file-text" active={view === 'script'} onClick={() => setView('script')} />
          <ViewTab label="AI refinement diff" icon="lucide:git-compare" active={view === 'diff'} onClick={() => setView('diff')} testId="diff-tab" />
        </div>
      )}

      <div className="relative min-h-0 flex-1">
        {view === 'script' ? (
          <textarea
            ref={textareaRef}
            value={script}
            data-testid="script-editor"
            aria-label="Script"
            spellCheck
            placeholder={'Paste a rough script, meeting notes or bullet points.\n\nLeave a blank line between ideas. Type / for commands.'}
            onChange={(event) => {
              store().setScript(event.target.value);
              updateSlash(event.target.value, event.target.selectionStart);
            }}
            onKeyDown={onEditorKeyDown}
            onClick={(event) => updateSlash(script, event.currentTarget.selectionStart)}
            onBlur={() => setSlash(null)}
            className="absolute inset-0 block h-full w-full resize-none border-0 bg-transparent px-4 py-3 text-[14px] leading-[1.65] outline-none"
            style={{ fieldSizing: 'fixed' } as React.CSSProperties}
          />
        ) : (
          <DiffView />
        )}

        {view === 'script' && !script && (
          <button
            type="button"
            data-testid="load-sample"
            className="btn btn-outline absolute bottom-3 left-4 text-ink-2"
            onClick={() => store().setScript(SAMPLE_SCRIPT)}
          >
            <AppIcon icon="lucide:file-text" size={14} />
            Try a sample script
          </button>
        )}

        {slash && commands.length > 0 && (
          <div
            ref={menuRef}
            role="listbox"
            aria-label="Slash commands"
            data-testid="slash-menu"
            className="popover fixed z-[70] w-[260px] p-1"
            style={{ left: slash.left, top: slash.top }}
            onPointerDown={(event) => event.preventDefault()}
          >
            {commands.map((command, index) => (
              <button
                key={command.id}
                type="button"
                role="option"
                aria-selected={index === slash.index}
                onClick={() => runCommand(command)}
                onPointerEnter={() => setSlash({ ...slash, index })}
                className={cn('flex w-full items-center gap-2 rounded-[4px] px-2 py-1.5 text-left', index === slash.index && 'bg-hover')}
              >
                <AppIcon icon={command.icon} size={15} className="text-ink-2" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px]">{command.label}</span>
                  <span className="block truncate text-[11px] text-ink-2">{command.hint}</span>
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      <AnalysisPanel />

      <footer className="shrink-0 border-t border-line px-3 py-2">
        {error && (
          <div role="alert" data-testid="analysis-error" className="mb-2 flex items-start gap-1.5 rounded-[5px] bg-danger-soft px-2 py-1.5 text-xs text-danger">
            <AppIcon icon="lucide:circle-alert" size={14} className="mt-px" />
            <span className="min-w-0 flex-1 break-words">{error}</span>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {running ? (
            <button type="button" className="btn btn-outline flex-1" data-testid="cancel-analysis" onClick={() => void store().cancelAnalysis()}>
              <AppIcon icon="lucide:square" size={13} />
              Cancel
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-primary flex-1"
              data-testid="analyze-button"
              title={online && textModel ? `Analyze & Structure Deck with ${textModel}` : 'Start Ollama and choose a text model first'}
              onClick={() => void store().analyzeScript()}
            >
              <AppIcon icon="lucide:sparkles" size={14} />
              Analyze &amp; Generate Slides
            </button>
          )}
          <button
            type="button"
            className="btn btn-outline"
            data-testid="outline-button"
            title="Split on blank lines into slides, without using AI"
            disabled={running}
            onClick={() => store().buildFromOutline()}
          >
            <AppIcon icon="lucide:list-tree" size={14} />
            Build from outline
          </button>
          <span className="ml-auto text-[11px] text-ink-3 tabular-nums" data-testid="word-count">
            {wordCount} word{wordCount === 1 ? '' : 's'}
          </span>
        </div>
      </footer>
    </section>
  );
}

function ViewTab({ label, icon, active, onClick, testId }: { label: string; icon: string; active: boolean; onClick: () => void; testId?: string }) {
  return (
    <button type="button" role="tab" aria-selected={active} data-testid={testId} className={cn('btn h-6 px-1.5 text-xs font-normal text-ink-2', active && 'bg-hover text-ink')} onClick={onClick}>
      <AppIcon icon={icon} size={13} />
      {label}
    </button>
  );
}

function AnalysisPanel() {
  const running = useDeckStore((state) => state.analysis.running);
  const live = useDeckStore((state) => state.analysis.live);
  const model = useDeckStore((state) => state.activeTextModel);
  const logRef = useRef<HTMLPreElement>(null);

  useLayoutEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [live]);

  if (!running) return null;

  return (
    <div data-testid="analysis-panel" className="shrink-0 border-t border-line bg-sidebar px-3 py-2">
      <div className="flex items-center gap-1.5 text-xs text-ink-2">
        <AppIcon icon="lucide:loader-circle" size={13} className="spin" />
        <span className="truncate">{live ? `Structuring with ${model}` : `Loading ${model}. The first run can take a minute.`}</span>
      </div>
      <div className="progress-track mt-1.5">
        <div className="progress-fill progress-indeterminate" />
      </div>
      <pre ref={logRef} data-testid="analysis-live" className="mt-1.5 h-20 overflow-hidden font-mono text-[10.5px] leading-snug break-all whitespace-pre-wrap text-ink-3">
        {live.slice(-900)}
      </pre>
    </div>
  );
}

function DiffView() {
  const slides = useDeckStore((state) => selectActiveProject(state)?.slides ?? []);
  const requestScrollTo = useDeckStore((state) => state.requestScrollTo);

  const rows = useMemo(
    () =>
      slides.map((slide) => {
        const refined = [slide.refinedTitle, ...slide.executiveSummary].filter(Boolean).join('. ');
        return { id: slide.id, number: slide.slideNumber, title: slide.refinedTitle, tokens: diffWords(slide.originalExcerpt, refined), hasOriginal: Boolean(slide.originalExcerpt.trim()) };
      }),
    [slides],
  );

  return (
    <div data-testid="diff-view" className="absolute inset-0 overflow-y-auto px-4 py-3">
      <p className="mb-2 flex flex-wrap items-center gap-3 text-[11px] text-ink-2">
        <span className="diff-removed">Removed from your script</span>
        <span className="diff-added">Added by the AI</span>
      </p>
      <div className="flex flex-col gap-2">
        {rows.map((row) => (
          <div key={row.id} className="rounded-[5px] border border-line p-2" data-testid="diff-row">
            <button type="button" className="mb-1 flex w-full items-center gap-1 text-left text-xs font-medium text-ink-2 hover:text-ink" onClick={() => requestScrollTo(row.id)}>
              <span>Slide {row.number}</span>
              <AppIcon icon="lucide:arrow-right" size={12} />
            </button>
            {row.hasOriginal ? (
              <p className="text-[13px] leading-relaxed break-words whitespace-pre-wrap">
                {row.tokens.map((token, index) => (
                  <span key={index} className={token.kind === 'removed' ? 'diff-removed' : token.kind === 'added' ? 'diff-added' : undefined}>
                    {token.text}
                  </span>
                ))}
              </p>
            ) : (
              <p className="text-xs text-ink-3">This slide was added by hand, so there is no original text to compare.</p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
