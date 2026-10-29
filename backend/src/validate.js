// Small hand-written validators. Every route validates ALL incoming fields.
export class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const bad = (msg) => new ApiError(400, 'invalid_input', msg);

export function onlyKeys(obj, allowed) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) throw bad('Request body must be a JSON object.');
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) throw bad(`Unexpected field: ${k.slice(0, 30)}`);
}
export function id(value, label = 'id') {
  const s = String(value);
  if (!/^[1-9]\d{0,9}$/.test(s)) throw bad(`${label} must be a positive whole number.`);
  return Number(s);
}
export function text(value, label, { min = 1, max = 40, pattern } = {}) {
  if (typeof value !== 'string') throw bad(`${label} must be text.`);
  const v = value.trim().replace(/\s+/g, ' ');
  if (v.length < min || v.length > max) throw bad(`${label} must be ${min}-${max} characters.`);
  if (pattern && !pattern.test(v)) throw bad(`${label} contains characters that are not allowed.`);
  return v;
}
export const NAME_RE = /^[\p{L}\p{N} .'\-]+$/u;
export function int(value, label, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) throw bad(`${label} must be a whole number from ${min} to ${max}.`);
  return value;
}
export function bool(value, label) {
  if (typeof value !== 'boolean') throw bad(`${label} must be true or false.`);
  return value;
}
