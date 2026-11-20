import { Search, Trash2 } from 'lucide-react';
import type { NetworkSummary } from '../types';

export interface NetworksViewProps {
  networkQuery: string;
  setNetworkQuery: (q: string) => void;
  filteredNetworks: NetworkSummary[];
  confirmDeleteNetwork: (net: NetworkSummary) => void;
}

export function NetworksView({
  networkQuery,
  setNetworkQuery,
  filteredNetworks,
  confirmDeleteNetwork,
}: NetworksViewProps) {
  return (
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
  );
}
