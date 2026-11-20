import { Download, Search, Trash2 } from 'lucide-react';
import type { ImageSummary, OverviewResponse, PruneRequest } from '../types';
import { formatBytes, formatRelativeEpoch } from '../utils/format';

export interface ImagesViewProps {
  images: ImageSummary[];
  filteredImages: ImageSummary[];
  imageQuery: string;
  setImageQuery: (q: string) => void;
  imageFilter: 'all' | 'in-use' | 'unused';
  setImageFilter: (f: 'all' | 'in-use' | 'unused') => void;
  selectedImageIds: Set<string>;
  allFilteredImagesSelected: boolean;
  toggleSelectAllImages: () => void;
  toggleSelectImage: (id: string) => void;
  overview: OverviewResponse | null;
  confirmDeleteSelectedImages: () => void;
  confirmDeleteSingleImage: (img: ImageSummary) => void;
  executePrune: (req: PruneRequest) => Promise<void>;
  onOpenPullDialog: () => void;
}

export function ImagesView({
  images,
  filteredImages,
  imageQuery,
  setImageQuery,
  imageFilter,
  setImageFilter,
  selectedImageIds,
  allFilteredImagesSelected,
  toggleSelectAllImages,
  toggleSelectImage,
  overview,
  confirmDeleteSelectedImages,
  confirmDeleteSingleImage,
  executePrune,
  onOpenPullDialog,
}: ImagesViewProps) {
  return (
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
                      onOpenPullDialog();
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
  );
}
