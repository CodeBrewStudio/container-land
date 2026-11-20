import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('./ExecTerminal', () => ({
  ExecTerminal: () => null,
}));

import type { ImageSummary, NetworkSummary, VolumeSummary } from '../types';
import { ImagesView } from './ImagesView';
import { NetworksView } from './NetworksView';
import { VolumesView, VOLUME_PAGE_SIZE } from './VolumesView';

describe('View components', () => {
  it('NetworksView hides Remove button for built-in networks and shows it for custom ones', () => {
    const nets: NetworkSummary[] = [
      {
        id: 'n1',
        shortId: 'n1',
        name: 'bridge',
        driver: 'bridge',
        scope: 'local',
        internal: false,
        attachable: false,
        subnet: '172.17.0.0/16',
        gateway: '172.17.0.1',
        created: '2026-01-01T00:00:00Z',
        builtIn: true,
        inUse: true,
        containers: [],
      },
      {
        id: 'n2',
        shortId: 'n2',
        name: 'app_default',
        driver: 'bridge',
        scope: 'local',
        internal: false,
        attachable: true,
        subnet: '172.20.0.0/16',
        gateway: '172.20.0.1',
        created: '2026-01-02T00:00:00Z',
        builtIn: false,
        inUse: false,
        containers: [],
      },
    ];

    const html = renderToStaticMarkup(
      <NetworksView
        networkQuery=""
        setNetworkQuery={vi.fn()}
        filteredNetworks={nets}
        confirmDeleteNetwork={vi.fn()}
      />
    );

    expect(html).toContain('bridge');
    expect(html).toContain('app_default');
    // Only one Remove button (for custom app_default, not built-in bridge)
    expect(html.match(/>Remove</g)?.length).toBe(1);
  });

  it('ImagesView renders bulk delete count when images are selected', () => {
    const imgs: ImageSummary[] = [
      {
        id: 'sha256:111111111111',
        shortId: '111111111111',
        repoTags: ['redis:7-alpine'],
        repository: 'redis',
        tag: '7-alpine',
        created: 1700000000,
        sizeBytes: 32_000_000,
        sharedSizeBytes: 0,
        containers: 0,
        inUse: false,
        usedByContainers: [],
      },
    ];

    const html = renderToStaticMarkup(
      <ImagesView
        images={imgs}
        filteredImages={imgs}
        imageQuery=""
        setImageQuery={vi.fn()}
        imageFilter="all"
        setImageFilter={vi.fn()}
        selectedImageIds={new Set(['sha256:111111111111'])}
        allFilteredImagesSelected={true}
        toggleSelectAllImages={vi.fn()}
        toggleSelectImage={vi.fn()}
        overview={null}
        confirmDeleteSelectedImages={vi.fn()}
        confirmDeleteSingleImage={vi.fn()}
        executePrune={vi.fn()}
        onOpenPullDialog={vi.fn()}
      />
    );

    expect(html).toContain('redis');
    expect(html).toContain('7-alpine');
    expect(html).toContain('Delete Selected (1)');
  });

  it('VolumesView renders inferred content hints and anonymous badges', () => {
    const vols: VolumeSummary[] = [
      {
        name: 'a'.repeat(64),
        shortName: 'a'.repeat(12),
        anonymous: true,
        driver: 'local',
        mountpoint: '/var/lib/docker/volumes/aaa/_data',
        createdAt: '2026-01-01T00:00:00Z',
        labels: {},
        scope: 'local',
        sizeBytes: 4096,
        refCount: 0,
        inUse: false,
        usedByContainers: [],
        contentHint: 'PostgreSQL database',
        topEntries: ['PG_VERSION'],
      },
    ];

    const html = renderToStaticMarkup(
      <VolumesView
        volumes={vols}
        filteredVolumes={vols}
        volumeQuery=""
        setVolumeQuery={vi.fn()}
        volumeFilter="all"
        setVolumeFilter={vi.fn()}
        selectedVolumeNames={new Set()}
        allFilteredVolumesSelected={false}
        toggleSelectAllVolumes={vi.fn()}
        toggleSelectVolume={vi.fn()}
        overview={null}
        drawerSelection={null}
        setDrawerSelection={vi.fn()}
        setActiveView={vi.fn()}
        confirmDeleteSelectedVolumes={vi.fn()}
        confirmDeleteSingleVolume={vi.fn()}
        handleContainerAction={vi.fn()}
        handleComposeAction={vi.fn()}
        onOpenCreateVolumeDialog={vi.fn()}
        onOpenVolumePruneDialog={vi.fn()}
      />
    );

    expect(html).toContain('PostgreSQL database');
    expect(html).toContain('aaaaaaaaaaaa');
  });

  it('VolumesView paginates large volume lists so the DOM stays bounded', () => {
    const vols: VolumeSummary[] = Array.from({ length: VOLUME_PAGE_SIZE + 50 }, (_, i) => ({
      name: `vol-${i}`,
      shortName: `vol-${i}`,
      anonymous: false,
      driver: 'local',
      mountpoint: `/var/lib/docker/volumes/vol-${i}/_data`,
      createdAt: '2026-01-01T00:00:00Z',
      labels: {},
      scope: 'local',
      sizeBytes: 1024,
      refCount: 0,
      inUse: false,
      usedByContainers: [],
      contentHint: 'Empty volume',
    }));

    const html = renderToStaticMarkup(
      <VolumesView
        volumes={vols}
        filteredVolumes={vols}
        volumeQuery=""
        setVolumeQuery={vi.fn()}
        volumeFilter="all"
        setVolumeFilter={vi.fn()}
        selectedVolumeNames={new Set()}
        allFilteredVolumesSelected={false}
        toggleSelectAllVolumes={vi.fn()}
        toggleSelectVolume={vi.fn()}
        overview={null}
        drawerSelection={null}
        setDrawerSelection={vi.fn()}
        setActiveView={vi.fn()}
        confirmDeleteSelectedVolumes={vi.fn()}
        confirmDeleteSingleVolume={vi.fn()}
        handleContainerAction={vi.fn()}
        handleComposeAction={vi.fn()}
        onOpenCreateVolumeDialog={vi.fn()}
        onOpenVolumePruneDialog={vi.fn()}
      />
    );

    expect(html).toContain('vol-0');
    expect(html).toContain(`vol-${VOLUME_PAGE_SIZE - 1}`);
    expect(html).not.toContain(`vol-${VOLUME_PAGE_SIZE}`);
    expect(html).toContain('Page 1 / 2');
  });
});
