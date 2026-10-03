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
    // WHY: enforce max connections to prevent memory exhaustion
    if (this.getClientCount(roomId) >= this.maxConnections) {
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
   * Remove a client from a room.
   * @param {string} roomId
   * @param {string} deviceId
   */
  removeClient(roomId, deviceId) {
    const roomClients = this.clients.get(roomId);
    if (!roomClients) return;
    for (const client of roomClients) {
      if (client.deviceId === deviceId) {
        roomClients.delete(client);
        try {
          client.res.end();
        } catch {
          /* connection already closed */
        }
        this.logger.debug({ roomId, deviceId }, "SSE client removed");
        break;
      }
    }
    // Clean up empty rooms
    if (roomClients.size === 0) {
      this.clients.delete(roomId);
      this._stopHeartbeat(roomId);
    }
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
        break;
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
      for (const client of roomClients) {
        try {
          client.res.write(heart);
        } catch {
          /* dead client, will be cleaned up */
        }
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
