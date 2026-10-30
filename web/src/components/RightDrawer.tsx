import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Copy,
  Download,
  Eye,
  EyeOff,
  FolderOpen,
  HardDrive,
  Play,
  RotateCw,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import type {
  ComposeGroup,
  ContainerInspectDetail,
  ContainerStats,
  ContainerSummary,
  LogEntry,
  VolumeSummary,
} from '../types';
import {
  formatBytes,
  formatRelativeTime,
  formatShortTimestamp,
  isSecretEnvKey,
  stripAnsi,
} from '../utils/format';
import { ExecTerminal } from './ExecTerminal';

export type DrawerSelection =
  | { kind: 'container'; container: ContainerSummary; initialTab?: ContainerTab }
  | { kind: 'compose'; group: ComposeGroup }
  | { kind: 'volume'; volume: VolumeSummary };

export type ContainerTab = 'logs' | 'exec' | 'stats' | 'env' | 'inspect';

interface RightDrawerProps {
  selection: DrawerSelection;
  onClose: () => void;
  onContainerAction: (id: string, action: 'start' | 'stop' | 'restart' | 'delete') => Promise<void>;
  onComposeAction: (project: string, action: 'start' | 'stop' | 'restart' | 'remove') => Promise<void>;
  onSelectContainer: (ctr: ContainerSummary, tab?: ContainerTab) => void;
  onDeleteVolume?: (name: string) => void;
}

const SERVICE_COLOURS = [
  'text-sky-400 border-sky-500/30 bg-sky-500/10',
  'text-emerald-400 border-emerald-500/30 bg-emerald-500/10',
  'text-amber-400 border-amber-500/30 bg-amber-500/10',
  'text-purple-400 border-purple-500/30 bg-purple-500/10',
  'text-rose-400 border-rose-500/30 bg-rose-500/10',
  'text-cyan-400 border-cyan-500/30 bg-cyan-500/10',
];

const SERVICE_TEXT_COLOURS = [
  'text-sky-400',
  'text-emerald-400',
  'text-amber-400',
  'text-purple-400',
  'text-rose-400',
  'text-cyan-400',
];

export function RightDrawer({
  selection,
  onClose,
  onContainerAction,
  onComposeAction,
  onSelectContainer,
  onDeleteVolume,
}: RightDrawerProps) {
  const [activeTab, setActiveTab] = useState<ContainerTab>(
    selection.kind === 'container' && selection.initialTab ? selection.initialTab : 'logs'
  );

  // Sync tab when user clicks a specific action button (e.g. ">_ Exec" or "Logs")
  useEffect(() => {
    if (selection.kind === 'container' && selection.initialTab) {
      setActiveTab(selection.initialTab);
    }
  }, [selection]);

  // Logs state (used by both Container logs and Compose stack logs)
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [logSearch, setLogSearch] = useState('');
  const [showTimestamps, setShowTimestamps] = useState(true);
  const [wrapLines, setWrapLines] = useState(true);
  const [autoScroll, setAutoScroll] = useState(true);
  const [selectedService, setSelectedService] = useState<string>('all');
  const logContainerRef = useRef<HTMLDivElement | null>(null);

  // Container inspect & live stats state
  const [inspectDetail, setInspectDetail] = useState<ContainerInspectDetail | null>(null);
  const [statsHistory, setStatsHistory] = useState<ContainerStats[]>([]);
  const [revealSecrets, setRevealSecrets] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const selectionKey =
    selection.kind === 'container'
      ? `ctr:${selection.container.id}`
      : selection.kind === 'compose'
        ? `compose:${selection.group.name}`
        : `vol:${selection.volume.name}`;

  useEffect(() => {
    setSelectedService('all');
    setLogSearch('');
  }, [selectionKey]);

  // Stream SSE logs for either Container Mode (when activeTab === 'logs') or Compose Stack Mode
  useEffect(() => {
    if (selection.kind === 'volume') {
      return;
    }
    if (selection.kind === 'container' && activeTab !== 'logs') {
      return;
    }

    setLogs([]);
    const url =
      selection.kind === 'container'
        ? `/api/containers/${encodeURIComponent(selection.container.id)}/logs?tail=300&follow=true`
        : `/api/compose/${encodeURIComponent(selection.group.name)}/logs?tail=120`;

    const es = new EventSource(url);
    es.addEventListener('log', (ev) => {
      try {
        const entry = JSON.parse((ev as MessageEvent).data) as LogEntry;
        setLogs((prev) => {
          const next = [...prev, entry];
          return next.length > 1500 ? next.slice(next.length - 1500) : next;
        });
      } catch {
        // ignore malformed line
      }
    });

    return () => {
      es.close();
    };
  }, [selectionKey, selection.kind, activeTab]);

  // Auto-scroll log viewer
  useEffect(() => {
    if (autoScroll && logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  // Fetch Container Inspect Detail when viewing a container
  const selectedContainerId =
    selection.kind === 'container' ? selection.container.id : null;

  useEffect(() => {
    if (!selectedContainerId) {
      setInspectDetail(null);
      return;
    }
    let cancelled = false;
    fetch(`/api/containers/${encodeURIComponent(selectedContainerId)}/inspect`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: ContainerInspectDetail | null) => {
        if (!cancelled && data) setInspectDetail(data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [selectedContainerId]);

  // Stream live 1-second stats when on the 'stats' tab
  useEffect(() => {
    if (!selectedContainerId || activeTab !== 'stats') {
      return;
    }
    setStatsHistory([]);
    const es = new EventSource(
      `/api/containers/${encodeURIComponent(selectedContainerId)}/stats`
    );
    es.addEventListener('stats', (ev) => {
      try {
        const sample = JSON.parse((ev as MessageEvent).data) as ContainerStats;
        setStatsHistory((prev) => [...prev.slice(-29), sample]);
      } catch {
        // ignore
      }
    });
    return () => {
      es.close();
    };
  }, [selectedContainerId, activeTab]);

  const filteredLogs = useMemo(() => {
    const q = logSearch.trim().toLowerCase();
    return logs.filter((entry) => {
      if (
        selection.kind === 'compose' &&
        selectedService !== 'all' &&
        entry.service !== selectedService &&
        entry.containerName !== selectedService
      ) {
        return false;
      }
      if (!q) return true;
      const clean = stripAnsi(entry.message).toLowerCase();
      return (
        clean.includes(q) ||
        (entry.service && entry.service.toLowerCase().includes(q)) ||
        (entry.containerName && entry.containerName.toLowerCase().includes(q))
      );
    });
  }, [logs, logSearch, selection.kind, selectedService]);

  const formatVisibleLogsText = () =>
    filteredLogs
      .map((l) => {
        const ts = l.timestamp ? `${l.timestamp} ` : '';
        const svc = l.service ? `[${l.service}] ` : '';
        return `${ts}${svc}[${l.stream}] ${stripAnsi(l.message)}`;
      })
      .join('\n');

  const downloadLogs = (filenamePrefix: string) => {
    const content = formatVisibleLogsText();
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${filenamePrefix}-logs.log`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const copyText = (key: string, val: string) => {
    navigator.clipboard.writeText(val).catch(() => {});
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 1500);
  };

  // =========================================================================
  // MODE C: VOLUME INSPECTOR DRAWER
  // =========================================================================
  if (selection.kind === 'volume') {
    const vol = selection.volume;
    const labelEntries = Object.entries(vol.labels || {});
    return (
      <aside
        aria-label={`Volume inspector for ${vol.shortName}`}
        className="w-1/2 bg-[var(--bg-card)] border-l border-[var(--border-subtle)] flex flex-col min-w-0 shrink-0 select-text"
      >
        <div className="px-3.5 py-2.5 border-b border-[var(--border-subtle)] bg-[var(--bg-sidebar)] flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-xs font-mono px-1.5 py-0.5 rounded bg-purple-500/15 text-purple-400 border border-purple-500/30">
                VOLUME
              </span>
              <h2 className="font-mono text-sm font-semibold truncate" title={vol.name}>
                {vol.shortName}
              </h2>
              {vol.anonymous ? (
                <span className="px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400 text-xs font-mono">
                  Anonymous
                </span>
              ) : (
                <span className="px-1.5 py-0.5 rounded bg-sky-500/15 text-sky-400 text-xs font-mono">
                  Named
                </span>
              )}
            </div>
            <div className="text-xs text-[var(--text-muted)] font-mono mt-0.5 truncate">
              Driver: {vol.driver} · Size:{' '}
              {vol.sizeBytes >= 0 ? formatBytes(vol.sizeBytes) : 'Unknown'} · Created{' '}
              {formatRelativeTime(vol.createdAt)}
            </div>
          </div>

          <div className="flex items-center gap-1 shrink-0 text-xs">
            {onDeleteVolume && (
              <button
                type="button"
                disabled={vol.inUse}
                onClick={() => onDeleteVolume(vol.name)}
                className="px-2 py-1 rounded border border-rose-500/40 bg-rose-500/10 text-rose-400 hover:bg-rose-500/20 disabled:opacity-40 inline-flex items-center gap-1"
                title={
                  vol.inUse
                    ? 'Cannot delete volume while attached to a container'
                    : 'Delete volume'
                }
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>Delete</span>
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close inspector drawer"
              className="p-1 rounded hover:bg-[var(--bg-elevated)] text-[var(--text-muted)]"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="flex-1 p-3.5 overflow-auto bg-[var(--bg-canvas)] space-y-3 text-xs">
          {/* Inferred Content / Purpose Card */}
          <div className="p-3.5 rounded-lg bg-[var(--bg-card)] border border-[var(--border-subtle)] space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 font-semibold text-sm">
                <HardDrive className="w-4 h-4 text-purple-400" />
                <span>Inferred Volume Purpose &amp; Contents</span>
              </div>
              <span
                className={`px-2 py-0.5 rounded font-mono text-xs ${
                  vol.inUse
                    ? 'bg-emerald-500/15 text-emerald-400'
                    : 'bg-zinc-500/15 text-[var(--text-muted)]'
                }`}
              >
                {vol.inUse ? 'Attached' : 'Unattached (Orphaned)'}
              </span>
            </div>

            <div className="p-2.5 rounded bg-[var(--bg-sidebar)] border border-[var(--border-subtle)]">
              <div className="text-[var(--text-muted)] text-xs">Detected Content Signature</div>
              <div className="text-sm font-mono font-semibold text-purple-400 mt-0.5">
                {vol.contentHint || 'Unknown / Uninspected volume'}
              </div>
              {vol.anonymous && !vol.inUse && (
                <p className="text-xs text-[var(--text-muted)] mt-1">
                  This is an unattached anonymous volume (created automatically by a container&apos;s{' '}
                  <code className="font-mono">VOLUME</code> instruction when the container ran, and
                  left behind when the container was removed without <code className="font-mono">-v</code>).
                </p>
              )}
            </div>

            <div>
              <div className="flex items-center gap-1.5 text-[var(--text-muted)] font-medium mb-1.5">
                <FolderOpen className="w-3.5 h-3.5 text-sky-400" />
                <span>
                  Top-Level Files &amp; Directories Inside Volume ({vol.topEntries?.length ?? 0})
                </span>
              </div>
              {!vol.topEntries || vol.topEntries.length === 0 ? (
                <div className="p-2 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)] font-mono text-[var(--text-muted)]">
                  Volume directory is empty (0 files).
                </div>
              ) : (
                <div className="flex flex-wrap gap-1.5 p-2.5 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)] font-mono">
                  {vol.topEntries.map((entry) => (
                    <span
                      key={entry}
                      className="px-2 py-0.5 rounded bg-[var(--bg-card)] border border-[var(--border-subtle)] text-xs"
                    >
                      {entry}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Container Mounts */}
          <div className="p-3.5 rounded-lg bg-[var(--bg-card)] border border-[var(--border-subtle)] space-y-2">
            <div className="font-semibold">Container Mounts</div>
            {vol.mountPaths && vol.mountPaths.length > 0 ? (
              <div className="space-y-1 font-mono">
                {vol.mountPaths.map((mp) => (
                  <div
                    key={mp}
                    className="p-2 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)] text-emerald-400"
                  >
                    {mp}
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-[var(--text-muted)]">
                Not currently mounted by any running or stopped container.
              </div>
            )}
          </div>

          {/* Full Volume ID & Host Path */}
          <div className="p-3.5 rounded-lg bg-[var(--bg-card)] border border-[var(--border-subtle)] space-y-2 font-mono">
            <div className="flex items-center justify-between">
              <span className="font-sans font-semibold">Volume Identifier &amp; Host Path</span>
              <button
                type="button"
                onClick={() => copyText('vol-name', vol.name)}
                className="px-2 py-0.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] inline-flex items-center gap-1 font-sans text-xs"
              >
                <Copy className="w-3 h-3" />
                <span>{copiedKey === 'vol-name' ? 'Copied!' : 'Copy Full Name'}</span>
              </button>
            </div>
            <div className="space-y-1 text-xs break-all">
              <div>
                <span className="text-[var(--text-muted)]">Name: </span>
                <span>{vol.name}</span>
              </div>
              <div>
                <span className="text-[var(--text-muted)]">Mountpoint: </span>
                <span className="text-[var(--text-muted)]">{vol.mountpoint}</span>
              </div>
              {vol.composeProject && (
                <div>
                  <span className="text-[var(--text-muted)]">Compose Project: </span>
                  <span className="text-sky-400">{vol.composeProject}</span>
                </div>
              )}
            </div>
          </div>

          {/* Volume Labels */}
          {labelEntries.length > 0 && (
            <div className="p-3.5 rounded-lg bg-[var(--bg-card)] border border-[var(--border-subtle)] space-y-2 font-mono">
              <div className="font-sans font-semibold">Docker Labels ({labelEntries.length})</div>
              <div className="divide-y divide-[var(--border-subtle)]">
                {labelEntries.map(([k, v]) => (
                  <div key={k} className="py-1 break-all">
                    <span className="text-sky-400">{k}</span>
                    <span className="text-[var(--text-muted)]"> = </span>
                    <span>{v || '""'}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </aside>
    );
  }

  // =========================================================================
  // MODE B: COMPOSE STACK DRAWER
  // =========================================================================
  if (selection.kind === 'compose') {
    const group = selection.group;
    const services = group.containers.map((c) => c.composeService || c.name);
    const serviceColourIndex = (svc?: string) => {
      if (!svc) return 0;
      const idx = services.indexOf(svc);
      return idx >= 0 ? idx % SERVICE_TEXT_COLOURS.length : 0;
    };

    return (
      <aside
        aria-label={`Compose stack inspector for ${group.name}`}
        className="w-1/2 bg-[var(--bg-card)] border-l border-[var(--border-subtle)] flex flex-col min-w-0 shrink-0 select-text"
      >
        {/* Header */}
        <div className="px-3.5 py-2.5 border-b border-[var(--border-subtle)] bg-[var(--bg-sidebar)] flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-xs font-mono px-1.5 py-0.5 rounded bg-sky-500/15 text-sky-400 border border-sky-500/30">
                STACK
              </span>
              <h2 className="font-mono text-sm font-semibold truncate">{group.name}</h2>
              <span className="px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400 font-mono text-xs">
                {group.runningCount}/{group.totalCount} running
              </span>
            </div>
            <div className="text-xs text-[var(--text-muted)] font-mono mt-0.5 truncate">
              {group.configFiles || group.workingDir || 'Docker Compose Stack'} · CPU{' '}
              {group.cpuPercent.toFixed(1)}% · RAM {formatBytes(group.memUsageBytes)}
            </div>
          </div>

          <div className="flex items-center gap-1 shrink-0 text-xs">
            <button
              type="button"
              onClick={() => onComposeAction(group.name, 'start')}
              className="px-2 py-1 rounded border border-[var(--border-subtle)] bg-[var(--bg-card)] hover:bg-[var(--bg-elevated)] inline-flex items-center gap-1"
              title="Start all containers in stack"
            >
              <Play className="w-3 h-3 text-emerald-400" />
              <span>Start</span>
            </button>
            <button
              type="button"
              onClick={() => onComposeAction(group.name, 'restart')}
              className="px-2 py-1 rounded border border-[var(--border-subtle)] bg-[var(--bg-card)] hover:bg-[var(--bg-elevated)] inline-flex items-center gap-1"
              title="Restart all containers in stack"
            >
              <RotateCw className="w-3 h-3" />
              <span>Restart</span>
            </button>
            <button
              type="button"
              onClick={() => onComposeAction(group.name, 'stop')}
              className="px-2 py-1 rounded border border-rose-500/40 bg-rose-500/10 text-rose-400 hover:bg-rose-500/20 inline-flex items-center gap-1"
              title="Stop all containers in stack"
            >
              <Square className="w-3 h-3" />
              <span>Stop</span>
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close inspector drawer"
              className="p-1 rounded hover:bg-[var(--bg-elevated)] text-[var(--text-muted)]"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Service Filter Pills + Quick Jump */}
        <div className="px-3.5 py-2 border-b border-[var(--border-subtle)] bg-[var(--bg-card)] flex flex-wrap items-center justify-between gap-2 text-xs">
          <div className="flex flex-wrap items-center gap-1.5 font-mono">
            <span className="text-[var(--text-muted)] font-sans">Services:</span>
            <button
              type="button"
              onClick={() => setSelectedService('all')}
              className={`px-2 py-0.5 rounded border text-xs ${
                selectedService === 'all'
                  ? 'bg-[var(--accent-primary)] text-[var(--accent-primary-fg)] border-transparent font-semibold'
                  : 'border-[var(--border-subtle)] text-[var(--text-muted)]'
              }`}
            >
              All ({group.containers.length})
            </button>
            {group.containers.map((ctr, idx) => {
              const svc = ctr.composeService || ctr.name;
              const active = selectedService === svc;
              const colourCls = SERVICE_COLOURS[idx % SERVICE_COLOURS.length];
              return (
                <button
                  key={ctr.id}
                  type="button"
                  onClick={() => setSelectedService(active ? 'all' : svc)}
                  onDoubleClick={() => onSelectContainer(ctr, 'logs')}
                  title="Click to filter stack logs · Double-click to inspect container"
                  className={`px-2 py-0.5 rounded border text-xs transition ${
                    active ? 'ring-1 ring-current font-semibold ' + colourCls : colourCls
                  }`}
                >
                  {svc}
                </button>
              );
            })}
          </div>
        </div>

        {/* Log Search & Controls Toolbar */}
        <div className="px-3.5 py-2 border-b border-[var(--border-subtle)] bg-[var(--bg-canvas)] flex flex-wrap items-center justify-between gap-2 text-xs">
          <input
            type="search"
            value={logSearch}
            onChange={(e) => setLogSearch(e.target.value)}
            placeholder="Filter interleaved stack logs..."
            className="px-2.5 py-1 rounded bg-[var(--bg-card)] border border-[var(--border-subtle)] text-xs w-52 font-mono focus:outline-none"
          />
          <div className="flex items-center gap-1.5 font-mono text-xs">
            <button
              type="button"
              onClick={() => setAutoScroll((v) => !v)}
              className={`px-2 py-0.5 rounded border ${
                autoScroll
                  ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400'
                  : 'border-[var(--border-subtle)] text-[var(--text-muted)]'
              }`}
            >
              ● Follow
            </button>
            <button
              type="button"
              onClick={() => setShowTimestamps((v) => !v)}
              className="px-2 py-0.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-card)]"
            >
              Timestamps: {showTimestamps ? 'ON' : 'OFF'}
            </button>
            <button
              type="button"
              onClick={() => copyText('stack-logs', formatVisibleLogsText())}
              className="px-2 py-0.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-card)] inline-flex items-center gap-1"
              title="Copy visible logs to clipboard"
            >
              <Copy className="w-3 h-3" />
              <span>{copiedKey === 'stack-logs' ? 'Copied!' : 'Copy'}</span>
            </button>
            <button
              type="button"
              onClick={() => downloadLogs(group.name)}
              className="px-2 py-0.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-card)] inline-flex items-center gap-1"
              title="Download stack logs"
            >
              <Download className="w-3 h-3" />
            </button>
          </div>
        </div>

        {/* Interleaved Stack Log Stream */}
        <div
          ref={logContainerRef}
          className="flex-1 p-3 font-mono text-xs overflow-auto space-y-1 bg-[var(--bg-canvas)] select-text cursor-text"
        >
          {filteredLogs.length === 0 ? (
            <div className="text-[var(--text-muted)] py-8 text-center">
              Waiting for stack log output...
            </div>
          ) : (
            filteredLogs.map((entry, idx) => {
              const svc = entry.service || entry.containerName || 'service';
              const textColour = SERVICE_TEXT_COLOURS[serviceColourIndex(svc)];
              return (
                <div
                  key={idx}
                  className={`leading-relaxed select-text ${
                    wrapLines ? 'whitespace-pre-wrap break-all' : 'whitespace-pre'
                  }`}
                >
                  <span className={`font-semibold inline-block min-w-[7rem] ${textColour}`}>
                    {svc.padEnd(11, ' ')} |
                  </span>{' '}
                  {showTimestamps && entry.timestamp && (
                    <span className="text-[var(--text-muted)] mr-1.5">
                      {formatShortTimestamp(entry.timestamp)}
                    </span>
                  )}
                  <span className={entry.stream === 'stderr' ? 'text-amber-300' : ''}>
                    {stripAnsi(entry.message)}
                  </span>
                </div>
              );
            })
          )}
        </div>
      </aside>
    );
  }

  // =========================================================================
  // MODE A: SINGLE CONTAINER DRAWER
  // =========================================================================
  const ctr = selection.container;
  const isRunning = ctr.state === 'running';
  const latestStat =
    statsHistory.length > 0 ? statsHistory[statsHistory.length - 1] : null;
  const displayCPU = latestStat ? latestStat.cpuPercent : ctr.cpuPercent;
  const displayMem = latestStat ? latestStat.memUsageBytes : ctr.memUsageBytes;
  const displayMemLimit = latestStat ? latestStat.memLimitBytes : ctr.memLimitBytes;
  const displayNetRx = latestStat ? latestStat.netRxBytes : ctr.netRxBytes;
  const displayNetTx = latestStat ? latestStat.netTxBytes : ctr.netTxBytes;
  const displayBlkR = latestStat ? latestStat.blockReadBytes : ctr.blockReadBytes;
  const displayBlkW = latestStat ? latestStat.blockWriteBytes : ctr.blockWriteBytes;
  const displayPIDs = latestStat ? latestStat.pids : ctr.pids;

  return (
    <aside
      aria-label={`Container inspector for ${ctr.name}`}
      className="w-1/2 bg-[var(--bg-card)] border-l border-[var(--border-subtle)] flex flex-col min-w-0 shrink-0 select-text"
    >
      {/* Container Header */}
      <div className="px-3.5 py-2.5 border-b border-[var(--border-subtle)] bg-[var(--bg-sidebar)] flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span
              className={`w-2.5 h-2.5 rounded-full shrink-0 ${
                isRunning ? 'bg-emerald-500' : 'bg-zinc-500'
              }`}
            />
            <h2 className="font-mono text-sm font-semibold truncate">{ctr.name}</h2>
            {ctr.ports?.map((p) =>
              p.publicPort ? (
                <a
                  key={`${p.publicPort}:${p.privatePort}`}
                  href={`http://localhost:${p.publicPort}`}
                  target="_blank"
                  rel="noreferrer"
                  className="px-1.5 py-0.5 rounded bg-[var(--bg-card)] border border-[var(--border-subtle)] font-mono text-xs text-sky-400 underline hover:opacity-80"
                >
                  :{p.publicPort}→{p.privatePort}
                </a>
              ) : null
            )}
          </div>
          <div className="text-xs text-[var(--text-muted)] font-mono mt-0.5 truncate">
            {ctr.image} · {ctr.status} · CPU {displayCPU.toFixed(1)}% · RAM{' '}
            {formatBytes(displayMem)}
          </div>
        </div>

        <div className="flex items-center gap-1 shrink-0 text-xs">
          {!isRunning ? (
            <button
              type="button"
              onClick={() => onContainerAction(ctr.id, 'start')}
              className="px-2 py-1 rounded border border-emerald-500/40 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 inline-flex items-center gap-1"
            >
              <Play className="w-3 h-3" />
              <span>Start</span>
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={() => onContainerAction(ctr.id, 'restart')}
                className="px-2 py-1 rounded border border-[var(--border-subtle)] bg-[var(--bg-card)] hover:bg-[var(--bg-elevated)] inline-flex items-center gap-1"
                title="Restart container"
              >
                <RotateCw className="w-3 h-3" />
                <span>Restart</span>
              </button>
              <button
                type="button"
                onClick={() => onContainerAction(ctr.id, 'stop')}
                className="px-2 py-1 rounded border border-rose-500/40 bg-rose-500/10 text-rose-400 hover:bg-rose-500/20 inline-flex items-center gap-1"
                title="Stop container"
              >
                <Square className="w-3 h-3" />
                <span>Stop</span>
              </button>
            </>
          )}
          <button
            type="button"
            onClick={() => onContainerAction(ctr.id, 'delete')}
            className="p-1.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-card)] hover:text-rose-400"
            title="Delete container"
            aria-label="Delete container"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close inspector drawer"
            className="p-1 rounded hover:bg-[var(--bg-elevated)] text-[var(--text-muted)]"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Container Drawer Mode Tabs */}
      <div className="px-3.5 py-1.5 border-b border-[var(--border-subtle)] bg-[var(--bg-card)] flex items-center gap-1 text-xs">
        {(
          [
            ['logs', 'Logs'],
            ['exec', 'Terminal (Exec)'],
            ['stats', 'Live Stats'],
            ['env', 'Env & Mounts'],
            ['inspect', 'Inspect JSON'],
          ] as [ContainerTab, string][]
        ).map(([tabKey, label]) => (
          <button
            key={tabKey}
            type="button"
            onClick={() => setActiveTab(tabKey)}
            className={`px-2.5 py-1 rounded font-medium transition ${
              activeTab === tabKey
                ? 'bg-[var(--accent-primary)] text-[var(--accent-primary-fg)]'
                : 'text-[var(--text-muted)] hover:text-[var(--text-main)]'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* TAB 1: LOGS */}
      {activeTab === 'logs' && (
        <div className="flex-1 flex flex-col min-h-0 bg-[var(--bg-canvas)]">
          <div className="px-3.5 py-2 border-b border-[var(--border-subtle)] flex flex-wrap items-center justify-between gap-2 text-xs">
            <input
              type="search"
              value={logSearch}
              onChange={(e) => setLogSearch(e.target.value)}
              placeholder="Filter container logs..."
              className="px-2.5 py-1 rounded bg-[var(--bg-card)] border border-[var(--border-subtle)] text-xs w-48 font-mono focus:outline-none"
            />
            <div className="flex items-center gap-1.5 font-mono text-xs">
              <button
                type="button"
                onClick={() => setAutoScroll((v) => !v)}
                className={`px-2 py-0.5 rounded border ${
                  autoScroll
                    ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400'
                    : 'border-[var(--border-subtle)] text-[var(--text-muted)]'
                }`}
              >
                ● Follow
              </button>
              <button
                type="button"
                onClick={() => setShowTimestamps((v) => !v)}
                className="px-2 py-0.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-card)]"
              >
                Timestamps: {showTimestamps ? 'ON' : 'OFF'}
              </button>
              <button
                type="button"
                onClick={() => setWrapLines((v) => !v)}
                className="px-2 py-0.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-card)]"
              >
                Wrap: {wrapLines ? 'ON' : 'OFF'}
              </button>
              <button
                type="button"
                onClick={() => copyText('ctr-logs', formatVisibleLogsText())}
                className="px-2 py-0.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-card)] inline-flex items-center gap-1"
                title="Copy visible logs to clipboard"
              >
                <Copy className="w-3 h-3" />
                <span>{copiedKey === 'ctr-logs' ? 'Copied!' : 'Copy'}</span>
              </button>
              <button
                type="button"
                onClick={() => downloadLogs(ctr.name)}
                className="px-2 py-0.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-card)] inline-flex items-center gap-1"
                title="Download .log"
              >
                <Download className="w-3 h-3" />
              </button>
            </div>
          </div>

          <div
            ref={logContainerRef}
            className="flex-1 p-3 font-mono text-xs overflow-auto space-y-1 select-text cursor-text"
          >
            {filteredLogs.length === 0 ? (
              <div className="text-[var(--text-muted)] py-8 text-center">
                No log entries match the current view.
              </div>
            ) : (
              filteredLogs.map((entry, idx) => (
                <div
                  key={idx}
                  className={`leading-relaxed select-text ${
                    wrapLines ? 'whitespace-pre-wrap break-all' : 'whitespace-pre'
                  }`}
                >
                  {showTimestamps && entry.timestamp && (
                    <span className="text-[var(--text-muted)] mr-2">
                      {formatShortTimestamp(entry.timestamp)}
                    </span>
                  )}
                  <span
                    className={`mr-2 ${
                      entry.stream === 'stderr' ? 'text-amber-400' : 'text-sky-400'
                    }`}
                  >
                    [{entry.stream}]
                  </span>
                  <span>{stripAnsi(entry.message)}</span>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* TAB 2: INTERACTIVE TERMINAL (EXEC) */}
      {activeTab === 'exec' && (
        <ExecTerminal
          containerId={ctr.id}
          containerName={ctr.name}
          isRunning={isRunning}
        />
      )}

      {/* TAB 3: LIVE STATS */}
      {activeTab === 'stats' && (
        <div className="flex-1 p-3.5 overflow-auto bg-[var(--bg-canvas)] space-y-3 text-xs">
          <div className="grid grid-cols-2 gap-3">
            <div className="p-3 rounded-lg bg-[var(--bg-card)] border border-[var(--border-subtle)] space-y-1.5">
              <div className="flex justify-between text-[var(--text-muted)]">
                <span>CPU Utilisation</span>
                <span className="font-mono">{displayCPU.toFixed(2)}%</span>
              </div>
              <div className="text-lg font-mono font-semibold text-emerald-400">
                {displayCPU.toFixed(1)}%
              </div>
              <div className="w-full h-2 bg-[var(--bg-sidebar)] rounded-full overflow-hidden border border-[var(--border-subtle)]">
                <div
                  className="h-full bg-emerald-500 transition-all"
                  style={{ width: `${Math.min(100, displayCPU)}%` }}
                />
              </div>
            </div>

            <div className="p-3 rounded-lg bg-[var(--bg-card)] border border-[var(--border-subtle)] space-y-1.5">
              <div className="flex justify-between text-[var(--text-muted)]">
                <span>Memory (excl. page cache)</span>
                <span className="font-mono">
                  {displayMemLimit > 0
                    ? `${((displayMem / displayMemLimit) * 100).toFixed(1)}%`
                    : ''}
                </span>
              </div>
              <div className="text-lg font-mono font-semibold text-sky-400">
                {formatBytes(displayMem)}{' '}
                <span className="text-xs text-[var(--text-muted)] font-normal">
                  / {formatBytes(displayMemLimit)}
                </span>
              </div>
              <div className="w-full h-2 bg-[var(--bg-sidebar)] rounded-full overflow-hidden border border-[var(--border-subtle)]">
                <div
                  className="h-full bg-sky-500 transition-all"
                  style={{
                    width: `${
                      displayMemLimit > 0
                        ? Math.min(100, (displayMem / displayMemLimit) * 100)
                        : 0
                    }%`,
                  }}
                />
              </div>
            </div>

            <div className="p-3 rounded-lg bg-[var(--bg-card)] border border-[var(--border-subtle)] space-y-1">
              <div className="text-[var(--text-muted)]">Network Traffic (RX / TX)</div>
              <div className="text-base font-mono font-semibold">
                ↓ {formatBytes(displayNetRx)} · ↑ {formatBytes(displayNetTx)}
              </div>
              <div className="text-[var(--text-muted)] font-mono">
                Networks: {ctr.networks?.join(', ') || 'default'}
              </div>
            </div>

            <div className="p-3 rounded-lg bg-[var(--bg-card)] border border-[var(--border-subtle)] space-y-1">
              <div className="text-[var(--text-muted)]">Block Disk I/O &amp; PIDs</div>
              <div className="text-base font-mono font-semibold">
                R {formatBytes(displayBlkR)} · W {formatBytes(displayBlkW)}
              </div>
              <div className="text-[var(--text-muted)] font-mono">
                Active PIDs: {displayPIDs}
              </div>
            </div>
          </div>

          {statsHistory.length > 1 && (
            <div className="p-3 rounded-lg bg-[var(--bg-card)] border border-[var(--border-subtle)] space-y-2">
              <div className="text-[var(--text-muted)] font-medium">
                Live CPU Sample History (last {statsHistory.length}s)
              </div>
              <div className="flex items-end gap-1 h-20 pt-2">
                {statsHistory.map((pt, i) => (
                  <div
                    key={i}
                    className="flex-1 bg-emerald-500/60 rounded-t"
                    style={{
                      height: `${Math.max(4, Math.min(100, pt.cpuPercent))}%`,
                    }}
                    title={`${pt.cpuPercent.toFixed(1)}%`}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* TAB 4: ENV & MOUNTS */}
      {activeTab === 'env' && (
        <div className="flex-1 p-3.5 overflow-auto bg-[var(--bg-canvas)] space-y-3 text-xs font-mono">
          {/* Mounts */}
          <div className="p-3 rounded-lg bg-[var(--bg-card)] border border-[var(--border-subtle)] space-y-2">
            <div className="font-sans font-semibold text-[var(--text-main)]">
              Mounts &amp; Volumes ({inspectDetail?.mounts?.length ?? ctr.mounts?.length ?? 0})
            </div>
            {(inspectDetail?.mounts ?? ctr.mounts ?? []).length === 0 ? (
              <div className="text-[var(--text-muted)]">No mounts attached.</div>
            ) : (
              <div className="space-y-1.5">
                {(inspectDetail?.mounts ?? ctr.mounts ?? []).map((m, idx) => (
                  <div
                    key={idx}
                    className="flex flex-wrap items-center gap-2 p-1.5 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)]"
                  >
                    <span
                      className={`px-1.5 py-0.5 rounded text-xs ${
                        m.type === 'volume'
                          ? 'bg-purple-500/15 text-purple-400'
                          : 'bg-sky-500/15 text-sky-400'
                      }`}
                    >
                      {m.type.toUpperCase()}
                    </span>
                    <span className="truncate">{m.name || m.source}</span>
                    <span className="text-[var(--text-muted)]">→</span>
                    <span className="text-emerald-400">{m.destination}</span>
                    <span className="text-[var(--text-muted)] ml-auto">
                      ({m.rw ? 'rw' : 'ro'})
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Environment Variables */}
          <div className="p-3 rounded-lg bg-[var(--bg-card)] border border-[var(--border-subtle)] space-y-2">
            <div className="flex items-center justify-between">
              <span className="font-sans font-semibold text-[var(--text-main)]">
                Environment Variables ({inspectDetail?.env?.length ?? 0})
              </span>
              <button
                type="button"
                onClick={() => setRevealSecrets((v) => !v)}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] font-sans text-xs"
              >
                {revealSecrets ? (
                  <>
                    <EyeOff className="w-3 h-3" />
                    <span>Mask Secrets</span>
                  </>
                ) : (
                  <>
                    <Eye className="w-3 h-3" />
                    <span>Reveal Secrets</span>
                  </>
                )}
              </button>
            </div>
            <div className="divide-y divide-[var(--border-subtle)]">
              {(inspectDetail?.env ?? []).map((rawEnv) => {
                const eqIdx = rawEnv.indexOf('=');
                const k = eqIdx >= 0 ? rawEnv.slice(0, eqIdx) : rawEnv;
                const v = eqIdx >= 0 ? rawEnv.slice(eqIdx + 1) : '';
                const masked = !revealSecrets && isSecretEnvKey(k);
                return (
                  <div
                    key={k}
                    className="py-1.5 flex items-center justify-between gap-2"
                  >
                    <div className="min-w-0 break-all">
                      <span className="text-sky-400 font-semibold">{k}</span>
                      <span className="text-[var(--text-muted)]">=</span>
                      <span>{masked ? '••••••••••••' : v}</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => copyText(k, v)}
                      className="px-1.5 py-0.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] text-[var(--text-muted)] hover:text-[var(--text-main)] shrink-0"
                      title="Copy value"
                    >
                      {copiedKey === k ? 'Copied' : <Copy className="w-3 h-3" />}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* TAB 5: RAW INSPECT JSON */}
      {activeTab === 'inspect' && (
        <div className="flex-1 flex flex-col min-h-0 bg-[var(--bg-canvas)]">
          <div className="px-3.5 py-2 border-b border-[var(--border-subtle)] flex items-center justify-between text-xs">
            <span className="text-[var(--text-muted)] font-mono">
              GET /containers/{ctr.shortId}/json
            </span>
            <button
              type="button"
              onClick={() =>
                copyText('inspect-json', JSON.stringify(inspectDetail?.raw ?? {}, null, 2))
              }
              className="px-2 py-0.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-card)] inline-flex items-center gap-1"
            >
              <Copy className="w-3 h-3" />
              <span>{copiedKey === 'inspect-json' ? 'Copied!' : 'Copy JSON'}</span>
            </button>
          </div>
          <pre className="flex-1 p-3.5 overflow-auto font-mono text-xs leading-relaxed text-[var(--text-muted)] select-text">
            {JSON.stringify(inspectDetail?.raw ?? inspectDetail ?? {}, null, 2)}
          </pre>
        </div>
      )}
    </aside>
  );
}
