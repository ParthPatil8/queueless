// Centralised API helper. VITE_API_URL is empty for same-origin deployment (the default).
// It must only ever hold a public URL - never a secret.
const BASE = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');

export class ApiFailure extends Error {
  constructor(status, code, message, data) { super(message); this.status = status; this.code = code; this.data = data; }
}

async function request(path, { method = 'GET', body, headers = {}, credentials = 'include' } = {}) {
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
  return { status: res.status, ok: res.ok, data };
}

export async function api(path, opts) {
  const r = await request(path, opts);
  if (!r.ok) {
    const e = r.data?.error;
    throw new ApiFailure(r.status, e?.code || 'error', e?.message || `Request failed (${r.status}).`, e);
  }
  return r.data;
}

// Used by the Security demo: never throws and reports the REAL HTTP status the server returned.
export async function probe(path, opts = {}) {
  try {
    const r = await request(path, opts);
    if (r.ok) return { status: r.status, ok: true, body: r.data };
    const e = r.data?.error;
    return { status: r.status, ok: false, code: e?.code, message: e?.message, data: e };
  } catch (e) {
    return { status: e.status ?? 0, ok: false, code: e.code, message: e.message };
  }
}
