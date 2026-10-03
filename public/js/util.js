/**
 * Shared formatting utilities for LocalShare.
 */

export function formatBytes(bytes) {
  if (!bytes || bytes < 1) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / Math.pow(1024, i);
  return `${value >= 10 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

export function formatRelativeTime(iso) {
  if (!iso) return "";
  const then = new Date(iso);
  const diffMs = Date.now() - then.getTime();
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function formatClockDuration(ms) {
  if (ms == null) return "";
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/**
 * Return a status label + class for a file expiry timestamp.
 * @returns {{ label: string, cls: string, urgent: boolean }}
 */
export function expiryLabel(expiresAt, pinned) {
  if (pinned) return { label: "pinned", cls: "success", urgent: false };
  if (!expiresAt) return { label: "", cls: "", urgent: false };
  const diff = new Date(expiresAt).getTime() - Date.now();
  if (diff <= 0) return { label: "expired", cls: "error", urgent: true };
  if (diff < 60 * 60 * 1000) {
    const mins = Math.max(1, Math.floor(diff / 60000));
    return { label: `${mins}m left`, cls: "error", urgent: true };
  }
  if (diff < 24 * 60 * 60 * 1000) {
    const hrs = Math.floor(diff / (60 * 60 * 1000));
    const mins = Math.floor((diff % (60 * 60 * 1000)) / 60000);
    return { label: `${hrs}h ${mins}m left`, cls: "warning", urgent: false };
  }
  const days = Math.floor(diff / (24 * 60 * 60 * 1000));
  return { label: `${days}d left`, cls: "success", urgent: false };
}

/**
 * Human label for a MIME type category.
 */
export function typeLabel(mimeType) {
  if (!mimeType) return "file";
  const [top, sub] = mimeType.split("/");
  if (top === "image") return "image";
  if (top === "video") return "video";
  if (top === "audio") return "audio";
  if (mimeType === "application/pdf") return "pdf";
  if (top === "text") return "text";
  if (mimeType.includes("zip") || mimeType.includes("tar") || mimeType.includes("gzip"))
    return "archive";
  if (mimeType.includes("json") || mimeType.includes("xml") || mimeType.includes("javascript"))
    return "code";
  return sub || "file";
}

export function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = String(str ?? "");
  return div.innerHTML;
}
