import { STATUS_TEXT } from '../hooks.js';
export default function StatusBadge({ status }) {
  return <span className={`badge badge-${status}`}>{STATUS_TEXT[status] || status}</span>;
}
