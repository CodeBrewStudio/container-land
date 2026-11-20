import type { Dispatch, SetStateAction } from 'react';
import {
  Activity,
  Cpu,
  HardDrive,
  Loader2,
  Square,
} from 'lucide-react';
import type {
  ComposeGroup,
  ContainerSummary,
  OverviewResponse,
  PruneRequest,
  PruneResponse,
} from '../types';
import { formatBytes } from '../utils/format';
import type { DrawerSelection } from './RightDrawer';

export interface ResourcesViewProps {
  overview: OverviewResponse | null;
  hostCores: number;
  hostCpuTotalPct: number;
  dockerCpuRawPct: number;
  dockerCpuHostPct: number;
  otherHostCpuPct: number;
  hostMemUsedBytes: number;
  dockerMemBytes: number;
  dockerMemHostPct: number;
  otherHostMemPct: number;
  dockerDiskBytes: number;
  dockerDiskHostPct: number;
  otherHostDiskPct: number;
  reclaimableTotal: number;
  runningContainers: ContainerSummary[];
  sortedRunningConsumers: ContainerSummary[];
  sortedRunningStacks: ComposeGroup[];
  pendingActions: Record<string, string>;
  pruneReq: PruneRequest;
  setPruneReq: Dispatch<SetStateAction<PruneRequest>>;
  pruning: boolean;
  estimatedPruneBytes: number;
  lastPruneResult: PruneResponse | null;
  setDrawerSelection: (sel: DrawerSelection | null) => void;
  setActiveView: (v: 'containers' | 'images' | 'volumes' | 'networks' | 'resources') => void;
  handleContainerAction: (id: string, action: 'start' | 'stop' | 'restart' | 'delete') => Promise<void>;
  handleComposeAction: (project: string, action: 'start' | 'stop' | 'restart' | 'remove') => Promise<void>;
  handlePruneSubmit: () => void | Promise<void>;
}

export function ResourcesView({
  overview,
  hostCores,
  hostCpuTotalPct,
  dockerCpuRawPct,
  dockerCpuHostPct,
  otherHostCpuPct,
  hostMemUsedBytes,
  dockerMemBytes,
  dockerMemHostPct,
  otherHostMemPct,
  dockerDiskBytes,
  dockerDiskHostPct,
  otherHostDiskPct,
  reclaimableTotal,
  runningContainers,
  sortedRunningConsumers,
  sortedRunningStacks,
  pendingActions,
  pruneReq,
  setPruneReq,
  pruning,
  estimatedPruneBytes,
  lastPruneResult,
  setDrawerSelection,
  setActiveView,
  handleContainerAction,
  handleComposeAction,
  handlePruneSubmit,
}: ResourcesViewProps) {
  return (
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
  );
}
