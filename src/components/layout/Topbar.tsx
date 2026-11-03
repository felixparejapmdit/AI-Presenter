import { useMemo } from 'react';
import { modKey, cn } from '../../lib/utils';
import { resolvedTheme, selectActiveProject, useDeckStore, type SaveState } from '../../store/useDeckStore';
import { AppIcon } from '../ui/AppIcon';
import { Select, type SelectOption } from '../ui/Select';

const SAVE_LABELS: Record<SaveState, { label: string; icon: string; className: string }> = {
  saved: { label: 'Saved', icon: 'lucide:check', className: 'text-ink-3' },
  pending: { label: 'Editing', icon: 'lucide:pencil', className: 'text-ink-3' },
  saving: { label: 'Saving', icon: 'lucide:cloud-upload', className: 'text-ink-3' },
  error: { label: 'Not saved', icon: 'lucide:circle-alert', className: 'text-danger' },
};

export function Topbar() {
  const projectName = useDeckStore((state) => selectActiveProject(state)?.name ?? '');
  const slideCount = useDeckStore((state) => selectActiveProject(state)?.slides.length ?? 0);
  const sidebarCollapsed = useDeckStore((state) => state.sidebarCollapsed);
  const saveState = useDeckStore((state) => state.saveState);
  const theme = useDeckStore((state) => state.theme);
  const models = useDeckStore((state) => state.models);
  const activeTextModel = useDeckStore((state) => state.activeTextModel);
  const activeVisionModel = useDeckStore((state) => state.activeVisionModel);
  const checking = useDeckStore((state) => state.updateCheck.running);
  const exporting = useDeckStore((state) => state.exportJob !== null);

  const store = useDeckStore.getState;
  const save = SAVE_LABELS[saveState];
  const isDark = resolvedTheme(theme) === 'dark';

  const { textOptions, visionOptions } = useMemo(() => {
    const describe = (parameterSize: string, family: string) => [parameterSize, family].filter(Boolean).join(' ');
    const text: SelectOption<string>[] = [...models]
      .sort((a, b) => Number(a.isVision) - Number(b.isVision))
      .map((model) => ({ value: model.name, label: model.name, hint: describe(model.parameterSize, model.family) }));
    const vision: SelectOption<string>[] = models
      .filter((model) => model.isVision)
      .map((model) => ({ value: model.name, label: model.name, hint: describe(model.parameterSize, model.family) }));
    return { textOptions: text, visionOptions: vision };
  }, [models]);

  const manageFooter = { label: 'Manage models', icon: 'lucide:settings', onSelect: () => store().setModelManagerOpen(true) };

  return (
    <header data-testid="topbar" className="@container flex h-11 shrink-0 items-center gap-1.5 border-b border-line bg-surface px-2">
      {sidebarCollapsed && (
        <button type="button" className="btn btn-icon" title="Show sidebar" aria-label="Show sidebar" data-testid="expand-sidebar" onClick={() => store().setSidebarCollapsed(false)}>
          <AppIcon icon="lucide:panel-left-open" />
        </button>
      )}

      <nav aria-label="Breadcrumb" data-testid="breadcrumbs" className="flex min-w-0 flex-1 items-center gap-1 pl-1 text-[13px]">
        <span className="hidden shrink-0 text-ink-2 @[720px]:inline">Projects</span>
        <AppIcon icon="lucide:chevron-right" size={13} className="hidden text-ink-3 @[720px]:inline" />
        <span className="min-w-0 truncate font-medium" data-testid="breadcrumb-project">
          {projectName}
        </span>
        <span className={cn('ml-1 hidden shrink-0 items-center gap-1 text-xs @[560px]:inline-flex', save.className)} data-testid="save-state" data-state={saveState} style={{ minWidth: 62 }}>
          <AppIcon icon={save.icon} size={12} />
          {save.label}
        </span>
      </nav>

      <div className="flex shrink-0 items-center gap-1" data-testid="model-switchers">
        <Select
          value={activeTextModel}
          options={textOptions}
          onChange={(value) => store().setActiveTextModel(value)}
          label="Active Text Model"
          placeholder="Text model"
          icon="lucide:type"
          testId="text-model-select"
          className="hidden w-[124px] @[680px]:block @[860px]:w-[148px] @[1040px]:w-[184px]"
          minMenuWidth={230}
          emptyContent="No models installed yet."
          footer={manageFooter}
        />
        <Select
          value={activeVisionModel}
          options={visionOptions}
          onChange={(value) => store().setActiveVisionModel(value)}
          label="Active Vision Model"
          placeholder="Vision model"
          icon="lucide:eye"
          testId="vision-model-select"
          className="hidden w-[124px] @[680px]:block @[860px]:w-[148px] @[1040px]:w-[184px]"
          minMenuWidth={230}
          emptyContent="No vision models installed yet."
          footer={manageFooter}
        />
        <button
          type="button"
          className="btn btn-icon hidden @[680px]:inline-flex"
          title="Check for Model Updates"
          aria-label="Check for Model Updates"
          data-testid="check-updates-top"
          disabled={checking}
          onClick={() => void store().checkForUpdates()}
        >
          <AppIcon icon="lucide:refresh-cw" size={14} className={checking ? 'spin' : undefined} />
        </button>
      </div>

      <div className="mx-0.5 hidden h-4 w-px bg-line @[680px]:block" />

      <button
        type="button"
        className="btn btn-icon"
        title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
        aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
        data-testid="theme-toggle"
        onClick={() => store().setTheme(isDark ? 'light' : 'dark')}
      >
        <AppIcon icon={isDark ? 'lucide:sun' : 'lucide:moon'} />
      </button>

      <ExportMenu disabled={slideCount === 0} busy={exporting} />

      <button
        type="button"
        className="btn btn-primary"
        data-testid="present-button"
        title={`Present (${modKey}+Enter)`}
        disabled={slideCount === 0}
        onClick={() => store().openPresenter()}
      >
        <AppIcon icon="lucide:play" size={14} />
        <span className="hidden @[420px]:inline">Present</span>
      </button>
    </header>
  );
}

function ExportMenu({ disabled, busy }: { disabled: boolean; busy: boolean }) {
  const store = useDeckStore.getState;
  return (
    <Select<'pdf' | 'pptx'>
      value={null}
      options={[
        { value: 'pdf', label: 'Export as PDF', icon: 'lucide:file-text', hint: 'High-DPI pages with callouts' },
        { value: 'pptx', label: 'Export as PowerPoint', icon: 'lucide:presentation', hint: 'Slides plus speaker notes' },
      ]}
      onChange={(format) => void store().exportDeck(format)}
      label="Export"
      placeholder={busy ? 'Exporting' : 'Export'}
      icon="lucide:download"
      testId="export-button"
      className="w-[104px]"
      minMenuWidth={230}
      plainPlaceholder
      disabled={disabled || busy}
    />
  );
}
