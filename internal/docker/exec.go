package docker

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
)

// ExecSession represents a hijacked bidirectional TTY stream inside a running container.
type ExecSession struct {
	ExecID string
	Conn   net.Conn
	Reader *bufio.Reader
}

// Close closes the underlying hijacked connection.
func (s *ExecSession) Close() error {
	if s.Conn != nil {
		return s.Conn.Close()
	}
	return nil
}

// CreateAndStartExec creates an interactive TTY exec instance inside container id and hijacks the stream.
func (c *Client) CreateAndStartExec(ctx context.Context, containerID string, shellCmd string, cols, rows int) (*ExecSession, error) {
	if shellCmd == "" {
		shellCmd = "command -v bash >/dev/null 2>&1 && exec bash || exec sh"
	}
	createBody, _ := json.Marshal(map[string]any{
		"AttachStdin":  true,
		"AttachStdout": true,
		"AttachStderr": true,
		"Tty":          true,
		"Cmd":          []string{"/bin/sh", "-c", shellCmd},
		"Env":          []string{"TERM=xterm-256color"},
	})

	resp, err := c.doRequest(ctx, http.MethodPost, fmt.Sprintf("/containers/%s/exec", url.PathEscape(containerID)), bytes.NewReader(createBody), map[string]string{
		"Content-Type": "application/json",
	})
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	var created struct {
		ID string `json:"Id"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&created); err != nil {
		return nil, err
	}
	if created.ID == "" {
		return nil, fmt.Errorf("docker exec returned empty ID")
	}

	// Dial a raw connection to the Docker socket and perform the HTTP Connection: Upgrade hijack for /exec/{id}/start
	var d net.Dialer
	rawConn, err := d.DialContext(ctx, c.network, c.addr)
	if err != nil {
		return nil, err
	}

	startPayload, _ := json.Marshal(map[string]any{
		"Detach": false,
		"Tty":    true,
	})

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, fmt.Sprintf("http://localhost/exec/%s/start", url.PathEscape(created.ID)), bytes.NewReader(startPayload))
	if err != nil {
		rawConn.Close()
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Connection", "Upgrade")
	req.Header.Set("Upgrade", "tcp")

	if err := req.Write(rawConn); err != nil {
		rawConn.Close()
		return nil, err
	}

	br := bufio.NewReader(rawConn)
	startResp, err := http.ReadResponse(br, req)
	if err != nil {
		rawConn.Close()
		return nil, err
	}
	if startResp.StatusCode != http.StatusSwitchingProtocols && startResp.StatusCode != http.StatusOK {
		msg, _ := io.ReadAll(io.LimitReader(startResp.Body, 4096))
		rawConn.Close()
		return nil, fmt.Errorf("docker exec start failed (%d): %s", startResp.StatusCode, string(msg))
	}

	if cols > 0 && rows > 0 {
		_ = c.ResizeExec(ctx, created.ID, cols, rows)
	}

	return &ExecSession{
		ExecID: created.ID,
		Conn:   rawConn,
		Reader: br,
	}, nil
}

// ResizeExec updates the PTY dimensions of an active exec instance.
func (c *Client) ResizeExec(ctx context.Context, execID string, cols, rows int) error {
	if cols <= 0 || rows <= 0 {
		return nil
	}
	q := url.Values{}
	q.Set("w", fmt.Sprintf("%d", cols))
	q.Set("h", fmt.Sprintf("%d", rows))
	resp, err := c.doRequest(ctx, http.MethodPost, fmt.Sprintf("/exec/%s/resize?%s", url.PathEscape(execID), q.Encode()), nil, nil)
	if err != nil {
		return err
	}
	resp.Body.Close()
	return nil
}
