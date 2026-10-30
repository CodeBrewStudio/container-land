import type { ContainerSummary, PortBinding } from '../types';

export function formatBytes(bytes: number | undefined | null, decimals = 1): string {
  if (bytes === undefined || bytes === null || bytes < 0) return '—';
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
  const val = bytes / Math.pow(k, i);
  return `${val.toFixed(i === 0 ? 0 : decimals)} ${sizes[i]}`;
}

export function formatUptime(seconds: number): string {
  if (!seconds || seconds <= 0) return '0m';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function formatRelativeEpoch(epochSeconds: number): string {
  if (!epochSeconds) return '—';
  const diffSec = Math.max(0, Math.floor(Date.now() / 1000) - epochSeconds);
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  const days = Math.floor(diffSec / 86400);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

export function formatRelativeTime(isoDate?: string): string {
  if (!isoDate) return '—';
  const ms = Date.parse(isoDate);
  if (Number.isNaN(ms)) return isoDate;
  return formatRelativeEpoch(Math.floor(ms / 1000));
}

export function formatShortTimestamp(iso?: string): string {
  if (!iso) return '';
  const match = iso.match(/T(\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?)/);
  if (match) return match[1];
  return iso.slice(0, 19);
}

// Strip terminal control / ANSI escape codes for clean plain-text search and display
export function stripAnsi(input: string): string {
  // eslint-disable-next-line no-control-regex
  return input.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

export function isSecretEnvKey(key: string): boolean {
  return /(PASSWORD|PASSWD|SECRET|TOKEN|KEY|SALT|AUTH|CREDENTIAL|PRIVATE|CERT|DSN|_URL|_URI)/i.test(
    key
  );
}

export function matchesContainerFilter(
  ctr: ContainerSummary,
  query: string,
  statusFilter: 'all' | 'running' | 'stopped'
): boolean {
  if (statusFilter === 'running' && ctr.state !== 'running') return false;
  if (statusFilter === 'stopped' && ctr.state === 'running') return false;

  const q = query.trim().toLowerCase();
  if (!q) return true;

  if (ctr.name.toLowerCase().includes(q)) return true;
  if (ctr.image.toLowerCase().includes(q)) return true;
  if (ctr.shortId.toLowerCase().includes(q)) return true;
  if (ctr.composeProject?.toLowerCase().includes(q)) return true;
  if (ctr.composeService?.toLowerCase().includes(q)) return true;
  if (ctr.ports?.some((p: PortBinding) => String(p.publicPort).includes(q) || String(p.privatePort).includes(q))) {
    return true;
  }
  return false;
}
