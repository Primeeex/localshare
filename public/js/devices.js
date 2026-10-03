/**
 * Device list rendering.
 */

import { escapeHtml, formatRelativeTime } from "./util.js";

export function renderDeviceRow(device, actions = {}) {
  const el = document.createElement("div");
  el.className = "device-row";
  el.setAttribute("role", "listitem");
  el.dataset.deviceId = device.id;

  const initials = (device.name || "?").slice(0, 2);
  const color = device.color || hashColor(device.id);

  el.innerHTML = `
    <div class="device-avatar" style="background:${escapeHtml(color)}">${escapeHtml(initials)}</div>
    <div class="device-info">
      <div class="device-name">
        <span class="device-name-text">${escapeHtml(device.name || "Unknown")}</span>
        ${actions.isSelf ? '<span class="device-you">You</span>' : ""}
      </div>
      <div class="device-meta">${escapeHtml(device.deviceType || "desktop")} · connected ${formatRelativeTime(
        device.joinedAt
      )}</div>
    </div>
    ${actions.isSelf ? '<button class="btn btn-ghost btn-sm" data-rename>Rename</button>' : `<code class="device-meta">${escapeHtml(device.id)}</code>`}
  `;

  const renameBtn = el.querySelector("[data-rename]");
  if (renameBtn) {
    renameBtn.addEventListener("click", () => {
      const span = el.querySelector(".device-name-text");
      const input = document.createElement("input");
      input.className = "device-name-input";
      input.value = device.name || "";
      input.maxLength = 32;
      span.replaceWith(input);
      input.focus();
      input.select();

      const commit = async () => {
        const value = input.value.trim();
        if (value && value !== device.name) {
          await actions.onRename?.(value);
        } else {
          // Restore original
          const restored = document.createElement("span");
          restored.className = "device-name-text";
          restored.textContent = device.name || "Unknown";
          input.replaceWith(restored);
        }
      };
      input.addEventListener("blur", commit);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") input.blur();
        if (e.key === "Escape") {
          input.value = device.name || "";
          input.blur();
        }
      });
    });
  }

  return el;
}

export function renderDeviceAvatars(container, devices) {
  if (!container) return;
  container.innerHTML = "";
  const visible = devices.slice(0, 5);
  for (const device of visible) {
    const el = document.createElement("div");
    el.className = "device-avatar";
    el.style.background = device.color || hashColor(device.id);
    el.title = device.name;
    el.textContent = (device.name || "?").slice(0, 2);
    container.appendChild(el);
  }
  if (devices.length > 5) {
    const more = document.createElement("div");
    more.className = "device-avatar";
    more.style.background = "var(--color-accent-strong)";
    more.textContent = `+${devices.length - 5}`;
    container.appendChild(more);
  }
}

function hashColor(id = "") {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  // Palette chosen so white 12px initials keep >= 4.5:1 contrast (spec 6.30)
  const colors = [
    "#B91C1C",
    "#9F1239",
    "#9A3412",
    "#854D0E",
    "#A16207",
    "#166534",
    "#0F766E",
    "#155E75",
    "#1E40AF",
    "#1D4ED8",
    "#4338CA",
    "#3730A3",
    "#6D28D9",
    "#7E22CE",
  ];
  return colors[hash % colors.length];
}
