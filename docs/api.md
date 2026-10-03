# LocalShare API Reference

Complete reference for the LocalShare REST API and the Server-Sent Events (SSE) stream. Every endpoint and event described here was verified against the implementation in `src/routes/`, `src/sse.js`, and `src/middleware/`.

## Contents

- [Conventions](#conventions)
- [Authentication](#authentication)
- [Rate limiting](#rate-limiting)
- [Server](#server)
- [Auth](#auth)
- [Rooms](#rooms)
- [Files](#files)
- [Text](#text)
- [Clipboard](#clipboard)
- [Devices](#devices)
- [Transfers](#transfers)
- [Events (SSE)](#events-sse)
- [Error codes](#error-codes)

## Conventions

- **Base URL**: `http://<host>:<port>`, for example `http://localhost:3000`. All REST endpoints are prefixed with `/api`.
- **Content type**: request bodies are `application/json` with a 100 KB limit; uploads use `multipart/form-data`. Successful responses are JSON unless the endpoint streams a file.
- **Timestamps**: every timestamp is an ISO 8601 UTC string, for example `2026-10-03T20:41:47.300Z`.
- **Empty responses**: `204 No Content` returns no body.
- **Identity headers** (optional, used for attribution):

  | Header          | Purpose                                                                                                                                                                                                                                         |
  | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `X-Device-Id`   | Stable id of the calling device. Used as `sharedBy` on text and clipboard entries, as `sourceDeviceId` when creating a transfer, as the credential for transfer downloads, and as the SSE device id when no `deviceId` query parameter is sent. |
  | `X-Device-Name` | Display name. Used as `uploadedBy` on file uploads, `sharedByName` on text and clipboard entries, and `sourceDeviceName` on transfers.                                                                                                          |

  The SSE endpoint accepts the same values as query parameters (`deviceId`, `deviceName`) because `EventSource` cannot send custom headers.

- **Error envelope**: every error is JSON of this exact shape:

  ```json
  {
    "error": {
      "code": "ROOM_NOT_FOUND",
      "message": "Room not found: demo",
      "requestId": "d106402e-2e80-4122-a0d8-2eebfc80446f",
      "timestamp": "2026-10-03T20:41:48.346Z"
    }
  }
  ```

  `requestId` matches the `X-Request-Id` response header and the request id in the server log. Additional diagnostic fields (for example `retriesLeft`) are merged into the `error` object. When `logLevel` is `debug` or `trace`, the response also contains `error.stack`.

- **Unknown paths**: a request to an unknown `/api/...` or `/events` path returns `404` with `code: "NOT_FOUND"`; other unknown non-GET requests do the same.

## Authentication

When the server runs with a PIN (`--pin`, `LOCALSHARE_PIN`, or `pin` in the config file):

1. `POST /api/auth/verify` with the PIN sets an HMAC-signed session cookie named `localshare_session` (`HttpOnly`, `SameSite=Strict`, `Path=/`).
2. Every other endpoint requires that cookie.
3. Requests without a valid cookie return `401` with `code: "AUTH_REQUIRED"`.

Public paths (no cookie needed): `GET /`, `GET /favicon.ico`, `POST /api/auth/verify`, `GET /api/auth/status`, `GET /api/server/health`, and static assets under `/css/`, `/js/`, `/vendor/`, `/assets/`.

Without a PIN configured, no cookie is required and `GET /api/auth/status` reports `pinRequired: false`.

## Rate limiting

Rate limits are applied per client IP. Responses carry `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset` headers; a rejected request adds `Retry-After` (seconds) and returns `429` with `code: "RATE_LIMITED"`.

| Scope                                        | Limit                       |
| -------------------------------------------- | --------------------------- |
| All `/api` requests                          | 100 requests per 15 minutes |
| `POST /api/auth/verify`                      | 5 requests per minute       |
| Any request under `/api/rooms/:roomId/files` | 10 requests per minute      |

## Server

### `GET /api/server/info`

Server and network summary.

**Success `200`**

```json
{
  "hostname": "workstation",
  "port": 3000,
  "interfaces": [
    { "name": "wlan0", "address": "192.168.1.42", "url": "http://192.168.1.42:3000?room=default" }
  ],
  "version": "1.0.0",
  "uptime": 128,
  "roomCount": 1,
  "totalFiles": 3,
  "totalSize": 1048576
}
```

`uptime` is whole seconds, `totalSize` is bytes. Errors: `AUTH_REQUIRED` `401`.

### `GET /api/server/health`

Liveness probe, always public.

**Success `200`**

```json
{ "status": "ok", "uptime": 128 }
```

### `GET /api/server/qr`

Render a QR code as SVG.

| Query | Type   | Description                                                                                 |
| ----- | ------ | ------------------------------------------------------------------------------------------- |
| `url` | string | Required. The URL to encode, up to 500 characters. Must start with `http://` or `https://`. |

**Success `200`**: `Content-Type: image/svg+xml`, `Cache-Control: public, max-age=300`, SVG body.

**Errors**: `INVALID_BODY` `400` (missing `url`, longer than 500 characters, or a non-http(s) scheme), `AUTH_REQUIRED` `401`.

## Auth

### `POST /api/auth/verify`

Exchange the PIN for a session cookie.

**Body**

```json
{ "pin": "1234" }
```

**Success `200`**

```json
{ "success": true }
```

Sets `Set-Cookie: localshare_session=...`.

**Errors**

| Code           | Status | When                                                                                     |
| -------------- | ------ | ---------------------------------------------------------------------------------------- |
| `INVALID_BODY` | 400    | `pin` missing or not a string                                                            |
| `AUTH_INVALID` | 401    | Wrong PIN. Adds `retriesLeft`                                                            |
| `AUTH_LOCKED`  | 429    | Lockout after repeated failures. Adds `retriesLeft`, `lockoutDuration` (ms), `permanent` |
| `RATE_LIMITED` | 429    | More than 5 attempts in a minute                                                         |

Failed attempts lock the client IP for 30 seconds after the third failure, then 5 minutes, then permanently until the server restarts. A successful verify clears the counter.

### `POST /api/auth/logout`

Clear the session cookie.

**Success `200`**: `{ "success": true }`

### `GET /api/auth/status`

Check whether a session is active and whether a PIN is configured.

**Success `200`**

```json
{ "authenticated": false, "pinRequired": true }
```

## Rooms

Room ids match `^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$`. The room `default` always exists and cannot be deleted. Custom rooms with no devices and no files are auto-deleted after 30 minutes of inactivity.

### `GET /api/rooms`

**Success `200`**

```json
[
  {
    "id": "default",
    "name": "Default Room",
    "fileCount": 0,
    "deviceCount": 0,
    "createdAt": "2026-10-03T20:35:36.525Z"
  }
]
```

### `POST /api/rooms`

**Body**

```json
{ "id": "team", "name": "Team room", "pin": "4321" }
```

All fields are optional. `id` is generated when omitted, `name` defaults to the id, `pin` is stored hashed.

**Success `201`**

```json
{
  "id": "team",
  "name": "Team room",
  "pin": "3f1a9c8e5b2d7f04:8c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f60718293",
  "createdAt": "2026-10-03T20:41:47.300Z",
  "lastActivityAt": "2026-10-03T20:41:47.300Z",
  "files": {}
}
```

`pin` comes back as `"<salt hex>:<scrypt hash hex>"` when one was supplied, `null` otherwise. `files` serializes as an empty object; file state is served by the files endpoints.

**Errors**: `ROOM_LIMIT_REACHED` `409` (maxRooms reached), `ROOM_EXISTS` `409` (duplicate id), `INVALID_BODY` `400` (invalid id format), `AUTH_REQUIRED` `401`.

### `GET /api/rooms/:roomId`

**Success `200`**: the room object plus the current device list.

```json
{
  "id": "default",
  "name": "Default Room",
  "pin": null,
  "createdAt": "2026-10-03T20:35:36.525Z",
  "lastActivityAt": "2026-10-03T20:41:47.300Z",
  "files": {},
  "deviceCount": 1,
  "devices": [
    {
      "id": "laptop",
      "name": "QuickOtter",
      "joinedAt": "2026-10-03T20:41:45.120Z",
      "lastSeenAt": "2026-10-03T20:41:47.300Z",
      "userAgent": "Mozilla/5.0 ...",
      "deviceType": "desktop",
      "deviceIcon": "laptop",
      "color": "#3B82F6"
    }
  ]
}
```

**Errors**: `ROOM_NOT_FOUND` `404`.

### `PATCH /api/rooms/:roomId`

**Body**: `{ "name": "New name", "pin": "4321" }` (both optional). A supplied `pin` replaces the room PIN and is stored as a salted scrypt hash; an empty or null `pin` value is ignored, so a room PIN cannot be removed through this endpoint.

**Success `200`**: the updated room object. Broadcasts `room:updated`.

**Errors**: `ROOM_NOT_FOUND` `404`.

### `DELETE /api/rooms/:roomId`

**Success `204`**: empty body.

**Errors**: `ROOM_NOT_FOUND` `404`, `CANNOT_DELETE_DEFAULT` `400` (for the `default` room).

## Files

File metadata object used by every files response:

```json
{
  "id": "a7f5e39c-8",
  "roomId": "default",
  "originalName": "report.pdf",
  "storedName": "a7f5e39c-8-report.pdf",
  "mimeType": "application/pdf",
  "size": 1048576,
  "uploadedAt": "2026-10-03T20:41:47.300Z",
  "uploadedBy": "Laptop",
  "expiresAt": "2026-10-04T20:41:47.300Z",
  "note": null,
  "downloadCount": 0,
  "pinned": false
}
```

`expiresAt` is `null` when `expiry` is `never`. Pinned files are skipped by the cleanup sweep.

### `GET /api/rooms/:roomId/files`

**Success `200`**: array of metadata objects (empty array for an unknown or empty room).

### `POST /api/rooms/:roomId/files`

Multipart upload. Field name is `files[]`, up to 10 files per request.

```bash
curl -X POST http://localhost:3000/api/rooms/default/files \
  -H 'X-Device-Name: Laptop' \
  -F 'files[]=@report.pdf'
```

**Success `201`**: a single metadata object when one file was sent, otherwise an array of metadata objects. Broadcasts `file:added` per file.

**Errors**

| Code             | Status | When                                                     |
| ---------------- | ------ | -------------------------------------------------------- |
| `ROOM_NOT_FOUND` | 404    | Unknown room                                             |
| `INVALID_BODY`   | 400    | No `files[]` field, or more than 10 files in one request |
| `ROOM_FULL`      | 409    | Room already holds `maxFilesPerRoom` files               |
| `STORAGE_FULL`   | 507    | Upload would exceed `maxStorage`, or the disk is full    |
| `FILE_TOO_LARGE` | 413    | File larger than `maxFileSize`                           |
| `RATE_LIMITED`   | 429    | More than 10 requests per minute against this route      |
| `AUTH_REQUIRED`  | 401    | Missing or invalid session cookie                        |

### `GET /api/rooms/:roomId/files/:fileId`

**Success `200`**: metadata object. **Errors**: `FILE_NOT_FOUND` `404`.

### `PATCH /api/rooms/:roomId/files/:fileId`

**Body** (all fields optional):

```json
{ "note": "Signed copy", "pinned": true, "expiresAt": "2026-12-01T00:00:00.000Z" }
```

**Success `200`**: updated metadata object. Broadcasts `file:updated`.

**Errors**: `FILE_NOT_FOUND` `404` (unknown file or unknown room). Fields are written through, so send `expiresAt` as an ISO 8601 string or `null`.

### `DELETE /api/rooms/:roomId/files/:fileId`

**Success `204`**: empty body. Broadcasts `file:deleted`.

**Errors**: `FILE_NOT_FOUND` `404`.

### `GET /api/rooms/:roomId/files/:fileId/download`

Download with `Content-Disposition: attachment`. Increments `downloadCount`.

```bash
curl -OJ http://localhost:3000/api/rooms/default/files/a7f5e39c-8/download
```

Supports resumable transfers: send `Range: bytes=0-1023` and the response is `206 Partial Content` with `Content-Range: bytes 0-1023/<size>`, `Accept-Ranges: bytes`, and a 1 MB chunk window.

**Errors**: `FILE_NOT_FOUND` `404`.

### `GET /api/rooms/:roomId/files/:fileId/preview`

Same bytes as download, but `Content-Disposition: inline` so browsers render images, PDF, video, and audio in place.

**Errors**: `FILE_NOT_FOUND` `404`.

### `GET /api/rooms/:roomId/files/zip`

Stream every file in the room as one ZIP archive.

**Success `200`**: `Content-Type: application/zip`, `Content-Disposition: attachment; filename="localshare-<roomId>-<date>.zip"`. Duplicate names are suffixed (`-1`, `-2`, ...). An empty room still returns a valid empty ZIP.

**Errors**: `STORAGE_FULL` `413` when the room exceeds 4 GB (the response also carries `X-Warning: Too large to ZIP. Download files individually.`).

## Text

Text entries are held in memory per room. The cap is 50 entries and 100000 characters per entry; creating an entry at the cap evicts the oldest unpinned entry and broadcasts `text:deleted`.

### `GET /api/rooms/:roomId/text`

**Success `200`**: array of entries.

```json
[
  {
    "id": "b1f2c3d4",
    "roomId": "default",
    "content": "Standup notes",
    "label": "notes",
    "sharedAt": "2026-10-03T20:41:47.300Z",
    "sharedBy": "laptop",
    "sharedByName": "Laptop",
    "expiresAt": "2026-10-04T20:41:47.300Z",
    "pinned": false,
    "size": 13
  }
]
```

### `POST /api/rooms/:roomId/text`

**Body**: `{ "content": "Standup notes", "label": "notes" }` (`label` optional).

**Success `201`**: the created entry. Broadcasts `text:added`.

**Errors**: `INVALID_BODY` `400` (missing `content`), `TEXT_TOO_LONG` `400` (over 100000 characters), `ROOM_NOT_FOUND` `404`.

### `PATCH /api/rooms/:roomId/text/:id`

**Body**: `{ "content": "...", "label": "..." }` (both optional). Adds `updatedAt`.

**Success `200`**: the updated entry. Broadcasts `text:updated`.

**Errors**: `TEXT_NOT_FOUND` `404`, `TEXT_TOO_LONG` `400`.

### `DELETE /api/rooms/:roomId/text/:id`

**Success `204`**: empty body. Broadcasts `text:deleted`.

**Errors**: `TEXT_NOT_FOUND` `404`.

## Clipboard

Clipboard entries live for 30 minutes, up to 10 per room (the oldest is dropped first), with a 5000 character limit per entry.

### `GET /api/rooms/:roomId/clipboard`

**Success `200`**: array of entries.

```json
[
  {
    "id": "e5f6a7b8",
    "roomId": "default",
    "content": "https://example.com/ticket/42",
    "type": "text",
    "label": null,
    "sharedAt": "2026-10-03T20:41:47.300Z",
    "sharedBy": "laptop",
    "sharedByName": "Laptop",
    "expiresAt": "2026-10-03T21:11:47.300Z",
    "size": 29
  }
]
```

### `POST /api/rooms/:roomId/clipboard`

**Body**: `{ "content": "...", "type": "text", "label": "link" }` (`type` and `label` optional).

**Success `201`**: the created entry. Broadcasts `clipboard:updated`.

**Errors**: `INVALID_BODY` `400` (missing `content`, or longer than 5000 characters), `ROOM_NOT_FOUND` `404`.

### `DELETE /api/rooms/:roomId/clipboard/:id`

**Success `204`**: empty body. Broadcasts `clipboard:deleted`.

**Errors**: `CLIPBOARD_NOT_FOUND` `404`.

## Devices

### `GET /api/rooms/:roomId/devices`

**Success `200`**: array of device objects (shape shown in [`GET /api/rooms/:roomId`](#get-apiroomsroomid)).

### `PATCH /api/rooms/:roomId/devices/:deviceId`

**Body**: `{ "name": "Kitchen tablet" }`

**Success `200`**: the renamed device. Broadcasts `device:joined` with the updated device so every client refreshes the presence list.

**Errors**: `DEVICE_NOT_FOUND` `404` (device not currently connected), `INVALID_BODY` `400` (missing `name`).

## Transfers

Send-to-device pushes a file that already exists in the room to one connected peer. A transfer stays pending for 60 seconds; declining or expiring deletes the source file.

Transfer object:

```json
{
  "id": "195ade8f-a",
  "roomId": "default",
  "fileId": "a7f5e39c-8",
  "sourceDeviceId": "sender1",
  "sourceDeviceName": "SenderOne",
  "targetDeviceId": "target1",
  "createdAt": "2026-10-03T20:42:38.882Z",
  "expiresAt": "2026-10-03T20:43:38.882Z",
  "status": "pending"
}
```

`status` is one of `pending`, `accepted`, `declined`, `expired`, `downloaded`.

### `POST /api/rooms/:roomId/transfers`

**Body**: `{ "fileId": "a7f5e39c-8", "targetDeviceId": "target1" }`

**Success `201`**: the pending transfer. The target device receives `transfer:incoming`.

**Errors**: `INVALID_BODY` `400` (missing `fileId` or `targetDeviceId`), `FILE_NOT_FOUND` `404`, `DEVICE_NOT_FOUND` `404` (target not connected), `ROOM_NOT_FOUND` `404`.

### `PATCH /api/rooms/:roomId/transfers/:transferId`

**Body**: `{ "action": "accept" }` or `{ "action": "decline" }`

**Success `200`**: the transfer with `status` set to `accepted` or `declined` and a `handledAt` timestamp. The source device receives `transfer:accepted` or `transfer:declined`.

**Errors**: `INVALID_BODY` `400` (any other action), `TRANSFER_NOT_FOUND` `404`, `TRANSFER_EXPIRED` `410` (already handled or past the 60 second TTL).

### `GET /api/rooms/:roomId/transfers/:transferId/download`

Single use. Requires `X-Device-Id` to equal the transfer's `targetDeviceId`.

```bash
curl -H 'X-Device-Id: target1' \
  -o report.pdf \
  http://localhost:3000/api/rooms/default/transfers/195ade8f-a/download
```

**Success `200`**: file bytes with `Content-Disposition: attachment`. The transfer becomes `downloaded`, so a second attempt fails.

**Errors**: `TRANSFER_NOT_FOUND` `404`, `TRANSFER_EXPIRED` `410` (not accepted, declined, expired, or already downloaded), `FORBIDDEN` `403` (`X-Device-Id` does not match the target).

## Events (SSE)

### `GET /events`

```
GET /events?roomId=default&deviceId=laptop&deviceName=Laptop
```

| Query        | Type   | Description                                                                                                      |
| ------------ | ------ | ---------------------------------------------------------------------------------------------------------------- |
| `roomId`     | string | Room to join. Defaults to `default`; the room is created when it does not exist yet.                             |
| `deviceId`   | string | Device id used for presence and targeted events. Falls back to the `X-Device-Id` header, then to a generated id. |
| `deviceName` | string | Display name. Falls back to the `X-Device-Name` header, then to a generated name such as `QuickOtter`.           |

Response headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`, `X-Accel-Buffering: no`.

At the connection limit (`maxConnections` per room) the endpoint answers `503` with `Retry-After: 30` and a plain-text body instead of a stream. With a PIN configured, `/events` requires the session cookie.

```js
const source = new EventSource(
  "http://localhost:3000/events?roomId=default&deviceId=laptop&deviceName=Laptop"
);
source.addEventListener("file:added", (event) => {
  const data = JSON.parse(event.data);
  console.log("new file", data.file.originalName);
});
```

### Frame format

Every event frame carries an `id`, a named `event`, and a JSON `data` payload:

```
id: default-1791060156880-3u3b
event: file:added
data: {"type":"file:added","roomId":"default","timestamp":"2026-10-03T20:41:47.300Z","file":{...},"by":"Laptop"}

```

`data` always contains `type`, `roomId`, and `timestamp`, plus the fields listed below.

### Heartbeat

A comment frame `: ping` is sent every 15 seconds to keep proxies and browsers from timing the connection out. Comments are ignored by `EventSource`.

### Replay (`Last-Event-ID`)

Each room buffers its last 50 events. When a client reconnects with a `Last-Event-ID` header (browsers send this automatically after a dropped connection) the server replays every buffered event that came after that id, then continues live. Ids not found in the buffer produce no replay.

### Event types

#### `connected`

Sent only to the device that just joined, after `device:joined`.

```json
{
  "type": "connected",
  "roomId": "default",
  "timestamp": "2026-10-03T20:41:47.300Z",
  "serverInfo": { "version": "1.0.0", "hostname": "workstation" },
  "room": { "id": "default", "name": "Default Room" },
  "files": [],
  "textEntries": [],
  "clipboardEntries": [],
  "devices": [
    {
      "id": "laptop",
      "name": "QuickOtter",
      "joinedAt": "2026-10-03T20:41:45.120Z",
      "lastSeenAt": "2026-10-03T20:41:47.300Z",
      "userAgent": "Mozilla/5.0 ...",
      "deviceType": "desktop",
      "deviceIcon": "laptop",
      "color": "#3B82F6"
    }
  ]
}
```

`files`, `textEntries`, and `clipboardEntries` are the full stored objects at connect time; `devices` already contains the joining device.

#### `device:joined`

```json
{
  "type": "device:joined",
  "roomId": "default",
  "timestamp": "2026-10-03T20:41:47.300Z",
  "device": {
    "id": "laptop",
    "name": "QuickOtter",
    "joinedAt": "2026-10-03T20:41:45.120Z",
    "lastSeenAt": "2026-10-03T20:41:47.300Z",
    "userAgent": "Mozilla/5.0 ...",
    "deviceType": "desktop",
    "deviceIcon": "laptop",
    "color": "#3B82F6"
  }
}
```

Also emitted when a device is renamed.

#### `device:left`

```json
{
  "type": "device:left",
  "roomId": "default",
  "timestamp": "2026-10-03T20:42:10.000Z",
  "deviceId": "laptop"
}
```

Broadcast after the 5 second reconnect grace period, and only when the device had been present for more than 30 seconds.

#### `file:added`

```json
{
  "type": "file:added",
  "roomId": "default",
  "timestamp": "2026-10-03T20:41:47.300Z",
  "file": { "id": "a7f5e39c-8", "originalName": "report.pdf", "size": 1048576 },
  "by": "Laptop"
}
```

`file` holds the full metadata object; it is abbreviated here.

#### `file:updated`

```json
{
  "type": "file:updated",
  "roomId": "default",
  "timestamp": "2026-10-03T20:42:00.000Z",
  "file": {
    "id": "a7f5e39c-8",
    "originalName": "report.pdf",
    "pinned": true,
    "note": "Signed copy",
    "expiresAt": "2026-12-01T00:00:00.000Z"
  }
}
```

`file` holds the complete metadata object after the update.

#### `file:deleted`

```json
{
  "type": "file:deleted",
  "roomId": "default",
  "timestamp": "2026-10-03T20:42:05.000Z",
  "fileId": "a7f5e39c-8"
}
```

Also emitted by the cleanup sweep for expired files.

#### `text:added`

```json
{
  "type": "text:added",
  "roomId": "default",
  "timestamp": "2026-10-03T20:41:59.941Z",
  "entry": {
    "id": "b1f2c3d4",
    "roomId": "default",
    "content": "Standup notes",
    "label": "notes",
    "sharedAt": "2026-10-03T20:41:59.941Z",
    "sharedBy": "laptop",
    "sharedByName": "Laptop",
    "expiresAt": "2026-10-04T20:41:59.941Z",
    "pinned": false,
    "size": 13
  }
}
```

#### `text:updated`

```json
{
  "type": "text:updated",
  "roomId": "default",
  "timestamp": "2026-10-03T20:42:01.000Z",
  "entry": { "id": "b1f2c3d4", "content": "Updated notes", "updatedAt": "2026-10-03T20:42:01.000Z" }
}
```

#### `text:deleted`

```json
{
  "type": "text:deleted",
  "roomId": "default",
  "timestamp": "2026-10-03T20:42:02.000Z",
  "entryId": "b1f2c3d4"
}
```

#### `clipboard:updated`

Emitted when a clipboard entry is created or refreshed.

```json
{
  "type": "clipboard:updated",
  "roomId": "default",
  "timestamp": "2026-10-03T20:41:47.300Z",
  "entry": {
    "id": "e5f6a7b8",
    "roomId": "default",
    "content": "https://example.com/ticket/42",
    "type": "text",
    "label": null,
    "sharedAt": "2026-10-03T20:41:47.300Z",
    "sharedBy": "laptop",
    "sharedByName": "Laptop",
    "expiresAt": "2026-10-03T21:11:47.300Z",
    "size": 29
  }
}
```

#### `clipboard:deleted`

```json
{
  "type": "clipboard:deleted",
  "roomId": "default",
  "timestamp": "2026-10-03T20:42:03.000Z",
  "entryId": "e5f6a7b8"
}
```

#### `transfer:incoming`

Targeted: only the `targetDeviceId` receives it.

```json
{
  "type": "transfer:incoming",
  "roomId": "default",
  "timestamp": "2026-10-03T20:42:38.882Z",
  "transfer": {
    "id": "195ade8f-a",
    "roomId": "default",
    "fileId": "a7f5e39c-8",
    "sourceDeviceId": "sender1",
    "sourceDeviceName": "SenderOne",
    "targetDeviceId": "target1",
    "createdAt": "2026-10-03T20:42:38.882Z",
    "expiresAt": "2026-10-03T20:43:38.882Z",
    "status": "pending"
  }
}
```

#### `transfer:accepted`

Targeted: only the `sourceDeviceId` receives it.

```json
{
  "type": "transfer:accepted",
  "roomId": "default",
  "timestamp": "2026-10-03T20:42:39.906Z",
  "transferId": "195ade8f-a"
}
```

#### `transfer:declined`

```json
{
  "type": "transfer:declined",
  "roomId": "default",
  "timestamp": "2026-10-03T20:42:41.000Z",
  "transferId": "195ade8f-a"
}
```

Sent to the source device. The source file is deleted as well.

#### `transfer:expired`

```json
{
  "type": "transfer:expired",
  "roomId": "default",
  "timestamp": "2026-10-03T20:43:38.882Z",
  "transferId": "195ade8f-a"
}
```

Sent to the source device when the 60 second TTL passes with no answer; the source file is deleted.

#### `room:updated`

```json
{
  "type": "room:updated",
  "roomId": "team",
  "timestamp": "2026-10-03T20:42:50.000Z",
  "room": { "id": "team", "name": "Team room" }
}
```

#### `server:shutdown`

Broadcast to every room when the process receives `SIGINT` or `SIGTERM`.

```json
{
  "type": "server:shutdown",
  "roomId": "default",
  "timestamp": "2026-10-03T20:44:00.000Z",
  "message": "Server is shutting down in 5 seconds...",
  "countdown": 5
}
```

## Error codes

| Code                    | HTTP status | When                                                                                                                                                            |
| ----------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AUTH_REQUIRED`         | 401         | PIN protection is on and the request has no valid `localshare_session` cookie                                                                                   |
| `AUTH_INVALID`          | 401         | Wrong PIN. Response adds `retriesLeft`                                                                                                                          |
| `AUTH_LOCKED`           | 429         | Repeated failed PIN attempts. Response adds `retriesLeft`, `lockoutDuration`, `permanent`                                                                       |
| `INVALID_BODY`          | 400         | Missing or malformed JSON body, missing required field, invalid room id, more than 10 files in one upload. Returns 413 when the JSON body itself exceeds 100 KB |
| `TEXT_TOO_LONG`         | 400         | Text entry longer than 100000 characters                                                                                                                        |
| `CANNOT_DELETE_DEFAULT` | 400         | Attempt to delete the `default` room                                                                                                                            |
| `INVALID_ID`            | 400         | Storage layer rejected the room id                                                                                                                              |
| `FORBIDDEN`             | 403         | Transfer download requested by a device that is not the target                                                                                                  |
| `ROOM_NOT_FOUND`        | 404         | Unknown room id                                                                                                                                                 |
| `FILE_NOT_FOUND`        | 404         | Unknown file id in the room                                                                                                                                     |
| `TEXT_NOT_FOUND`        | 404         | Unknown text entry id                                                                                                                                           |
| `CLIPBOARD_NOT_FOUND`   | 404         | Unknown clipboard entry id                                                                                                                                      |
| `DEVICE_NOT_FOUND`      | 404         | Unknown or disconnected device id                                                                                                                               |
| `TRANSFER_NOT_FOUND`    | 404         | Unknown transfer id                                                                                                                                             |
| `NOT_FOUND`             | 404         | Unknown `/api` or `/events` path                                                                                                                                |
| `ROOM_LIMIT_REACHED`    | 409         | `maxRooms` reached                                                                                                                                              |
| `ROOM_EXISTS`           | 409         | Room id already in use                                                                                                                                          |
| `ROOM_FULL`             | 409         | Room already holds `maxFilesPerRoom` files                                                                                                                      |
| `FILE_TOO_LARGE`        | 413         | File larger than `maxFileSize`                                                                                                                                  |
| `STORAGE_FULL`          | 507         | Total size would exceed `maxStorage`, or the disk is full                                                                                                       |
| `STORAGE_FULL`          | 413         | Room contents exceed the 4 GB ZIP limit (`GET /files/zip` only)                                                                                                 |
| `TRANSFER_EXPIRED`      | 410         | Transfer is not pending (declined, expired, or already downloaded)                                                                                              |
| `RATE_LIMITED`          | 429         | Rate limit exceeded. Response includes `Retry-After`                                                                                                            |
| `INTERNAL_ERROR`        | 500         | Unexpected server failure, or any error code outside this list                                                                                                  |

Codes outside this list are collapsed to `INTERNAL_ERROR` unless they are 4xx uppercase codes thrown by the application itself.
