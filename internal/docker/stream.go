package docker

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"io"
	"strings"
)

// LogEntry represents a single demultiplexed container or Compose log line.
type LogEntry struct {
	Stream        string `json:"stream"` // "stdout" or "stderr"
	Timestamp     string `json:"timestamp,omitempty"`
	Message       string `json:"message"`
	ContainerID   string `json:"containerId,omitempty"`
	ContainerName string `json:"containerName,omitempty"`
	Service       string `json:"service,omitempty"`
}

// DemuxDockerStream reads a Docker log stream (either 8-byte multiplexed frames or raw TTY lines)
// and invokes onEntry for each line until EOF or context cancellation.
func DemuxDockerStream(ctx context.Context, r io.Reader, isTTY bool, meta LogEntry, onEntry func(LogEntry) error) error {
	if isTTY {
		return scanLines(ctx, r, "stdout", meta, onEntry)
	}

	br := bufio.NewReaderSize(r, 32*1024)
	var header [8]byte

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		// Peek first 4 bytes to verify whether this is a multiplexed header:
		// header[0] in {0, 1, 2} and header[1..3] == 0.
		peek, err := br.Peek(4)
		if err != nil {
			if err == io.EOF {
				return nil
			}
			// If fewer than 4 bytes remain, drain as stdout.
			return scanLines(ctx, br, "stdout", meta, onEntry)
		}

		if (peek[0] != 0 && peek[0] != 1 && peek[0] != 2) || peek[1] != 0 || peek[2] != 0 || peek[3] != 0 {
			// Container actually has TTY enabled or raw stream; fall back to line scanner.
			return scanLines(ctx, br, "stdout", meta, onEntry)
		}

		if _, err := io.ReadFull(br, header[:]); err != nil {
			if err == io.EOF || err == io.ErrUnexpectedEOF {
				return nil
			}
			return err
		}

		streamType := "stdout"
		if header[0] == 2 {
			streamType = "stderr"
		}
		frameLen := binary.BigEndian.Uint32(header[4:8])
		if frameLen == 0 {
			continue
		}

		payload := make([]byte, frameLen)
		if _, err := io.ReadFull(br, payload); err != nil {
			if err == io.EOF || err == io.ErrUnexpectedEOF {
				emitLinesFromChunk(payload, streamType, meta, onEntry)
				return nil
			}
			return err
		}

		if err := emitLinesFromChunk(payload, streamType, meta, onEntry); err != nil {
			return err
		}
	}
}

func scanLines(ctx context.Context, r io.Reader, streamType string, meta LogEntry, onEntry func(LogEntry) error) error {
	scanner := bufio.NewScanner(r)
	buf := make([]byte, 0, 64*1024)
	scanner.Buffer(buf, 1024*1024)
	for scanner.Scan() {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}
		ts, msg := splitDockerTimestamp(scanner.Text())
		entry := meta
		entry.Stream = streamType
		entry.Timestamp = ts
		entry.Message = msg
		if err := onEntry(entry); err != nil {
			return err
		}
	}
	return scanner.Err()
}

func emitLinesFromChunk(chunk []byte, streamType string, meta LogEntry, onEntry func(LogEntry) error) error {
	chunk = bytes.TrimRight(chunk, "\r\n")
	lines := bytes.Split(chunk, []byte{'\n'})
	for _, rawLine := range lines {
		line := strings.TrimSuffix(string(rawLine), "\r")
		ts, msg := splitDockerTimestamp(line)
		entry := meta
		entry.Stream = streamType
		entry.Timestamp = ts
		entry.Message = msg
		if err := onEntry(entry); err != nil {
			return err
		}
	}
	return nil
}

// splitDockerTimestamp extracts an RFC3339/RFC3339Nano timestamp prefix if present on a Docker log line.
func splitDockerTimestamp(line string) (string, string) {
	if len(line) >= 20 && line[4] == '-' && line[7] == '-' && line[10] == 'T' {
		if idx := strings.IndexByte(line, ' '); idx > 18 && idx <= 36 {
			return line[:idx], line[idx+1:]
		}
	}
	return "", line
}
