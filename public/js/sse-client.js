/**
 * SSE client for LocalShare.
 * Handles connection, reconnection with backoff, and event dispatch.
 */

import { deviceId, deviceName, getRoomPin } from "./api.js";

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
    this.firstConnect = true;
    this.listeners = { connecting: [], reconnected: [], disconnected: [] };
  }

  connect() {
    if (this.closed) return;
    // Spec 13.7: the yellow banner is for RE-connecting. The very first
    // attempt is silent so a healthy page load never flashes "Reconnecting...".
    if (!this.firstConnect) this._emit("connecting");
    this.firstConnect = false;
    const params = new URLSearchParams({
      roomId: this.roomId,
      deviceId,
      deviceName: deviceName || "Unknown",
    });
    // WHY the query param: EventSource cannot set request headers, and the
    // server accepts `?roomPin=` as the fallback channel for exactly this
    // reason. Without it a PIN room's stream 401s, `onerror` fires, and the
    // backoff loop below reconnects forever - the "connection lost" hang.
    const roomPin = getRoomPin(this.roomId);
    if (roomPin) params.set("roomPin", roomPin);
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

    source.onerror = async () => {
      // EventSource reconnects automatically unless closed, but we manage
      // our own backoff so we close and reopen manually.
      source.close();
      if (this.closed) return;

      // WHY the probe: EventSource exposes no status code, so a 401 (wrong or
      // missing room PIN) is indistinguishable from a network drop. Retrying it
      // on the backoff loop is what produced "Connection lost" that never
      // recovers - every attempt was guaranteed to fail again. A same-origin
      // HEAD tells us which case we are in before we schedule a retry.
      const failure = await this._classifyFailure();
      if (failure === "locked") {
        // Do NOT schedule a retry: the retry cannot succeed until the user
        // supplies a PIN, and switchRoom() opens a fresh stream afterwards.
        this._emit("locked", { roomId: this.roomId });
        return;
      }
      if (failure === "notfound") {
        // Equally un-retryable: no amount of waiting makes the room exist.
        // Stop the loop and let the app show "Room not found" and fall back.
        this._emit("notfound", { roomId: this.roomId });
        return;
      }

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

  /**
   * Ask the server whether the stream was refused because of a room PIN.
   *
   * Uses a same-origin fetch with an AbortController so the long-lived stream
   * never actually opens here. A network failure is treated as "not denied" so
   * a flaky LAN still gets its normal reconnect behaviour.
   * @returns {Promise<boolean>}
   */
  /**
   * Classify a failed stream.
   *
   * WHY more than a boolean: `EventSource` exposes no status code, so a 401
   * (wrong/missing room PIN) is indistinguishable from a network drop -- which
   * is what produced "Connection lost" that never recovers, because every
   * retry was guaranteed to fail again. A same-origin HEAD resolves it.
   *
   * A 404 matters for the same reason: /events no longer auto-creates unknown
   * rooms (an unauthenticated GET must not be a room-creation primitive), so
   * joining a room that was never created now fails permanently. Without this
   * the client would retry that 404 on the backoff loop until the page died.
   *
   * @returns {Promise<"locked"|"notfound"|"network">}
   */
  async _classifyFailure() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      const params = new URLSearchParams({
        roomId: this.roomId,
        deviceId,
        deviceName: deviceName || "Unknown",
        probe: "1",
      });
      const roomPin = getRoomPin(this.roomId);
      if (roomPin) params.set("roomPin", roomPin);
      const res = await fetch(`/events?${params}`, {
        method: "HEAD",
        signal: controller.signal,
        cache: "no-store",
      });
      if (res.status === 401) return "locked";
      if (res.status === 404) return "notfound";
      return "network";
    } catch {
      // Aborted, offline, or CORS: not an auth problem, so keep reconnecting.
      return "network";
    } finally {
      clearTimeout(timer);
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
