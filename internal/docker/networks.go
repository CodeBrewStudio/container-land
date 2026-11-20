package docker

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"sort"
)

// CountNetworks returns the total number of Docker networks without cross-referencing containers.
func (c *Client) CountNetworks(ctx context.Context) (int, error) {
	var rawNets []struct {
		ID string `json:"Id"`
	}
	if err := c.getJSON(ctx, "/networks", &rawNets); err != nil {
		return 0, err
	}
	return len(rawNets), nil
}

// ListNetworks lists all Docker networks and their attached containers.
func (c *Client) ListNetworks(ctx context.Context) ([]NetworkSummary, error) {
	var rawNets []struct {
		ID         string `json:"Id"`
		Name       string `json:"Name"`
		Driver     string `json:"Driver"`
		Scope      string `json:"Scope"`
		Internal   bool   `json:"Internal"`
		Attachable bool   `json:"Attachable"`
		Created    string `json:"Created"`
		IPAM       struct {
			Config []struct {
				Subnet  string `json:"Subnet"`
				Gateway string `json:"Gateway"`
			} `json:"Config"`
		} `json:"IPAM"`
		Containers map[string]struct {
			Name        string `json:"Name"`
			IPv4Address string `json:"IPv4Address"`
			MacAddress  string `json:"MacAddress"`
		} `json:"Containers"`
	}
	if err := c.getJSON(ctx, "/networks", &rawNets); err != nil {
		return nil, err
	}

	// Cross-reference container networks from /containers/json since some Docker versions omit Containers map in /networks list
	ctrs, _ := c.ListContainers(ctx, false)
	byNet := make(map[string][]NetworkContainerEndpoint)
	recordNet := func(ctr ContainerSummary) {
		for _, n := range ctr.Networks {
			byNet[n] = append(byNet[n], NetworkContainerEndpoint{
				ContainerID:   ctr.ShortID,
				ContainerName: ctr.Name,
			})
		}
	}
	for _, g := range ctrs.ComposeGroups {
		for _, ctr := range g.Containers {
			recordNet(ctr)
		}
	}
	for _, ctr := range ctrs.Standalone {
		recordNet(ctr)
	}

	out := make([]NetworkSummary, 0, len(rawNets))
	for _, rn := range rawNets {
		shortID := rn.ID
		if len(shortID) > 12 {
			shortID = shortID[:12]
		}
		var subnet, gateway string
		if len(rn.IPAM.Config) > 0 {
			subnet = rn.IPAM.Config[0].Subnet
			gateway = rn.IPAM.Config[0].Gateway
		}
		endpoints := make([]NetworkContainerEndpoint, 0)
		for cid, ep := range rn.Containers {
			shortC := cid
			if len(shortC) > 12 {
				shortC = shortC[:12]
			}
			endpoints = append(endpoints, NetworkContainerEndpoint{
				ContainerID:   shortC,
				ContainerName: ep.Name,
				IPv4Address:   ep.IPv4Address,
				MacAddress:    ep.MacAddress,
			})
		}
		if len(endpoints) == 0 {
			endpoints = byNet[rn.Name]
		}
		builtIn := rn.Name == "bridge" || rn.Name == "host" || rn.Name == "none"

		out = append(out, NetworkSummary{
			ID:         rn.ID,
			ShortID:    shortID,
			Name:       rn.Name,
			Driver:     rn.Driver,
			Scope:      rn.Scope,
			Internal:   rn.Internal,
			Attachable: rn.Attachable,
			Subnet:     subnet,
			Gateway:    gateway,
			Created:    rn.Created,
			BuiltIn:    builtIn,
			InUse:      len(endpoints) > 0 || builtIn,
			Containers: endpoints,
		})
	}

	sort.Slice(out, func(i, j int) bool {
		return out[i].Name < out[j].Name
	})

	return out, nil
}

// RemoveNetwork removes a custom Docker network by ID.
func (c *Client) RemoveNetwork(ctx context.Context, id string) error {
	resp, err := c.doRequest(ctx, http.MethodDelete, fmt.Sprintf("/networks/%s", url.PathEscape(id)), nil, nil)
	if err != nil {
		return err
	}
	resp.Body.Close()
	return nil
}
