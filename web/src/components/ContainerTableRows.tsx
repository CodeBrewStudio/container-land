import {
  ChevronDown,
  ChevronRight,
  Loader2,
  Play,
  RotateCw,
  Square,
  Terminal as TerminalIcon,
  Trash2,
} from 'lucide-react';
import type { ComposeGroup, ContainerSummary } from '../types';
import { formatBytes } from '../utils/format';
import type { ContainerTab } from './RightDrawer';

// ============================================================================
// SUBCOMPONENTS: COMPOSE GROUP ROWS & CONTAINER ROW
// ============================================================================

interface ComposeStackRowsProps {
  group: ComposeGroup;
  isCollapsed: boolean;
  isSelectedStack: boolean;
  selectedContainerId: string | null;
  compact: boolean;
  pendingActions: Record<string, string>;
  onToggleCollapse: () => void;
  onSelectStack: () => void;
  onSelectContainer: (ctr: ContainerSummary, tab?: ContainerTab) => void;
  onContainerAction: (
    id: string,
    action: 'start' | 'stop' | 'restart' | 'delete'
  ) => Promise<void>;
  onComposeAction: (
    project: string,
    action: 'start' | 'stop' | 'restart' | 'remove'
  ) => Promise<void>;
}

export function ComposeStackRows({
  group,
  isCollapsed,
  isSelectedStack,
  selectedContainerId,
  compact,
  pendingActions,
  onToggleCollapse,
  onSelectStack,
  onSelectContainer,
  onContainerAction,
  onComposeAction,
}: ComposeStackRowsProps) {
  const stackPending = pendingActions[`stack:${group.name}`];

  return (
    <>
      <tr
        onClick={onSelectStack}
        className={`cursor-pointer transition font-medium ${
          isSelectedStack
            ? 'bg-[var(--bg-elevated)] border-l-2 border-l-sky-400'
            : 'bg-[var(--bg-sidebar)]/80 hover:bg-[var(--bg-elevated)]/60'
        }`}
      >
        <td className="py-2 px-3">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onToggleCollapse();
              }}
              aria-label={isCollapsed ? `Expand ${group.name}` : `Collapse ${group.name}`}
              className="p-0.5 rounded hover:bg-[var(--bg-card)] text-[var(--text-muted)]"
            >
              {isCollapsed ? (
                <ChevronRight className="w-3.5 h-3.5" />
              ) : (
                <ChevronDown className="w-3.5 h-3.5" />
              )}
            </button>
            <span className="font-mono font-semibold">📦 {group.name}</span>
            <span
              className={`px-1.5 py-0.5 rounded font-mono text-xs ${
                group.status === 'running'
                  ? 'bg-emerald-500/15 text-emerald-400'
                  : group.status === 'partial'
                    ? 'bg-amber-500/15 text-amber-400'
                    : 'bg-zinc-500/20 text-[var(--text-muted)]'
              }`}
            >
              {group.runningCount}/{group.totalCount}
            </span>
          </div>
        </td>
        {!compact && (
          <td className="py-2 px-3 font-mono text-[var(--text-muted)] truncate max-w-[14rem]">
            compose stack
          </td>
        )}
        <td className="py-2 px-2.5">
          {stackPending ? (
            <span className="text-sky-400 inline-flex items-center gap-1 font-mono">
              <Loader2 className="w-3 h-3 animate-spin" />
              <span>{stackPending}ing...</span>
            </span>
          ) : (
            <span
              className={
                group.status === 'running'
                  ? 'text-emerald-400'
                  : group.status === 'partial'
                    ? 'text-amber-400'
                    : 'text-[var(--text-muted)]'
              }
            >
              {group.status === 'running'
                ? 'Active'
                : group.status === 'partial'
                  ? 'Partial'
                  : 'Stopped'}
            </span>
          )}
        </td>
        <td className="py-2 px-2.5 font-mono text-[var(--text-muted)]">
          {group.exposedPorts?.length > 0
            ? `${group.exposedPorts.length} exposed`
            : '—'}
        </td>
        <td className="py-2 px-2.5 font-mono tabular-nums">
          {group.cpuPercent.toFixed(1)}%
        </td>
        <td className="py-2 px-2.5 font-mono tabular-nums">
          {formatBytes(group.memUsageBytes)}
        </td>
        {!compact && (
          <td
            className="py-2 px-3 text-right space-x-1 whitespace-nowrap"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={onSelectStack}
              className="px-2 py-0.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-card)] hover:bg-[var(--bg-elevated)]"
              title="Stream interleaved stack logs"
            >
              Stack Logs
            </button>
            <button
              type="button"
              disabled={!!stackPending}
              onClick={() => onComposeAction(group.name, 'restart')}
              className="p-1 rounded border border-[var(--border-subtle)] bg-[var(--bg-card)] hover:bg-[var(--bg-elevated)] align-middle disabled:opacity-50"
              title="Restart stack"
              aria-label={`Restart ${group.name} stack`}
            >
              <RotateCw
                className={`w-3 h-3 ${stackPending === 'restart' ? 'animate-spin' : ''}`}
              />
            </button>
            <button
              type="button"
              disabled={!!stackPending}
              onClick={() =>
                onComposeAction(
                  group.name,
                  group.runningCount > 0 ? 'stop' : 'start'
                )
              }
              className="p-1 rounded border border-[var(--border-subtle)] bg-[var(--bg-card)] hover:bg-[var(--bg-elevated)] align-middle disabled:opacity-50"
              title={group.runningCount > 0 ? 'Stop stack' : 'Start stack'}
              aria-label={
                group.runningCount > 0
                  ? `Stop ${group.name} stack`
                  : `Start ${group.name} stack`
              }
            >
              {stackPending === 'stop' || stackPending === 'start' ? (
                <Loader2 className="w-3 h-3 animate-spin text-sky-400" />
              ) : group.runningCount > 0 ? (
                <Square className="w-3 h-3 text-rose-400" />
              ) : (
                <Play className="w-3 h-3 text-emerald-400" />
              )}
            </button>
          </td>
        )}
      </tr>

      {!isCollapsed &&
        group.containers.map((ctr) => (
          <ContainerRow
            key={ctr.id}
            ctr={ctr}
            indented={true}
            compact={compact}
            pendingAction={pendingActions[`ctr:${ctr.id}`]}
            isSelected={selectedContainerId === ctr.id}
            onSelect={(tab) => onSelectContainer(ctr, tab)}
            onAction={onContainerAction}
          />
        ))}
    </>
  );
}

interface ContainerRowProps {
  ctr: ContainerSummary;
  indented: boolean;
  compact: boolean;
  pendingAction?: string;
  isSelected: boolean;
  onSelect: (tab?: ContainerTab) => void;
  onAction: (
    id: string,
    action: 'start' | 'stop' | 'restart' | 'delete'
  ) => Promise<void>;
}

export function ContainerRow({
  ctr,
  indented,
  compact,
  pendingAction,
  isSelected,
  onSelect,
  onAction,
}: ContainerRowProps) {
  const isRunning = ctr.state === 'running';
  const publicPorts = (ctr.ports ?? []).filter((p) => p.publicPort);

  return (
    <tr
      onClick={() => onSelect()}
      className={`cursor-pointer transition ${
        isSelected
          ? 'bg-[var(--bg-elevated)] border-l-2 border-l-emerald-500'
          : 'hover:bg-[var(--bg-card)]'
      }`}
    >
      <td className={`py-2 pr-3 ${indented ? 'pl-8' : 'pl-3'}`}>
        <div className="flex items-center gap-2 font-mono">
          <span
            className={`w-2 h-2 rounded-full shrink-0 ${
              isRunning ? 'bg-emerald-500' : 'bg-zinc-500'
            }`}
          />
          <span className="font-semibold truncate">{ctr.name}</span>
          {compact && (
            <span className="text-[var(--text-muted)] truncate max-w-[9rem]">
              {ctr.image}
            </span>
          )}
        </div>
      </td>

      {!compact && (
        <td className="py-2 px-3 font-mono text-[var(--text-muted)] truncate max-w-[14rem]">
          {ctr.image}
        </td>
      )}

      <td className="py-2 px-2.5">
        {pendingAction ? (
          <span className="text-sky-400 inline-flex items-center gap-1 font-mono">
            <Loader2 className="w-3 h-3 animate-spin" />
            <span>{pendingAction}ing...</span>
          </span>
        ) : (
          <span className={isRunning ? 'text-emerald-400' : 'text-[var(--text-muted)]'}>
            {ctr.status}
          </span>
        )}
      </td>

      <td className="py-2 px-2.5 font-mono" onClick={(e) => e.stopPropagation()}>
        {publicPorts.length === 0 ? (
          <span className="text-[var(--text-muted)]">—</span>
        ) : (
          <div className="flex flex-wrap gap-1">
            {publicPorts.slice(0, 2).map((p) => (
              <a
                key={`${p.publicPort}:${p.privatePort}`}
                href={`http://localhost:${p.publicPort}`}
                target="_blank"
                rel="noreferrer"
                className="px-1.5 py-0.5 rounded bg-[var(--bg-sidebar)] border border-[var(--border-subtle)] text-sky-400 underline hover:opacity-80"
              >
                :{p.publicPort}→{p.privatePort}
              </a>
            ))}
          </div>
        )}
      </td>

      <td className="py-2 px-2.5 font-mono tabular-nums">
        {isRunning ? `${ctr.cpuPercent.toFixed(1)}%` : '0.0%'}
      </td>

      <td className="py-2 px-2.5 font-mono tabular-nums">
        {isRunning ? formatBytes(ctr.memUsageBytes) : '0 B'}
      </td>

      {!compact && (
        <td
          className="py-2 px-3 text-right space-x-1 whitespace-nowrap"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            onClick={() => onSelect('logs')}
            className="px-1.5 py-0.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-card)] hover:bg-[var(--bg-elevated)]"
          >
            Logs
          </button>
          <button
            type="button"
            onClick={() => onSelect('exec')}
            className="px-1.5 py-0.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-card)] hover:bg-[var(--bg-elevated)] inline-flex items-center gap-0.5"
            title="Open interactive shell"
          >
            <TerminalIcon className="w-3 h-3" />
            <span>Exec</span>
          </button>
          {isRunning ? (
            <>
              <button
                type="button"
                disabled={!!pendingAction}
                onClick={() => onAction(ctr.id, 'restart')}
                className="p-1 rounded border border-[var(--border-subtle)] bg-[var(--bg-card)] hover:bg-[var(--bg-elevated)] align-middle disabled:opacity-50"
                title="Restart"
                aria-label={`Restart ${ctr.name}`}
              >
                <RotateCw
                  className={`w-3 h-3 ${pendingAction === 'restart' ? 'animate-spin' : ''}`}
                />
              </button>
              <button
                type="button"
                disabled={!!pendingAction}
                onClick={() => onAction(ctr.id, 'stop')}
                className="p-1 rounded border border-[var(--border-subtle)] bg-[var(--bg-card)] hover:bg-[var(--bg-elevated)] align-middle disabled:opacity-50"
                title="Stop"
                aria-label={`Stop ${ctr.name}`}
              >
                {pendingAction === 'stop' ? (
                  <Loader2 className="w-3 h-3 animate-spin text-sky-400" />
                ) : (
                  <Square className="w-3 h-3 text-rose-400" />
                )}
              </button>
            </>
          ) : (
            <button
              type="button"
              disabled={!!pendingAction}
              onClick={() => onAction(ctr.id, 'start')}
              className="p-1 rounded border border-emerald-500/40 bg-emerald-500/10 text-emerald-400 align-middle disabled:opacity-50"
              title="Start"
              aria-label={`Start ${ctr.name}`}
            >
              {pendingAction === 'start' ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <Play className="w-3 h-3" />
              )}
            </button>
          )}
          <button
            type="button"
            disabled={!!pendingAction}
            onClick={() => onAction(ctr.id, 'delete')}
            className="p-1 rounded border border-[var(--border-subtle)] bg-[var(--bg-card)] hover:text-rose-400 align-middle disabled:opacity-50"
            title="Delete"
            aria-label={`Delete ${ctr.name}`}
          >
            <Trash2 className="w-3 h-3" />
          </button>
        </td>
      )}
    </tr>
  );
}
