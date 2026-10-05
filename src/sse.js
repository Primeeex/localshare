/**
 * Server-Sent Events (SSE) channel management for LocalShare.
 * @module sse
 */

/**
 * SSE client representation.
 * @typedef {Object} SSEClient
 * @property {import('node:http').ServerResponse} res
 * @property {string} deviceId
 * @property {string} lastEventId
 */

const HEARTBEAT_INTERVAL_MS = 15000;
const MAX_EVENTS_BUFFER = 50;

/**
 * SSE manager for LocalShare.
 */
export class SSEManager {
  /**
   * @param {import('./logger.js').Logger} logger
   * @param {number} maxConnections
   */
  constructor(logger, maxConnections = 500) {
    this.logger = logger;
    this.maxConnections = maxConnections;
    // Map<roomId, Set<SSEClient>>
    this.clients = new Map();
    // Map<roomId, Array<{id: string, event: string, data: string}>>
    this.eventBuffers = new Map();
    this._heartbeatIntervals = new Map();
  }

  /**
   * Add a client to a room's SSE channel.
   * @param {string} roomId
   * @param {import('node:http').ServerResponse} res
   * @param {string} deviceId
   * @returns {SSEClient|null}
   */
  addClient(roomId, res, deviceId) {
    // WHY: enforce max connections to prevent memory exhaustion. The budget is
    // server-wide (PROMPT.md 6.12), not per room, otherwise every room would
    // get its own full allocation.
    if (this.getTotalClientCount() >= this.maxConnections) {
      res.writeHead(503, { "Retry-After": "30", "Content-Type": "text/plain" });
      res.end("Server at connection limit. Please retry later.");
      return null;
    }

    // Set SSE headers
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no", // WHY: disable nginx buffering for SSE
    });

    const client = { res, deviceId, lastEventId: "" };
    if (!this.clients.has(roomId)) {
      this.clients.set(roomId, new Set());
    }
    this.clients.get(roomId).add(client);

    // Start heartbeat if not already running for this room
    this._startHeartbeat(roomId);

    // WHY: replay missed events if client has a Last-Event-ID
    const lastEventId = res.req?.headers?.["last-event-id"];
    if (lastEventId) {
      this._replayEvents(roomId, client, lastEventId);
    }

    this.logger.debug({ roomId, deviceId }, "SSE client connected");
    return client;
  }

  /**
   * Remove a client's SSE connection from a room.
   *
   * WHY: a single device can briefly hold two sockets. The browser
   * `EventSource` reconnects by opening a *new* connection while the old one is
   * still tearing down, so a close handler for the dead socket can fire after
   * its replacement has already registered. Teardown therefore has to remove
   * exactly the socket that closed, never "the first socket for this device" -
   * the latter evicts the live replacement and the device then reads as gone
   * on every other screen while it is still perfectly connected.
   *
   * @param {string} roomId
   * @param {string} deviceId
   * @param {import('node:http').ServerResponse} [res] Socket that closed. When
   *   omitted, falls back to removing the device's first connection.
   * @returns {number} Number of connections removed
   */
  removeClient(roomId, deviceId, res) {
    const roomClients = this.clients.get(roomId);
    if (!roomClients) return 0;
    let removed = 0;

    if (res) {
      for (const client of roomClients) {
        if (client.res === res) {
          roomClients.delete(client);
          removed++;
          break;
        }
      }
    } else {
      for (const client of roomClients) {
        if (client.deviceId === deviceId) {
          roomClients.delete(client);
          try {
            client.res.end();
          } catch {
            /* connection already closed */
          }
          removed++;
          break;
        }
      }
    }

    if (removed > 0) {
      this.logger.debug({ roomId, deviceId }, "SSE client removed");
    }
    // Clean up empty rooms
    if (roomClients.size === 0) {
      this.clients.delete(roomId);
      this._stopHeartbeat(roomId);
    }
    return removed;
  }

  /**
   * Whether a device currently holds at least one live connection in a room.
   * Used to decide whether a disconnecting device is really gone: a reconnect
   * that has already been accepted must never be treated as a departure.
   * @param {string} roomId
   * @param {string} deviceId
   * @returns {boolean}
   */
  hasClient(roomId, deviceId) {
    const roomClients = this.clients.get(roomId);
    if (!roomClients) return false;
    for (const client of roomClients) {
      if (client.deviceId === deviceId && !this._isDead(client)) return true;
    }
    return false;
  }

  /**
   * Whether a client socket is already torn down.
   * @param {SSEClient} client
   * @returns {boolean}
   */
  _isDead(client) {
    return Boolean(client.res.writableEnded || client.res.destroyed);
  }

  /**
   * Broadcast an event to all clients in a room.
   * @param {string} roomId
   * @param {string} event
   * @param {Object} data
   */
  broadcast(roomId, event, data) {
    const roomClients = this.clients.get(roomId);
    if (!roomClients || roomClients.size === 0) return;
    const eventId = `${roomId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const payload = JSON.stringify({
      type: event,
      roomId,
      timestamp: new Date().toISOString(),
      ...data,
    });
    const formatted = `id: ${eventId}\nevent: ${event}\ndata: ${payload}\n\n`;
    // Store in buffer for replay
    this._storeEvent(roomId, eventId, event, payload);
    for (const client of roomClients) {
      try {
        client.res.write(formatted);
      } catch {
        // Client disconnected, will be cleaned up on next write
      }
    }
  }

  /**
   * Broadcast an event to a specific device in a room.
   * @param {string} roomId
   * @param {string} deviceId
   * @param {string} event
   * @param {Object} data
   */
  broadcastToDevice(roomId, deviceId, event, data) {
    const roomClients = this.clients.get(roomId);
    if (!roomClients) return;
    const eventId = `${roomId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const payload = JSON.stringify({
      type: event,
      roomId,
      timestamp: new Date().toISOString(),
      ...data,
    });
    const formatted = `id: ${eventId}\nevent: ${event}\ndata: ${payload}\n\n`;
    this._storeEvent(roomId, eventId, event, payload);
    for (const client of roomClients) {
      if (client.deviceId === deviceId) {
        try {
          client.res.write(formatted);
        } catch {
          /* connection already closed */
        }
      }
    }
  }

  /**
   * Get the number of connected clients in a room.
   * @param {string} roomId
   * @returns {number}
   */
  getClientCount(roomId) {
    return this.clients.get(roomId)?.size || 0;
  }

  /**
   * Get the number of connected clients across every room on this server.
   * @returns {number}
   */
  getTotalClientCount() {
    let total = 0;
    for (const roomClients of this.clients.values()) {
      total += roomClients.size;
    }
    return total;
  }

  /**
   * Close all SSE connections.
   */
  closeAll() {
    for (const roomClients of this.clients.values()) {
      for (const client of roomClients) {
        try {
          client.res.end();
        } catch {
          /* connection already closed */
        }
      }
    }
    this.clients.clear();
    this.eventBuffers.clear();
    for (const id of this._heartbeatIntervals.keys()) {
      clearInterval(this._heartbeatIntervals.get(id));
    }
    this._heartbeatIntervals.clear();
  }

  // --- Private ---

  _storeEvent(roomId, eventId, event, data) {
    if (!this.eventBuffers.has(roomId)) {
      this.eventBuffers.set(roomId, []);
    }
    const buffer = this.eventBuffers.get(roomId);
    buffer.push({ id: eventId, event, data });
    // WHY: cap buffer to prevent unbounded memory growth
    if (buffer.length > MAX_EVENTS_BUFFER) {
      buffer.splice(0, buffer.length - MAX_EVENTS_BUFFER);
    }
  }

  _replayEvents(roomId, client, lastEventId) {
    const buffer = this.eventBuffers.get(roomId) || [];
    let started = false;
    for (const entry of buffer) {
      if (entry.id === lastEventId) {
        started = true;
        continue;
      }
      if (started) {
        try {
          client.res.write(`id: ${entry.id}\nevent: ${entry.event}\ndata: ${entry.data}\n\n`);
        } catch {
          /* connection already closed */
        }
      }
    }
  }

  _startHeartbeat(roomId) {
    if (this._heartbeatIntervals.has(roomId)) return;
    const interval = setInterval(() => {
      const roomClients = this.clients.get(roomId);
      if (!roomClients || roomClients.size === 0) {
        clearInterval(interval);
        this._heartbeatIntervals.delete(roomId);
        return;
      }
      const heart = `: ping\n\n`;
      for (const client of [...roomClients]) {
        // WHY: a socket can die without ever emitting 'close' (an aborted
        // mobile connection, a killed proxy socket). Reaping it here keeps a
        // dead device from lingering in every room's device list forever.
        if (this._isDead(client)) {
          roomClients.delete(client);
          this.logger.debug({ roomId, deviceId: client.deviceId }, "SSE zombie client reaped");
          continue;
        }
        try {
          client.res.write(heart);
        } catch {
          /* dead client, will be cleaned up */
        }
      }
      if (roomClients.size === 0) {
        clearInterval(interval);
        this._heartbeatIntervals.delete(roomId);
        this.clients.delete(roomId);
      }
    }, HEARTBEAT_INTERVAL_MS);
    this._heartbeatIntervals.set(roomId, interval);
  }

  _stopHeartbeat(roomId) {
    const interval = this._heartbeatIntervals.get(roomId);
    if (interval) {
      clearInterval(interval);
      this._heartbeatIntervals.delete(roomId);
    }
  }
}
