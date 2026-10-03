/**
 * SSE client for LocalShare.
 * Handles connection, reconnection with backoff, and event dispatch.
 */

import { deviceId, deviceName } from "./api.js";

export class SSEClient {
  /**
   * @param {string} roomId
   * @param {Object} handlers - Map of event name to handler function
   */
  constructor(roomId, handlers) {
    this.roomId = roomId;
    this.handlers = handlers;
    this.source = null;
    this.retryMs = 1000;
    this.maxRetryMs = 30000;
    this.closed = false;
    this.reconnectTimer = null;
    this.lastEventId = "";
    this.listeners = { connecting: [], reconnected: [], disconnected: [] };
  }

  connect() {
    if (this.closed) return;
    this._emit("connecting");
    const params = new URLSearchParams({
      roomId: this.roomId,
      deviceId,
      deviceName: deviceName || "Unknown",
    });
    const url = `/events?${params}`;

    const source = new EventSource(url, {
      withCredentials: false,
    });
    this.source = source;

    source.onopen = () => {
      if (this.retryMs > 1000) {
        this._emit("reconnected");
      }
      this.retryMs = 1000;
    };

    source.onerror = () => {
      // EventSource reconnects automatically unless closed, but we manage
      // our own backoff so we close and reopen manually.
      source.close();
      if (this.closed) return;
      this._emit("disconnected");
      this.reconnectTimer = setTimeout(() => this.connect(), this.retryMs);
      this.retryMs = Math.min(this.retryMs * 2, this.maxRetryMs);
    };

    // Attach named event listeners from handlers
    for (const [event, handler] of Object.entries(this.handlers)) {
      if (event.startsWith("_")) continue;
      source.addEventListener(event, (e) => {
        try {
          this.lastEventId = e.lastEventId || this.lastEventId;
          const data = JSON.parse(e.data);
          handler(data);
        } catch (err) {
          console.error(`SSE handler error for "${event}":`, err);
        }
      });
    }
  }

  close() {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.source) this.source.close();
  }

  on(evt, fn) {
    if (!this.listeners[evt]) this.listeners[evt] = [];
    this.listeners[evt].push(fn);
  }

  _emit(evt, data) {
    for (const fn of this.listeners[evt] || []) {
      try {
        fn(data);
      } catch {
        /* listener errors should not break the client */
      }
    }
  }
}
