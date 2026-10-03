/**
 * Anchored popover menu.
 * Spec 13.4 (dropdown: elevated bg, border, 8px radius, 36px items, red danger)
 * and spec 6.19 ("Send to..." popover listing connected devices).
 * @module menu
 */

let active = null;

/** Whether a popover menu is currently open. */
export function menuOpen() {
  return !!active;
}

/**
 * Close the open popover.
 * @param {Object} [opts]
 * @param {boolean} [opts.restoreFocus=true] Return focus to the anchor element.
 */
export function closeMenu({ restoreFocus = true } = {}) {
  if (!active) return;
  const { el, anchor, cleanup } = active;
  active = null;
  cleanup();
  el.remove();
  if (restoreFocus && anchor && document.contains(anchor)) anchor.focus();
}

function positionMenu(el, rect) {
  const gap = 6;
  const edge = 8;
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  let left = Math.min(rect.left, window.innerWidth - w - edge);
  left = Math.max(edge, left);
  let top = rect.bottom + gap;
  if (top + h > window.innerHeight - edge) {
    top = rect.top - gap - h;
  }
  top = Math.max(edge, top);
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
}

/**
 * Open an anchored popover menu.
 * @param {Object} opts
 * @param {HTMLElement} [opts.anchor] Element the menu is anchored to.
 * @param {number} [opts.x] Pointer X (context menus, no anchor element).
 * @param {number} [opts.y] Pointer Y.
 * @param {string} [opts.label] Accessible name for the menu.
 * @param {Array<Object>} opts.items `{label, hint, avatar:{initials,color}, danger, disabled, onSelect}`
 * @returns {HTMLElement|null} The menu element.
 */
export function openMenu({ anchor = null, x = null, y = null, label = "", items = [] }) {
  closeMenu({ restoreFocus: false });
  if (!items.length) return null;

  const el = document.createElement("div");
  el.className = "menu menu-popover";
  el.setAttribute("role", "menu");
  if (label) el.setAttribute("aria-label", label);

  items.forEach((item, index) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "menu-item" + (item.danger ? " menu-item--danger" : "");
    btn.setAttribute("role", "menuitem");
    btn.tabIndex = index === 0 ? 0 : -1;
    btn.disabled = !!item.disabled;
    if (item.avatar) {
      const av = document.createElement("span");
      av.className = "menu-avatar";
      av.style.background = item.avatar.color || "var(--color-accent-strong)";
      av.textContent = item.avatar.initials || "?";
      av.setAttribute("aria-hidden", "true");
      btn.appendChild(av);
    }
    const text = document.createElement("span");
    text.textContent = item.label;
    btn.appendChild(text);
    if (item.hint) {
      const hint = document.createElement("span");
      hint.className = "menu-item-hint";
      hint.textContent = item.hint;
      btn.appendChild(hint);
    }
    btn.addEventListener("click", () => {
      closeMenu();
      item.onSelect?.();
    });
    el.appendChild(btn);
  });

  document.body.appendChild(el);

  // Popovers may open above the modal layer (spec 13.4 z: dropdown above modal)
  const z = parseInt(getComputedStyle(document.documentElement).getPropertyValue("--z-modal"), 10);
  el.style.zIndex = String((Number.isFinite(z) ? z : 210) + 10);

  const rect = anchor
    ? anchor.getBoundingClientRect()
    : { left: x, right: x, top: y, bottom: y, width: 0, height: 0 };
  positionMenu(el, rect);

  const buttons = [...el.querySelectorAll(".menu-item:not(:disabled)")];
  buttons[0]?.focus();

  const onPointerDown = (e) => {
    if (el.contains(e.target)) return;
    if (anchor && anchor.contains(e.target)) return;
    closeMenu({ restoreFocus: false });
  };
  const onKeyDown = (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      closeMenu();
      return;
    }
    if (e.key === "Tab") {
      closeMenu({ restoreFocus: false });
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const i = buttons.indexOf(document.activeElement);
      const next =
        e.key === "ArrowDown"
          ? (i + 1 + buttons.length) % buttons.length
          : (i - 1 + buttons.length) % buttons.length;
      buttons.forEach((b) => (b.tabIndex = -1));
      buttons[next].tabIndex = 0;
      buttons[next].focus();
      return;
    }
    if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      (e.key === "Home" ? buttons[0] : buttons[buttons.length - 1]).focus();
    }
  };
  const onViewportChange = () => closeMenu({ restoreFocus: false });

  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("resize", onViewportChange);
  window.addEventListener("scroll", onViewportChange, true);

  active = {
    el,
    anchor,
    cleanup: () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("resize", onViewportChange);
      window.removeEventListener("scroll", onViewportChange, true);
    },
  };
  return el;
}
