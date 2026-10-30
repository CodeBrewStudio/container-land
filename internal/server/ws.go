package server

import (
	"bufio"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
)

const wsGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

const (
	wsOpText   = 0x1
	wsOpBinary = 0x2
	wsOpClose  = 0x8
	wsOpPing   = 0x9
	wsOpPong   = 0xA
)

// WSConn is a minimal RFC 6455 server WebSocket connection over a hijacked net.Conn.
type WSConn struct {
	conn   net.Conn
	reader *bufio.Reader
	wmu    sync.Mutex
}

// UpgradeWebSocket upgrades an HTTP request to a WebSocket connection.
func UpgradeWebSocket(w http.ResponseWriter, r *http.Request) (*WSConn, error) {
	if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		return nil, errors.New("missing websocket upgrade header")
	}
	key := strings.TrimSpace(r.Header.Get("Sec-WebSocket-Key"))
	if key == "" {
		return nil, errors.New("missing Sec-WebSocket-Key")
	}

	hj, ok := w.(http.Hijacker)
	if !ok {
		return nil, errors.New("response writer does not support hijacking")
	}
	conn, rw, err := hj.Hijack()
	if err != nil {
		return nil, err
	}

	h := sha1.New()
	h.Write([]byte(key + wsGUID))
	accept := base64.StdEncoding.EncodeToString(h.Sum(nil))

	resp := fmt.Sprintf(
		"HTTP/1.1 101 Switching Protocols\r\n"+
			"Upgrade: websocket\r\n"+
			"Connection: Upgrade\r\n"+
			"Sec-WebSocket-Accept: %s\r\n\r\n",
		accept,
	)
	if _, err := rw.WriteString(resp); err != nil {
		conn.Close()
		return nil, err
	}
	if err := rw.Flush(); err != nil {
		conn.Close()
		return nil, err
	}

	return &WSConn{
		conn:   conn,
		reader: rw.Reader,
	}, nil
}

// ReadMessage reads the next complete WebSocket frame payload.
func (ws *WSConn) ReadMessage() (opcode byte, payload []byte, err error) {
	for {
		var b [2]byte
		if _, err := io.ReadFull(ws.reader, b[:]); err != nil {
			return 0, nil, err
		}
		opcode = b[0] & 0x0F
		masked := (b[1] & 0x80) != 0
		length := uint64(b[1] & 0x7F)

		switch length {
		case 126:
			var ext [2]byte
			if _, err := io.ReadFull(ws.reader, ext[:]); err != nil {
				return 0, nil, err
			}
			length = uint64(binary.BigEndian.Uint16(ext[:]))
		case 127:
			var ext [8]byte
			if _, err := io.ReadFull(ws.reader, ext[:]); err != nil {
				return 0, nil, err
			}
			length = binary.BigEndian.Uint64(ext[:])
		}

		if length > 4*1024*1024 {
			return 0, nil, errors.New("websocket frame too large")
		}

		var maskKey [4]byte
		if masked {
			if _, err := io.ReadFull(ws.reader, maskKey[:]); err != nil {
				return 0, nil, err
			}
		}

		data := make([]byte, length)
		if _, err := io.ReadFull(ws.reader, data); err != nil {
			return 0, nil, err
		}
		if masked {
			for i := range data {
				data[i] ^= maskKey[i%4]
			}
		}

		switch opcode {
		case wsOpPing:
			_ = ws.writeFrame(wsOpPong, data)
			continue
		case wsOpPong:
			continue
		case wsOpClose:
			_ = ws.writeFrame(wsOpClose, nil)
			return wsOpClose, nil, io.EOF
		default:
			return opcode, data, nil
		}
	}
}

// WriteText sends a UTF-8 text WebSocket frame.
func (ws *WSConn) WriteText(msg string) error {
	return ws.writeFrame(wsOpText, []byte(msg))
}

// WriteBinary sends a binary WebSocket frame.
func (ws *WSConn) WriteBinary(data []byte) error {
	return ws.writeFrame(wsOpBinary, data)
}

func (ws *WSConn) writeFrame(opcode byte, data []byte) error {
	ws.wmu.Lock()
	defer ws.wmu.Unlock()

	var header []byte
	length := len(data)
	header = append(header, 0x80|opcode)
	switch {
	case length < 126:
		header = append(header, byte(length))
	case length <= 65535:
		header = append(header, 126, byte(length>>8), byte(length))
	default:
		header = append(header, 127,
			byte(uint64(length)>>56),
			byte(uint64(length)>>48),
			byte(uint64(length)>>40),
			byte(uint64(length)>>32),
			byte(uint64(length)>>24),
			byte(uint64(length)>>16),
			byte(uint64(length)>>8),
			byte(uint64(length)),
		)
	}

	if _, err := ws.conn.Write(header); err != nil {
		return err
	}
	if length > 0 {
		_, err := ws.conn.Write(data)
		return err
	}
	return nil
}

// Close closes the WebSocket connection.
func (ws *WSConn) Close() error {
	return ws.conn.Close()
}
