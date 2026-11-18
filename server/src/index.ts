// AtomConnect signaling: one Durable Object per room relays WebRTC
// signaling (offer/answer/ice) between peers. TURN via Cloudflare Realtime
// (short-lived credentials minted per /ice request); falls back to STUN only.
// A singleton Registry DO records sessions + quality stats for the admin dashboard (/admin/api/*).

import { DurableObject } from "cloudflare:workers";
import { Registry } from "./registry";

export { Registry };

export interface Env {
  ROOMS: DurableObjectNamespace<Room>;
  REGISTRY: DurableObjectNamespace<Registry>;
  TURN_KEY_ID?: string; // wrangler.jsonc var: Cloudflare Realtime TURN key ID
  TURN_API_TOKEN?: string; // secret: `wrangler secret put TURN_API_TOKEN`
  ADMIN_TOKEN?: string; // secret: bearer token for /admin/api/*; unset = admin disabled
  CF_ACCOUNT_ID?: string; // wrangler.jsonc var, only used for the optional usage panel
  CF_API_TOKEN?: string; // optional secret (Account Analytics:Read) for the usage panel
}

const MAX_PEERS = 2; // 1:1 for the PoC; raise for group calls (needs SFU later)
const TURN_TTL_S = 3600; // credential lifetime; must outlast the longest call (ICE restarts re-fetch)

const STUN_ONLY = {
  iceServers: [{ urls: ["stun:stun.cloudflare.com:3478"] }],
};

async function iceConfig(env: Env): Promise<{ body: unknown; turn: boolean }> {
  if (!env.TURN_KEY_ID || !env.TURN_API_TOKEN) return { body: STUN_ONLY, turn: false };
  try {
    const r = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.TURN_API_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ ttl: TURN_TTL_S }),
      },
    );
    if (!r.ok) {
      console.error("turn credentials failed", r.status, await r.text());
      return { body: STUN_ONLY, turn: false };
    }
    return { body: await r.json(), turn: true }; // { iceServers: [{urls, username?, credential?}, ...] }
  } catch (e) {
    console.error("turn credentials error", e);
    return { body: STUN_ONLY, turn: false };
  }
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, authorization",
};

// ---- admin API ----------------------------------------------------------------------------------

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { ...CORS, "cache-control": "no-store" } });

// Constant-time token check (compare fixed-length digests so length can't leak)
async function tokenOk(given: string, expected: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(given)),
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

let usageCache: { at: number; v: unknown } | null = null;
// Optional: account usage (shared free-tier quotas) via the GraphQL Analytics API, cached 5 min
async function usageInfo(env: Env): Promise<unknown> {
  if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID || !/^[0-9a-f]{32}$/.test(env.CF_ACCOUNT_ID)) return { configured: false };
  if (usageCache && Date.now() - usageCache.at < 300_000) return usageCache.v;
  const iso = new Date().toISOString();
  const day = iso.slice(0, 10), month = iso.slice(0, 8) + "01";
  const q = `{viewer{accounts(filter:{accountTag:"${env.CF_ACCOUNT_ID}"}){
    w:workersInvocationsAdaptive(limit:100,filter:{date_geq:"${day}"}){sum{requests}}
    do:durableObjectsInvocationsAdaptiveGroups(limit:100,filter:{date_geq:"${day}"}){sum{requests}}
    turn:callsTurnUsageAdaptiveGroups(limit:10000,filter:{date_geq:"${month}"}){sum{egressBytes}}}}}`;
  try {
    const r = await fetch("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers: { authorization: `Bearer ${env.CF_API_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ query: q }),
    });
    type G = { data?: { viewer: { accounts: { w: { sum: { requests: number } }[]; do: { sum: { requests: number } }[]; turn: { sum: { egressBytes: number } }[] }[] } }; errors?: unknown };
    const j = (await r.json()) as G;
    const a = j.data?.viewer.accounts[0];
    if (!a) return { configured: true, error: "analytics query failed" };
    const v = {
      configured: true,
      workers_today: a.w.reduce((n, x) => n + x.sum.requests, 0), workers_limit: 100_000,
      do_today: a.do.reduce((n, x) => n + x.sum.requests, 0), do_limit: 100_000,
      turn_gb_month: Math.round(a.turn.reduce((n, x) => n + x.sum.egressBytes, 0) / 1e7) / 100, turn_limit_gb: 1000,
    };
    usageCache = { at: Date.now(), v };
    return v;
  } catch (e) {
    console.error("usage query error", e);
    return { configured: true, error: "analytics query failed" };
  }
}

async function adminApi(req: Request, env: Env, url: URL): Promise<Response> {
  if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
  if (!env.ADMIN_TOKEN) return json({ error: "admin disabled: set the ADMIN_TOKEN secret" }, 503);
  const given = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!(await tokenOk(given, env.ADMIN_TOKEN))) return json({ error: "unauthorized" }, 401);

  const reg = env.REGISTRY.get(env.REGISTRY.idFromName("main"));
  const path = url.pathname.slice("/admin/api/".length);
  const q = url.searchParams;
  const room = q.get("room") || undefined;
  const limit = Number(q.get("limit")) || undefined;

  if (path === "dashboard") {
    const [d, usage] = await Promise.all([reg.dashboard({ room, limit }), usageInfo(env)]);
    return json({ ...(d as object), usage });
  }
  if (path === "sessions") return json(await reg.history({ room, limit, before: Number(q.get("before")) || undefined }));
  const m = path.match(/^sessions\/([\w-]{1,64})$/);
  if (m) {
    const d = await reg.detail(m[1]);
    return d ? json(d) : json({ error: "not found" }, 404);
  }
  return json({ error: "not found" }, 404);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

    if (url.pathname.startsWith("/admin/api/")) return adminApi(req, env, url);

    if (url.pathname === "/ice") {
      const { body, turn } = await iceConfig(env);
      // never cache: credentials are per-request and expire
      return Response.json(body, {
        headers: { ...CORS, "cache-control": "no-store", "x-turn": turn ? "1" : "0" },
      });
    }

    if (url.pathname === "/ws") {
      if (req.headers.get("upgrade") !== "websocket") {
        return new Response("expected websocket", { status: 426 });
      }
      const room = url.searchParams.get("room");
      if (!room || !/^[\w-]{1,64}$/.test(room)) {
        return new Response("bad room", { status: 400 });
      }
      return env.ROOMS.get(env.ROOMS.idFromName(room)).fetch(req);
    }

    return new Response("atomconnect-signaling ok", { headers: CORS });
  },
};

type Attachment = { id: string; room: string; seen?: number; st?: number };
const STALE_MS = 180_000; // clients ping every 30s (hidden tabs get throttled to ~60s); silent longer than this = dead
const STATS_MIN_MS = 5_000; // clients report every 30s; drop anything faster (flood guard)

export class Room extends DurableObject<Env> {
  private reg() {
    return this.env.REGISTRY.get(this.env.REGISTRY.idFromName("main"));
  }

  // Registry bookkeeping must never break signaling: fire and forget, log failures
  private notify(p: Promise<unknown>) {
    p.catch((e) => console.error("registry", e));
  }

  // Evict dead peers (closed tabs/crashes leave sockets behind). A reconnecting client sends its previous id
  // (?prev=) so its own ghost socket is dropped immediately instead of blocking the rejoin as "room full".
  private evictStale(prev: string | null, now: number) {
    for (const w of this.ctx.getWebSockets()) {
      const att = w.deserializeAttachment() as Attachment | null;
      const seen = att?.seen ?? 0;
      const replaced = !!prev && att?.id === prev;
      if (replaced || now - seen > STALE_MS) {
        try { w.close(4000, "stale"); } catch {}
        try { this.announceLeft(w, 4000, replaced ? "replaced" : "stale"); } catch {}
      }
    }
  }

  // RPC for the Registry: how many peers are really here (after evicting dead ones)
  liveCount(): number {
    this.evictStale(null, Date.now());
    return this.live().length;
  }

  async fetch(req: Request): Promise<Response> {
    const now = Date.now();
    const u = new URL(req.url);
    const room = u.searchParams.get("room") ?? "";
    const prev = u.searchParams.get("prev");
    this.evictStale(prev, now);
    if (this.live().length >= MAX_PEERS) {
      return new Response("room full", { status: 409 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const id = crypto.randomUUID();
    this.ctx.acceptWebSocket(server); // hibernation API: idle sockets cost nothing
    server.serializeAttachment({ id, room, seen: now } satisfies Attachment);

    const others = this.peers(server);
    server.send(JSON.stringify({ type: "welcome", id, peers: others.map(idOf) }));
    for (const p of others) p.send(JSON.stringify({ type: "peer-joined", id }));

    this.notify(
      this.reg().peerJoined(room, id, prev, now, {
        ua: (req.headers.get("user-agent") ?? "").slice(0, 120),
        cc: typeof req.cf?.country === "string" ? req.cf.country : undefined,
      }),
    );
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws: WebSocket, data: string | ArrayBuffer) {
    if (typeof data !== "string" || data.length > 64 * 1024) return;
    const att = ws.deserializeAttachment() as Attachment | null;
    const from = att?.id ?? "unknown";
    const room = att?.room ?? "";
    const now = Date.now();
    let msg: { type?: string; to?: string; [k: string]: unknown };
    try {
      msg = JSON.parse(data);
    } catch {
      ws.serializeAttachment({ id: from, room, seen: now, st: att?.st } satisfies Attachment);
      return;
    }
    let st = att?.st;
    // quality telemetry goes to the Registry, never to the other peer
    if (msg.type === "stats") {
      if (now - (st ?? 0) >= STATS_MIN_MS) {
        st = now;
        this.notify(this.reg().stats(room, from, msg));
      }
    } else if (msg.type === "media-event") {
      this.notify(this.reg().mediaEvent(room, from, String(msg.kind ?? ""), String(msg.reason ?? "")));
    }
    ws.serializeAttachment({ id: from, room, seen: now, st } satisfies Attachment);
    if (msg.type === "stats" || msg.type === "media-event") return;
    if (msg.type === "ping") return ws.send('{"type":"pong"}');
    // relay offer/answer/ice/chat to the target peer, or to everyone else
    const out = JSON.stringify({ ...msg, from });
    for (const p of this.peers(ws)) {
      if (!msg.to || msg.to === idOf(p)) p.send(out);
    }
  }

  webSocketClose(ws: WebSocket, code: number, reason: string) {
    try { ws.close(code, reason); } catch {} // reserved codes (1005/1006) can't be echoed back
    this.announceLeft(ws, code, reason);
  }

  webSocketError(ws: WebSocket) {
    this.announceLeft(ws, 1006, "error");
  }

  private announceLeft(ws: WebSocket, code: number, reason: string) {
    const att = ws.deserializeAttachment() as Attachment | null;
    const id = att?.id ?? "unknown";
    for (const p of this.peers(ws)) p.send(JSON.stringify({ type: "peer-left", id }));
    this.notify(this.reg().peerLeft(att?.room ?? "", id, code, reason, Date.now()));
  }

  // Sockets still open (closing/closed ones can linger in getWebSockets)
  private live() {
    return this.ctx.getWebSockets().filter((w) => w.readyState === 1);
  }

  private peers(except: WebSocket) {
    return this.live().filter((w) => w !== except);
  }
}

function idOf(ws: WebSocket): string {
  return (ws.deserializeAttachment() as Attachment | null)?.id ?? "unknown";
}
