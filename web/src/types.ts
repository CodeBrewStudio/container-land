export interface EngineInfo {
  hostname: string;
  serverVersion: string;
  apiVersion: string;
  operatingSystem: string;
  architecture: string;
  kernelVersion: string;
  dockerRootDir: string;
  storageDriver: string;
  socketPath: string;
  containers: number;
  containersRunning: number;
  containersPaused: number;
  containersStopped: number;
  images: number;
  memTotal: number;
  ncpu: number;
}

export interface CoreLoad {
  core: string;
  percent: number;
}

export interface DiskSpace {
  path: string;
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  usedPercent: number;
}

export interface HostSnapshot {
  timestamp: string;
  hostname: string;
  kernelVersion: string;
  cpuModel: string;
  cpuCores: number;
  cpuPercent: number;
  perCore?: CoreLoad[];
  cpuTempC?: number;
  memTotalBytes: number;
  memUsedBytes: number;
  memCacheBytes: number;
  memAvailBytes: number;
  memPercent: number;
  swapTotalBytes: number;
  swapUsedBytes: number;
  load1: number;
  load5: number;
  load15: number;
  uptimeSeconds: number;
  rootDisk: DiskSpace;
  dockerDisk: DiskSpace;
}

export interface DiskUsageSummary {
  layersSize: number;
  imagesTotal: number;
  imagesActive: number;
  imagesSize: number;
  imagesReclaimable: number;
  containersTotal: number;
  containersActive: number;
  containersSize: number;
  containersReclaimable: number;
  volumesTotal: number;
  volumesActive: number;
  volumesSize: number;
  volumesReclaimable: number;
  buildCacheTotal: number;
  buildCacheActive: number;
  buildCacheSize: number;
  buildCacheReclaimable: number;
  totalSize: number;
  totalReclaimable: number;
  safeReclaimable: number;
}

export interface OverviewResponse {
  engine: EngineInfo;
  host: HostSnapshot;
  diskUsage: DiskUsageSummary;
  composeStackCount: number;
  volumeCount: number;
  networkCount: number;
}

export interface PortBinding {
  ip?: string;
  privatePort: number;
  publicPort?: number;
  type: string;
}

export interface MountPoint {
  type: string;
  name?: string;
  source: string;
  destination: string;
  mode?: string;
  rw: boolean;
}

export interface ContainerSummary {
  id: string;
  shortId: string;
  name: string;
  image: string;
  imageId: string;
  command: string;
  created: number;
  state: string;
  status: string;
  ports: PortBinding[];
  labels: Record<string, string>;
  composeProject?: string;
  composeService?: string;
  composeWorkDir?: string;
  composeConfigFiles?: string;
  mounts: MountPoint[];
  networks: string[];
  cpuPercent: number;
  memUsageBytes: number;
  memLimitBytes: number;
  memPercent: number;
  netRxBytes: number;
  netTxBytes: number;
  blockReadBytes: number;
  blockWriteBytes: number;
  pids: number;
}

export interface ComposeGroup {
  name: string;
  status: 'running' | 'partial' | 'stopped';
  runningCount: number;
  totalCount: number;
  workingDir?: string;
  configFiles?: string;
  cpuPercent: number;
  memUsageBytes: number;
  exposedPorts: PortBinding[];
  containers: ContainerSummary[];
}

export interface ContainersResponse {
  composeGroups: ComposeGroup[];
  standalone: ContainerSummary[] | null;
  totalCount: number;
  runningCount: number;
  stoppedCount: number;
}

export interface ContainerInspectDetail {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  startedAt: string;
  finishedAt?: string;
  restartCount: number;
  restartPolicy: string;
  platform: string;
  command: string[];
  entrypoint: string[];
  workingDir: string;
  user: string;
  tty: boolean;
  env: string[];
  labels: Record<string, string>;
  mounts: MountPoint[];
  ports: PortBinding[];
  networks: Record<string, string>;
  raw: Record<string, unknown>;
}

export interface ContainerStats {
  containerId: string;
  name: string;
  timestamp: string;
  cpuPercent: number;
  memUsageBytes: number;
  memLimitBytes: number;
  memPercent: number;
  netRxBytes: number;
  netTxBytes: number;
  blockReadBytes: number;
  blockWriteBytes: number;
  pids: number;
}

export interface LogEntry {
  stream: 'stdout' | 'stderr';
  timestamp?: string;
  message: string;
  containerId?: string;
  containerName?: string;
  service?: string;
}

export interface ImageSummary {
  id: string;
  shortId: string;
  repoTags: string[];
  repository: string;
  tag: string;
  created: number;
  sizeBytes: number;
  sharedSizeBytes: number;
  containers: number;
  inUse: boolean;
  usedByContainers?: string[];
}

export interface VolumeSummary {
  name: string;
  driver: string;
  mountpoint: string;
  createdAt: string;
  labels: Record<string, string>;
  scope: string;
  sizeBytes: number;
  refCount: number;
  inUse: boolean;
  usedByContainers?: string[];
}

export interface NetworkContainerEndpoint {
  containerId: string;
  containerName: string;
  ipv4Address: string;
  macAddress: string;
}

export interface NetworkSummary {
  id: string;
  shortId: string;
  name: string;
  driver: string;
  scope: string;
  internal: boolean;
  attachable: boolean;
  subnet?: string;
  gateway?: string;
  created: string;
  builtIn: boolean;
  inUse: boolean;
  containers: NetworkContainerEndpoint[];
}

export interface PruneRequest {
  containers: boolean;
  images: boolean;
  danglingOnly: boolean;
  buildCache: boolean;
  volumes: boolean;
}

export interface PruneResponse {
  containersDeleted?: string[];
  imagesDeleted?: string[];
  volumesDeleted?: string[];
  buildCacheDeleted?: string[];
  reclaimedContainersBytes: number;
  reclaimedImagesBytes: number;
  reclaimedVolumesBytes: number;
  reclaimedBuildCacheBytes: number;
  totalReclaimedBytes: number;
}
