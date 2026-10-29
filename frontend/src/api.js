// Centralised API helper. VITE_API_URL is empty for same-origin deployment (the default).
// It must only ever hold a public URL - never a secret.
const BASE = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');

export class ApiFailure extends Error {
  constructor(status, code, message, data) { super(message); this.status = status; this.code = code; this.data = data; }
}

export async function api(path, { method = 'GET', body, headers = {}, credentials = 'include' } = {}) {
  let res;
  try {
    res = await fetch(`${BASE}/api${path}`, {
      method, credentials,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiFailure(0, 'network', 'Cannot reach the server. Check your connection and try again.');
  }
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON body */ }
  if (!res.ok) {
    const e = data?.error;
    throw new ApiFailure(res.status, e?.code || 'error', e?.message || `Request failed (${res.status}).`, e);
  }
  return data;
}

// Used by the Security demo: returns the status instead of throwing so we can show the real result.
export async function probe(path, opts = {}) {
  try {
    const r = await api(path, opts);
    return { status: 200, ok: true, body: r };
  } catch (e) {
    return { status: e.status, ok: false, code: e.code, message: e.message, data: e.data };
  }
}
