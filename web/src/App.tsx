import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  Box,
  ChevronDown,
  ChevronRight,
  Cpu,
  Database,
  Download,
  HardDrive,
  Layers,
  Network,
  Play,
  Plus,
  RefreshCw,
  RotateCw,
  Search,
  Square,
  Terminal as TerminalIcon,
  Trash2,
  Zap,
} from 'lucide-react';
import type {
  ComposeGroup,
  ContainerSummary,
  ContainersResponse,
  ImageSummary,
  NetworkSummary,
  OverviewResponse,
  PruneRequest,
  PruneResponse,
  VolumeSummary,
} from './types';
import {
  formatBytes,
  formatRelativeEpoch,
  formatUptime,
  matchesContainerFilter,
} from './utils/format';
import {
  type ContainerTab,
  type DrawerSelection,
  RightDrawer,
} from './components/RightDrawer';

type MainView = 'containers' | 'images' | 'volumes' | 'networks' | 'resources';
type ColorSchemeSetting = 'light dark' | 'dark' | 'light';

export function App() {
  const [activeView, setActiveView] = useState<MainView>('containers');
  const [sseConnected, setSseConnected] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // Data states
  const [overview, setOverview] = useState<OverviewResponse | null>(null);
  const [containersData, setContainersData] = useState<ContainersResponse>({
    composeGroups: [],
    standalone: [],
    totalCount: 0,
    runningCount: 0,
    stoppedCount: 0,
  });
  const [images, setImages] = useState<ImageSummary[]>([]);
  const [volumes, setVolumes] = useState<VolumeSummary[]>([]);
  const [networks, setNetworks] = useState<NetworkSummary[]>([]);

  // Containers view UI state
  const [containerQuery, setContainerQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'running' | 'stopped'>('all');
  const [collapsedStacks, setCollapsedStacks] = useState<Record<string, boolean>>({});
  const [drawerSelection, setDrawerSelection] = useState<DrawerSelection | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  // Images view UI state
  const [imageQuery, setImageQuery] = useState('');
  const [imageFilter, setImageFilter] = useState<'all' | 'in-use' | 'unused'>('all');
  const pullDialogRef = useRef<HTMLDialogElement | null>(null);
  const [pullImageRef, setPullImageRef] = useState('');
  const [pulling, setPulling] = useState(false);
  const [pullLogs, setPullLogs] = useState<string[]>([]);

  // Volumes view UI state
  const [volumeQuery, setVolumeQuery] = useState('');
  const [volumeFilter, setVolumeFilter] = useState<'all' | 'in-use' | 'unused'>('all');
  const createVolumeDialogRef = useRef<HTMLDialogElement | null>(null);
  const [newVolumeName, setNewVolumeName] = useState('');
  const confirmVolumePruneDialogRef = useRef<HTMLDialogElement | null>(null);

  // Networks view UI state
  const [networkQuery, setNetworkQuery] = useState('');

  // Resources & Prune Builder state
  const [pruneReq, setPruneReq] = useState<PruneRequest>({
    containers: true,
    images: true,
    danglingOnly: false,
    buildCache: true,
    volumes: false,
  });
  const [pruning, setPruning] = useState(false);
  const [lastPruneResult, setLastPruneResult] = useState<PruneResponse | null>(null);

  // Color scheme state (follows modern-web-guidance `dark-mode-toggle`)
  const [scheme, setScheme] = useState<ColorSchemeSetting>(() => {
    try {
      const saved = localStorage.getItem('color-scheme');
      if (saved === 'dark' || saved === 'light') return saved;
    } catch {
      // ignore
    }
    return 'light dark';
  });

  const applyColorScheme = useCallback((next: ColorSchemeSetting) => {
    setScheme(next);
    const meta = document.querySelector('meta[name="color-scheme"]');
    if (meta) {
      meta.setAttribute('content', next);
    }
    try {
      if (next === 'light dark') {
        localStorage.removeItem('color-scheme');
      } else {
        localStorage.setItem('color-scheme', next);
      }
    } catch {
      // ignore storage errors
    }
  }, []);

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'color-scheme') {
        const val =
          e.newValue === 'dark' || e.newValue === 'light'
            ? e.newValue
            : 'light dark';
        setScheme(val);
        const meta = document.querySelector('meta[name="color-scheme"]');
        if (meta) meta.setAttribute('content', val);
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const showToast = useCallback((msg: string) => {
    setToastMessage(msg);
    setTimeout(() => {
      setToastMessage((curr) => (curr === msg ? null : curr));
    }, 4000);
  }, []);

  // Data fetchers
  const fetchOverview = useCallback(async (force = false) => {
    try {
      const r = await fetch(`/api/overview${force ? '?refresh=true' : ''}`);
      if (r.ok) {
        const data = (await r.json()) as OverviewResponse;
        setOverview(data);
      }
    } catch {
      // ignore
    }
  }, []);

  const fetchContainers = useCallback(async (withStats = true) => {
    try {
      const r = await fetch(`/api/containers?stats=${withStats}`);
      if (r.ok) {
        const data = (await r.json()) as ContainersResponse;
        setContainersData(data);
        // Keep active drawer selection fresh
        setDrawerSelection((prev) => {
          if (!prev) return null;
          if (prev.kind === 'compose') {
            const updatedGroup = data.composeGroups.find(
              (g) => g.name === prev.group.name
            );
            return updatedGroup ? { kind: 'compose', group: updatedGroup } : null;
          }
          const allCtrs = [
            ...data.composeGroups.flatMap((g) => g.containers),
            ...(data.standalone ?? []),
          ];
          const updatedCtr = allCtrs.find((c) => c.id === prev.container.id);
          return updatedCtr
            ? {
                kind: 'container',
                container: updatedCtr,
                initialTab: prev.initialTab,
              }
            : null;
        });
      }
    } catch {
      // ignore
    }
  }, []);

  const fetchImages = useCallback(async () => {
    try {
      const r = await fetch('/api/images');
      if (r.ok) setImages((await r.json()) as ImageSummary[]);
    } catch {
      // ignore
    }
  }, []);

  const fetchVolumes = useCallback(async () => {
    try {
      const r = await fetch('/api/volumes');
      if (r.ok) setVolumes((await r.json()) as VolumeSummary[]);
    } catch {
      // ignore
    }
  }, []);

  const fetchNetworks = useCallback(async () => {
    try {
      const r = await fetch('/api/networks');
      if (r.ok) setNetworks((await r.json()) as NetworkSummary[]);
    } catch {
      // ignore
    }
  }, []);

  const refreshAll = useCallback(async () => {
    await Promise.all([
      fetchOverview(true),
      fetchContainers(true),
      fetchImages(),
      fetchVolumes(),
      fetchNetworks(),
    ]);
  }, [fetchOverview, fetchContainers, fetchImages, fetchVolumes, fetchNetworks]);

  // Initial load + SSE event stream subscription
  useEffect(() => {
    fetchOverview();
    // Instant container list (<15ms) followed by live CPU/RAM stats enrichment
    fetchContainers(false).then(() => fetchContainers(true));
    fetchImages();
    fetchVolumes();
    fetchNetworks();

    const es = new EventSource('/api/events');
    es.onopen = () => setSseConnected(true);
    es.onerror = () => setSseConnected(false);

    es.addEventListener('overview', (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data) as OverviewResponse;
        setOverview(data);
      } catch {
        // ignore
      }
    });

    es.addEventListener('docker', () => {
      fetchContainers(true);
      fetchImages();
      fetchVolumes();
      fetchNetworks();
    });

    // Periodic container CPU/RAM refresh every 5s
    const interval = setInterval(() => {
      fetchContainers(true);
    }, 5000);

    return () => {
      clearInterval(interval);
      es.close();
    };
  }, [fetchOverview, fetchContainers, fetchImages, fetchVolumes, fetchNetworks]);

  // Keyboard shortcuts: '/' focuses container filter, 'Escape' closes right drawer
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      const inInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
      if (e.key === '/' && !inInput && activeView === 'containers') {
        e.preventDefault();
        searchInputRef.current?.focus();
      } else if (e.key === 'Escape' && drawerSelection && !inInput) {
        setDrawerSelection(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeView, drawerSelection]);

  // Actions
  const handleContainerAction = async (
    id: string,
    action: 'start' | 'stop' | 'restart' | 'delete'
  ) => {
    try {
      if (action === 'delete') {
        const r = await fetch(`/api/containers/${encodeURIComponent(id)}?force=true`, {
          method: 'DELETE',
        });
        if (!r.ok) throw new Error(await r.text());
        showToast('Container deleted');
        if (
          drawerSelection?.kind === 'container' &&
          drawerSelection.container.id === id
        ) {
          setDrawerSelection(null);
        }
      } else {
        const r = await fetch(
          `/api/containers/${encodeURIComponent(id)}/${action}`,
          { method: 'POST' }
        );
        if (!r.ok) throw new Error(await r.text());
        showToast(`Container ${action}ed`);
      }
      await fetchContainers(true);
      await fetchOverview(true);
    } catch (err) {
      showToast(`Action failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleComposeAction = async (
    project: string,
    action: 'start' | 'stop' | 'restart' | 'remove'
  ) => {
    try {
      const r = await fetch(
        `/api/compose/${encodeURIComponent(project)}/${action}`,
        { method: 'POST' }
      );
      if (!r.ok) throw new Error(await r.text());
      showToast(`Stack ${project}: ${action} complete`);
      if (action === 'remove') {
        setDrawerSelection(null);
      }
      await fetchContainers(true);
      await fetchOverview(true);
    } catch (err) {
      showToast(`Stack action failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const executePrune = async (req: PruneRequest) => {
    setPruning(true);
    try {
      const r = await fetch('/api/system/prune', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req),
      });
      if (!r.ok) throw new Error(await r.text());
      const res = (await r.json()) as PruneResponse;
      setLastPruneResult(res);
      showToast(`Reclaimed ${formatBytes(res.totalReclaimedBytes)}`);
      await refreshAll();
    } catch (err) {
      showToast(`Prune failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setPruning(false);
    }
  };

  const handlePruneSubmit = () => {
    if (pruneReq.volumes) {
      confirmVolumePruneDialogRef.current?.showModal();
    } else {
      executePrune(pruneReq);
    }
  };

  // Pull image handler using native <dialog>
  const startImagePull = () => {
    const ref = pullImageRef.trim();
    if (!ref) return;
    setPulling(true);
    setPullLogs([`Pulling ${ref}...`]);
    const es = new EventSource(`/api/images/pull?image=${encodeURIComponent(ref)}`);
    es.addEventListener('progress', (ev) => {
      try {
        const msg = JSON.parse((ev as MessageEvent).data) as {
          status?: string;
          id?: string;
          progress?: string;
        };
        const line = [msg.id, msg.status, msg.progress].filter(Boolean).join(' ');
        if (line) {
          setPullLogs((prev) => [...prev.slice(-80), line]);
        }
      } catch {
        // ignore
      }
    });
    es.addEventListener('done', () => {
      es.close();
      setPulling(false);
      setPullLogs((prev) => [...prev, `✓ Successfully pulled ${ref}`]);
      fetchImages();
      fetchOverview(true);
      showToast(`Pulled ${ref}`);
    });
    es.addEventListener('error', (ev) => {
      es.close();
      setPulling(false);
      const data = (ev as MessageEvent).data;
      setPullLogs((prev) => [...prev, `✗ Pull failed ${data || ''}`]);
    });
  };

  const handleDeleteImage = async (id: string, force = false) => {
    try {
      const r = await fetch(
        `/api/images/${encodeURIComponent(id)}?force=${force}`,
        { method: 'DELETE' }
      );
      if (!r.ok) throw new Error(await r.text());
      showToast('Image removed');
      await fetchImages();
      await fetchOverview(true);
    } catch (err) {
      showToast(`Failed to remove image: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleCreateVolume = async () => {
    const name = newVolumeName.trim();
    if (!name) return;
    try {
      const r = await fetch('/api/volumes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!r.ok) throw new Error(await r.text());
      setNewVolumeName('');
      createVolumeDialogRef.current?.close();
      showToast(`Created volume ${name}`);
      await fetchVolumes();
      await fetchOverview(true);
    } catch (err) {
      showToast(`Failed to create volume: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleDeleteVolume = async (name: string) => {
    try {
      const r = await fetch(`/api/volumes/${encodeURIComponent(name)}?force=true`, {
        method: 'DELETE',
      });
      if (!r.ok) throw new Error(await r.text());
      showToast(`Deleted volume ${name}`);
      await fetchVolumes();
      await fetchOverview(true);
    } catch (err) {
      showToast(`Failed to delete volume: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleDeleteNetwork = async (id: string, name: string) => {
    try {
      const r = await fetch(`/api/networks/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      if (!r.ok) throw new Error(await r.text());
      showToast(`Removed network ${name}`);
      await fetchNetworks();
    } catch (err) {
      showToast(`Failed to remove network: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // Filtered Compose Groups & Standalone Containers
  const filteredComposeGroups = useMemo(() => {
    return containersData.composeGroups
      .map((g) => ({
        ...g,
        containers: g.containers.filter((c) =>
          matchesContainerFilter(c, containerQuery, statusFilter)
        ),
      }))
      .filter((g) => g.containers.length > 0);
  }, [containersData.composeGroups, containerQuery, statusFilter]);

  const filteredStandalone = useMemo(() => {
    return (containersData.standalone ?? []).filter((c) =>
      matchesContainerFilter(c, containerQuery, statusFilter)
    );
  }, [containersData.standalone, containerQuery, statusFilter]);

  const filteredImages = useMemo(() => {
    const q = imageQuery.trim().toLowerCase();
    return images.filter((img) => {
      if (imageFilter === 'in-use' && !img.inUse) return false;
      if (imageFilter === 'unused' && img.inUse) return false;
      if (!q) return true;
      return (
        img.repository.toLowerCase().includes(q) ||
        img.tag.toLowerCase().includes(q) ||
        img.shortId.toLowerCase().includes(q)
      );
    });
  }, [images, imageQuery, imageFilter]);

  const filteredVolumes = useMemo(() => {
    const q = volumeQuery.trim().toLowerCase();
    return volumes.filter((v) => {
      if (volumeFilter === 'in-use' && !v.inUse) return false;
      if (volumeFilter === 'unused' && v.inUse) return false;
      if (!q) return true;
      return (
        v.name.toLowerCase().includes(q) ||
        (v.usedByContainers ?? []).some((c) => c.toLowerCase().includes(q))
      );
    });
  }, [volumes, volumeQuery, volumeFilter]);

  const filteredNetworks = useMemo(() => {
    const q = networkQuery.trim().toLowerCase();
    return networks.filter((n) => {
      if (!q) return true;
      return (
        n.name.toLowerCase().includes(q) ||
        n.driver.toLowerCase().includes(q) ||
        (n.subnet && n.subnet.toLowerCase().includes(q))
      );
    });
  }, [networks, networkQuery]);

  // Estimated reclaimable space for current Prune Builder checkboxes
  const estimatedPruneBytes = useMemo(() => {
    if (!overview) return 0;
    const df = overview.diskUsage;
    let total = 0;
    if (pruneReq.containers) total += df.containersReclaimable;
    if (pruneReq.images) total += df.imagesReclaimable;
    if (pruneReq.buildCache) total += df.buildCacheReclaimable;
    if (pruneReq.volumes) total += df.volumesReclaimable;
    return total;
  }, [overview, pruneReq]);

  const cpuPct = overview?.host.cpuPercent ?? 0;
  const memPct = overview?.host.memPercent ?? 0;
  const reclaimableTotal = overview?.diskUsage.totalReclaimable ?? 0;

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-[var(--bg-canvas)] text-[var(--text-main)] select-none">
      {/* ================================================================= */}
      {/* TOP HOST & DOCKER TELEMETRY BAR                                   */}
      {/* ================================================================= */}
      <header className="bg-[var(--bg-card)] border-b border-[var(--border-subtle)] px-4 py-2 flex flex-wrap items-center justify-between gap-3 shrink-0">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 font-semibold text-sm tracking-tight">
            <span className="inline-flex items-center justify-center w-5 h-5 rounded bg-emerald-500/20 text-emerald-400 font-mono text-xs border border-emerald-500/30">
              ❖
            </span>
            <span>Container Land</span>
          </div>
          <div className="flex items-center gap-2 text-xs text-[var(--text-muted)] border-l border-[var(--border-subtle)] pl-3 font-mono">
            <span
              className={`w-2 h-2 rounded-full ${
                overview ? 'bg-emerald-500' : 'bg-amber-500'
              }`}
              title="Docker Engine Status"
            />
            <span className="text-[var(--text-main)] font-medium">
              {overview?.engine.hostname || overview?.host.hostname || 'local-engine'}
            </span>
            <span>·</span>
            <span>Engine {overview?.engine.serverVersion || '—'}</span>
            <span>·</span>
            <span className="px-1.5 py-0.5 rounded bg-[var(--bg-sidebar)] border border-[var(--border-subtle)] hidden sm:inline">
              {overview?.engine.socketPath || 'unix:///var/run/docker.sock'}
            </span>
          </div>
        </div>

        {/* Live Telemetry Strip + Theme Override */}
        <div className="flex flex-wrap items-center gap-4 text-xs">
          {toastMessage && (
            <div className="px-2.5 py-1 rounded bg-emerald-500/15 border border-emerald-500/40 text-emerald-400 font-mono text-xs">
              {toastMessage}
            </div>
          )}

          <div
            className="flex items-center gap-2 font-mono tabular-nums"
            title={overview?.host.cpuModel || 'Host CPU'}
          >
            <span className="text-[var(--text-muted)] font-sans font-medium">CPU</span>
            <div className="w-16 h-1.5 bg-[var(--bg-sidebar)] rounded-full overflow-hidden border border-[var(--border-subtle)]">
              <div
                className="h-full bg-emerald-500 transition-all"
                style={{ width: `${Math.min(100, cpuPct)}%` }}
              />
            </div>
            <span>{cpuPct.toFixed(0)}%</span>
            {overview?.host.cpuTempC !== undefined && (
              <span className="text-[var(--text-muted)]">
                ({overview.host.cpuTempC.toFixed(0)}°C)
              </span>
            )}
          </div>

          <div className="flex items-center gap-2 font-mono tabular-nums">
            <span className="text-[var(--text-muted)] font-sans font-medium">RAM</span>
            <div className="w-16 h-1.5 bg-[var(--bg-sidebar)] rounded-full overflow-hidden border border-[var(--border-subtle)]">
              <div
                className="h-full bg-sky-500 transition-all"
                style={{ width: `${Math.min(100, memPct)}%` }}
              />
            </div>
            <span>
              {formatBytes(overview?.host.memUsedBytes, 1)} /{' '}
              {formatBytes(overview?.host.memTotalBytes, 0)}
            </span>
          </div>

          <div className="flex items-center gap-1.5 font-mono tabular-nums">
            <span className="text-[var(--text-muted)] font-sans font-medium">
              Docker Disk
            </span>
            <span>{formatBytes(overview?.diskUsage.totalSize)}</span>
          </div>

          <button
            type="button"
            onClick={() => setActiveView('resources')}
            className="px-2.5 py-1 rounded-md border border-amber-500/40 bg-amber-500/10 text-amber-400 font-medium text-xs hover:bg-amber-500/20 transition font-mono tabular-nums inline-flex items-center gap-1"
          >
            <Zap className="w-3.5 h-3.5" />
            <span>{formatBytes(reclaimableTotal)} Reclaimable</span>
          </button>

          {/* Tri-state Color Scheme Control per modern-web-guidance */}
          <select
            aria-label="Color scheme"
            value={scheme}
            onChange={(e) => applyColorScheme(e.target.value as ColorSchemeSetting)}
            className="px-2 py-1 rounded-md bg-[var(--bg-sidebar)] border border-[var(--border-subtle)] text-xs font-medium"
          >
            <option value="light dark">Theme: System</option>
            <option value="dark">Theme: Dark</option>
            <option value="light">Theme: Light</option>
          </select>
        </div>
      </header>

      {/* ================================================================= */}
      {/* MAIN BODY: LEFT SIDEBAR + ACTIVE WORKSPACE                        */}
      {/* ================================================================= */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Left Navigation Sidebar */}
        <aside className="w-48 bg-[var(--bg-sidebar)] border-r border-[var(--border-subtle)] p-2.5 flex flex-col justify-between shrink-0">
          <nav aria-label="Main navigation" className="space-y-1">
            <button
              type="button"
              onClick={() => setActiveView('containers')}
              className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-md text-xs font-medium transition ${
                activeView === 'containers'
                  ? 'bg-[var(--bg-card)] text-[var(--text-main)] border border-[var(--border-subtle)] shadow-sm'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-main)]'
              }`}
            >
              <span className="flex items-center gap-2">
                <Box className="w-3.5 h-3.5" />
                <span>Containers</span>
              </span>
              <span className="font-mono tabular-nums px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400">
                {containersData.runningCount}/{containersData.totalCount}
              </span>
            </button>

            <button
              type="button"
              onClick={() => setActiveView('images')}
              className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-md text-xs font-medium transition ${
                activeView === 'images'
                  ? 'bg-[var(--bg-card)] text-[var(--text-main)] border border-[var(--border-subtle)] shadow-sm'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-main)]'
              }`}
            >
              <span className="flex items-center gap-2">
                <Layers className="w-3.5 h-3.5" />
                <span>Images</span>
              </span>
              <span className="font-mono tabular-nums">{images.length}</span>
            </button>

            <button
              type="button"
              onClick={() => setActiveView('volumes')}
              className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-md text-xs font-medium transition ${
                activeView === 'volumes'
                  ? 'bg-[var(--bg-card)] text-[var(--text-main)] border border-[var(--border-subtle)] shadow-sm'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-main)]'
              }`}
            >
              <span className="flex items-center gap-2">
                <Database className="w-3.5 h-3.5" />
                <span>Volumes</span>
              </span>
              <span className="font-mono tabular-nums">{volumes.length}</span>
            </button>

            <button
              type="button"
              onClick={() => setActiveView('networks')}
              className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-md text-xs font-medium transition ${
                activeView === 'networks'
                  ? 'bg-[var(--bg-card)] text-[var(--text-main)] border border-[var(--border-subtle)] shadow-sm'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-main)]'
              }`}
            >
              <span className="flex items-center gap-2">
                <Network className="w-3.5 h-3.5" />
                <span>Networks</span>
              </span>
              <span className="font-mono tabular-nums">{networks.length}</span>
            </button>

            <button
              type="button"
              onClick={() => setActiveView('resources')}
              className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-md text-xs font-medium transition ${
                activeView === 'resources'
                  ? 'bg-[var(--bg-card)] text-[var(--text-main)] border border-[var(--border-subtle)] shadow-sm'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-main)]'
              }`}
            >
              <span className="flex items-center gap-2">
                <Activity className="w-3.5 h-3.5" />
                <span>Resources &amp; Prune</span>
              </span>
              <span className="font-mono tabular-nums text-amber-400">
                {formatBytes(reclaimableTotal, 0)}
              </span>
            </button>
          </nav>

          <div className="p-2.5 rounded-lg bg-[var(--bg-card)] border border-[var(--border-subtle)] space-y-1 text-xs font-mono tabular-nums">
            <div className="flex items-center justify-between">
              <span className="text-[var(--text-muted)] font-sans">Events</span>
              <span className={sseConnected ? 'text-emerald-400' : 'text-amber-400'}>
                ● {sseConnected ? 'Live SSE' : 'Reconnecting'}
              </span>
            </div>
            <div className="text-[var(--text-muted)] truncate">
              Load: {overview?.host.load1.toFixed(2) ?? '0.00'}{' '}
              {overview?.host.load5.toFixed(2) ?? '0.00'}{' '}
              {overview?.host.load15.toFixed(2) ?? '0.00'}
            </div>
            <div className="text-[var(--text-muted)] truncate">
              Up: {formatUptime(overview?.host.uptimeSeconds ?? 0)}
            </div>
          </div>
        </aside>

        {/* =============================================================== */}
        {/* MAIN WORKSPACE                                                  */}
        {/* =============================================================== */}
        <main className="flex-1 flex flex-col min-w-0 min-h-0 bg-[var(--bg-canvas)]">
          {/* ------------------------------------------------------------- */}
          {/* VIEW 1: CONTAINERS & COMPOSE + RIGHT SLIDE-OVER DRAWER        */}
          {/* ------------------------------------------------------------- */}
          {activeView === 'containers' && (
            <div className="flex-1 flex flex-col min-h-0">
              {/* Toolbar */}
              <div className="px-3.5 py-2 border-b border-[var(--border-subtle)] bg-[var(--bg-card)] flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <div className="relative">
                    <Search className="w-3.5 h-3.5 text-[var(--text-muted)] absolute left-2.5 top-2" />
                    <input
                      ref={searchInputRef}
                      type="search"
                      value={containerQuery}
                      onChange={(e) => setContainerQuery(e.target.value)}
                      placeholder="Filter containers, compose stacks, images, or ports (/)..."
                      className="pl-8 pr-3 py-1 rounded-md bg-[var(--bg-canvas)] border border-[var(--border-subtle)] text-xs w-72 font-mono focus:outline-none"
                    />
                  </div>
                  <div className="flex items-center rounded-md border border-[var(--border-subtle)] bg-[var(--bg-canvas)] p-0.5 text-xs">
                    {(
                      [
                        ['all', `All (${containersData.totalCount})`],
                        ['running', `Running (${containersData.runningCount})`],
                        ['stopped', `Stopped (${containersData.stoppedCount})`],
                      ] as const
                    ).map(([key, label]) => (
                      <button
                        key={key}
                        type="button"
                        onClick={() => setStatusFilter(key)}
                        className={`px-2.5 py-0.5 rounded font-medium ${
                          statusFilter === key
                            ? 'bg-[var(--bg-card)] text-[var(--text-main)] shadow-sm'
                            : 'text-[var(--text-muted)] hover:text-[var(--text-main)]'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="flex items-center gap-2 text-xs">
                  {containersData.stoppedCount > 0 && (
                    <button
                      type="button"
                      onClick={() =>
                        executePrune({
                          containers: true,
                          images: false,
                          danglingOnly: false,
                          buildCache: false,
                          volumes: false,
                        })
                      }
                      className="px-2.5 py-1 rounded-md border border-amber-500/40 bg-amber-500/10 text-amber-400 hover:bg-amber-500/20 font-medium"
                    >
                      Prune Stopped ({containersData.stoppedCount})
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => fetchContainers(true)}
                    className="px-2.5 py-1 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-canvas)] hover:bg-[var(--bg-elevated)] inline-flex items-center gap-1"
                  >
                    <RefreshCw className="w-3 h-3" />
                    <span>Refresh</span>
                  </button>
                </div>
              </div>

              {/* Split Pane: Left Table + Right Slide-Over Drawer */}
              <div className="flex-1 flex flex-row min-h-0 overflow-hidden">
                <div
                  tabIndex={0}
                  role="region"
                  aria-label="Containers and Compose stacks"
                  className={`table-wrapper flex-1 min-h-0 ${
                    drawerSelection ? 'w-1/2' : 'w-full'
                  }`}
                >
                  <table className="text-left text-xs">
                    <thead>
                      <tr className="border-b border-[var(--border-subtle)] text-[var(--text-muted)]">
                        <th className="py-2 px-3 font-medium">Name / Compose Stack</th>
                        {!drawerSelection && (
                          <th className="py-2 px-3 font-medium">Image</th>
                        )}
                        <th className="py-2 px-2.5 font-medium">Status</th>
                        <th className="py-2 px-2.5 font-medium">Ports</th>
                        <th className="py-2 px-2.5 font-medium">CPU</th>
                        <th className="py-2 px-2.5 font-medium">Memory</th>
                        {!drawerSelection && (
                          <th className="py-2 px-3 font-medium text-right">Actions</th>
                        )}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[var(--border-subtle)]">
                      {filteredComposeGroups.map((group: ComposeGroup) => {
                        const isCollapsed = !!collapsedStacks[group.name];
                        const isSelectedStack =
                          drawerSelection?.kind === 'compose' &&
                          drawerSelection.group.name === group.name;

                        return (
                          <ComposeStackRows
                            key={group.name}
                            group={group}
                            isCollapsed={isCollapsed}
                            isSelectedStack={isSelectedStack}
                            selectedContainerId={
                              drawerSelection?.kind === 'container'
                                ? drawerSelection.container.id
                                : null
                            }
                            compact={!!drawerSelection}
                            onToggleCollapse={() =>
                              setCollapsedStacks((prev) => ({
                                ...prev,
                                [group.name]: !prev[group.name],
                              }))
                            }
                            onSelectStack={() =>
                              setDrawerSelection({ kind: 'compose', group })
                            }
                            onSelectContainer={(ctr, tab) =>
                              setDrawerSelection({
                                kind: 'container',
                                container: ctr,
                                initialTab: tab,
                              })
                            }
                            onContainerAction={handleContainerAction}
                            onComposeAction={handleComposeAction}
                          />
                        );
                      })}

                      {filteredStandalone.length > 0 && (
                        <>
                          <tr className="bg-[var(--bg-sidebar)]/60 text-[var(--text-muted)]">
                            <td
                              colSpan={drawerSelection ? 6 : 7}
                              className="py-1.5 px-3 font-mono text-xs font-semibold"
                            >
                              Standalone Containers ({filteredStandalone.length})
                            </td>
                          </tr>
                          {filteredStandalone.map((ctr) => (
                            <ContainerRow
                              key={ctr.id}
                              ctr={ctr}
                              indented={false}
                              compact={!!drawerSelection}
                              isSelected={
                                drawerSelection?.kind === 'container' &&
                                drawerSelection.container.id === ctr.id
                              }
                              onSelect={(tab) =>
                                setDrawerSelection({
                                  kind: 'container',
                                  container: ctr,
                                  initialTab: tab,
                                })
                              }
                              onAction={handleContainerAction}
                            />
                          ))}
                        </>
                      )}

                      {filteredComposeGroups.length === 0 &&
                        filteredStandalone.length === 0 && (
                          <tr>
                            <td
                              colSpan={drawerSelection ? 6 : 7}
                              className="py-12 text-center text-[var(--text-muted)] font-mono"
                            >
                              No containers match the current filter.
                            </td>
                          </tr>
                        )}
                    </tbody>
                  </table>
                </div>

                {/* Right Slide-Over Drawer */}
                {drawerSelection && (
                  <RightDrawer
                    selection={drawerSelection}
                    onClose={() => setDrawerSelection(null)}
                    onContainerAction={handleContainerAction}
                    onComposeAction={handleComposeAction}
                    onSelectContainer={(ctr, tab) =>
                      setDrawerSelection({
                        kind: 'container',
                        container: ctr,
                        initialTab: tab,
                      })
                    }
                  />
                )}
              </div>
            </div>
          )}

          {/* ------------------------------------------------------------- */}
          {/* VIEW 2: IMAGES                                                */}
          {/* ------------------------------------------------------------- */}
          {activeView === 'images' && (
            <div className="flex-1 flex flex-col min-h-0 p-4 space-y-3 overflow-hidden">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <div className="relative">
                    <Search className="w-3.5 h-3.5 text-[var(--text-muted)] absolute left-2.5 top-2" />
                    <input
                      type="search"
                      value={imageQuery}
                      onChange={(e) => setImageQuery(e.target.value)}
                      placeholder="Filter images by repository, tag, or short ID..."
                      className="pl-8 pr-3 py-1 rounded-md bg-[var(--bg-card)] border border-[var(--border-subtle)] text-xs w-72 font-mono focus:outline-none"
                    />
                  </div>
                  <div className="flex items-center rounded-md border border-[var(--border-subtle)] bg-[var(--bg-card)] p-0.5 text-xs">
                    {(
                      [
                        ['all', `All (${images.length})`],
                        ['in-use', `In Use (${images.filter((i) => i.inUse).length})`],
                        ['unused', `Unused (${images.filter((i) => !i.inUse).length})`],
                      ] as const
                    ).map(([key, label]) => (
                      <button
                        key={key}
                        type="button"
                        onClick={() => setImageFilter(key)}
                        className={`px-2.5 py-0.5 rounded font-medium ${
                          imageFilter === key
                            ? 'bg-[var(--bg-elevated)] text-[var(--text-main)]'
                            : 'text-[var(--text-muted)]'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="flex items-center gap-2 text-xs">
                  <button
                    type="button"
                    onClick={() => {
                      setPullLogs([]);
                      pullDialogRef.current?.showModal();
                    }}
                    className="px-3 py-1.5 rounded-md bg-[var(--accent-primary)] text-[var(--accent-primary-fg)] font-semibold inline-flex items-center gap-1.5"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>Pull Image...</span>
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      executePrune({
                        containers: false,
                        images: true,
                        danglingOnly: false,
                        buildCache: false,
                        volumes: false,
                      })
                    }
                    className="px-3 py-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 text-amber-400 hover:bg-amber-500/20 font-medium"
                  >
                    Prune Unused Images (
                    {formatBytes(overview?.diskUsage.imagesReclaimable)})
                  </button>
                </div>
              </div>

              <div
                tabIndex={0}
                role="region"
                aria-label="Docker images"
                className="table-wrapper flex-1 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-card)]"
              >
                <table className="text-left text-xs font-mono tabular-nums">
                  <thead>
                    <tr className="border-b border-[var(--border-subtle)] text-[var(--text-muted)] font-sans">
                      <th className="py-2 px-3 font-medium">Repository</th>
                      <th className="py-2 px-3 font-medium">Tag</th>
                      <th className="py-2 px-3 font-medium">Image ID</th>
                      <th className="py-2 px-3 font-medium">Status / Used By</th>
                      <th className="py-2 px-3 font-medium">Created</th>
                      <th className="py-2 px-3 font-medium">Size</th>
                      <th className="py-2 px-3 font-medium text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--border-subtle)]">
                    {filteredImages.map((img) => (
                      <tr key={img.id} className="hover:bg-[var(--bg-elevated)]/40">
                        <td className="py-2 px-3 font-semibold">{img.repository}</td>
                        <td className="py-2 px-3 text-sky-400">{img.tag}</td>
                        <td className="py-2 px-3 text-[var(--text-muted)]">
                          {img.shortId}
                        </td>
                        <td className="py-2 px-3">
                          {img.inUse ? (
                            <span className="px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400">
                              In Use (
                              {(img.usedByContainers ?? []).slice(0, 2).join(', ') ||
                                img.containers}
                              )
                            </span>
                          ) : (
                            <span className="px-1.5 py-0.5 rounded bg-zinc-500/20 text-[var(--text-muted)]">
                              Unused
                            </span>
                          )}
                        </td>
                        <td className="py-2 px-3 text-[var(--text-muted)]">
                          {formatRelativeEpoch(img.created)}
                        </td>
                        <td className="py-2 px-3">{formatBytes(img.sizeBytes)}</td>
                        <td className="py-2 px-3 text-right">
                          <button
                            type="button"
                            onClick={() => handleDeleteImage(img.id, img.inUse)}
                            className="px-2 py-0.5 rounded border border-rose-500/40 text-rose-400 hover:bg-rose-500/10 inline-flex items-center gap-1 font-sans"
                          >
                            <Trash2 className="w-3 h-3" />
                            <span>Delete</span>
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ------------------------------------------------------------- */}
          {/* VIEW 3: VOLUMES                                               */}
          {/* ------------------------------------------------------------- */}
          {activeView === 'volumes' && (
            <div className="flex-1 flex flex-col min-h-0 p-4 space-y-3 overflow-hidden">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <div className="relative">
                    <Search className="w-3.5 h-3.5 text-[var(--text-muted)] absolute left-2.5 top-2" />
                    <input
                      type="search"
                      value={volumeQuery}
                      onChange={(e) => setVolumeQuery(e.target.value)}
                      placeholder="Filter volumes by name or attached container..."
                      className="pl-8 pr-3 py-1 rounded-md bg-[var(--bg-card)] border border-[var(--border-subtle)] text-xs w-72 font-mono focus:outline-none"
                    />
                  </div>
                  <div className="flex items-center rounded-md border border-[var(--border-subtle)] bg-[var(--bg-card)] p-0.5 text-xs">
                    {(
                      [
                        ['all', `All (${volumes.length})`],
                        ['in-use', `Attached (${volumes.filter((v) => v.inUse).length})`],
                        [
                          'unused',
                          `Unattached (${volumes.filter((v) => !v.inUse).length})`,
                        ],
                      ] as const
                    ).map(([key, label]) => (
                      <button
                        key={key}
                        type="button"
                        onClick={() => setVolumeFilter(key)}
                        className={`px-2.5 py-0.5 rounded font-medium ${
                          volumeFilter === key
                            ? 'bg-[var(--bg-elevated)] text-[var(--text-main)]'
                            : 'text-[var(--text-muted)]'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="flex items-center gap-2 text-xs">
                  <button
                    type="button"
                    onClick={() => createVolumeDialogRef.current?.showModal()}
                    className="px-3 py-1.5 rounded-md bg-[var(--accent-primary)] text-[var(--accent-primary-fg)] font-semibold inline-flex items-center gap-1.5"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>Create Volume</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => confirmVolumePruneDialogRef.current?.showModal()}
                    className="px-3 py-1.5 rounded-md border border-rose-500/40 bg-rose-500/10 text-rose-400 hover:bg-rose-500/20 font-medium"
                  >
                    Prune Unattached Volumes (
                    {formatBytes(overview?.diskUsage.volumesReclaimable)})...
                  </button>
                </div>
              </div>

              <div
                tabIndex={0}
                role="region"
                aria-label="Docker volumes"
                className="table-wrapper flex-1 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-card)]"
              >
                <table className="text-left text-xs font-mono tabular-nums">
                  <thead>
                    <tr className="border-b border-[var(--border-subtle)] text-[var(--text-muted)] font-sans">
                      <th className="py-2 px-3 font-medium">Volume Name</th>
                      <th className="py-2 px-3 font-medium">Driver</th>
                      <th className="py-2 px-3 font-medium">Attached Containers</th>
                      <th className="py-2 px-3 font-medium">Size</th>
                      <th className="py-2 px-3 font-medium text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--border-subtle)]">
                    {filteredVolumes.map((vol) => (
                      <tr key={vol.name} className="hover:bg-[var(--bg-elevated)]/40">
                        <td className="py-2 px-3 font-semibold">{vol.name}</td>
                        <td className="py-2 px-3 text-[var(--text-muted)]">
                          {vol.driver}
                        </td>
                        <td className="py-2 px-3">
                          {vol.inUse ? (
                            <span className="px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400">
                              {(vol.usedByContainers ?? []).join(', ')}
                            </span>
                          ) : (
                            <span className="px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400">
                              Unattached
                            </span>
                          )}
                        </td>
                        <td className="py-2 px-3">
                          {vol.sizeBytes >= 0 ? formatBytes(vol.sizeBytes) : '—'}
                        </td>
                        <td className="py-2 px-3 text-right">
                          <button
                            type="button"
                            onClick={() => handleDeleteVolume(vol.name)}
                            className="px-2 py-0.5 rounded border border-rose-500/40 text-rose-400 hover:bg-rose-500/10 inline-flex items-center gap-1 font-sans"
                          >
                            <Trash2 className="w-3 h-3" />
                            <span>Delete</span>
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ------------------------------------------------------------- */}
          {/* VIEW 4: NETWORKS                                              */}
          {/* ------------------------------------------------------------- */}
          {activeView === 'networks' && (
            <div className="flex-1 flex flex-col min-h-0 p-4 space-y-3 overflow-hidden">
              <div className="flex items-center justify-between gap-2">
                <div className="relative">
                  <Search className="w-3.5 h-3.5 text-[var(--text-muted)] absolute left-2.5 top-2" />
                  <input
                    type="search"
                    value={networkQuery}
                    onChange={(e) => setNetworkQuery(e.target.value)}
                    placeholder="Filter networks by name, driver, or subnet..."
                    className="pl-8 pr-3 py-1 rounded-md bg-[var(--bg-card)] border border-[var(--border-subtle)] text-xs w-72 font-mono focus:outline-none"
                  />
                </div>
              </div>

              <div
                tabIndex={0}
                role="region"
                aria-label="Docker networks"
                className="table-wrapper flex-1 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-card)]"
              >
                <table className="text-left text-xs font-mono tabular-nums">
                  <thead>
                    <tr className="border-b border-[var(--border-subtle)] text-[var(--text-muted)] font-sans">
                      <th className="py-2 px-3 font-medium">Network Name</th>
                      <th className="py-2 px-3 font-medium">ID</th>
                      <th className="py-2 px-3 font-medium">Driver / Scope</th>
                      <th className="py-2 px-3 font-medium">Subnet &amp; Gateway</th>
                      <th className="py-2 px-3 font-medium">Connected Containers</th>
                      <th className="py-2 px-3 font-medium text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--border-subtle)]">
                    {filteredNetworks.map((net) => (
                      <tr key={net.id} className="hover:bg-[var(--bg-elevated)]/40">
                        <td className="py-2 px-3 font-semibold">{net.name}</td>
                        <td className="py-2 px-3 text-[var(--text-muted)]">
                          {net.shortId}
                        </td>
                        <td className="py-2 px-3">
                          {net.driver} ({net.scope})
                        </td>
                        <td className="py-2 px-3 text-[var(--text-muted)]">
                          {net.subnet ? `${net.subnet} · gw ${net.gateway || '—'}` : '—'}
                        </td>
                        <td className="py-2 px-3">
                          {net.containers && net.containers.length > 0 ? (
                            <div className="flex flex-wrap gap-1">
                              {net.containers.map((ep) => (
                                <span
                                  key={ep.containerId + ep.containerName}
                                  className="px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400"
                                >
                                  {ep.containerName}
                                  {ep.ipv4Address ? ` (${ep.ipv4Address})` : ''}
                                </span>
                              ))}
                            </div>
                          ) : (
                            <span className="text-[var(--text-muted)]">0 containers</span>
                          )}
                        </td>
                        <td className="py-2 px-3 text-right">
                          {!net.builtIn && (
                            <button
                              type="button"
                              onClick={() => handleDeleteNetwork(net.id, net.name)}
                              className="px-2 py-0.5 rounded border border-rose-500/40 text-rose-400 hover:bg-rose-500/10 inline-flex items-center gap-1 font-sans"
                            >
                              <Trash2 className="w-3 h-3" />
                              <span>Remove</span>
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ------------------------------------------------------------- */}
          {/* VIEW 5: RESOURCES & PRUNE CENTRE                              */}
          {/* ------------------------------------------------------------- */}
          {activeView === 'resources' && (
            <div className="flex-1 p-4 space-y-4 overflow-auto">
              {/* Host Telemetry Section */}
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 text-xs">
                {/* CPU Card */}
                <div className="p-3.5 rounded-xl bg-[var(--bg-card)] border border-[var(--border-subtle)] space-y-2.5">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold inline-flex items-center gap-1.5">
                      <Cpu className="w-4 h-4 text-emerald-400" />
                      <span>Host CPU ({overview?.host.cpuCores ?? 0} cores)</span>
                    </span>
                    <span className="font-mono text-sm font-semibold text-emerald-400">
                      {cpuPct.toFixed(1)}%
                    </span>
                  </div>
                  <div className="text-[var(--text-muted)] font-mono truncate">
                    {overview?.host.cpuModel || 'Linux CPU'} · Kernel{' '}
                    {overview?.host.kernelVersion}
                  </div>
                  {overview?.host.perCore && overview.host.perCore.length > 0 && (
                    <div className="grid grid-cols-4 gap-1.5 pt-1">
                      {overview.host.perCore.map((core) => (
                        <div
                          key={core.core}
                          className="p-1 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)] font-mono"
                        >
                          <div className="flex justify-between text-xs">
                            <span className="text-[var(--text-muted)]">{core.core}</span>
                            <span>{core.percent.toFixed(0)}%</span>
                          </div>
                          <div className="w-full h-1 bg-[var(--bg-sidebar)] rounded-full mt-1 overflow-hidden">
                            <div
                              className="h-full bg-emerald-500"
                              style={{ width: `${Math.min(100, core.percent)}%` }}
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Memory & Swap Card */}
                <div className="p-3.5 rounded-xl bg-[var(--bg-card)] border border-[var(--border-subtle)] space-y-2.5">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold inline-flex items-center gap-1.5">
                      <Activity className="w-4 h-4 text-sky-400" />
                      <span>Host Memory &amp; Swap</span>
                    </span>
                    <span className="font-mono text-sm font-semibold text-sky-400">
                      {memPct.toFixed(1)}%
                    </span>
                  </div>
                  <div className="w-full h-2.5 bg-[var(--bg-sidebar)] rounded-full overflow-hidden border border-[var(--border-subtle)]">
                    <div
                      className="h-full bg-sky-500"
                      style={{ width: `${Math.min(100, memPct)}%` }}
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-2 font-mono pt-1">
                    <div>
                      <span className="text-[var(--text-muted)] block">Used</span>
                      <span>{formatBytes(overview?.host.memUsedBytes)}</span>
                    </div>
                    <div>
                      <span className="text-[var(--text-muted)] block">Available</span>
                      <span>{formatBytes(overview?.host.memAvailBytes)}</span>
                    </div>
                    <div>
                      <span className="text-[var(--text-muted)] block">Page Cache</span>
                      <span>{formatBytes(overview?.host.memCacheBytes)}</span>
                    </div>
                    <div>
                      <span className="text-[var(--text-muted)] block">Swap Used</span>
                      <span>
                        {formatBytes(overview?.host.swapUsedBytes)} /{' '}
                        {formatBytes(overview?.host.swapTotalBytes)}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Filesystems Card */}
                <div className="p-3.5 rounded-xl bg-[var(--bg-card)] border border-[var(--border-subtle)] space-y-2.5">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold inline-flex items-center gap-1.5">
                      <HardDrive className="w-4 h-4 text-purple-400" />
                      <span>Linux Filesystems</span>
                    </span>
                    <span className="font-mono text-xs text-[var(--text-muted)]">
                      {overview?.engine.storageDriver || 'overlay2'}
                    </span>
                  </div>
                  <div className="space-y-2 font-mono">
                    <div>
                      <div className="flex justify-between">
                        <span>Root (/)</span>
                        <span>
                          {formatBytes(overview?.host.rootDisk.usedBytes)} /{' '}
                          {formatBytes(overview?.host.rootDisk.totalBytes)} (
                          {overview?.host.rootDisk.usedPercent.toFixed(1)}%)
                        </span>
                      </div>
                      <div className="w-full h-2 bg-[var(--bg-sidebar)] rounded-full mt-1 overflow-hidden border border-[var(--border-subtle)]">
                        <div
                          className="h-full bg-purple-500"
                          style={{
                            width: `${Math.min(
                              100,
                              overview?.host.rootDisk.usedPercent ?? 0
                            )}%`,
                          }}
                        />
                      </div>
                    </div>
                    <div>
                      <div className="flex justify-between">
                        <span className="truncate max-w-[10rem]">
                          Docker ({overview?.host.dockerDisk.path})
                        </span>
                        <span>
                          {formatBytes(overview?.diskUsage.totalSize)} Docker Objects
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Docker Disk Breakdown (/system/df) */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 text-xs">
                <div className="p-3.5 rounded-xl bg-[var(--bg-card)] border border-[var(--border-subtle)] space-y-1.5">
                  <div className="flex justify-between text-[var(--text-muted)]">
                    <span>
                      Images ({overview?.diskUsage.imagesActive ?? 0}/
                      {overview?.diskUsage.imagesTotal ?? 0} active)
                    </span>
                  </div>
                  <div className="text-lg font-mono font-semibold">
                    {formatBytes(overview?.diskUsage.imagesSize)}
                  </div>
                  <div className="text-emerald-400 font-mono">
                    {formatBytes(overview?.diskUsage.imagesReclaimable)} reclaimable
                  </div>
                </div>

                <div className="p-3.5 rounded-xl bg-[var(--bg-card)] border border-[var(--border-subtle)] space-y-1.5">
                  <div className="flex justify-between text-[var(--text-muted)]">
                    <span>
                      Build Cache ({overview?.diskUsage.buildCacheTotal ?? 0} entries)
                    </span>
                  </div>
                  <div className="text-lg font-mono font-semibold">
                    {formatBytes(overview?.diskUsage.buildCacheSize)}
                  </div>
                  <div className="text-emerald-400 font-mono">
                    {formatBytes(overview?.diskUsage.buildCacheReclaimable)} reclaimable
                  </div>
                </div>

                <div className="p-3.5 rounded-xl bg-[var(--bg-card)] border border-[var(--border-subtle)] space-y-1.5">
                  <div className="flex justify-between text-[var(--text-muted)]">
                    <span>
                      Containers ({overview?.diskUsage.containersActive ?? 0}/
                      {overview?.diskUsage.containersTotal ?? 0} running)
                    </span>
                  </div>
                  <div className="text-lg font-mono font-semibold">
                    {formatBytes(overview?.diskUsage.containersSize)}
                  </div>
                  <div className="text-emerald-400 font-mono">
                    {formatBytes(overview?.diskUsage.containersReclaimable)} reclaimable
                  </div>
                </div>

                <div className="p-3.5 rounded-xl bg-[var(--bg-card)] border border-[var(--border-subtle)] space-y-1.5">
                  <div className="flex justify-between text-[var(--text-muted)]">
                    <span>
                      Local Volumes ({overview?.diskUsage.volumesActive ?? 0}/
                      {overview?.diskUsage.volumesTotal ?? 0} active)
                    </span>
                    <span className="text-amber-400 font-medium">Protected</span>
                  </div>
                  <div className="text-lg font-mono font-semibold">
                    {formatBytes(overview?.diskUsage.volumesSize)}
                  </div>
                  <div className="text-amber-400 font-mono">
                    {formatBytes(overview?.diskUsage.volumesReclaimable)} unattached
                  </div>
                </div>
              </div>

              {/* Safe Prune Builder */}
              <div className="p-4 rounded-xl bg-[var(--bg-card)] border border-[var(--border-subtle)] space-y-3 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h3 className="text-sm font-semibold">Docker System Prune Builder</h3>
                    <p className="text-[var(--text-muted)]">
                      Select which unused Docker resources to clean up. Named volumes are
                      excluded by default to protect local databases.
                    </p>
                  </div>
                  <div className="text-right font-mono">
                    <div className="text-[var(--text-muted)]">Estimated Reclaimable</div>
                    <div className="text-base font-semibold text-emerald-400">
                      {formatBytes(estimatedPruneBytes)}
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3 pt-1">
                  <label className="flex items-start gap-2.5 p-3 rounded-lg bg-[var(--bg-canvas)] border border-[var(--border-subtle)] cursor-pointer">
                    <input
                      type="checkbox"
                      checked={pruneReq.containers}
                      onChange={(e) =>
                        setPruneReq((p) => ({ ...p, containers: e.target.checked }))
                      }
                      className="mt-0.5"
                    />
                    <div>
                      <div className="font-semibold">Stopped Containers</div>
                      <div className="text-[var(--text-muted)] font-mono mt-0.5">
                        {formatBytes(overview?.diskUsage.containersReclaimable)}
                      </div>
                    </div>
                  </label>

                  <label className="flex items-start gap-2.5 p-3 rounded-lg bg-[var(--bg-canvas)] border border-[var(--border-subtle)] cursor-pointer">
                    <input
                      type="checkbox"
                      checked={pruneReq.images}
                      onChange={(e) =>
                        setPruneReq((p) => ({ ...p, images: e.target.checked }))
                      }
                      className="mt-0.5"
                    />
                    <div>
                      <div className="font-semibold">Unused Images</div>
                      <div className="text-[var(--text-muted)] font-mono mt-0.5">
                        {formatBytes(overview?.diskUsage.imagesReclaimable)}
                      </div>
                    </div>
                  </label>

                  <label className="flex items-start gap-2.5 p-3 rounded-lg bg-[var(--bg-canvas)] border border-[var(--border-subtle)] cursor-pointer">
                    <input
                      type="checkbox"
                      checked={pruneReq.buildCache}
                      onChange={(e) =>
                        setPruneReq((p) => ({ ...p, buildCache: e.target.checked }))
                      }
                      className="mt-0.5"
                    />
                    <div>
                      <div className="font-semibold">Build Cache</div>
                      <div className="text-[var(--text-muted)] font-mono mt-0.5">
                        {formatBytes(overview?.diskUsage.buildCacheReclaimable)}
                      </div>
                    </div>
                  </label>

                  <label className="flex items-start gap-2.5 p-3 rounded-lg bg-rose-500/5 border border-rose-500/30 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={pruneReq.volumes}
                      onChange={(e) =>
                        setPruneReq((p) => ({ ...p, volumes: e.target.checked }))
                      }
                      className="mt-0.5"
                    />
                    <div>
                      <div className="font-semibold text-rose-400">
                        Unattached Volumes (Caution)
                      </div>
                      <div className="text-[var(--text-muted)] font-mono mt-0.5">
                        {formatBytes(overview?.diskUsage.volumesReclaimable)}
                      </div>
                    </div>
                  </label>
                </div>

                <div className="flex items-center justify-between pt-2">
                  <div>
                    {lastPruneResult && (
                      <span className="text-emerald-400 font-mono">
                        ✓ Last prune reclaimed{' '}
                        {formatBytes(lastPruneResult.totalReclaimedBytes)}
                      </span>
                    )}
                  </div>
                  <button
                    type="button"
                    disabled={
                      pruning ||
                      (!pruneReq.containers &&
                        !pruneReq.images &&
                        !pruneReq.buildCache &&
                        !pruneReq.volumes)
                    }
                    onClick={handlePruneSubmit}
                    className="px-4 py-2 rounded-lg bg-[var(--accent-primary)] text-[var(--accent-primary-fg)] font-semibold disabled:opacity-50"
                  >
                    {pruning
                      ? 'Pruning...'
                      : `Prune Selected (${formatBytes(estimatedPruneBytes)})`}
                  </button>
                </div>
              </div>
            </div>
          )}
        </main>
      </div>

      {/* ================================================================= */}
      {/* NATIVE MODAL DIALOGS (per modern-web-guidance `dialog`)           */}
      {/* ================================================================= */}

      {/* 1. Pull Image Modal */}
      <dialog ref={pullDialogRef} aria-labelledby="pull-dialog-title">
        <div className="p-4 space-y-3 text-xs">
          <h2 id="pull-dialog-title" className="text-sm font-semibold">
            Pull Docker Image
          </h2>
          <p className="text-[var(--text-muted)]">
            Enter a registry image reference (for example{' '}
            <code className="font-mono">redis:7-alpine</code> or{' '}
            <code className="font-mono">postgres:18</code>).
          </p>
          <input
            type="text"
            value={pullImageRef}
            onChange={(e) => setPullImageRef(e.target.value)}
            placeholder="repository:tag"
            className="w-full px-3 py-1.5 rounded-md bg-[var(--bg-canvas)] border border-[var(--border-subtle)] font-mono text-xs"
          />
          {pullLogs.length > 0 && (
            <pre className="p-2.5 rounded-md bg-[var(--bg-canvas)] border border-[var(--border-subtle)] font-mono text-xs max-h-44 overflow-auto">
              {pullLogs.join('\n')}
            </pre>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <form method="dialog">
              <button
                value="cancel"
                className="px-3 py-1.5 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-canvas)]"
              >
                Close
              </button>
            </form>
            <button
              type="button"
              disabled={pulling || !pullImageRef.trim()}
              onClick={startImagePull}
              className="px-3 py-1.5 rounded-md bg-[var(--accent-primary)] text-[var(--accent-primary-fg)] font-semibold disabled:opacity-50"
            >
              {pulling ? 'Pulling...' : 'Pull Image'}
            </button>
          </div>
        </div>
      </dialog>

      {/* 2. Create Volume Modal */}
      <dialog ref={createVolumeDialogRef} aria-labelledby="create-vol-title">
        <div className="p-4 space-y-3 text-xs">
          <h2 id="create-vol-title" className="text-sm font-semibold">
            Create Docker Volume
          </h2>
          <input
            type="text"
            value={newVolumeName}
            onChange={(e) => setNewVolumeName(e.target.value)}
            placeholder="my_volume_data"
            className="w-full px-3 py-1.5 rounded-md bg-[var(--bg-canvas)] border border-[var(--border-subtle)] font-mono text-xs"
          />
          <div className="flex justify-end gap-2 pt-2">
            <form method="dialog">
              <button
                value="cancel"
                className="px-3 py-1.5 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-canvas)]"
              >
                Cancel
              </button>
            </form>
            <button
              type="button"
              onClick={handleCreateVolume}
              className="px-3 py-1.5 rounded-md bg-[var(--accent-primary)] text-[var(--accent-primary-fg)] font-semibold"
            >
              Create
            </button>
          </div>
        </div>
      </dialog>

      {/* 3. Destructive Volume Prune Confirmation Modal */}
      <dialog
        ref={confirmVolumePruneDialogRef}
        aria-labelledby="confirm-vol-prune-title"
        onClose={(e) => {
          const dlg = e.currentTarget;
          const choice = dlg.returnValue;
          dlg.returnValue = '';
          if (choice === 'confirm') {
            executePrune({
              ...pruneReq,
              volumes: true,
            });
          }
        }}
      >
        <div className="p-4 space-y-3 text-xs">
          <h2
            id="confirm-vol-prune-title"
            className="text-sm font-semibold text-rose-400"
          >
            Prune Unattached Volumes?
          </h2>
          <p className="text-[var(--text-muted)] leading-relaxed">
            This will permanently delete all local volumes not currently mounted by a
            container ({formatBytes(overview?.diskUsage.volumesReclaimable)}). Any
            database state stored in unattached volumes will be lost.
          </p>
          <form method="dialog" className="flex justify-end gap-2 pt-2">
            <button
              value="cancel"
              autoFocus
              className="px-3 py-1.5 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-canvas)] font-medium"
            >
              Cancel
            </button>
            <button
              value="confirm"
              className="px-3 py-1.5 rounded-md bg-rose-600 text-white font-semibold"
            >
              Delete Unattached Volumes
            </button>
          </form>
        </div>
      </dialog>
    </div>
  );
}

// ============================================================================
// SUBCOMPONENTS: COMPOSE GROUP ROWS & CONTAINER ROW
// ============================================================================

interface ComposeStackRowsProps {
  group: ComposeGroup;
  isCollapsed: boolean;
  isSelectedStack: boolean;
  selectedContainerId: string | null;
  compact: boolean;
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

function ComposeStackRows({
  group,
  isCollapsed,
  isSelectedStack,
  selectedContainerId,
  compact,
  onToggleCollapse,
  onSelectStack,
  onSelectContainer,
  onContainerAction,
  onComposeAction,
}: ComposeStackRowsProps) {
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
              onClick={() => onComposeAction(group.name, 'restart')}
              className="p-1 rounded border border-[var(--border-subtle)] bg-[var(--bg-card)] hover:bg-[var(--bg-elevated)] align-middle"
              title="Restart stack"
              aria-label={`Restart ${group.name} stack`}
            >
              <RotateCw className="w-3 h-3" />
            </button>
            <button
              type="button"
              onClick={() =>
                onComposeAction(
                  group.name,
                  group.runningCount > 0 ? 'stop' : 'start'
                )
              }
              className="p-1 rounded border border-[var(--border-subtle)] bg-[var(--bg-card)] hover:bg-[var(--bg-elevated)] align-middle"
              title={group.runningCount > 0 ? 'Stop stack' : 'Start stack'}
              aria-label={
                group.runningCount > 0
                  ? `Stop ${group.name} stack`
                  : `Start ${group.name} stack`
              }
            >
              {group.runningCount > 0 ? (
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
  isSelected: boolean;
  onSelect: (tab?: ContainerTab) => void;
  onAction: (
    id: string,
    action: 'start' | 'stop' | 'restart' | 'delete'
  ) => Promise<void>;
}

function ContainerRow({
  ctr,
  indented,
  compact,
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
        <span className={isRunning ? 'text-emerald-400' : 'text-[var(--text-muted)]'}>
          {ctr.status}
        </span>
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
                onClick={() => onAction(ctr.id, 'restart')}
                className="p-1 rounded border border-[var(--border-subtle)] bg-[var(--bg-card)] hover:bg-[var(--bg-elevated)] align-middle"
                title="Restart"
                aria-label={`Restart ${ctr.name}`}
              >
                <RotateCw className="w-3 h-3" />
              </button>
              <button
                type="button"
                onClick={() => onAction(ctr.id, 'stop')}
                className="p-1 rounded border border-[var(--border-subtle)] bg-[var(--bg-card)] hover:bg-[var(--bg-elevated)] align-middle"
                title="Stop"
                aria-label={`Stop ${ctr.name}`}
              >
                <Square className="w-3 h-3 text-rose-400" />
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => onAction(ctr.id, 'start')}
              className="p-1 rounded border border-emerald-500/40 bg-emerald-500/10 text-emerald-400 align-middle"
              title="Start"
              aria-label={`Start ${ctr.name}`}
            >
              <Play className="w-3 h-3" />
            </button>
          )}
          <button
            type="button"
            onClick={() => onAction(ctr.id, 'delete')}
            className="p-1 rounded border border-[var(--border-subtle)] bg-[var(--bg-card)] hover:text-rose-400 align-middle"
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
