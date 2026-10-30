import { describe, expect, it } from 'vitest';
import {
  formatBytes,
  formatShortTimestamp,
  formatUptime,
  isSecretEnvKey,
  matchesContainerFilter,
  stripAnsi,
} from './format';
import type { ContainerSummary } from '../types';

describe('format utilities', () => {
  it('formats bytes cleanly across units', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(15 * 1024 * 1024)).toBe('15.0 MB');
    expect(formatBytes(2.5 * 1024 * 1024 * 1024)).toBe('2.5 GB');
    expect(formatBytes(-1)).toBe('—');
  });

  it('formats uptime duration', () => {
    expect(formatUptime(90)).toBe('1m');
    expect(formatUptime(7260)).toBe('2h 1m');
    expect(formatUptime(90060)).toBe('1d 1h 1m');
  });

  it('extracts short timestamp from RFC3339', () => {
    expect(formatShortTimestamp('2026-10-30T08:15:42.981234Z')).toBe('08:15:42.981');
  });

  it('strips ANSI colour escape sequences', () => {
    expect(stripAnsi('\x1b[32mINFO\x1b[0m Server ready')).toBe('INFO Server ready');
  });

  it('identifies sensitive environment keys', () => {
    expect(isSecretEnvKey('POSTGRES_PASSWORD')).toBe(true);
    expect(isSecretEnvKey('STRIPE_SECRET_KEY')).toBe(true);
    expect(isSecretEnvKey('OTP_ENCRYPTION_KEY')).toBe(true);
    expect(isSecretEnvKey('ACTIVE_RECORD_ENCRYPTION_KEY_DERIVATION_SALT')).toBe(true);
    expect(isSecretEnvKey('RABBIT_URL')).toBe(true);
    expect(isSecretEnvKey('NODE_ENV')).toBe(false);
  });

  it('filters containers by status, name, compose stack, and port', () => {
    const sample: ContainerSummary = {
      id: 'aaaa11112222',
      shortId: 'aaaa11112222',
      name: 'acme-platform-api-1',
      image: 'acme/api:dev',
      imageId: 'sha256:123',
      command: 'node server.js',
      created: 1700000000,
      state: 'running',
      status: 'Up 2 hours',
      ports: [{ privatePort: 3000, publicPort: 3000, type: 'tcp' }],
      labels: {},
      composeProject: 'acme-platform',
      composeService: 'api',
      mounts: [],
      networks: ['acme_default'],
      cpuPercent: 4.2,
      memUsageBytes: 1024,
      memLimitBytes: 4096,
      memPercent: 25,
      netRxBytes: 0,
      netTxBytes: 0,
      blockReadBytes: 0,
      blockWriteBytes: 0,
      pids: 4,
    };

    expect(matchesContainerFilter(sample, '', 'running')).toBe(true);
    expect(matchesContainerFilter(sample, '', 'stopped')).toBe(false);
    expect(matchesContainerFilter(sample, '3000', 'all')).toBe(true);
    expect(matchesContainerFilter(sample, 'acme-platform', 'all')).toBe(true);
    expect(matchesContainerFilter(sample, 'nonexistent', 'all')).toBe(false);
  });
});
