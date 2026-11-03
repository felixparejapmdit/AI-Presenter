import { memo, useEffect, useRef, useState } from 'react';
import { useDeckStore } from '../../store/useDeckStore';
import { cn } from '../../lib/utils';
import type { Project } from '../../types/deck';
import { AppIcon } from '../ui/AppIcon';
import { ConfirmDialog } from '../ui/Modal';

export function Sidebar() {
  const projects = useDeckStore((state) => state.projects);
  const activeProjectId = useDeckStore((state) => state.activeProjectId);
  const [pendingDelete, setPendingDelete] = useState<Project | null>(null);

  return (
    <aside data-testid="sidebar" aria-label="Projects" className="flex h-full w-[248px] shrink-0 flex-col border-r border-line bg-sidebar">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-3">
        <span className="flex h-5 w-5 items-center justify-center rounded-[4px]" style={{ background: 'var(--badge-bg)', color: 'var(--badge-fg)' }}>
          <AppIcon icon="lucide:presentation" size={13} />
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">Vanguard Deck</span>
        <button
          type="button"
          className="btn btn-icon"
          title="Hide sidebar"
          aria-label="Hide sidebar"
          data-testid="collapse-sidebar"
          onClick={() => useDeckStore.getState().setSidebarCollapsed(true)}
        >
          <AppIcon icon="lucide:panel-left-close" />
        </button>
      </div>

      <div className="flex h-8 shrink-0 items-center justify-between pr-2 pl-3">
        <span className="section-label">Projects</span>
        <button
          type="button"
          className="btn btn-icon h-6 w-6"
          title="New project"
          aria-label="New project"
          data-testid="new-project"
          onClick={() => useDeckStore.getState().createProject()}
        >
          <AppIcon icon="lucide:plus" size={15} />
        </button>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2" data-testid="project-tree">
        {projects.map((project) => (
          <ProjectNode key={project.id} project={project} active={project.id === activeProjectId} onRequestDelete={setPendingDelete} />
        ))}
      </nav>

      <AiStatusFooter />

      {pendingDelete && (
        <ConfirmDialog
          title="Delete this project?"
          message={`"${pendingDelete.name}" and all of its images will be permanently removed.`}
          confirmLabel="Delete project"
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => {
            void useDeckStore.getState().deleteProject(pendingDelete.id);
            setPendingDelete(null);
          }}
        />
      )}
    </aside>
  );
}

interface ProjectNodeProps {
  project: Project;
  active: boolean;
  onRequestDelete: (project: Project) => void;
}

const ProjectNode = memo(function ProjectNode({ project, active, onRequestDelete }: ProjectNodeProps) {
  const [expanded, setExpanded] = useState(true);
  const [renaming, setRenaming] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const store = useDeckStore.getState;

  useEffect(() => {
    if (renaming) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [renaming]);

  const commitRename = () => {
    const value = inputRef.current?.value ?? '';
    if (value.trim()) store().renameProject(project.id, value);
    setRenaming(false);
  };

  return (
    <div data-testid="project-node" data-project-id={project.id} data-active={active}>
      <div className={cn('group flex h-7 items-center gap-0.5 rounded-[4px] pr-0.5', active ? 'bg-hover' : 'hover:bg-hover')}>
        <button
          type="button"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[4px] text-ink-3 hover:text-ink"
          aria-label={expanded ? 'Collapse project' : 'Expand project'}
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          <AppIcon icon="lucide:chevron-right" size={14} className={cn(expanded && 'rotate-90')} />
        </button>

        {renaming ? (
          <input
            ref={inputRef}
            defaultValue={project.name}
            aria-label="Project name"
            data-testid="project-rename-input"
            onBlur={commitRename}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commitRename();
              if (event.key === 'Escape') {
                event.stopPropagation();
                setRenaming(false);
              }
            }}
            className="field-plain h-6 min-w-0 flex-1 rounded-[4px] bg-surface px-1 text-[13px] ring-1 ring-accent"
          />
        ) : (
          <button
            type="button"
            className={cn('flex min-w-0 flex-1 items-center gap-1.5 text-left text-[13px]', active ? 'font-medium' : 'text-ink')}
            data-testid="project-open"
            onClick={() => store().setActiveProject(project.id)}
            onDoubleClick={() => setRenaming(true)}
          >
            <AppIcon icon="lucide:file-text" size={14} className="text-ink-2" />
            <span className="truncate" data-testid="project-name">
              {project.name}
            </span>
          </button>
        )}

        {!renaming && (
          <span className="flex shrink-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
            <button type="button" className="btn btn-icon h-6 w-6" title="Rename" aria-label={`Rename ${project.name}`} data-testid="project-rename" onClick={() => setRenaming(true)}>
              <AppIcon icon="lucide:pencil" size={13} />
            </button>
            <button type="button" className="btn btn-icon btn-danger h-6 w-6" title="Delete" aria-label={`Delete ${project.name}`} data-testid="project-delete" onClick={() => onRequestDelete(project)}>
              <AppIcon icon="lucide:trash-2" size={13} />
            </button>
          </span>
        )}
      </div>

      {expanded && project.slides.length > 0 && (
        <ul className="mt-px mb-1 ml-[18px] border-l border-line pl-1.5">
          {project.slides.map((slide) => (
            <li key={slide.id}>
              <button
                type="button"
                data-testid="tree-slide"
                className="flex h-6 w-full items-center gap-1.5 rounded-[4px] px-1 text-left text-xs text-ink-2 hover:bg-hover hover:text-ink"
                onClick={() => {
                  store().setActiveProject(project.id);
                  store().requestScrollTo(slide.id);
                }}
              >
                <span className="w-3.5 shrink-0 text-right text-[10px] text-ink-3 tabular-nums">{slide.slideNumber}</span>
                <span className="truncate">{slide.refinedTitle || 'Untitled slide'}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
});

function AiStatusFooter() {
  const ollama = useDeckStore((state) => state.ollama);
  const modelCount = useDeckStore((state) => state.ollama?.modelCount ?? 0);
  const pullCount = useDeckStore((state) => Object.keys(state.pulls).length);

  const online = ollama?.online ?? false;
  let detail = 'Checking';
  if (ollama) detail = online ? `${modelCount} model${modelCount === 1 ? '' : 's'} installed` : 'Daemon offline';
  if (pullCount > 0) detail = `Downloading ${pullCount} model${pullCount === 1 ? '' : 's'}`;

  return (
    <div className="shrink-0 border-t border-line p-1.5">
      <button
        type="button"
        data-testid="open-settings"
        title="Settings & AI Engine"
        className="flex w-full items-center gap-2 rounded-[5px] px-2 py-1.5 text-left hover:bg-hover"
        onClick={() => useDeckStore.getState().setModelManagerOpen(true)}
      >
        <AppIcon icon="lucide:cpu" className="text-ink-2" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium">Settings &amp; AI Engine</span>
          <span className="flex items-center gap-1.5 truncate text-[11px] text-ink-2" data-testid="ai-status" data-online={online}>
            <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', online ? 'bg-ok' : ollama ? 'bg-danger' : 'bg-ink-3')} />
            {detail}
          </span>
        </span>
        <AppIcon icon="lucide:settings" size={14} className="text-ink-3" />
      </button>
    </div>
  );
}
