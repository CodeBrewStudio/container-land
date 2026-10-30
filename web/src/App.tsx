import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Box,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Cpu,
  Database,
  Download,
  HardDrive,
  Layers,
  Loader2,
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
  formatRelativeTime,
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

interface ToastNotification {
  id: string;
  message: string;
  status: 'pending' | 'success' | 'error';
}

interface ConfirmActionState {
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm: () => Promise<void>;
}

export function App() {
  const [activeView, setActiveView] = useState<MainView>('containers');
  const [sseConnected, setSseConnected] = useState(false);
  const [toasts, setToasts] = useState<ToastNotification[]>([]);
  const [pendingActions, setPendingActions] = useState<Record<string, string>>({});

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
  const [selectedImageIds, setSelectedImageIds] = useState<Set<string>>(new Set());
  const pullDialogRef = useRef<HTMLDialogElement | null>(null);
  const [pullImageRef, setPullImageRef] = useState('');
  const [pulling, setPulling] = useState(false);
  const [pullLogs, setPullLogs] = useState<string[]>([]);

  // Volumes view UI state
  const [volumeQuery, setVolumeQuery] = useState('');
  const [volumeFilter, setVolumeFilter] = useState<'all' | 'in-use' | 'unused'>('all');
  const [selectedVolumeNames, setSelectedVolumeNames] = useState<Set<string>>(new Set());
  const createVolumeDialogRef = useRef<HTMLDialogElement | null>(null);
  const [newVolumeName, setNewVolumeName] = useState('');
  const confirmVolumePruneDialogRef = useRef<HTMLDialogElement | null>(null);

  // Generic Confirmation Modal state (for deleting images, volumes, containers, networks)
  const confirmActionDialogRef = useRef<HTMLDialogElement | null>(null);
  const [confirmState, setConfirmState] = useState<ConfirmActionState | null>(null);

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

  // Toast helpers
  const pushToast = useCallback(
    (message: string, status: 'pending' | 'success' | 'error' = 'success'): string => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      setToasts((prev) => [...prev.slice(-4), { id, message, status }]);
      if (status !== 'pending') {
        setTimeout(() => {
          setToasts((prev) => prev.filter((t) => t.id !== id));
        }, 4000);
      }
      return id;
    },
    []
  );

  const updateToast = useCallback(
    (id: string, message: string, status: 'success' | 'error') => {
      setToasts((prev) =>
        prev.map((t) => (t.id === id ? { ...t, message, status } : t))
      );
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, 4000);
    },
    []
  );

  const openConfirmDialog = useCallback((state: ConfirmActionState) => {
    setConfirmState(state);
    setTimeout(() => {
      confirmActionDialogRef.current?.showModal();
    }, 0);
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
        setDrawerSelection((prev) => {
          if (!prev) return null;
          if (prev.kind === 'volume') return prev;
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
      if (r.ok) {
        const list = (await r.json()) as ImageSummary[];
        setImages(list);
        setSelectedImageIds((prev) => {
          const valid = new Set(list.map((i) => i.id));
          const next = new Set<string>();
          prev.forEach((id) => {
            if (valid.has(id)) next.add(id);
          });
          return next;
        });
      }
    } catch {
      // ignore
    }
  }, []);

  const fetchVolumes = useCallback(async () => {
    try {
      const r = await fetch('/api/volumes');
      if (r.ok) {
        const list = (await r.json()) as VolumeSummary[];
        setVolumes(list);
        setSelectedVolumeNames((prev) => {
          const valid = new Set(list.map((v) => v.name));
          const next = new Set<string>();
          prev.forEach((n) => {
            if (valid.has(n)) next.add(n);
          });
          return next;
        });
        setDrawerSelection((prev) => {
          if (!prev || prev.kind !== 'volume') return prev;
          const updated = list.find((v) => v.name === prev.volume.name);
          return updated ? { kind: 'volume', volume: updated } : null;
        });
      }
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

    const interval = setInterval(() => {
      fetchContainers(true);
    }, 5000);

    return () => {
      clearInterval(interval);
      es.close();
    };
  }, [fetchOverview, fetchContainers, fetchImages, fetchVolumes, fetchNetworks]);

  // Keyboard shortcuts
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

  // All containers helper
  const allContainers = useMemo(() => {
    return [
      ...containersData.composeGroups.flatMap((g) => g.containers),
      ...(containersData.standalone ?? []),
    ];
  }, [containersData]);

  // Container lifecycle action with immediate toast feedback & confirmation on delete
  const executeContainerAction = async (
    id: string,
    action: 'start' | 'stop' | 'restart' | 'delete'
  ) => {
    const targetCtr = allContainers.find((c) => c.id === id);
    const label = targetCtr ? targetCtr.name : id.slice(0, 12);
    const actionKey = `ctr:${id}`;
    const verbMap = {
      start: ['Starting', 'started'],
      stop: ['Stopping', 'stopped'],
      restart: ['Restarting', 'restarted'],
      delete: ['Deleting', 'deleted'],
    } as const;
    const [gerund, past] = verbMap[action];

    setPendingActions((prev) => ({ ...prev, [actionKey]: action }));
    const toastId = pushToast(`${gerund} container ${label}...`, 'pending');

    try {
      if (action === 'delete') {
        const r = await fetch(`/api/containers/${encodeURIComponent(id)}?force=true`, {
          method: 'DELETE',
        });
        if (!r.ok) throw new Error(await r.text());
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
      }
      updateToast(toastId, `Container ${label} ${past}`, 'success');
      await fetchContainers(true);
      await fetchOverview(true);
    } catch (err) {
      updateToast(
        toastId,
        `Failed to ${action} ${label}: ${err instanceof Error ? err.message : String(err)}`,
        'error'
      );
    } finally {
      setPendingActions((prev) => {
        const next = { ...prev };
        delete next[actionKey];
        return next;
      });
    }
  };

  const handleContainerAction = async (
    id: string,
    action: 'start' | 'stop' | 'restart' | 'delete'
  ) => {
    if (action === 'delete') {
      const targetCtr = allContainers.find((c) => c.id === id);
      const label = targetCtr ? targetCtr.name : id.slice(0, 12);
      openConfirmDialog({
        title: `Delete Container "${label}"?`,
        description: `This will permanently remove container "${label}"${
          targetCtr?.state === 'running' ? ' (stopping it first)' : ''
        }. Named volumes will be preserved.`,
        confirmLabel: 'Delete Container',
        onConfirm: () => executeContainerAction(id, 'delete'),
      });
      return;
    }
    await executeContainerAction(id, action);
  };

  // Compose Stack lifecycle action with immediate toast feedback
  const handleComposeAction = async (
    project: string,
    action: 'start' | 'stop' | 'restart' | 'remove'
  ) => {
    const actionKey = `stack:${project}`;
    const verbMap = {
      start: ['Starting', 'started'],
      stop: ['Stopping', 'stopped'],
      restart: ['Restarting', 'restarted'],
      remove: ['Removing', 'removed'],
    } as const;
    const [gerund, past] = verbMap[action];

    setPendingActions((prev) => ({ ...prev, [actionKey]: action }));
    const toastId = pushToast(`${gerund} stack ${project}...`, 'pending');

    try {
      const r = await fetch(
        `/api/compose/${encodeURIComponent(project)}/${action}`,
        { method: 'POST' }
      );
      if (!r.ok) throw new Error(await r.text());
      updateToast(toastId, `Stack ${project} ${past}`, 'success');
      if (action === 'remove') {
        setDrawerSelection(null);
      }
      await fetchContainers(true);
      await fetchOverview(true);
    } catch (err) {
      updateToast(
        toastId,
        `Stack ${project} ${action} failed: ${err instanceof Error ? err.message : String(err)}`,
        'error'
      );
    } finally {
      setPendingActions((prev) => {
        const next = { ...prev };
        delete next[actionKey];
        return next;
      });
    }
  };

  const executePrune = async (req: PruneRequest) => {
    setPruning(true);
    const toastId = pushToast('Pruning selected unused Docker resources...', 'pending');
    try {
      const r = await fetch('/api/system/prune', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req),
      });
      if (!r.ok) throw new Error(await r.text());
      const res = (await r.json()) as PruneResponse;
      setLastPruneResult(res);
      updateToast(
        toastId,
        `Prune complete — reclaimed ${formatBytes(res.totalReclaimedBytes)}`,
        'success'
      );
      await refreshAll();
    } catch (err) {
      updateToast(
        toastId,
        `Prune failed: ${err instanceof Error ? err.message : String(err)}`,
        'error'
      );
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

  // Pull image handler using native <dialog> and <form onSubmit>
  const startImagePull = () => {
    const ref = pullImageRef.trim();
    if (!ref || pulling) return;
    setPulling(true);
    setPullLogs([`Pulling ${ref}...`]);
    const toastId = pushToast(`Pulling image ${ref}...`, 'pending');
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
      updateToast(toastId, `Successfully pulled ${ref}`, 'success');
    });
    es.addEventListener('error', (ev) => {
      es.close();
      setPulling(false);
      const data = (ev as MessageEvent).data;
      setPullLogs((prev) => [...prev, `✗ Pull failed ${data || ''}`]);
      updateToast(toastId, `Failed to pull ${ref}`, 'error');
    });
  };

  // Single & Bulk Image deletion with confirmation modal
  const executeDeleteImages = async (targetImages: ImageSummary[]) => {
    const label =
      targetImages.length === 1
        ? `${targetImages[0].repository}:${targetImages[0].tag}`
        : `${targetImages.length} images`;
    const toastId = pushToast(`Deleting ${label}...`, 'pending');
    let deletedCount = 0;
    let lastError = '';

    for (const img of targetImages) {
      try {
        const r = await fetch(
          `/api/images/${encodeURIComponent(img.id)}?force=true`,
          { method: 'DELETE' }
        );
        if (!r.ok) {
          lastError = await r.text();
        } else {
          deletedCount++;
        }
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }

    if (deletedCount === targetImages.length) {
      updateToast(toastId, `Deleted ${label}`, 'success');
    } else if (deletedCount > 0) {
      updateToast(
        toastId,
        `Deleted ${deletedCount}/${targetImages.length} images (${lastError})`,
        'error'
      );
    } else {
      updateToast(toastId, `Failed to delete ${label}: ${lastError}`, 'error');
    }

    setSelectedImageIds(new Set());
    await fetchImages();
    await fetchOverview(true);
  };

  const confirmDeleteSingleImage = (img: ImageSummary) => {
    const tagLabel = `${img.repository}:${img.tag} (${img.shortId})`;
    openConfirmDialog({
      title: `Delete Image "${img.repository}:${img.tag}"?`,
      description: img.inUse
        ? `Image ${tagLabel} is referenced by container(s) (${(img.usedByContainers ?? []).join(', ')}). Deleting it will untag or force-remove the image.`
        : `This will permanently remove image ${tagLabel} (${formatBytes(img.sizeBytes)}) from your local Docker Engine.`,
      confirmLabel: 'Delete Image',
      onConfirm: () => executeDeleteImages([img]),
    });
  };

  const confirmDeleteSelectedImages = () => {
    const targets = images.filter((img) => selectedImageIds.has(img.id));
    if (targets.length === 0) return;
    const totalBytes = targets.reduce((acc, i) => acc + i.sizeBytes, 0);
    const inUseCount = targets.filter((i) => i.inUse).length;
    openConfirmDialog({
      title: `Delete ${targets.length} Selected Image${targets.length > 1 ? 's' : ''}?`,
      description: `You are about to delete ${targets.length} image${
        targets.length > 1 ? 's' : ''
      } (${formatBytes(totalBytes)} total)${
        inUseCount > 0 ? `, including ${inUseCount} currently referenced by containers` : ''
      }.`,
      confirmLabel: `Delete ${targets.length} Image${targets.length > 1 ? 's' : ''}`,
      onConfirm: () => executeDeleteImages(targets),
    });
  };

  const handleCreateVolume = async () => {
    const name = newVolumeName.trim();
    if (!name) return;
    const toastId = pushToast(`Creating volume ${name}...`, 'pending');
    try {
      const r = await fetch('/api/volumes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!r.ok) throw new Error(await r.text());
      setNewVolumeName('');
      createVolumeDialogRef.current?.close();
      updateToast(toastId, `Created volume ${name}`, 'success');
      await fetchVolumes();
      await fetchOverview(true);
    } catch (err) {
      updateToast(
        toastId,
        `Failed to create volume: ${err instanceof Error ? err.message : String(err)}`,
        'error'
      );
    }
  };

  // Single & Bulk Volume deletion with confirmation modal
  const executeDeleteVolumes = async (targetVolumes: VolumeSummary[]) => {
    const label =
      targetVolumes.length === 1
        ? targetVolumes[0].shortName
        : `${targetVolumes.length} volumes`;
    const toastId = pushToast(`Deleting ${label}...`, 'pending');
    let deletedCount = 0;
    let lastError = '';

    for (const vol of targetVolumes) {
      try {
        const r = await fetch(`/api/volumes/${encodeURIComponent(vol.name)}?force=true`, {
          method: 'DELETE',
        });
        if (!r.ok) {
          lastError = await r.text();
        } else {
          deletedCount++;
          if (
            drawerSelection?.kind === 'volume' &&
            drawerSelection.volume.name === vol.name
          ) {
            setDrawerSelection(null);
          }
        }
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }

    if (deletedCount === targetVolumes.length) {
      updateToast(toastId, `Deleted ${label}`, 'success');
    } else if (deletedCount > 0) {
      updateToast(
        toastId,
        `Deleted ${deletedCount}/${targetVolumes.length} volumes (${lastError})`,
        'error'
      );
    } else {
      updateToast(toastId, `Failed to delete ${label}: ${lastError}`, 'error');
    }

    setSelectedVolumeNames(new Set());
    await fetchVolumes();
    await fetchOverview(true);
  };

  const confirmDeleteSingleVolume = (vol: VolumeSummary) => {
    openConfirmDialog({
      title: `Delete Volume "${vol.shortName}"?`,
      description: `This will permanently delete volume "${vol.name}" (${
        vol.sizeBytes >= 0 ? formatBytes(vol.sizeBytes) : 'unknown size'
      }${vol.contentHint ? ` · ${vol.contentHint}` : ''}). Any data inside this volume cannot be recovered.`,
      confirmLabel: 'Delete Volume',
      onConfirm: () => executeDeleteVolumes([vol]),
    });
  };

  const confirmDeleteSelectedVolumes = () => {
    const targets = volumes.filter((v) => selectedVolumeNames.has(v.name));
    if (targets.length === 0) return;
    const totalBytes = targets.reduce(
      (acc, v) => acc + (v.sizeBytes > 0 ? v.sizeBytes : 0),
      0
    );
    openConfirmDialog({
      title: `Delete ${targets.length} Selected Volume${targets.length > 1 ? 's' : ''}?`,
      description: `This will permanently delete ${targets.length} volume${
        targets.length > 1 ? 's' : ''
      } (${formatBytes(totalBytes)}) and all data stored inside them.`,
      confirmLabel: `Delete ${targets.length} Volume${targets.length > 1 ? 's' : ''}`,
      onConfirm: () => executeDeleteVolumes(targets),
    });
  };

  const confirmDeleteNetwork = (net: NetworkSummary) => {
    openConfirmDialog({
      title: `Remove Network "${net.name}"?`,
      description: `This will delete Docker network "${net.name}" (${net.shortId}).`,
      confirmLabel: 'Remove Network',
      onConfirm: async () => {
        const toastId = pushToast(`Removing network ${net.name}...`, 'pending');
        try {
          const r = await fetch(`/api/networks/${encodeURIComponent(net.id)}`, {
            method: 'DELETE',
          });
          if (!r.ok) throw new Error(await r.text());
          updateToast(toastId, `Removed network ${net.name}`, 'success');
          await fetchNetworks();
        } catch (err) {
          updateToast(
            toastId,
            `Failed to remove network: ${err instanceof Error ? err.message : String(err)}`,
            'error'
          );
        }
      },
    });
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
        v.shortName.toLowerCase().includes(q) ||
        (v.contentHint && v.contentHint.toLowerCase().includes(q)) ||
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

  // =========================================================================
  // DOCKER SYSTEM VS HOST SYSTEM TELEMETRY CALCULATIONS
  // =========================================================================
  const runningContainers = useMemo(
    () => allContainers.filter((c) => c.state === 'running'),
    [allContainers]
  );

  // Sum of CPU % across all running Docker containers (100% = 1 core)
  const dockerCpuRawPct = useMemo(
    () => runningContainers.reduce((acc, c) => acc + (c.cpuPercent || 0), 0),
    [runningContainers]
  );

  const hostCores = overview?.host.cpuCores || overview?.engine.ncpu || 1;
  // Normalised to 0..100% of total host CPU capacity
  const dockerCpuHostPct = Math.min(100, dockerCpuRawPct / hostCores);
  const hostCpuTotalPct = overview?.host.cpuPercent ?? 0;
  const otherHostCpuPct = Math.max(0, hostCpuTotalPct - dockerCpuHostPct);

  // Sum of live RAM (excluding page cache) used by all running Docker containers
  // This is the exact memory freed if all running containers are stopped.
  const dockerMemBytes = useMemo(
    () => runningContainers.reduce((acc, c) => acc + (c.memUsageBytes || 0), 0),
    [runningContainers]
  );
  const hostMemTotalBytes = overview?.host.memTotalBytes || 1;
  const hostMemUsedBytes = overview?.host.memUsedBytes ?? 0;
  const hostMemTotalPct = overview?.host.memPercent ?? 0;
  const dockerMemHostPct = Math.min(100, (dockerMemBytes / hostMemTotalBytes) * 100);
  const otherHostMemPct = Math.max(0, hostMemTotalPct - dockerMemHostPct);

  // Docker disk vs Host root disk
  const dockerDiskBytes = overview?.diskUsage.totalSize ?? 0;
  const hostDiskTotalBytes = overview?.host.rootDisk.totalBytes || 1;
  const hostDiskUsedPct = overview?.host.rootDisk.usedPercent ?? 0;
  const dockerDiskHostPct = Math.min(100, (dockerDiskBytes / hostDiskTotalBytes) * 100);
  const otherHostDiskPct = Math.max(0, hostDiskUsedPct - dockerDiskHostPct);

  const reclaimableTotal = overview?.diskUsage.totalReclaimable ?? 0;

  // Sorted running containers by RAM usage for the Resources & Prune breakdown
  const sortedRunningConsumers = useMemo(() => {
    return [...runningContainers].sort((a, b) => b.memUsageBytes - a.memUsageBytes);
  }, [runningContainers]);

  const sortedRunningStacks = useMemo(() => {
    return [...containersData.composeGroups]
      .filter((g) => g.runningCount > 0)
      .sort((a, b) => b.memUsageBytes - a.memUsageBytes);
  }, [containersData.composeGroups]);

  // Multi-select helpers for Images
  const allFilteredImagesSelected =
    filteredImages.length > 0 &&
    filteredImages.every((img) => selectedImageIds.has(img.id));

  const toggleSelectAllImages = () => {
    if (allFilteredImagesSelected) {
      setSelectedImageIds(new Set());
    } else {
      setSelectedImageIds(new Set(filteredImages.map((img) => img.id)));
    }
  };

  const toggleSelectImage = (id: string) => {
    setSelectedImageIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Multi-select helpers for Volumes
  const allFilteredVolumesSelected =
    filteredVolumes.length > 0 &&
    filteredVolumes.every((v) => selectedVolumeNames.has(v.name));

  const toggleSelectAllVolumes = () => {
    if (allFilteredVolumesSelected) {
      setSelectedVolumeNames(new Set());
    } else {
      setSelectedVolumeNames(new Set(filteredVolumes.map((v) => v.name)));
    }
  };

  const toggleSelectVolume = (name: string) => {
    setSelectedVolumeNames((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-[var(--bg-canvas)] text-[var(--text-main)]">
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

        {/* Live Telemetry Strip (Docker portion vs Host system) + Theme Override */}
        <div className="flex flex-wrap items-center gap-4 text-xs">
          {/* CPU: Docker vs Host */}
          <div
            className="flex items-center gap-2 font-mono tabular-nums"
            title={`Docker Containers: ${dockerCpuRawPct.toFixed(1)}% (${dockerCpuHostPct.toFixed(1)}% of ${hostCores} cores) · Total Host CPU: ${hostCpuTotalPct.toFixed(1)}%`}
          >
            <span className="text-[var(--text-muted)] font-sans font-medium">CPU</span>
            <div className="w-20 h-2 bg-[var(--bg-sidebar)] rounded-full overflow-hidden border border-[var(--border-subtle)] flex">
              <div
                className="h-full bg-emerald-500 transition-all"
                style={{ width: `${dockerCpuHostPct}%` }}
                title={`Docker: ${dockerCpuHostPct.toFixed(1)}%`}
              />
              <div
                className="h-full bg-slate-500/50 transition-all"
                style={{ width: `${otherHostCpuPct}%` }}
                title={`Rest of Host: ${otherHostCpuPct.toFixed(1)}%`}
              />
            </div>
            <span className="text-emerald-400 font-semibold">
              {dockerCpuRawPct.toFixed(1)}%
            </span>
            <span className="text-[var(--text-muted)]">
              / {hostCpuTotalPct.toFixed(0)}% host
            </span>
          </div>

          {/* RAM: Docker vs Host */}
          <div
            className="flex items-center gap-2 font-mono tabular-nums"
            title={`Docker Containers RAM: ${formatBytes(dockerMemBytes)} (freed if stopped) · Total Host RAM Used: ${formatBytes(hostMemUsedBytes)} / ${formatBytes(hostMemTotalBytes)}`}
          >
            <span className="text-[var(--text-muted)] font-sans font-medium">RAM</span>
            <div className="w-20 h-2 bg-[var(--bg-sidebar)] rounded-full overflow-hidden border border-[var(--border-subtle)] flex">
              <div
                className="h-full bg-sky-500 transition-all"
                style={{ width: `${dockerMemHostPct}%` }}
                title={`Docker Containers: ${formatBytes(dockerMemBytes)}`}
              />
              <div
                className="h-full bg-slate-500/50 transition-all"
                style={{ width: `${otherHostMemPct}%` }}
                title="Rest of Host System"
              />
            </div>
            <span className="text-sky-400 font-semibold">
              {formatBytes(dockerMemBytes, 1)}
            </span>
            <span className="text-[var(--text-muted)]">
              / {formatBytes(hostMemUsedBytes, 1)} host
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
                            pendingActions={pendingActions}
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
                              colSpan={drawerSelection ? 5 : 7}
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
                              pendingAction={pendingActions[`ctr:${ctr.id}`]}
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
                              colSpan={drawerSelection ? 5 : 7}
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
                    onDeleteVolume={(volName) => {
                      const v = volumes.find((item) => item.name === volName);
                      if (v) confirmDeleteSingleVolume(v);
                    }}
                  />
                )}
              </div>
            </div>
          )}

          {/* ------------------------------------------------------------- */}
          {/* VIEW 2: IMAGES (WITH CHECKBOX MULTI-SELECT & CONFIRM DELETE)  */}
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
                  {selectedImageIds.size > 0 && (
                    <button
                      type="button"
                      onClick={confirmDeleteSelectedImages}
                      className="px-3 py-1.5 rounded-md bg-rose-600 text-white font-semibold inline-flex items-center gap-1.5 shadow-sm hover:bg-rose-500"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      <span>Delete Selected ({selectedImageIds.size})</span>
                    </button>
                  )}
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
                      <th className="py-2 px-3 w-8">
                        <input
                          type="checkbox"
                          aria-label="Select all visible images"
                          checked={allFilteredImagesSelected}
                          onChange={toggleSelectAllImages}
                        />
                      </th>
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
                    {filteredImages.map((img) => {
                      const isChecked = selectedImageIds.has(img.id);
                      return (
                        <tr
                          key={img.id}
                          onClick={() => toggleSelectImage(img.id)}
                          className={`cursor-pointer transition ${
                            isChecked
                              ? 'bg-sky-500/10'
                              : 'hover:bg-[var(--bg-elevated)]/40'
                          }`}
                        >
                          <td
                            className="py-2 px-3"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <input
                              type="checkbox"
                              aria-label={`Select image ${img.repository}:${img.tag}`}
                              checked={isChecked}
                              onChange={() => toggleSelectImage(img.id)}
                            />
                          </td>
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
                          <td
                            className="py-2 px-3 text-right"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <button
                              type="button"
                              onClick={() => confirmDeleteSingleImage(img)}
                              className="px-2 py-0.5 rounded border border-rose-500/40 text-rose-400 hover:bg-rose-500/10 inline-flex items-center gap-1 font-sans"
                            >
                              <Trash2 className="w-3 h-3" />
                              <span>Delete</span>
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ------------------------------------------------------------- */}
          {/* VIEW 3: VOLUMES (PROVENANCE, CONTENT HINTS, DRAWER INSPECTOR) */}
          {/* ------------------------------------------------------------- */}
          {activeView === 'volumes' && (
            <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
              <div className="px-4 py-2.5 border-b border-[var(--border-subtle)] bg-[var(--bg-card)] flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <div className="relative">
                    <Search className="w-3.5 h-3.5 text-[var(--text-muted)] absolute left-2.5 top-2" />
                    <input
                      type="search"
                      value={volumeQuery}
                      onChange={(e) => setVolumeQuery(e.target.value)}
                      placeholder="Filter volumes by name, content hint (e.g. Postgres, RabbitMQ), or container..."
                      className="pl-8 pr-3 py-1 rounded-md bg-[var(--bg-canvas)] border border-[var(--border-subtle)] text-xs w-80 font-mono focus:outline-none"
                    />
                  </div>
                  <div className="flex items-center rounded-md border border-[var(--border-subtle)] bg-[var(--bg-canvas)] p-0.5 text-xs">
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
                            ? 'bg-[var(--bg-card)] text-[var(--text-main)] shadow-sm'
                            : 'text-[var(--text-muted)]'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="flex items-center gap-2 text-xs">
                  {selectedVolumeNames.size > 0 && (
                    <button
                      type="button"
                      onClick={confirmDeleteSelectedVolumes}
                      className="px-3 py-1.5 rounded-md bg-rose-600 text-white font-semibold inline-flex items-center gap-1.5 shadow-sm hover:bg-rose-500"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      <span>Delete Selected ({selectedVolumeNames.size})</span>
                    </button>
                  )}
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

              <div className="flex-1 flex flex-row min-h-0 overflow-hidden">
                <div
                  tabIndex={0}
                  role="region"
                  aria-label="Docker volumes"
                  className={`table-wrapper flex-1 min-h-0 bg-[var(--bg-card)] ${
                    drawerSelection?.kind === 'volume' ? 'w-1/2' : 'w-full'
                  }`}
                >
                  <table className="text-left text-xs font-mono tabular-nums">
                    <thead>
                      <tr className="border-b border-[var(--border-subtle)] text-[var(--text-muted)] font-sans">
                        <th className="py-2 px-3 w-8">
                          <input
                            type="checkbox"
                            aria-label="Select all visible volumes"
                            checked={allFilteredVolumesSelected}
                            onChange={toggleSelectAllVolumes}
                          />
                        </th>
                        <th className="py-2 px-3 font-medium">Volume / Type</th>
                        <th className="py-2 px-3 font-medium">
                          Inferred Contents / What It Was Used For
                        </th>
                        {drawerSelection?.kind !== 'volume' && (
                          <th className="py-2 px-3 font-medium">Container Mounts</th>
                        )}
                        {drawerSelection?.kind !== 'volume' && (
                          <th className="py-2 px-3 font-medium">Created</th>
                        )}
                        <th className="py-2 px-3 font-medium">Size</th>
                        {drawerSelection?.kind !== 'volume' && (
                          <th className="py-2 px-3 font-medium text-right">Actions</th>
                        )}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[var(--border-subtle)]">
                      {filteredVolumes.map((vol) => {
                        const isChecked = selectedVolumeNames.has(vol.name);
                        const isSelectedDrawer =
                          drawerSelection?.kind === 'volume' &&
                          drawerSelection.volume.name === vol.name;

                        return (
                          <tr
                            key={vol.name}
                            onClick={() =>
                              setDrawerSelection({ kind: 'volume', volume: vol })
                            }
                            className={`cursor-pointer transition ${
                              isSelectedDrawer
                                ? 'bg-[var(--bg-elevated)] border-l-2 border-l-purple-400'
                                : isChecked
                                  ? 'bg-sky-500/10'
                                  : 'hover:bg-[var(--bg-elevated)]/40'
                            }`}
                          >
                            <td
                              className="py-2 px-3"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <input
                                type="checkbox"
                                aria-label={`Select volume ${vol.shortName}`}
                                checked={isChecked}
                                onChange={() => toggleSelectVolume(vol.name)}
                              />
                            </td>
                            <td className="py-2 px-3">
                              <div className="flex items-center gap-2 whitespace-nowrap">
                                <span
                                  className="font-semibold"
                                  title={vol.name}
                                >
                                  {vol.shortName}
                                </span>
                                {vol.anonymous ? (
                                  <span
                                    className="px-1.5 py-0.5 rounded bg-zinc-500/20 text-[var(--text-muted)] text-[11px] font-sans"
                                    title="Anonymous Docker volume (64-char hash created by a container VOLUME instruction)"
                                  >
                                    Anon
                                  </span>
                                ) : vol.composeProject ? (
                                  <span className="px-1.5 py-0.5 rounded bg-sky-500/15 text-sky-400 text-[11px] font-sans">
                                    Stack: {vol.composeProject}
                                  </span>
                                ) : (
                                  <span className="px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400 text-[11px] font-sans">
                                    Named
                                  </span>
                                )}
                              </div>
                            </td>
                            <td className="py-2 px-3">
                              <div className="flex flex-col gap-0.5">
                                <span
                                  className={
                                    vol.contentHint === 'Empty volume'
                                      ? 'text-[var(--text-muted)]'
                                      : 'text-purple-400 font-semibold font-sans'
                                  }
                                >
                                  {vol.contentHint || 'Inspecting...'}
                                </span>
                                {vol.topEntries && vol.topEntries.length > 0 && (
                                  <span className="text-[11px] text-[var(--text-muted)] truncate max-w-[14rem]">
                                    /{vol.topEntries.slice(0, 4).join(', /')}
                                    {vol.topEntries.length > 4 ? ', ...' : ''}
                                  </span>
                                )}
                              </div>
                            </td>
                            {drawerSelection?.kind !== 'volume' && (
                              <td className="py-2 px-3">
                                {vol.inUse ? (
                                  <div className="flex flex-col gap-0.5">
                                    {(vol.mountPaths && vol.mountPaths.length > 0
                                      ? vol.mountPaths
                                      : vol.usedByContainers ?? []
                                    ).map((mp) => (
                                      <span
                                        key={mp}
                                        className="px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400 inline-block w-fit truncate max-w-[13rem]"
                                        title={mp}
                                      >
                                        {mp}
                                      </span>
                                    ))}
                                  </div>
                                ) : (
                                  <span className="px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400">
                                    Unattached
                                  </span>
                                )}
                              </td>
                            )}
                            {drawerSelection?.kind !== 'volume' && (
                              <td className="py-2 px-3 text-[var(--text-muted)]">
                                {formatRelativeTime(vol.createdAt)}
                              </td>
                            )}
                            <td className="py-2 px-3 whitespace-nowrap">
                              {vol.sizeBytes >= 0 ? formatBytes(vol.sizeBytes) : '—'}
                            </td>
                            {drawerSelection?.kind !== 'volume' && (
                              <td
                                className="py-2 px-3 text-right space-x-1 whitespace-nowrap"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <button
                                  type="button"
                                  onClick={() =>
                                    setDrawerSelection({ kind: 'volume', volume: vol })
                                  }
                                  className="px-2 py-0.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] hover:bg-[var(--bg-elevated)] font-sans"
                                >
                                  Inspect
                                </button>
                                <button
                                  type="button"
                                  onClick={() => confirmDeleteSingleVolume(vol)}
                                  className="px-2 py-0.5 rounded border border-rose-500/40 text-rose-400 hover:bg-rose-500/10 inline-flex items-center gap-1 font-sans"
                                >
                                  <Trash2 className="w-3 h-3" />
                                  <span>Delete</span>
                                </button>
                              </td>
                            )}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {drawerSelection?.kind === 'volume' && (
                  <RightDrawer
                    selection={drawerSelection}
                    onClose={() => setDrawerSelection(null)}
                    onContainerAction={handleContainerAction}
                    onComposeAction={handleComposeAction}
                    onSelectContainer={(ctr, tab) => {
                      setActiveView('containers');
                      setDrawerSelection({
                        kind: 'container',
                        container: ctr,
                        initialTab: tab,
                      });
                    }}
                    onDeleteVolume={(volName) => {
                      const v = volumes.find((item) => item.name === volName);
                      if (v) confirmDeleteSingleVolume(v);
                    }}
                  />
                )}
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
                              onClick={() => confirmDeleteNetwork(net)}
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
          {/* VIEW 5: RESOURCES & PRUNE CENTRE (DOCKER VS HOST + CONSUMERS) */}
          {/* ------------------------------------------------------------- */}
          {activeView === 'resources' && (
            <div className="flex-1 p-4 space-y-4 overflow-auto">
              {/* Row 1: Docker System vs Host System (Dual-Colour Stacked Bars) */}
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 text-xs">
                {/* 1. CPU: Docker Share vs Host System */}
                <div className="p-3.5 rounded-xl bg-[var(--bg-card)] border border-[var(--border-subtle)] space-y-2.5">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold inline-flex items-center gap-1.5">
                      <Cpu className="w-4 h-4 text-emerald-400" />
                      <span>CPU: Docker vs Host ({hostCores} cores)</span>
                    </span>
                    <span className="font-mono text-sm font-semibold text-emerald-400">
                      {dockerCpuRawPct.toFixed(1)}% Docker
                    </span>
                  </div>

                  {/* Dual-colour stacked progress bar */}
                  <div className="w-full h-3 bg-[var(--bg-sidebar)] rounded-full overflow-hidden border border-[var(--border-subtle)] flex">
                    <div
                      className="h-full bg-emerald-500 transition-all"
                      style={{ width: `${dockerCpuHostPct}%` }}
                      title={`Docker Containers: ${dockerCpuHostPct.toFixed(1)}% of host CPU`}
                    />
                    <div
                      className="h-full bg-slate-500/45 transition-all"
                      style={{ width: `${otherHostCpuPct}%` }}
                      title={`Other Host Processes: ${otherHostCpuPct.toFixed(1)}% of host CPU`}
                    />
                  </div>

                  <div className="flex items-center justify-between font-mono text-[11px]">
                    <span className="inline-flex items-center gap-1.5 text-emerald-400 font-semibold">
                      <span className="w-2.5 h-2.5 rounded-sm bg-emerald-500 inline-block" />
                      Docker: {dockerCpuHostPct.toFixed(1)}% host ({dockerCpuRawPct.toFixed(1)}% raw)
                    </span>
                    <span className="inline-flex items-center gap-1.5 text-[var(--text-muted)]">
                      <span className="w-2.5 h-2.5 rounded-sm bg-slate-500/60 inline-block" />
                      Other Host: {otherHostCpuPct.toFixed(1)}%
                    </span>
                  </div>

                  <div className="pt-1 border-t border-[var(--border-subtle)] flex justify-between font-mono text-[var(--text-muted)]">
                    <span className="truncate max-w-[14rem]">
                      {overview?.host.cpuModel || 'Linux CPU'}
                    </span>
                    <span>Total Host CPU: {hostCpuTotalPct.toFixed(1)}%</span>
                  </div>
                </div>

                {/* 2. Memory: Docker Containers RAM (Reclaimable by Stopping) vs Host RAM */}
                <div className="p-3.5 rounded-xl bg-[var(--bg-card)] border border-[var(--border-subtle)] space-y-2.5">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold inline-flex items-center gap-1.5">
                      <Activity className="w-4 h-4 text-sky-400" />
                      <span>Memory: Docker vs Host RAM</span>
                    </span>
                    <span className="font-mono text-sm font-semibold text-sky-400">
                      {formatBytes(dockerMemBytes)} Docker
                    </span>
                  </div>

                  {/* Dual-colour stacked progress bar */}
                  <div className="w-full h-3 bg-[var(--bg-sidebar)] rounded-full overflow-hidden border border-[var(--border-subtle)] flex">
                    <div
                      className="h-full bg-sky-500 transition-all"
                      style={{ width: `${dockerMemHostPct}%` }}
                      title={`Docker Containers: ${formatBytes(dockerMemBytes)} (${dockerMemHostPct.toFixed(1)}%)`}
                    />
                    <div
                      className="h-full bg-slate-500/45 transition-all"
                      style={{ width: `${otherHostMemPct}%` }}
                      title={`Other Host RAM: ${otherHostMemPct.toFixed(1)}%`}
                    />
                  </div>

                  <div className="flex items-center justify-between font-mono text-[11px]">
                    <span className="inline-flex items-center gap-1.5 text-sky-400 font-semibold">
                      <span className="w-2.5 h-2.5 rounded-sm bg-sky-500 inline-block" />
                      Docker: {formatBytes(dockerMemBytes)} ({dockerMemHostPct.toFixed(1)}%)
                    </span>
                    <span className="inline-flex items-center gap-1.5 text-[var(--text-muted)]">
                      <span className="w-2.5 h-2.5 rounded-sm bg-slate-500/60 inline-block" />
                      Other Host:{' '}
                      {formatBytes(Math.max(0, hostMemUsedBytes - dockerMemBytes))}
                    </span>
                  </div>

                  <div className="p-2 rounded-lg bg-sky-500/10 border border-sky-500/30 flex items-center justify-between">
                    <div>
                      <div className="font-semibold text-sky-400">
                        Reclaimable RAM if Containers Stopped
                      </div>
                      <div className="text-[11px] text-[var(--text-muted)]">
                         across {runningContainers.length} running container
                        {runningContainers.length === 1 ? '' : 's'}
                      </div>
                    </div>
                    <div className="font-mono text-sm font-bold text-sky-400">
                      {formatBytes(dockerMemBytes)}
                    </div>
                  </div>
                </div>

                {/* 3. Disk Storage: Docker Footprint vs Host Filesystem */}
                <div className="p-3.5 rounded-xl bg-[var(--bg-card)] border border-[var(--border-subtle)] space-y-2.5">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold inline-flex items-center gap-1.5">
                      <HardDrive className="w-4 h-4 text-purple-400" />
                      <span>Disk: Docker vs Host ({overview?.engine.storageDriver || 'overlay2'})</span>
                    </span>
                    <span className="font-mono text-sm font-semibold text-purple-400">
                      {formatBytes(dockerDiskBytes)} Docker
                    </span>
                  </div>

                  {/* Dual-colour stacked progress bar */}
                  <div className="w-full h-3 bg-[var(--bg-sidebar)] rounded-full overflow-hidden border border-[var(--border-subtle)] flex">
                    <div
                      className="h-full bg-purple-500 transition-all"
                      style={{ width: `${dockerDiskHostPct}%` }}
                      title={`Docker Engine Storage: ${formatBytes(dockerDiskBytes)} (${dockerDiskHostPct.toFixed(1)}%)`}
                    />
                    <div
                      className="h-full bg-slate-500/45 transition-all"
                      style={{ width: `${otherHostDiskPct}%` }}
                      title={`Other Host Files: ${otherHostDiskPct.toFixed(1)}%`}
                    />
                  </div>

                  <div className="flex items-center justify-between font-mono text-[11px]">
                    <span className="inline-flex items-center gap-1.5 text-purple-400 font-semibold">
                      <span className="w-2.5 h-2.5 rounded-sm bg-purple-500 inline-block" />
                      Docker: {formatBytes(dockerDiskBytes)} ({dockerDiskHostPct.toFixed(1)}%)
                    </span>
                    <span className="inline-flex items-center gap-1.5 text-[var(--text-muted)]">
                      <span className="w-2.5 h-2.5 rounded-sm bg-slate-500/60 inline-block" />
                      Host Disk: {formatBytes(overview?.host.rootDisk.usedBytes)} /{' '}
                      {formatBytes(overview?.host.rootDisk.totalBytes)}
                    </span>
                  </div>

                  <div className="p-2 rounded-lg bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-between">
                    <div>
                      <div className="font-semibold text-emerald-400">
                        Reclaimable Disk by Pruning Unused Objects
                      </div>
                      <div className="text-[11px] text-[var(--text-muted)]">
                        {formatBytes(overview?.diskUsage.safeReclaimable)} safe +{' '}
                        {formatBytes(overview?.diskUsage.volumesReclaimable)} unattached volumes
                      </div>
                    </div>
                    <div className="font-mono text-sm font-bold text-emerald-400">
                      {formatBytes(reclaimableTotal)}
                    </div>
                  </div>
                </div>
              </div>

              {/* Row 2: Per-Stack & Per-Container Live Resource Consumption Breakdown */}
              <div className="p-4 rounded-xl bg-[var(--bg-card)] border border-[var(--border-subtle)] space-y-3 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h3 className="text-sm font-semibold">
                      Consumption by Running Compose Stack &amp; Container
                    </h3>
                    <p className="text-[var(--text-muted)]">
                      Live memory and CPU consumed by each active Compose stack and container,
                      ranked by RAM usage. Stopping a stack or container immediately frees its
                      memory back to the host.
                    </p>
                  </div>
                  <div className="flex items-center gap-3 font-mono">
                    <div className="px-2.5 py-1 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)]">
                      <span className="text-[var(--text-muted)]">Total Docker CPU: </span>
                      <span className="text-emerald-400 font-semibold">
                        {dockerCpuRawPct.toFixed(1)}%
                      </span>
                    </div>
                    <div className="px-2.5 py-1 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)]">
                      <span className="text-[var(--text-muted)]">Total Docker RAM: </span>
                      <span className="text-sky-400 font-semibold">
                        {formatBytes(dockerMemBytes)}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Active Compose Stacks Summary Strip */}
                {sortedRunningStacks.length > 0 && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                    {sortedRunningStacks.map((stack) => {
                      const stackMemShare =
                        dockerMemBytes > 0
                          ? (stack.memUsageBytes / dockerMemBytes) * 100
                          : 0;
                      const pending = pendingActions[`stack:${stack.name}`];
                      return (
                        <div
                          key={stack.name}
                          className="p-3 rounded-lg bg-[var(--bg-canvas)] border border-[var(--border-subtle)] flex items-center justify-between gap-3"
                        >
                          <div className="min-w-0 flex-1 space-y-1">
                            <div className="flex items-center gap-2 font-mono">
                              <span className="font-semibold text-sky-400">
                                📦 {stack.name}
                              </span>
                              <span className="text-[var(--text-muted)]">
                                ({stack.runningCount} running)
                              </span>
                            </div>
                            <div className="flex items-center gap-3 font-mono text-xs">
                              <span className="text-emerald-400">
                                CPU {stack.cpuPercent.toFixed(1)}%
                              </span>
                              <span className="text-sky-400 font-semibold">
                                RAM {formatBytes(stack.memUsageBytes)} (
                                {stackMemShare.toFixed(0)}% of Docker RAM)
                              </span>
                            </div>
                            <div className="w-full h-1.5 bg-[var(--bg-sidebar)] rounded-full overflow-hidden">
                              <div
                                className="h-full bg-sky-500"
                                style={{ width: `${Math.min(100, stackMemShare)}%` }}
                              />
                            </div>
                          </div>
                          <button
                            type="button"
                            disabled={!!pending}
                            onClick={() => handleComposeAction(stack.name, 'stop')}
                            className="px-2.5 py-1.5 rounded-md border border-rose-500/40 bg-rose-500/10 text-rose-400 hover:bg-rose-500/20 font-mono text-xs shrink-0 inline-flex items-center gap-1.5 disabled:opacity-50"
                          >
                            {pending ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            ) : (
                              <Square className="w-3 h-3" />
                            )}
                            <span>
                              {pending
                                ? 'Stopping...'
                                : `Stop Stack (Free ${formatBytes(stack.memUsageBytes, 0)})`}
                            </span>
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Per-Container Table */}
                <div className="table-wrapper rounded-lg border border-[var(--border-subtle)]">
                  <table className="text-left text-xs font-mono tabular-nums">
                    <thead>
                      <tr className="border-b border-[var(--border-subtle)] text-[var(--text-muted)] font-sans">
                        <th className="py-2 px-3 font-medium">Container</th>
                        <th className="py-2 px-3 font-medium">Stack / Image</th>
                        <th className="py-2 px-3 font-medium">CPU Usage</th>
                        <th className="py-2 px-3 font-medium">RAM Used (Freed if Stopped)</th>
                        <th className="py-2 px-3 font-medium w-44">Share of Docker RAM</th>
                        <th className="py-2 px-3 font-medium text-right">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[var(--border-subtle)]">
                      {sortedRunningConsumers.length === 0 ? (
                        <tr>
                          <td
                            colSpan={6}
                            className="py-6 text-center text-[var(--text-muted)]"
                          >
                            No containers are currently running (0 B RAM consumed).
                          </td>
                        </tr>
                      ) : (
                        sortedRunningConsumers.map((ctr) => {
                          const sharePct =
                            dockerMemBytes > 0
                              ? (ctr.memUsageBytes / dockerMemBytes) * 100
                              : 0;
                          const pending = pendingActions[`ctr:${ctr.id}`];
                          return (
                            <tr
                              key={ctr.id}
                              className="hover:bg-[var(--bg-elevated)]/40"
                            >
                              <td className="py-2 px-3 font-semibold">
                                <button
                                  type="button"
                                  onClick={() => {
                                    setActiveView('containers');
                                    setDrawerSelection({
                                      kind: 'container',
                                      container: ctr,
                                      initialTab: 'stats',
                                    });
                                  }}
                                  className="text-left hover:underline text-sky-400"
                                >
                                  {ctr.name}
                                </button>
                              </td>
                              <td className="py-2 px-3 text-[var(--text-muted)]">
                                {ctr.composeProject ? (
                                  <span className="text-sky-400">{ctr.composeProject}</span>
                                ) : (
                                  ctr.image
                                )}
                              </td>
                              <td className="py-2 px-3 text-emerald-400">
                                {ctr.cpuPercent.toFixed(1)}%
                              </td>
                              <td className="py-2 px-3 font-semibold text-sky-400">
                                {formatBytes(ctr.memUsageBytes)}
                              </td>
                              <td className="py-2 px-3">
                                <div className="flex items-center gap-2">
                                  <div className="flex-1 h-2 bg-[var(--bg-sidebar)] rounded-full overflow-hidden border border-[var(--border-subtle)]">
                                    <div
                                      className="h-full bg-sky-500"
                                      style={{ width: `${Math.min(100, sharePct)}%` }}
                                    />
                                  </div>
                                  <span className="w-10 text-right text-[var(--text-muted)]">
                                    {sharePct.toFixed(0)}%
                                  </span>
                                </div>
                              </td>
                              <td className="py-2 px-3 text-right">
                                <button
                                  type="button"
                                  disabled={!!pending}
                                  onClick={() => handleContainerAction(ctr.id, 'stop')}
                                  className="px-2 py-0.5 rounded border border-rose-500/40 text-rose-400 hover:bg-rose-500/10 font-sans inline-flex items-center gap-1 disabled:opacity-50"
                                >
                                  {pending ? (
                                    <Loader2 className="w-3 h-3 animate-spin" />
                                  ) : (
                                    <Square className="w-3 h-3" />
                                  )}
                                  <span>
                                    {pending
                                      ? 'Stopping...'
                                      : `Stop (Free ${formatBytes(ctr.memUsageBytes, 0)})`}
                                  </span>
                                </button>
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Row 3: Docker Disk Breakdown (/system/df) */}
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
                    {formatBytes(overview?.diskUsage.imagesReclaimable)} reclaimable disk
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
                    {formatBytes(overview?.diskUsage.buildCacheReclaimable)} reclaimable disk
                  </div>
                </div>

                <div className="p-3.5 rounded-xl bg-[var(--bg-card)] border border-[var(--border-subtle)] space-y-1.5">
                  <div className="flex justify-between text-[var(--text-muted)]">
                    <span>
                      Containers RW Layer ({overview?.diskUsage.containersActive ?? 0}/
                      {overview?.diskUsage.containersTotal ?? 0} running)
                    </span>
                  </div>
                  <div className="text-lg font-mono font-semibold">
                    {formatBytes(overview?.diskUsage.containersSize)}
                  </div>
                  <div className="text-emerald-400 font-mono">
                    {formatBytes(overview?.diskUsage.containersReclaimable)} reclaimable disk
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
                    {formatBytes(overview?.diskUsage.volumesReclaimable)} unattached disk
                  </div>
                </div>
              </div>

              {/* Row 4: Safe Prune Builder */}
              <div className="p-4 rounded-xl bg-[var(--bg-card)] border border-[var(--border-subtle)] space-y-3 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h3 className="text-sm font-semibold">Docker Disk Prune Builder</h3>
                    <p className="text-[var(--text-muted)]">
                      Select which unused Docker disk objects to clean up. Volumes are
                      excluded by default to protect local databases.
                    </p>
                  </div>
                  <div className="text-right font-mono">
                    <div className="text-[var(--text-muted)]">Estimated Disk Reclaimable</div>
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
      {/* FLOATING TOAST NOTIFICATIONS (PENDING + COMPLETION FEEDBACK)      */}
      {/* ================================================================= */}
      {toasts.length > 0 && (
        <div
          aria-live="polite"
          className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm w-full pointer-events-none"
        >
          {toasts.map((t) => (
            <div
              key={t.id}
              className={`pointer-events-auto flex items-center gap-2.5 px-3.5 py-2.5 rounded-lg border shadow-xl font-mono text-xs ${
                t.status === 'pending'
                  ? 'bg-[var(--bg-card)] border-sky-500/50 text-sky-400'
                  : t.status === 'error'
                    ? 'bg-[var(--bg-card)] border-rose-500/50 text-rose-400'
                    : 'bg-[var(--bg-card)] border-emerald-500/50 text-emerald-400'
              }`}
            >
              {t.status === 'pending' && (
                <Loader2 className="w-4 h-4 animate-spin shrink-0 text-sky-400" />
              )}
              {t.status === 'success' && (
                <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-400" />
              )}
              {t.status === 'error' && (
                <AlertTriangle className="w-4 h-4 shrink-0 text-rose-400" />
              )}
              <span className="truncate">{t.message}</span>
            </div>
          ))}
        </div>
      )}

      {/* ================================================================= */}
      {/* NATIVE MODAL DIALOGS (CENTRED VIA `margin: auto` IN index.css)    */}
      {/* ================================================================= */}

      {/* 1. Pull Image Modal (Supports Enter Key via <form onSubmit>) */}
      <dialog ref={pullDialogRef} aria-labelledby="pull-dialog-title">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            startImagePull();
          }}
          className="p-4 space-y-3 text-xs"
        >
          <h2 id="pull-dialog-title" className="text-sm font-semibold">
            Pull Docker Image
          </h2>
          <p className="text-[var(--text-muted)]">
            Enter a registry image reference (for example{' '}
            <code className="font-mono">redis:7-alpine</code> or{' '}
            <code className="font-mono">postgres:18</code>) and press Enter.
          </p>
          <input
            type="text"
            value={pullImageRef}
            onChange={(e) => setPullImageRef(e.target.value)}
            placeholder="repository:tag"
            autoFocus
            className="w-full px-3 py-1.5 rounded-md bg-[var(--bg-canvas)] border border-[var(--border-subtle)] font-mono text-xs"
          />
          {pullLogs.length > 0 && (
            <pre className="p-2.5 rounded-md bg-[var(--bg-canvas)] border border-[var(--border-subtle)] font-mono text-xs max-h-44 overflow-auto select-text">
              {pullLogs.join('\n')}
            </pre>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => pullDialogRef.current?.close()}
              className="px-3 py-1.5 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-canvas)]"
            >
              Close
            </button>
            <button
              type="submit"
              disabled={pulling || !pullImageRef.trim()}
              className="px-3 py-1.5 rounded-md bg-[var(--accent-primary)] text-[var(--accent-primary-fg)] font-semibold disabled:opacity-50 inline-flex items-center gap-1.5"
            >
              {pulling && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              <span>{pulling ? 'Pulling...' : 'Pull Image'}</span>
            </button>
          </div>
        </form>
      </dialog>

      {/* 2. Create Volume Modal (Supports Enter Key via <form onSubmit>) */}
      <dialog ref={createVolumeDialogRef} aria-labelledby="create-vol-title">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleCreateVolume();
          }}
          className="p-4 space-y-3 text-xs"
        >
          <h2 id="create-vol-title" className="text-sm font-semibold">
            Create Docker Volume
          </h2>
          <input
            type="text"
            value={newVolumeName}
            onChange={(e) => setNewVolumeName(e.target.value)}
            placeholder="my_volume_data"
            autoFocus
            className="w-full px-3 py-1.5 rounded-md bg-[var(--bg-canvas)] border border-[var(--border-subtle)] font-mono text-xs"
          />
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => createVolumeDialogRef.current?.close()}
              className="px-3 py-1.5 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-canvas)]"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!newVolumeName.trim()}
              className="px-3 py-1.5 rounded-md bg-[var(--accent-primary)] text-[var(--accent-primary-fg)] font-semibold disabled:opacity-50"
            >
              Create
            </button>
          </div>
        </form>
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

      {/* 4. Generic Delete Confirmation Modal (Single/Bulk Images, Volumes, Containers, Networks) */}
      <dialog
        ref={confirmActionDialogRef}
        aria-labelledby="confirm-action-title"
        onClose={(e) => {
          const dlg = e.currentTarget;
          const choice = dlg.returnValue;
          dlg.returnValue = '';
          if (choice === 'confirm' && confirmState) {
            confirmState.onConfirm();
          }
        }}
      >
        <div className="p-4 space-y-3 text-xs">
          <h2
            id="confirm-action-title"
            className="text-sm font-semibold text-rose-400"
          >
            {confirmState?.title || 'Confirm Delete'}
          </h2>
          <p className="text-[var(--text-muted)] leading-relaxed">
            {confirmState?.description}
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
              className="px-3 py-1.5 rounded-md bg-rose-600 text-white font-semibold hover:bg-rose-500"
            >
              {confirmState?.confirmLabel || 'Delete'}
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

function ComposeStackRows({
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

function ContainerRow({
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
