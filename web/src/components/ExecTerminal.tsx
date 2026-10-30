import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { RefreshCw } from 'lucide-react';

interface ExecTerminalProps {
  containerId: string;
  containerName: string;
  isRunning: boolean;
}

export function ExecTerminal({ containerId, containerName, isRunning }: ExecTerminalProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [connected, setConnected] = useState(false);
  const [shellMode, setShellMode] = useState<'auto' | '/bin/bash' | '/bin/sh'>('auto');
  const [sessionNonce, setSessionNonce] = useState(0);

  useEffect(() => {
    if (!isRunning || !containerRef.current) {
      setConnected(false);
      return;
    }

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 12,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
      theme: {
        background: '#090d16',
        foreground: '#e2e8f0',
        cursor: '#34d399',
        selectionBackground: '#334155',
      },
      scrollback: 5000,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);

    try {
      fitAddon.fit();
    } catch {
      // Ignore layout measurement error if hidden
    }

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const shellQuery =
      shellMode === 'auto'
        ? ''
        : `&shell=${encodeURIComponent(`exec ${shellMode}`)}`;
    const wsUrl = `${proto}//${window.location.host}/api/containers/${encodeURIComponent(
      containerId
    )}/exec?cols=${term.cols || 100}&rows=${term.rows || 28}${shellQuery}`;

    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      setConnected(true);
      term.focus();
      try {
        fitAddon.fit();
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      } catch {
        // ignore
      }
    };

    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        term.write(ev.data);
      }
    };

    ws.onclose = () => {
      setConnected(false);
      term.write('\r\n\x1b[90m[Session disconnected]\x1b[0m\r\n');
    };

    ws.onerror = () => {
      setConnected(false);
    };

    const dataSub = term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data }));
      }
    });

    const resizeObserver = new ResizeObserver(() => {
      try {
        fitAddon.fit();
        if (ws.readyState === WebSocket.OPEN && term.cols > 0 && term.rows > 0) {
          ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
        }
      } catch {
        // ignore
      }
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      dataSub.dispose();
      ws.close();
      term.dispose();
    };
  }, [containerId, isRunning, shellMode, sessionNonce]);

  if (!isRunning) {
    return (
      <div className="flex-1 flex items-center justify-center p-6 text-xs text-[var(--text-muted)] font-mono">
        Container {containerName} is not running. Start the container to open an interactive shell.
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-[#090d16]">
      <div className="px-3 py-1.5 border-b border-[var(--border-subtle)] bg-[var(--bg-card)] flex items-center justify-between gap-2 text-xs">
        <div className="flex items-center gap-2 font-mono">
          <span
            className={`w-2 h-2 rounded-full ${
              connected ? 'bg-emerald-500' : 'bg-amber-500'
            }`}
          />
          <span className="text-[var(--text-muted)]">
            TTY Exec ({containerName})
          </span>
          <select
            aria-label="Shell binary"
            value={shellMode}
            onChange={(e) => setShellMode(e.target.value as 'auto' | '/bin/bash' | '/bin/sh')}
            className="px-2 py-0.5 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)] text-xs font-mono"
          >
            <option value="auto">Auto (bash → sh)</option>
            <option value="/bin/bash">/bin/bash</option>
            <option value="/bin/sh">/bin/sh</option>
          </select>
        </div>
        <button
          type="button"
          onClick={() => setSessionNonce((n) => n + 1)}
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] hover:bg-[var(--bg-elevated)] text-xs"
        >
          <RefreshCw className="w-3 h-3" />
          <span>Reconnect</span>
        </button>
      </div>
      <div ref={containerRef} className="flex-1 min-h-0 p-2 overflow-hidden" />
    </div>
  );
}
