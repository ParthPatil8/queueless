import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';

// Loads data once, then refreshes every `intervalMs` (simple near-live updates, no WebSockets).
// Pass a null path to do nothing. Data is only returned for the path it was fetched for, so a
// component never renders with another URL's (differently shaped) response.
export function usePolling(path, intervalMs = 4000) {
  const [state, setState] = useState({ path: null, data: null, error: null, loading: true });
  const latest = useRef(path);
  latest.current = path;

  const load = useCallback(async () => {
    if (!path) return;
    try {
      const data = await api(path);
      if (latest.current === path) setState({ path, data, error: null, loading: false });
    } catch (error) {
      if (latest.current === path) setState((s) => ({ path, data: s.path === path ? s.data : null, error, loading: false }));
    }
  }, [path]);

  useEffect(() => {
    if (!path) return undefined;
    load();
    const t = setInterval(() => { if (!document.hidden) load(); }, intervalMs);
    return () => clearInterval(t);
  }, [path, load, intervalMs]);

  const current = !!path && state.path === path;
  return {
    data: current ? state.data : null,
    error: current ? state.error : null,
    loading: !!path && !current,
    reload: load,
  };
}

export const STATUS_TEXT = {
  waiting: 'Waiting', called: 'Called - go to the counter', served: 'Served', skipped: 'Skipped', cancelled: 'Cancelled',
};
