import { describe, expect, it } from 'vitest';
import type { ContainerSummary, ContainersResponse } from '../types';
import { reconcileContainerDrawerSelection } from './drawer';

const sampleContainer = (overrides: Partial<ContainerSummary> = {}): ContainerSummary => ({
  id: 'ctr-1',
  shortId: 'ctr-1',
  name: 'api-1',
  image: 'node:22',
  imageId: 'sha256:abc',
  command: 'node server.js',
  created: 1700000000,
  state: 'running',
  status: 'Up 10 minutes',
  ports: [],
  labels: {},
  mounts: [],
  networks: [],
  cpuPercent: 1.5,
  memUsageBytes: 1024,
  memLimitBytes: 4096,
  memPercent: 25,
  netRxBytes: 0,
  netTxBytes: 0,
  blockReadBytes: 0,
  blockWriteBytes: 0,
  pids: 4,
  ...overrides,
});

describe('reconcileContainerDrawerSelection', () => {
  it('clears initialTab on background container poll so active tab does not snap back', () => {
    const initial = sampleContainer({ cpuPercent: 1.5 });
    const updated = sampleContainer({ cpuPercent: 4.2 });
    const data: ContainersResponse = {
      composeGroups: [],
      standalone: [updated],
      totalCount: 1,
      runningCount: 1,
      stoppedCount: 0,
    };

    const next = reconcileContainerDrawerSelection(
      { kind: 'container', container: initial, initialTab: 'exec' },
      data
    );

    expect(next).toEqual({
      kind: 'container',
      container: updated,
    });
    expect(next && next.kind === 'container' ? next.initialTab : undefined).toBeUndefined();
  });

  it('closes drawer when selected container disappears', () => {
    const data: ContainersResponse = {
      composeGroups: [],
      standalone: [],
      totalCount: 0,
      runningCount: 0,
      stoppedCount: 0,
    };

    const next = reconcileContainerDrawerSelection(
      { kind: 'container', container: sampleContainer(), initialTab: 'logs' },
      data
    );

    expect(next).toBeNull();
  });
});
