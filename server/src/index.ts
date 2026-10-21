import "dotenv/config";
import express from "express";
import cors from "cors";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { Server } from "socket.io";
import db from "./db.js";

const app = express();
const http = createServer(app);

const allowedOrigins = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
];

const io = new Server(http, {
  cors: { origin: allowedOrigins },
});

const pingExec = promisify(execFile);

app.use(cors({ origin: allowedOrigins }));
app.use(express.json());

const deviceSelect = `
  SELECT
    id,
    name,
    host,
    kind,
    enabled,
    status,
    latency_ms AS latencyMs,
    packet_loss_pct AS packetLossPct,
    last_checked_at AS lastCheckedAt,
    created_at AS createdAt
  FROM devices
`;

const summary = () => {
  const x = db
    .prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(status = 'up') AS up,
        SUM(status = 'down') AS down,
        AVG(CASE WHEN status = 'up' THEN latency_ms END) AS avgLatency
      FROM devices
      WHERE enabled = 1
    `)
    .get() as any;

  return {
    total: x.total,
    up: x.up || 0,
    down: x.down || 0,
    avgLatency:
      x.avgLatency === null ? null : Number(x.avgLatency),
  };
};

app.get("/api/health", (_q, r) =>
  r.json({ ok: true, service: "HomeNet Monitor API" }),
);

app.get("/api/summary", (_q, r) => r.json(summary()));

app.get("/api/devices", (_q, r) =>
  r.json(
    (db.prepare(`${deviceSelect} ORDER BY id`).all() as any[]).map(
      (d) => ({ ...d, enabled: Boolean(d.enabled) }),
    ),
  ),
);

app.post("/api/devices", (q, r) => {
  const { name, host, kind = "device" } = q.body ?? {};

  if (
    typeof name !== "string" ||
    !name.trim() ||
    typeof host !== "string" ||
    !host.trim() ||
    !/^[a-zA-Z0-9._:-]+$/.test(host.trim())
  ) {
    return r
      .status(400)
      .json({ error: "Valid name and IP/hostname are required" });
  }

  if (!["router", "internet", "server", "device"].includes(kind)) {
    return r.status(400).json({ error: "Invalid device type" });
  }

  const x = db
    .prepare("INSERT INTO devices(name,host,kind) VALUES(?,?,?)")
    .run(name.trim(), host.trim(), kind);

  const d = db
    .prepare(`${deviceSelect} WHERE id=?`)
    .get(x.lastInsertRowid) as any;

  io.emit("device:added", { ...d, enabled: Boolean(d.enabled) });
  return r.status(201).json({ ...d, enabled: Boolean(d.enabled) });
});

app.delete("/api/devices/:id", (q, r) => {
  const x = db
    .prepare("DELETE FROM devices WHERE id=?")
    .run(Number(q.params.id));

  if (!x.changes) return r.sendStatus(404);

  io.emit("device:removed", { id: Number(q.params.id) });
  return r.sendStatus(204);
});

app.get("/api/devices/:id/history", (q, r) => {
  const hours = Math.max(1, Math.min(168, Number(q.query.hours ?? 6)));

  const rows = db
    .prepare(`
      SELECT
        checked_at AS checkedAt,
        latency_ms AS latencyMs,
        success
      FROM checks
      WHERE device_id = ?
        AND checked_at >= ?
      ORDER BY checked_at
    `)
    .all(
      Number(q.params.id),
      new Date(Date.now() - hours * 3600000).toISOString(),
    ) as any[];

  return r.json(rows.map((x) => ({ ...x, success: Boolean(x.success) })));
});

app.get("/api/incidents", (q, r) => {
  const limit = Math.max(1, Math.min(500, Number(q.query.limit ?? 100)));

  return r.json(
    db
      .prepare(`
        SELECT
          i.id,
          i.device_id AS deviceId,
          d.name AS deviceName,
          d.host,
          i.started_at AS startedAt,
          i.ended_at AS endedAt,
          CASE
            WHEN i.ended_at IS NULL THEN NULL
            ELSE CAST(
              (julianday(i.ended_at) - julianday(i.started_at)) * 86400
              AS INTEGER
            )
          END AS durationSeconds,
          CASE
            WHEN i.ended_at IS NULL THEN 'open'
            ELSE 'resolved'
          END AS status
        FROM incidents i
        JOIN devices d ON d.id = i.device_id
        ORDER BY i.started_at DESC
        LIMIT ?
      `)
      .all(limit),
  );
});

io.on("connection", (s) => s.emit("summary:update", summary()));

let busy = false;

async function checkTargets() {
  if (busy) return;
  busy = true;

  try {
    const targets = db
      .prepare("SELECT * FROM devices WHERE enabled = 1")
      .all() as any[];

    for (const d of targets) {
      let success = false;
      let latency: number | null = null;

      try {
        const isWindows = process.platform === "win32";
        const timeoutSeconds = Math.max(
          1,
          Number(process.env.PING_TIMEOUT_SECONDS ?? 2),
        );

        // Windows uses milliseconds for -w; Linux uses seconds for -W.
        const args = isWindows
          ? ["-n", "1", "-w", String(timeoutSeconds * 1000), d.host]
          : ["-n", "-c", "1", "-W", String(timeoutSeconds), d.host];

        const { stdout } = await pingExec("ping", args, { timeout: 5000 });

        // Supports common Windows and Linux ping output, including decimal latency.
        const match = stdout.match(/time[=<]\s*([\d.,]+)\s*ms/i);

        if (match) {
          latency = Number(match[1].replace(",", "."));
        }

        success = true;
      } catch {
        // A failed ping marks this device as down.
      }

      const now = new Date().toISOString();
      const next = success ? "up" : "down";

      db.prepare(`
        INSERT INTO checks(device_id, checked_at, latency_ms, success)
        VALUES(?,?,?,?)
      `).run(d.id, now, latency, success ? 1 : 0);

      db.prepare(`
        UPDATE devices
        SET status=?, latency_ms=?, packet_loss_pct=?, last_checked_at=?
        WHERE id=?
      `).run(next, latency, success ? 0 : 100, now, d.id);

      if (next === "down" && d.status !== "down") {
        db.prepare(
          "INSERT INTO incidents(device_id,started_at) VALUES(?,?)",
        ).run(d.id, now);

        io.emit("incident:new", {
          deviceId: d.id,
          deviceName: d.name,
          host: d.host,
          startedAt: now,
        });
      } else if (next === "up" && d.status === "down") {
        db.prepare(`
          UPDATE incidents
          SET ended_at=?
          WHERE device_id=? AND ended_at IS NULL
        `).run(now, d.id);

        io.emit("incident:resolved", {
          deviceId: d.id,
          deviceName: d.name,
          host: d.host,
          endedAt: now,
        });
      }

      const updated = db
        .prepare(`${deviceSelect} WHERE id=?`)
        .get(d.id) as any;

      io.emit("device:update", {
        ...updated,
        enabled: Boolean(updated.enabled),
      });
    }

    io.emit("summary:update", summary());
  } finally {
    busy = false;
  }
}

void checkTargets();

setInterval(
  () => void checkTargets(),
  Number(process.env.CHECK_INTERVAL_MS ?? 10000),
);

http.listen(
  Number(process.env.PORT ?? 3001),
  "0.0.0.0",
  () => console.log(`HomeNet Monitor API on port ${process.env.PORT ?? 3001}`),
);
