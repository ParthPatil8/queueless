import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';

// Loads data once, then refreshes every `intervalMs` (simple near-live updates, no WebSockets).
export function usePolling(path, intervalMs = 4000) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const alive = useRef(true);
  const load = useCallback(async () => {
    try {
      const data = await api(path);
      if (alive.current) setState({ data, error: null, loading: false });
    } catch (error) {
      if (alive.current) setState((s) => ({ ...s, error, loading: false }));
    }
  }, [path]);
  useEffect(() => {
    alive.current = true;
    setState({ data: null, error: null, loading: true });
    load();
    const t = setInterval(() => { if (!document.hidden) load(); }, intervalMs);
    return () => { alive.current = false; clearInterval(t); };
  }, [load, intervalMs]);
  return { ...state, reload: load };
}

export const STATUS_TEXT = {
  waiting: 'Waiting', called: 'Called - go to the counter', served: 'Served', skipped: 'Skipped', cancelled: 'Cancelled',
};
