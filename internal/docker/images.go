package docker

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
)

// ListImages lists all Docker images enriched with active container usage references.
func (c *Client) ListImages(ctx context.Context) ([]ImageSummary, error) {
	var rawImages []struct {
		ID          string   `json:"Id"`
		RepoTags    []string `json:"RepoTags"`
		RepoDigests []string `json:"RepoDigests"`
		Created     int64    `json:"Created"`
		Size        int64    `json:"Size"`
		SharedSize  int64    `json:"SharedSize"`
		Containers  int64    `json:"Containers"`
	}
	if err := c.getJSON(ctx, "/images/json?all=0", &rawImages); err != nil {
		return nil, err
	}

	ctrs, _ := c.ListContainers(ctx, false)
	usedByMap := make(map[string][]string)
	addRef := func(imgID, name string) {
		usedByMap[imgID] = append(usedByMap[imgID], name)
	}
	for _, g := range ctrs.ComposeGroups {
		for _, ctr := range g.Containers {
			addRef(ctr.ImageID, ctr.Name)
		}
	}
	for _, ctr := range ctrs.Standalone {
		addRef(ctr.ImageID, ctr.Name)
	}

	out := make([]ImageSummary, 0, len(rawImages))
	for _, ri := range rawImages {
		shortID := strings.TrimPrefix(ri.ID, "sha256:")
		if len(shortID) > 12 {
			shortID = shortID[:12]
		}
		repo := "<none>"
		tag := "<none>"
		if len(ri.RepoTags) > 0 && ri.RepoTags[0] != "<none>:<none>" {
			parts := strings.Split(ri.RepoTags[0], ":")
			if len(parts) > 1 {
				tag = parts[len(parts)-1]
				repo = strings.Join(parts[:len(parts)-1], ":")
			} else {
				repo = ri.RepoTags[0]
				tag = "latest"
			}
		} else if len(ri.RepoDigests) > 0 {
			parts := strings.Split(ri.RepoDigests[0], "@")
			if len(parts) > 0 && parts[0] != "<none>" {
				repo = parts[0]
			}
		}

		usedBy := usedByMap[ri.ID]
		inUse := len(usedBy) > 0 || ri.Containers > 0

		out = append(out, ImageSummary{
			ID:               ri.ID,
			ShortID:          shortID,
			RepoTags:         ri.RepoTags,
			Repository:       repo,
			Tag:              tag,
			Created:          ri.Created,
			SizeBytes:        ri.Size,
			SharedSizeBytes:  ri.SharedSize,
			Containers:       int64(len(usedBy)),
			InUse:            inUse,
			UsedByContainers: usedBy,
		})
	}

	sort.Slice(out, func(i, j int) bool {
		if out[i].InUse != out[j].InUse {
			return out[i].InUse
		}
		return out[i].Created > out[j].Created
	})

	return out, nil
}

// PullImage pulls an image from a registry and streams JSON progress updates.
func (c *Client) PullImage(ctx context.Context, fromImage string, onProgress func(map[string]any) error) error {
	q := url.Values{}
	q.Set("fromImage", strings.TrimSpace(fromImage))
	resp, err := c.doRequest(ctx, http.MethodPost, "/images/create?"+q.Encode(), nil, nil)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	dec := json.NewDecoder(resp.Body)
	for {
		var msg map[string]any
		if err := dec.Decode(&msg); err != nil {
			if err == io.EOF {
				return nil
			}
			return err
		}
		if err := onProgress(msg); err != nil {
			return err
		}
	}
}

// RemoveImage removes an image by ID or reference.
func (c *Client) RemoveImage(ctx context.Context, id string, force bool) error {
	q := url.Values{}
	if force {
		q.Set("force", "true")
	}
	resp, err := c.doRequest(ctx, http.MethodDelete, fmt.Sprintf("/images/%s?%s", url.PathEscape(id), q.Encode()), nil, nil)
	if err != nil {
		return err
	}
	resp.Body.Close()
	return nil
}
