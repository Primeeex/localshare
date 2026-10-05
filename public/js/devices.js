/**
 * Device list rendering.
 * Spec 6.18 ("Your own device is marked with '(you)'"), spec 24.4.
 * @module devices
 */

import { escapeHtml, formatRelativeTime } from "./util.js";
import { icon } from "./icons.js";

/**
 * Render one device row.
 *
 * @param {Object} device `{id, name, color, deviceType, joinedAt}`.
 * @param {Object} [actions]
 * @param {boolean} [actions.isSelf] Marks this device as the local one.
 * @param {(name: string) => void} [actions.onRename] Commits a new device name.
 * @param {string|Date} [actions.joinedAt] Override for the join timestamp
 *   (the header dropdown passes the raw value). Defaults to `device.joinedAt`.
 * @param {(value: string|Date) => string} [actions.formatRelative]
 *   Override for the relative-time formatter. Defaults to
 *   `formatRelativeTime`, which is backed by `Intl.RelativeTimeFormat`.
 * @returns {HTMLElement}
 */
export function renderDeviceRow(device, actions = {}) {
  const el = document.createElement("div");
  el.className = "device-row";
  el.setAttribute("role", "listitem");
  el.dataset.deviceId = device.id;

  const name = device.name || "Unknown";
  const initials = name.slice(0, 2);
  const colorIndex = device.color ? avatarColors.indexOf(device.color) : hashIndex(device.id);
  const avatarClass = `device-avatar device-avatar--${colorIndex >= 0 ? colorIndex : 0}`;

  const joinedAt = actions.joinedAt ?? device.joinedAt;
  const relative = (actions.formatRelative || formatRelativeTime)(joinedAt);

  el.innerHTML = `
    <div class="${avatarClass}" aria-hidden="true">${escapeHtml(initials)}</div>
    <div class="device-info">
      <div class="device-name">
        <span class="device-name-text">${escapeHtml(name)}</span>
        ${actions.isSelf ? '<span class="device-you">(you)</span>' : ""}
      </div>
      <div class="device-meta">${escapeHtml(device.deviceType || "desktop")} &middot; connected ${escapeHtml(relative)}</div>
    </div>
    ${
      actions.isSelf
        ? `<button type="button" class="btn btn-ghost btn-sm" data-rename aria-label="Rename this device">Rename</button>`
        : `<code class="device-meta">${escapeHtml(device.id)}</code>`
    }
  `;

  const renameBtn = el.querySelector("[data-rename]");
  if (renameBtn) {
    renameBtn.addEventListener("click", () => {
      const span = el.querySelector(".device-name-text");
      const input = document.createElement("input");
      input.type = "text";
      input.className = "device-name-input";
      // A bare input has no accessible name; label it explicitly.
      input.setAttribute("aria-label", "Device name");
      input.value = device.name || "";
      input.maxLength = 32;
      input.autocomplete = "off";
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
          restored.textContent = name;
          input.replaceWith(restored);
        }
      };
      input.addEventListener("blur", commit);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          input.blur();
        }
        if (e.key === "Escape") {
          input.value = device.name || "";
          input.blur();
        }
      });
    });
  }

  return el;
}

/**
 * Render the stacked header avatars: up to 5, then a "+N" chip.
 *
 * DOM contract consumed by `app.js` / `index.html`: children are
 * `.device-avatar` divs written into the given container.
 * @param {HTMLElement|null} container `#device-avatars`
 * @param {Array<Object>} devices
 */
export function renderDeviceAvatars(container, devices) {
  if (!container) return;
  container.innerHTML = "";
  const visible = devices.slice(0, 5);
  for (const device of visible) {
    const el = document.createElement("div");
    const colorIndex = device.color ? avatarColors.indexOf(device.color) : hashIndex(device.id);
    el.className = `device-avatar device-avatar--${colorIndex >= 0 ? colorIndex : 0}`;
    el.title = device.name;
    el.textContent = (device.name || "?").slice(0, 2);
    container.appendChild(el);
  }
  if (devices.length > 5) {
    const more = document.createElement("div");
    more.className = "device-avatar device-avatar--more";
    more.textContent = `+${devices.length - 5}`;
    container.appendChild(more);
  }
}

// Exported for renderDeviceAvatars to use class-based palette
export function hashIndex(id = "") {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return hash % avatarColors.length;
}

export const avatarColors = [
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

/**
 * Returns an SVG string for the device type icon.
 * @param {string} type Device type (desktop, laptop, mobile, tablet, etc.)
 * @returns {string} SVG icon markup
 */
export function deviceTypeIcon(type) {
  const map = {
    desktop: "monitor",
    laptop: "monitor",
    mobile: "smartphone",
    tablet: "tablet",
    phone: "smartphone",
  };
  const iconName = map[type?.toLowerCase()] || "monitor";
  return icon(iconName, { size: 12, strokeWidth: 2 });
}
