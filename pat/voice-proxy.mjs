import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function loadDotEnvLocal() {
  const envPath = path.join(process.cwd(), ".env.local");
  if (!fs.existsSync(envPath)) return;
  const raw = fs.readFileSync(envPath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (!key) continue;
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function sendWsFrame(socket, payload, opts) {
  const opcode = opts?.opcode ?? (opts?.binary === true ? 0x2 : 0x1);

  const data = Buffer.isBuffer(payload)
    ? payload
    : typeof payload === "string"
      ? Buffer.from(payload, "utf8")
      : Buffer.from(payload);

  const length = data.length;
  let header = null;

  if (length < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode;
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }

  socket.write(Buffer.concat([header, data]));
}

function sendJson(socket, obj) {
  try {
    sendWsFrame(socket, JSON.stringify(obj), { binary: false });
  } catch {
    // ignore
  }
}

function sendPong(socket, payload) {
  sendWsFrame(socket, payload ?? Buffer.alloc(0), { opcode: 0xA });
}

function parseWsFrames(buffer) {
  const frames = [];
  let offset = 0;

  while (offset + 2 <= buffer.length) {
    const b0 = buffer[offset];
    const b1 = buffer[offset + 1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let length = b1 & 0x7f;
    let headerLen = 2;

    if (!fin) {
      // We don’t support fragmented frames in this minimal proxy.
      throw new Error("Fragmented frames not supported.");
    }

    if (length === 126) {
      if (offset + 4 > buffer.length) break;
      length = buffer.readUInt16BE(offset + 2);
      headerLen = 4;
    } else if (length === 127) {
      if (offset + 10 > buffer.length) break;
      const big = buffer.readBigUInt64BE(offset + 2);
      length = Number(big);
      headerLen = 10;
    }

    const maskLen = masked ? 4 : 0;
    const frameStart = offset + headerLen + maskLen;
    const frameEnd = frameStart + length;
    if (frameEnd > buffer.length) break;

    let payload = buffer.subarray(frameStart, frameEnd);
    if (masked) {
      const maskKey = buffer.subarray(offset + headerLen, offset + headerLen + 4);
      const unmasked = Buffer.alloc(payload.length);
      for (let i = 0; i < payload.length; i += 1) {
        unmasked[i] = payload[i] ^ maskKey[i % 4];
      }
      payload = unmasked;
    }

    frames.push({ opcode, payload });
    offset = frameEnd;
  }

  return { frames, remaining: buffer.subarray(offset) };
}

loadDotEnvLocal();

const PORT = Number(process.env.PAT_VOICE_PROXY_PORT ?? "8787");
const HOST = process.env.PAT_VOICE_PROXY_HOST ?? "127.0.0.1";

const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("Pat voice proxy running.\n");
});

server.on("upgrade", (req, socket) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (url.pathname !== "/voice") {
    socket.destroy();
    return;
  }

  const key = req.headers["sec-websocket-key"];
  const version = req.headers["sec-websocket-version"];
  if (typeof key !== "string" || version !== "13") {
    socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    socket.destroy();
    return;
  }

  const accept = crypto
    .createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");

  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "\r\n",
    ].join("\r\n"),
  );

  socket.setNoDelay(true);

  const xaiKey = process.env.XAI_API_KEY ?? "";
  const upstreamUrl = process.env.XAI_REALTIME_WS_URL ?? "";
  const extraHeadersRaw = process.env.XAI_REALTIME_HEADERS_JSON ?? "";
  const extraHeadersParsed = extraHeadersRaw ? safeJsonParse(extraHeadersRaw) : null;

  if (!xaiKey.trim() || !upstreamUrl.trim()) {
    sendJson(socket, {
      type: "error",
      error: !xaiKey.trim()
        ? "Missing XAI_API_KEY in pat/.env.local"
        : "Missing XAI_REALTIME_WS_URL in pat/.env.local",
    });
    sendWsFrame(socket, Buffer.alloc(0), { binary: false });
    socket.end();
    return;
  }

  const headers = {};
  if (extraHeadersParsed && typeof extraHeadersParsed === "object") {
    for (const [k, v] of Object.entries(extraHeadersParsed)) {
      if (typeof v === "string") headers[k] = v;
    }
  }

  let upstream;
  try {
    upstream = new WebSocket(upstreamUrl, {
      headers: {
        authorization: `Bearer ${xaiKey}`,
        ...headers,
      },
    });
  } catch (e) {
    sendJson(socket, {
      type: "error",
      error: `Failed to connect upstream: ${e instanceof Error ? e.message : "unknown error"}`,
    });
    socket.end();
    return;
  }

  let buf = Buffer.alloc(0);

  const closeBoth = () => {
    try {
      upstream?.close();
    } catch {
      // ignore
    }
    try {
      socket.end();
    } catch {
      // ignore
    }
  };

  socket.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    let parsed;
    try {
      parsed = parseWsFrames(buf);
    } catch (e) {
      sendJson(socket, { type: "error", error: e instanceof Error ? e.message : "WS parse error." });
      closeBoth();
      return;
    }

    buf = parsed.remaining;

    for (const frame of parsed.frames) {
      if (!upstream || upstream.readyState !== WebSocket.OPEN) continue;

      if (frame.opcode === 0x8) {
        closeBoth();
        return;
      }
      if (frame.opcode === 0x9) {
        // ping -> pong
        sendPong(socket, frame.payload);
        continue;
      }
      if (frame.opcode === 0xa) continue; // pong
      if (frame.opcode !== 0x1 && frame.opcode !== 0x2) continue;

      if (frame.opcode === 0x1) {
        upstream.send(frame.payload.toString("utf8"));
      } else {
        upstream.send(frame.payload);
      }
    }
  });

  socket.on("close", closeBoth);
  socket.on("error", closeBoth);

  upstream.onopen = () => {
    sendJson(socket, { type: "proxy.ready" });
  };

  upstream.onmessage = (event) => {
    const data = event.data;
    if (typeof data === "string") {
      sendWsFrame(socket, data, { binary: false });
      return;
    }

    if (data instanceof ArrayBuffer) {
      sendWsFrame(socket, Buffer.from(data), { binary: true });
      return;
    }

    // Some implementations deliver a Blob; handle via arrayBuffer() if present.
    if (data && typeof data === "object" && typeof data.arrayBuffer === "function") {
      data
        .arrayBuffer()
        .then((ab) => sendWsFrame(socket, Buffer.from(ab), { binary: true }))
        .catch(() => {});
    }
  };

  upstream.onerror = () => {
    sendJson(socket, { type: "error", error: "Upstream websocket error." });
    closeBoth();
  };

  upstream.onclose = () => {
    closeBoth();
  };
});

server.listen(PORT, HOST, () => {
  console.log(`Pat voice proxy listening on ws://${HOST}:${PORT}/voice`);
});
