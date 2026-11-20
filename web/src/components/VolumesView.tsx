import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Plus, Search, Trash2 } from 'lucide-react';
import type { OverviewResponse, VolumeSummary } from '../types';
import { formatBytes, formatRelativeTime } from '../utils/format';
import { type DrawerSelection, RightDrawer } from './RightDrawer';

export const VOLUME_PAGE_SIZE = 100;

export interface VolumesViewProps {
  volumes: VolumeSummary[];
  filteredVolumes: VolumeSummary[];
  volumeQuery: string;
  setVolumeQuery: (q: string) => void;
  volumeFilter: 'all' | 'in-use' | 'unused';
  setVolumeFilter: (f: 'all' | 'in-use' | 'unused') => void;
  selectedVolumeNames: Set<string>;
  allFilteredVolumesSelected: boolean;
  toggleSelectAllVolumes: () => void;
  toggleSelectVolume: (name: string) => void;
  overview: OverviewResponse | null;
  drawerSelection: DrawerSelection | null;
  setDrawerSelection: (sel: DrawerSelection | null) => void;
  setActiveView: (v: 'containers' | 'images' | 'volumes' | 'networks' | 'resources') => void;
  confirmDeleteSelectedVolumes: () => void;
  confirmDeleteSingleVolume: (vol: VolumeSummary) => void;
  handleContainerAction: (id: string, action: 'start' | 'stop' | 'restart' | 'delete') => Promise<void>;
  handleComposeAction: (project: string, action: 'start' | 'stop' | 'restart' | 'remove') => Promise<void>;
  onOpenCreateVolumeDialog: () => void;
  onOpenVolumePruneDialog: () => void;
}

export function VolumesView({
  volumes,
  filteredVolumes,
  volumeQuery,
  setVolumeQuery,
  volumeFilter,
  setVolumeFilter,
  selectedVolumeNames,
  allFilteredVolumesSelected,
  toggleSelectAllVolumes,
  toggleSelectVolume,
  overview,
  drawerSelection,
  setDrawerSelection,
  setActiveView,
  confirmDeleteSelectedVolumes,
  confirmDeleteSingleVolume,
  handleContainerAction,
  handleComposeAction,
  onOpenCreateVolumeDialog,
  onOpenVolumePruneDialog,
}: VolumesViewProps) {
  const [page, setPage] = useState(1);
  const totalPages = Math.max(1, Math.ceil(filteredVolumes.length / VOLUME_PAGE_SIZE));
  const safePage = Math.min(page, totalPages);

  useEffect(() => {
    setPage(1);
  }, [volumeQuery, volumeFilter]);

  const pageVolumes = useMemo(() => {
    const start = (safePage - 1) * VOLUME_PAGE_SIZE;
    return filteredVolumes.slice(start, start + VOLUME_PAGE_SIZE);
  }, [filteredVolumes, safePage]);

  const startRow = filteredVolumes.length === 0 ? 0 : (safePage - 1) * VOLUME_PAGE_SIZE + 1;
  const endRow = Math.min(safePage * VOLUME_PAGE_SIZE, filteredVolumes.length);

  return (
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
                    onClick={() => onOpenCreateVolumeDialog()}
                    className="px-3 py-1.5 rounded-md bg-[var(--accent-primary)] text-[var(--accent-primary-fg)] font-semibold inline-flex items-center gap-1.5"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>Create Volume</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => onOpenVolumePruneDialog()}
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
                      {pageVolumes.map((vol) => {
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

              {filteredVolumes.length > VOLUME_PAGE_SIZE && (
                <div className="px-4 py-2 border-t border-[var(--border-subtle)] bg-[var(--bg-card)] flex items-center justify-between text-xs font-mono">
                  <span className="text-[var(--text-muted)]">
                    Showing {startRow.toLocaleString()}–{endRow.toLocaleString()} of{' '}
                    {filteredVolumes.length.toLocaleString()} volumes
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={safePage <= 1}
                      onClick={() => setPage((p) => Math.max(1, p - 1))}
                      className="px-2 py-1 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] hover:bg-[var(--bg-elevated)] disabled:opacity-40 inline-flex items-center gap-1 font-sans"
                    >
                      <ChevronLeft className="w-3.5 h-3.5" />
                      <span>Prev</span>
                    </button>
                    <span className="text-[var(--text-muted)]">
                      Page {safePage.toLocaleString()} / {totalPages.toLocaleString()}
                    </span>
                    <button
                      type="button"
                      disabled={safePage >= totalPages}
                      onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                      className="px-2 py-1 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] hover:bg-[var(--bg-elevated)] disabled:opacity-40 inline-flex items-center gap-1 font-sans"
                    >
                      <span>Next</span>
                      <ChevronRight className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              )}
            </div>
  );
}
