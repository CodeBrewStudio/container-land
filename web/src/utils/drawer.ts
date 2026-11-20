import type { ContainersResponse, VolumeSummary } from '../types';
import type { DrawerSelection } from '../components/RightDrawer';

/**
 * Reconciles an open drawer selection against freshly polled container data.
 * Drops `initialTab` so periodic background refreshes never snap the user
 * back to the tab they originally opened the drawer with.
 */
export function reconcileContainerDrawerSelection(
  prev: DrawerSelection | null,
  data: ContainersResponse
): DrawerSelection | null {
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
      }
    : null;
}

export function reconcileVolumeDrawerSelection(
  prev: DrawerSelection | null,
  list: VolumeSummary[]
): DrawerSelection | null {
  if (!prev || prev.kind !== 'volume') return prev;
  const updated = list.find((v) => v.name === prev.volume.name);
  return updated ? { kind: 'volume', volume: updated } : null;
}
