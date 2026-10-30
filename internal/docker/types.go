package docker

import "time"

// EngineInfo summarises the connected Docker daemon and host configuration.
type EngineInfo struct {
	Hostname          string `json:"hostname"`
	ServerVersion     string `json:"serverVersion"`
	APIVersion        string `json:"apiVersion"`
	OperatingSystem   string `json:"operatingSystem"`
	Architecture      string `json:"architecture"`
	KernelVersion     string `json:"kernelVersion"`
	DockerRootDir     string `json:"dockerRootDir"`
	StorageDriver     string `json:"storageDriver"`
	SocketPath        string `json:"socketPath"`
	Containers        int    `json:"containers"`
	ContainersRunning int    `json:"containersRunning"`
	ContainersPaused  int    `json:"containersPaused"`
	ContainersStopped int    `json:"containersStopped"`
	Images            int    `json:"images"`
	MemTotal          int64  `json:"memTotal"`
	NCPU              int    `json:"ncpu"`
}

// PortBinding represents a container port mapping.
type PortBinding struct {
	IP          string `json:"ip,omitempty"`
	PrivatePort uint16 `json:"privatePort"`
	PublicPort  uint16 `json:"publicPort,omitempty"`
	Type        string `json:"type"`
}

// MountPoint represents a bind mount or volume attached to a container.
type MountPoint struct {
	Type        string `json:"type"`
	Name        string `json:"name,omitempty"`
	Source      string `json:"source"`
	Destination string `json:"destination"`
	Mode        string `json:"mode,omitempty"`
	RW          bool   `json:"rw"`
}

// ContainerSummary represents a container enriched with Compose metadata and live resource stats.
type ContainerSummary struct {
	ID                 string            `json:"id"`
	ShortID            string            `json:"shortId"`
	Name               string            `json:"name"`
	Image              string            `json:"image"`
	ImageID            string            `json:"imageId"`
	Command            string            `json:"command"`
	Created            int64             `json:"created"`
	State              string            `json:"state"`
	Status             string            `json:"status"`
	Ports              []PortBinding     `json:"ports"`
	Labels             map[string]string `json:"labels"`
	ComposeProject     string            `json:"composeProject,omitempty"`
	ComposeService     string            `json:"composeService,omitempty"`
	ComposeWorkDir     string            `json:"composeWorkDir,omitempty"`
	ComposeConfigFiles string            `json:"composeConfigFiles,omitempty"`
	Mounts             []MountPoint      `json:"mounts"`
	Networks           []string          `json:"networks"`
	CPUPercent         float64           `json:"cpuPercent"`
	MemUsageBytes      uint64            `json:"memUsageBytes"`
	MemLimitBytes      uint64            `json:"memLimitBytes"`
	MemPercent         float64           `json:"memPercent"`
	NetRxBytes         uint64            `json:"netRxBytes"`
	NetTxBytes         uint64            `json:"netTxBytes"`
	BlockReadBytes     uint64            `json:"blockReadBytes"`
	BlockWriteBytes    uint64            `json:"blockWriteBytes"`
	PIDs               uint64            `json:"pids"`
}

// ComposeGroup aggregates all containers belonging to a single Docker Compose project.
type ComposeGroup struct {
	Name          string             `json:"name"`
	Status        string             `json:"status"` // "running", "partial", "stopped"
	RunningCount  int                `json:"runningCount"`
	TotalCount    int                `json:"totalCount"`
	WorkingDir    string             `json:"workingDir,omitempty"`
	ConfigFiles   string             `json:"configFiles,omitempty"`
	CPUPercent    float64            `json:"cpuPercent"`
	MemUsageBytes uint64             `json:"memUsageBytes"`
	ExposedPorts  []PortBinding      `json:"exposedPorts"`
	Containers    []ContainerSummary `json:"containers"`
}

// ContainersResponse is the payload returned by GET /api/containers.
type ContainersResponse struct {
	ComposeGroups []ComposeGroup     `json:"composeGroups"`
	Standalone    []ContainerSummary `json:"standalone"`
	TotalCount    int                `json:"totalCount"`
	RunningCount  int                `json:"runningCount"`
	StoppedCount  int                `json:"stoppedCount"`
}

// ContainerStats holds a live resource telemetry sample for a single container.
type ContainerStats struct {
	ContainerID     string    `json:"containerId"`
	Name            string    `json:"name"`
	Timestamp       time.Time `json:"timestamp"`
	CPUPercent      float64   `json:"cpuPercent"`
	MemUsageBytes   uint64    `json:"memUsageBytes"`
	MemLimitBytes   uint64    `json:"memLimitBytes"`
	MemPercent      float64   `json:"memPercent"`
	NetRxBytes      uint64    `json:"netRxBytes"`
	NetTxBytes      uint64    `json:"netTxBytes"`
	BlockReadBytes  uint64    `json:"blockReadBytes"`
	BlockWriteBytes uint64    `json:"blockWriteBytes"`
	PIDs            uint64    `json:"pids"`
}

// ContainerInspectDetail holds structured inspection details plus the raw JSON object.
type ContainerInspectDetail struct {
	ID            string            `json:"id"`
	Name          string            `json:"name"`
	Image         string            `json:"image"`
	State         string            `json:"state"`
	Status        string            `json:"status"`
	StartedAt     string            `json:"startedAt"`
	FinishedAt    string            `json:"finishedAt,omitempty"`
	RestartCount  int               `json:"restartCount"`
	RestartPolicy string            `json:"restartPolicy"`
	Platform      string            `json:"platform"`
	Command       []string          `json:"command"`
	Entrypoint    []string          `json:"entrypoint"`
	WorkingDir    string            `json:"workingDir"`
	User          string            `json:"user"`
	TTY           bool              `json:"tty"`
	Env           []string          `json:"env"`
	Labels        map[string]string `json:"labels"`
	Mounts        []MountPoint      `json:"mounts"`
	Ports         []PortBinding     `json:"ports"`
	Networks      map[string]string `json:"networks"` // networkName -> IPAddress
	Raw           any               `json:"raw"`
}

// ImageSummary represents a local Docker image and its container usage references.
type ImageSummary struct {
	ID               string   `json:"id"`
	ShortID          string   `json:"shortId"`
	RepoTags         []string `json:"repoTags"`
	Repository       string   `json:"repository"`
	Tag              string   `json:"tag"`
	Created          int64    `json:"created"`
	SizeBytes        int64    `json:"sizeBytes"`
	SharedSizeBytes  int64    `json:"sharedSizeBytes"`
	Containers       int64    `json:"containers"`
	InUse            bool     `json:"inUse"`
	UsedByContainers []string `json:"usedByContainers"`
}

// VolumeSummary represents a Docker volume enriched with disk usage, container mount paths, and content hints.
type VolumeSummary struct {
	Name             string            `json:"name"`
	ShortName        string            `json:"shortName"`
	Anonymous        bool              `json:"anonymous"`
	ComposeProject   string            `json:"composeProject,omitempty"`
	Driver           string            `json:"driver"`
	Mountpoint       string            `json:"mountpoint"`
	CreatedAt        string            `json:"createdAt"`
	Labels           map[string]string `json:"labels"`
	Scope            string            `json:"scope"`
	SizeBytes        int64             `json:"sizeBytes"`
	RefCount         int64             `json:"refCount"`
	InUse            bool              `json:"inUse"`
	UsedByContainers []string          `json:"usedByContainers"`
	MountPaths       []string          `json:"mountPaths"`
	ContentHint      string            `json:"contentHint,omitempty"`
	TopEntries       []string          `json:"topEntries,omitempty"`
}

// NetworkContainerEndpoint represents a container attached to a Docker network.
type NetworkContainerEndpoint struct {
	ContainerID   string `json:"containerId"`
	ContainerName string `json:"containerName"`
	IPv4Address   string `json:"ipv4Address"`
	MacAddress    string `json:"macAddress"`
}

// NetworkSummary represents a Docker network and its attached containers.
type NetworkSummary struct {
	ID         string                     `json:"id"`
	ShortID    string                     `json:"shortId"`
	Name       string                     `json:"name"`
	Driver     string                     `json:"driver"`
	Scope      string                     `json:"scope"`
	Internal   bool                       `json:"internal"`
	Attachable bool                       `json:"attachable"`
	Subnet     string                     `json:"subnet,omitempty"`
	Gateway    string                     `json:"gateway,omitempty"`
	Created    string                     `json:"created"`
	BuiltIn    bool                       `json:"builtIn"`
	InUse      bool                       `json:"inUse"`
	Containers []NetworkContainerEndpoint `json:"containers"`
}

// DiskUsageSummary represents the output of /system/df with safe vs total reclaimable bytes.
type DiskUsageSummary struct {
	LayersSize            int64 `json:"layersSize"`
	ImagesTotal           int   `json:"imagesTotal"`
	ImagesActive          int   `json:"imagesActive"`
	ImagesSize            int64 `json:"imagesSize"`
	ImagesReclaimable     int64 `json:"imagesReclaimable"`
	ContainersTotal       int   `json:"containersTotal"`
	ContainersActive      int   `json:"containersActive"`
	ContainersSize        int64 `json:"containersSize"`
	ContainersReclaimable int64 `json:"containersReclaimable"`
	VolumesTotal          int   `json:"volumesTotal"`
	VolumesActive         int   `json:"volumesActive"`
	VolumesSize           int64 `json:"volumesSize"`
	VolumesReclaimable    int64 `json:"volumesReclaimable"`
	BuildCacheTotal       int   `json:"buildCacheTotal"`
	BuildCacheActive      int   `json:"buildCacheActive"`
	BuildCacheSize        int64 `json:"buildCacheSize"`
	BuildCacheReclaimable int64 `json:"buildCacheReclaimable"`
	TotalSize             int64 `json:"totalSize"`
	TotalReclaimable      int64 `json:"totalReclaimable"`
	SafeReclaimable       int64 `json:"safeReclaimable"` // excludes volumes
}

// PruneRequest specifies which Docker resource categories to prune.
type PruneRequest struct {
	Containers   bool `json:"containers"`
	Images       bool `json:"images"`
	DanglingOnly bool `json:"danglingOnly"`
	BuildCache   bool `json:"buildCache"`
	Volumes      bool `json:"volumes"`
}

// PruneResponse reports items deleted and space reclaimed across selected categories.
type PruneResponse struct {
	ContainersDeleted        []string `json:"containersDeleted"`
	ImagesDeleted            []string `json:"imagesDeleted"`
	VolumesDeleted           []string `json:"volumesDeleted"`
	BuildCacheDeleted        []string `json:"buildCacheDeleted"`
	ReclaimedContainersBytes uint64   `json:"reclaimedContainersBytes"`
	ReclaimedImagesBytes     uint64   `json:"reclaimedImagesBytes"`
	ReclaimedVolumesBytes    uint64   `json:"reclaimedVolumesBytes"`
	ReclaimedBuildCacheBytes uint64   `json:"reclaimedBuildCacheBytes"`
	TotalReclaimedBytes      uint64   `json:"totalReclaimedBytes"`
}

// DaemonEvent represents a real-time Docker Engine event from /events.
type DaemonEvent struct {
	Type   string            `json:"type"`
	Action string            `json:"action"`
	ID     string            `json:"id"`
	Name   string            `json:"name,omitempty"`
	Time   int64             `json:"time"`
	Attrs  map[string]string `json:"attrs,omitempty"`
}
