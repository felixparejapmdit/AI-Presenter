import { memo, useMemo } from 'react';
import { formatBytes, formatSpeed, cn } from '../../lib/utils';
import { useDeckStore, type PullState } from '../../store/useDeckStore';
import type { LeaderStyle, ModelRecommendation, ThemeMode } from '../../types/deck';
import { bridge } from '../../lib/bridge';
import { AppIcon } from '../ui/AppIcon';
import { Modal } from '../ui/Modal';
import { Select } from '../ui/Select';

export const OLLAMA_DOWNLOAD_URL = 'https://ollama.com/download';

export function ModelManagerModal() {
  const setOpen = useDeckStore((state) => state.setModelManagerOpen);
  const checking = useDeckStore((state) => state.updateCheck);
  const online = useDeckStore((state) => state.ollama?.online ?? false);
  const store = useDeckStore.getState;

  return (
    <Modal
      title="Settings & AI Engine"
      subtitle="Hardware, local models and preferences"
      onClose={() => setOpen(false)}
      className="h-[min(90vh,820px)] max-w-[860px]"
      testId="model-manager"
      headerActions={
        <button type="button" className="btn btn-outline" data-testid="check-updates" disabled={checking.running || !online} onClick={() => void store().checkForUpdates()}>
          <AppIcon icon="lucide:refresh-cw" size={14} className={checking.running ? 'spin' : undefined} />
          <span className="hidden sm:inline">{checking.running ? `Checking ${checking.done + 1} of ${checking.total}` : 'Check for Model Updates'}</span>
        </button>
      }
    >
      <div className="flex flex-col gap-5 p-4">
        <HardwareBanner />
        <DaemonRow />
        <ModelMatrix />
        <InstalledOthers />
        <Preferences />
      </div>
    </Modal>
  );
}

function SpecCell({ icon, label, value, detail, testId }: { icon: string; label: string; value: string; detail?: string; testId: string }) {
  return (
    <div className="min-w-0 rounded-[5px] border border-line bg-surface p-2.5">
      <div className="flex items-center gap-1.5 text-[11px] font-medium text-ink-2">
        <AppIcon icon={icon} size={13} />
        {label}
      </div>
      <div className="mt-1 truncate text-[13px] font-medium" title={value} data-testid={testId}>
        {value}
      </div>
      {detail && <div className="truncate text-[11px] text-ink-2">{detail}</div>}
    </div>
  );
}

function HardwareBanner() {
  const hardware = useDeckStore((state) => state.hardware);

  if (!hardware) {
    return (
      <section className="grid h-[132px] place-items-center rounded-[6px] border border-line bg-sidebar text-[13px] text-ink-2">
        <span className="flex items-center gap-1.5">
          <AppIcon icon="lucide:loader-circle" size={14} className="spin" />
          Reading machine specs
        </span>
      </section>
    );
  }

  const vramLabel = hardware.isUnifiedMemory ? 'Unified Memory' : 'VRAM';
  const vramValue = hardware.vramGb > 0 ? `${hardware.vramGb.toFixed(1)} GB` : 'None detected';

  return (
    <section aria-label="Machine specs" data-testid="hardware-banner" className="rounded-[6px] border border-line bg-sidebar p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="section-label">Live machine specs</h3>
        <span
          data-testid="tier-badge"
          data-tier={hardware.tierLevel}
          className="inline-flex h-6 items-center gap-1.5 rounded-[4px] px-2 text-[11px] font-semibold tracking-wide"
          style={{ background: 'var(--badge-bg)', color: 'var(--badge-fg)' }}
        >
          <AppIcon icon="tabler:gauge" size={13} />
          {hardware.tier}
        </span>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2 lg:grid-cols-4">
        <SpecCell icon="lucide:cpu" label="CPU" value={hardware.cpuBrand} detail={[hardware.cpuArch, hardware.cpuCores ? `${hardware.cpuCores} threads` : ''].filter(Boolean).join(', ')} testId="spec-cpu" />
        <SpecCell icon="tabler:cpu-2" label="System RAM" value={`${hardware.totalRamGb.toFixed(1)} GB`} detail={`${hardware.availableRamGb.toFixed(1)} GB available`} testId="spec-ram" />
        <SpecCell icon="lucide:monitor" label="GPU" value={hardware.gpuName} detail={hardware.detectionSource} testId="spec-gpu" />
        <SpecCell icon="lucide:memory-stick" label={vramLabel} value={vramValue} detail={`${hardware.effectiveMemoryGb.toFixed(1)} GB usable for AI`} testId="spec-vram" />
      </div>
    </section>
  );
}

function DaemonRow() {
  const ollama = useDeckStore((state) => state.ollama);
  if (!ollama) return null;
  return (
    <section className="flex flex-wrap items-center gap-2 text-[13px]" data-testid="daemon-row">
      <span className={cn('h-2 w-2 rounded-full', ollama.online ? 'bg-ok' : 'bg-danger')} />
      <span className="font-medium">{ollama.online ? 'Ollama is running' : 'Ollama is offline'}</span>
      {ollama.online && ollama.version && <span className="text-ink-2">Version {ollama.version}</span>}
      <span className="truncate text-xs text-ink-3">{ollama.endpoint}</span>
      {!ollama.online && <DaemonActions className="ml-auto" />}
    </section>
  );
}

export function DaemonActions({ className }: { className?: string }) {
  const installed = useDeckStore((state) => state.ollama?.installed ?? false);
  const launching = useDeckStore((state) => state.launching);
  const store = useDeckStore.getState;

  return (
    <div className={cn('flex items-center gap-1.5', className)}>
      {bridge.canLaunchOllama && installed && (
        <button type="button" className="btn btn-outline" data-testid="start-ollama" disabled={launching} onClick={() => void store().launchOllama()}>
          <AppIcon icon={launching ? 'lucide:loader-circle' : 'lucide:play'} size={14} className={launching ? 'spin' : undefined} />
          {launching ? 'Starting' : 'Start Ollama'}
        </button>
      )}
      {!installed && (
        <button type="button" className="btn btn-outline" data-testid="download-ollama" onClick={() => void bridge.openExternal(OLLAMA_DOWNLOAD_URL)}>
          <AppIcon icon="lucide:download" size={14} />
          Download Ollama
        </button>
      )}
      <button type="button" className="btn btn-icon" title="Check again" aria-label="Check again" data-testid="recheck-ollama" onClick={() => void store().refreshStatus()}>
        <AppIcon icon="lucide:refresh-cw" size={14} />
      </button>
    </div>
  );
}

function ModelMatrix() {
  const recommendations = useDeckStore((state) => state.hardware?.recommendations);
  const sections = useMemo(() => {
    const sort = (role: 'vision' | 'text') =>
      (recommendations ?? [])
        .filter((entry) => entry.role === role)
        .sort((a, b) => Number(b.recommended) - Number(a.recommended) || a.tierLevel - b.tierLevel);
    return [
      { role: 'vision' as const, title: 'Vision models', icon: 'lucide:eye', entries: sort('vision') },
      { role: 'text' as const, title: 'Text models', icon: 'lucide:type', entries: sort('text') },
    ];
  }, [recommendations]);

  if (!recommendations) return null;

  return (
    <div className="grid gap-4 md:grid-cols-2" data-testid="model-matrix">
      {sections.map((section) => (
        <section key={section.role} aria-label={section.title} data-testid={`models-${section.role}`}>
          <h3 className="section-label mb-1.5 flex items-center gap-1.5">
            <AppIcon icon={section.icon} size={13} />
            {section.title}
          </h3>
          <div className="flex flex-col gap-1.5">
            {section.entries.map((entry) => (
              <ModelRow key={entry.id} entry={entry} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

const ModelRow = memo(function ModelRow({ entry }: { entry: ModelRecommendation }) {
  const installed = useDeckStore((state) => state.models.some((model) => model.name === entry.id));
  const pull = useDeckStore((state) => state.pulls[entry.id]);
  const online = useDeckStore((state) => state.ollama?.online ?? false);
  const store = useDeckStore.getState;

  return (
    <div data-testid="model-row" data-model={entry.id} data-installed={installed} className="rounded-[5px] border border-line p-2.5">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
            <span className="truncate text-[13px] font-medium">{entry.displayName}</span>
            {installed && (
              <span className="inline-flex items-center text-ok" data-testid="installed-mark" title="Installed">
                <AppIcon icon="lucide:check" size={14} />
              </span>
            )}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[11px] text-ink-2">
            <code className="font-mono">{entry.id}</code>
            <span>{entry.sizeGb.toFixed(1)} GB</span>
          </div>
          {entry.recommended && (
            <span data-testid="recommended-badge" className="mt-1 inline-flex h-[18px] items-center gap-1 rounded-[4px] bg-accent-soft px-1.5 text-[10.5px] font-medium text-accent">
              Recommended for your hardware
            </span>
          )}
          <p className="mt-1 text-[11.5px] leading-snug text-ink-2">{entry.reason}</p>
        </div>
        {pull ? (
          <button type="button" className="btn btn-outline" data-testid="cancel-pull" onClick={() => void store().cancelPull(entry.id)}>
            <AppIcon icon="lucide:x" size={14} />
            Cancel
          </button>
        ) : (
          <button type="button" className="btn btn-outline" data-testid="pull-model" disabled={!online} title={online ? undefined : 'Start Ollama to download models'} onClick={() => void store().pullModel(entry.id)}>
            <AppIcon icon={installed ? 'lucide:refresh-cw' : 'lucide:download'} size={14} />
            {installed ? 'Update' : 'Pull'}
          </button>
        )}
      </div>
      {pull && <PullBar pull={pull} />}
    </div>
  );
});

function PullBar({ pull }: { pull: PullState }) {
  const hasTotal = pull.total > 0 && pull.completed > 0;
  return (
    <div className="mt-2" data-testid="pull-progress" data-percent={pull.percent.toFixed(1)}>
      <div className="progress-track">
        <div
          className={cn('progress-fill', !hasTotal && 'progress-indeterminate')}
          style={hasTotal ? { transform: `scaleX(${Math.min(1, pull.percent / 100)})` } : undefined}
          role="progressbar"
          aria-valuenow={Math.round(pull.percent)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`Downloading ${pull.model}`}
        />
      </div>
      <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-ink-2 tabular-nums">
        <span className="truncate" data-testid="pull-status">
          {hasTotal ? `${formatBytes(pull.completed)} of ${formatBytes(pull.total)}` : prettyStatus(pull.status)}
        </span>
        {hasTotal && pull.bytesPerSecond > 0 && <span data-testid="pull-speed">{formatSpeed(pull.bytesPerSecond)}</span>}
      </div>
    </div>
  );
}

function prettyStatus(status: string): string {
  if (!status || status === 'starting') return 'Connecting';
  if (status.startsWith('pulling manifest')) return 'Reading manifest';
  if (status.startsWith('verifying')) return 'Verifying download';
  if (status.startsWith('writing')) return 'Finishing';
  return status;
}

function InstalledOthers() {
  const models = useDeckStore((state) => state.models);
  const recommendations = useDeckStore((state) => state.hardware?.recommendations);
  const pulls = useDeckStore((state) => state.pulls);
  const store = useDeckStore.getState;

  const others = useMemo(() => {
    const known = new Set((recommendations ?? []).map((entry) => entry.id));
    return models.filter((model) => !known.has(model.name));
  }, [models, recommendations]);

  if (others.length === 0) return null;

  return (
    <section aria-label="Other installed models" data-testid="other-models">
      <h3 className="section-label mb-1.5">Other installed models</h3>
      <div className="flex flex-col gap-1.5">
        {others.map((model) => {
          const pull = pulls[model.name];
          return (
            <div key={model.name} data-testid="other-model" className="rounded-[5px] border border-line p-2.5">
              <div className="flex items-center gap-2">
                <AppIcon icon="lucide:check" size={14} className="text-ok" />
                <code className="min-w-0 flex-1 truncate font-mono text-[12px]">{model.name}</code>
                <span className="text-[11px] text-ink-2">{model.isVision ? 'Vision' : 'Text'}</span>
                <span className="text-[11px] text-ink-2 tabular-nums">{formatBytes(model.size)}</span>
                {pull ? (
                  <button type="button" className="btn btn-outline" onClick={() => void store().cancelPull(model.name)}>
                    <AppIcon icon="lucide:x" size={14} />
                    Cancel
                  </button>
                ) : (
                  <button type="button" className="btn btn-outline" onClick={() => void store().pullModel(model.name)}>
                    <AppIcon icon="lucide:refresh-cw" size={14} />
                    Update
                  </button>
                )}
              </div>
              {pull && <PullBar pull={pull} />}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string; icon: string }[]; onChange: (value: T) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-[5px] border border-line p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          data-testid={`pref-${option.value}`}
          className={cn('btn h-6 px-2 text-xs font-normal text-ink-2', value === option.value && 'bg-hover text-ink')}
          onClick={() => onChange(option.value)}
        >
          <AppIcon icon={option.icon} size={13} />
          {option.label}
        </button>
      ))}
    </div>
  );
}

function Preferences() {
  const theme = useDeckStore((state) => state.theme);
  const leaderStyle = useDeckStore((state) => state.leaderStyle);
  const models = useDeckStore((state) => state.models);
  const activeTextModel = useDeckStore((state) => state.activeTextModel);
  const activeVisionModel = useDeckStore((state) => state.activeVisionModel);
  const store = useDeckStore.getState;
  const textOptions = models.map((model) => ({ value: model.name, label: model.name }));
  const visionOptions = textOptions.filter((option) => models.find((model) => model.name === option.value)?.isVision);

  return (
    <section aria-label="Preferences" data-testid="preferences">
      <h3 className="section-label mb-1.5">Preferences</h3>
      <div className="flex flex-col divide-y divide-line rounded-[5px] border border-line">
        <div className="flex flex-wrap items-center justify-between gap-2 p-2.5">
          <span className="text-[13px]">Active text model</span>
          <Select value={activeTextModel} options={textOptions} onChange={(value) => store().setActiveTextModel(value)} label="Active text model" placeholder="None installed" icon="lucide:type" testId="pref-text-model" className="w-[200px]" emptyContent="No models installed yet." />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 p-2.5">
          <span className="text-[13px]">Active vision model</span>
          <Select value={activeVisionModel} options={visionOptions} onChange={(value) => store().setActiveVisionModel(value)} label="Active vision model" placeholder="None installed" icon="lucide:eye" testId="pref-vision-model" className="w-[200px]" emptyContent="No vision models installed yet." />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 p-2.5">
          <span className="text-[13px]">Appearance</span>
          <Segmented<ThemeMode>
            label="Appearance"
            value={theme}
            onChange={(value) => store().setTheme(value)}
            options={[
              { value: 'light', label: 'Light', icon: 'lucide:sun' },
              { value: 'dark', label: 'Dark', icon: 'lucide:moon' },
              { value: 'system', label: 'System', icon: 'lucide:monitor' },
            ]}
          />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 p-2.5">
          <span className="text-[13px]">Leader line style</span>
          <Segmented<LeaderStyle>
            label="Leader line style"
            value={leaderStyle}
            onChange={(value) => store().setLeaderStyle(value)}
            options={[
              { value: 'elbow', label: 'Elbow', icon: 'tabler:route-square-2' },
              { value: 'bezier', label: 'Bezier', icon: 'tabler:vector-bezier-2' },
            ]}
          />
        </div>
      </div>
    </section>
  );
}
