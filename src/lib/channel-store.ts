/**
 * ─────────────────────────────────────────────────────────────────────
 * Channel store — server-side merge of the external backend channel
 * with this deployment's local customizations.
 *
 * WHY THIS EXISTS
 * ---------------
 * The deployed BharatTube backend (NEXT_PUBLIC_API_URL) was probed live and
 * exposes ONLY:
 *   GET  /channel/me        → own channel (401 without a token)
 *   GET  /channel/:handle   → channel by handle
 *   POST /channel           → create channel
 * Every mutation attempt answers "Route '/api/v1/...' not found":
 *   PATCH/PUT/POST /channels, /channel/me, /channel/:handle  → 404 route
 *   POST /upload, /upload/video, /video/upload, ...          → 404 route
 * (POST /videos exists but is the video-publish route, not an image route.)
 *
 * So the Edit channel screen cannot talk to the backend for writes. This
 * module persists the editable channel fields in PostgreSQL and merges them
 * OVER the backend channel on every read. The backend remains the source of
 * truth for everything it does return (subscribers, videos, views,
 * verified, owner); only the fields the backend cannot store live locally.
 *
 * Nothing here is ever imported by client components.
 */

import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { channelAssets, channelProfiles } from "@/db/schema";
import { unwrapEnvelope } from "@/lib/backend-adapter";
import { MAX_IMAGE_BYTES } from "@/lib/upload-config";

/** External backend base, resolved server-side from the public env var. */
export const BACKEND_BASE: string = (
  process.env.NEXT_PUBLIC_API_URL ||
  process.env.NEXT_PUBLIC_API_BASE_URL ||
  process.env.VITE_API_URL ||
  "https://bharattube-ylmq.onrender.com/api/v1"
).replace(/\/+$/, "");

export const HANDLE_RE = /^[a-z0-9_]{3,30}$/;
export const MAX_LINKS = 6;
export const MAX_CHANNEL_NAME = 60;
export const MAX_DESCRIPTION = 1000;

export interface ChannelLink {
  label: string;
  url: string;
}

/** Normalized channel returned to the UI (merged backend + local edits). */
export interface MergedChannel {
  id: string;
  ownerUserId: string;
  handle: string;
  channelName: string;
  description: string;
  contactEmail: string | null;
  profilePhotoUrl: string | null;
  bannerUrl: string | null;
  links: ChannelLink[];
  subscriberCount: number;
  videoCount: number;
  totalViews: number;
  isVerified: boolean;
  createdAt: string;
  /** False when the backend has no channel record for this user yet. */
  exists: boolean;
}

export interface ChannelPatch {
  channelName: string;
  handle: string;
  description: string;
  contactEmail: string;
  profilePhotoUrl: string | null;
  bannerUrl: string | null;
  links: ChannelLink[];
}

/* ------------------------------------------------------------------ */
/* auth                                                               */
/* ------------------------------------------------------------------ */

/** Reads the bearer token from the Authorization header or session cookie. */
export function readToken(req: Request): string | null {
  const header = req.headers.get("authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (match?.[1]) return match[1].trim();
  const cookie = req.headers.get("cookie") || "";
  for (const name of ["bharattube_session_client", "bharattube_token"]) {
    const m = cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
    if (m?.[1]) return decodeURIComponent(m[1]);
  }
  return null;
}

/** Decodes a JWT payload without verifying (we only need the subject id). */
function decodeJwtSubject(token: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const json = Buffer.from(
      parts[1].replace(/-/g, "+").replace(/_/g, "/"),
      "base64"
    ).toString("utf8");
    const payload = JSON.parse(json);
    const id = payload?._id ?? payload?.id ?? payload?.userId ?? payload?.sub;
    return id == null ? null : String(id);
  } catch {
    return null;
  }
}

/**
 * Stable backend user id for a token: JWT subject when present, otherwise an
 * authenticated GET /auth/me round-trip. Null means the token is not usable.
 */
export async function resolveUserId(token: string): Promise<string | null> {
  const fromJwt = decodeJwtSubject(token);
  if (fromJwt) return fromJwt;

  try {
    const res = await fetch(`${BACKEND_BASE}/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const data = unwrapEnvelope(await res.json().catch(() => null));
    const user = (data.user ?? data) as Record<string, unknown>;
    const id = user?._id ?? user?.id ?? user?.userId;
    return id == null ? null : String(id);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* backend reads                                                      */
/* ------------------------------------------------------------------ */

interface BackendChannel {
  raw: Record<string, any> | null;
  status: number;
}

/** GET /channel/me with the caller's token. 401 = session invalid. */
async function fetchBackendChannel(token: string): Promise<BackendChannel> {
  try {
    const res = await fetch(`${BACKEND_BASE}/channel/me`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    let payload: any = null;
    try {
      payload = await res.json();
    } catch {
      payload = null;
    }
    if (!res.ok) return { raw: null, status: res.status };
    const data = unwrapEnvelope(payload);
    const raw = (data.channel ?? data) as Record<string, any> | null;
    return { raw: raw && typeof raw === "object" ? raw : null, status: res.status };
  } catch {
    return { raw: null, status: 0 };
  }
}

/* ------------------------------------------------------------------ */
/* merge                                                              */
/* ------------------------------------------------------------------ */

function firstString(...values: unknown[]): string {
  for (const v of values) {
    if (typeof v === "string" && v.trim() !== "") return v;
  }
  return "";
}

function firstNumber(...values: unknown[]): number {
  for (const v of values) {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) {
      return Number(v);
    }
  }
  return 0;
}

function normalizeLinks(value: unknown): ChannelLink[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((l) => {
      const item = (l ?? {}) as Record<string, unknown>;
      return {
        label: String(item.label ?? "").trim(),
        url: String(item.url ?? "").trim(),
      };
    })
    .filter((l) => l.label !== "" && l.url !== "");
}

/**
 * Merges the local override row over the backend channel. Local values win
 * ONLY when they are actually set, so clearing a field on the backend later
 * still falls back to the backend value instead of an empty string.
 */
export function mergeChannel(
  userId: string,
  backendRaw: Record<string, any> | null,
  override: typeof channelProfiles.$inferSelect | null
): MergedChannel {
  const owner = (backendRaw?.owner ?? backendRaw?.user ?? {}) as Record<
    string,
    any
  >;
  const subscribers = Array.isArray(backendRaw?.subscribers)
    ? backendRaw.subscribers.length
    : 0;

  const channelName =
    override?.channelName?.trim() ||
    firstString(backendRaw?.channelName, backendRaw?.name, owner?.name) ||
    "My channel";
  const handle =
    override?.handle?.trim() ||
    firstString(backendRaw?.handle, backendRaw?.username, owner?.username);

  const description =
    override && override.description.trim() !== ""
      ? override.description
      : override
        ? "" // owner explicitly cleared it
        : firstString(backendRaw?.description, backendRaw?.bio);

  const contactEmail =
    override?.contactEmail?.trim() || null;

  const profilePhotoUrl =
    override?.profilePhotoUrl ||
    firstString(backendRaw?.logo, backendRaw?.avatar, owner?.profilePhoto) ||
    null;

  const bannerUrl =
    override?.bannerUrl || firstString(backendRaw?.banner) || null;

  const links = override ? normalizeLinks(override.links) : [];

  return {
    id: firstString(backendRaw?._id, backendRaw?.id) || `local:${userId}`,
    ownerUserId:
      firstString(owner?._id, owner?.id, backendRaw?.ownerId) || userId,
    handle,
    channelName,
    description,
    contactEmail,
    profilePhotoUrl,
    bannerUrl,
    links,
    subscriberCount: firstNumber(
      backendRaw?.subscribersCount,
      backendRaw?.subscriberCount,
      subscribers
    ),
    videoCount: firstNumber(backendRaw?.totalVideos),
    totalViews: firstNumber(backendRaw?.totalViews),
    isVerified: Boolean(backendRaw?.verified),
    createdAt: firstString(backendRaw?.createdAt) || new Date(0).toISOString(),
    // A channel "exists" once either the backend has a record or the owner
    // has saved edits here — both are real, user-owned channel data.
    exists: Boolean(backendRaw) || Boolean(override),
  };
}

/** Reads the merged channel for a token holder. */
export async function loadMergedChannel(
  token: string
): Promise<{ channel: MergedChannel; userId: string } | null> {
  const userId = await resolveUserId(token);
  if (!userId) return null;

  const [{ raw, status }, overrideRows] = await Promise.all([
    fetchBackendChannel(token),
    db.select().from(channelProfiles).where(eq(channelProfiles.userId, userId)),
  ]);

  // The backend rejected the token — the session is not valid, so local
  // channel data must never be served or written for it (this also blocks
  // self-minted JWTs, whose subject we read without verifying).
  if (status === 401 || status === 403) return null;

  const override = overrideRows[0] ?? null;
  return { channel: mergeChannel(userId, raw, override), userId };
}

/* ------------------------------------------------------------------ */
/* validation                                                         */
/* ------------------------------------------------------------------ */

export function validatePatch(
  body: unknown
): { ok: true; value: ChannelPatch } | { ok: false; error: string } {
  const b = (body ?? {}) as Record<string, unknown>;

  const channelName = String(b.channelName ?? "").trim();
  if (!channelName) return { ok: false, error: "Channel name cannot be empty." };
  if (channelName.length > MAX_CHANNEL_NAME) {
    return {
      ok: false,
      error: `Channel name must be ${MAX_CHANNEL_NAME} characters or fewer.`,
    };
  }

  const handle = String(b.handle ?? "")
    .trim()
    .toLowerCase();
  if (!HANDLE_RE.test(handle)) {
    return {
      ok: false,
      error:
        "Handle must be 3–30 characters and can only contain lowercase letters, numbers and underscores.",
    };
  }

  const description = String(b.description ?? "").trim();
  if (description.length > MAX_DESCRIPTION) {
    return {
      ok: false,
      error: `Description must be ${MAX_DESCRIPTION} characters or fewer.`,
    };
  }

  const contactEmail = String(b.contactEmail ?? "").trim();
  if (contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) {
    return {
      ok: false,
      error: "Please enter a valid contact email, or leave it empty.",
    };
  }

  /**
   * Accepted image values:
   *   - "/api/uploads/<uuid>" — an image just uploaded through this app;
   *   - an https?: URL — the image the BACKEND already hosts (Cloudinary).
   *     The form loads the existing channel logo/banner into the same fields,
   *     so a user who never touches their picture resubmits that backend URL
   *     unchanged. Rejecting it would make saving impossible for every
   *     channel that already has a picture.
   * Anything else (javascript:, data:, relative junk) is refused.
   */
  const isImageValue = (v: unknown): string | null => {
    if (v == null || v === "") return null;
    const url = String(v).trim();
    if (/^\/api\/uploads\/[0-9a-f-]{36}$/i.test(url)) return url;
    if (/^https?:\/\/[^\s]+$/i.test(url)) return url.slice(0, 1000);
    return null;
  };
  const profilePhotoUrl = isImageValue(b.profilePhotoUrl);
  const bannerUrl = isImageValue(b.bannerUrl);
  if (b.profilePhotoUrl && !profilePhotoUrl) {
    return { ok: false, error: "Invalid profile picture. Please re-upload it." };
  }
  if (b.bannerUrl && !bannerUrl) {
    return { ok: false, error: "Invalid banner image. Please re-upload it." };
  }

  const links = normalizeLinks(b.links).slice(0, MAX_LINKS).map((l) => ({
    label: l.label.slice(0, 40),
    url: /^https?:\/\//i.test(l.url) ? l.url.slice(0, 500) : "",
  }));
  for (const l of links) {
    if (!l.url) {
      return { ok: false, error: "Every link needs a valid http(s) URL." };
    }
  }

  return {
    ok: true,
    value: {
      channelName,
      handle,
      description,
      contactEmail,
      profilePhotoUrl,
      bannerUrl,
      links,
    },
  };
}

/* ------------------------------------------------------------------ */
/* writes                                                             */
/* ------------------------------------------------------------------ */

/** Upserts the local channel override for a user. */
export async function saveChannelPatch(
  userId: string,
  patch: ChannelPatch
): Promise<void> {
  const now = new Date();
  await db
    .insert(channelProfiles)
    .values({
      userId,
      channelName: patch.channelName,
      handle: patch.handle,
      description: patch.description,
      contactEmail: patch.contactEmail || null,
      profilePhotoUrl: patch.profilePhotoUrl,
      bannerUrl: patch.bannerUrl,
      links: patch.links,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: channelProfiles.userId,
      set: {
        channelName: patch.channelName,
        handle: patch.handle,
        description: patch.description,
        contactEmail: patch.contactEmail || null,
        profilePhotoUrl: patch.profilePhotoUrl,
        bannerUrl: patch.bannerUrl,
        links: patch.links,
        updatedAt: now,
      },
    });
}

/* ------------------------------------------------------------------ */
/* backend sync — PUT /channel                                        */
/* ------------------------------------------------------------------ */

export interface SyncResult {
  /** True when the backend accepted and stored the update. */
  synced: boolean;
  status: number;
  message: string;
  /** Channel object the backend returned, when it returned one. */
  raw: Record<string, any> | null;
}

/** Loads the bytes behind a "/api/uploads/<uuid>" value, if it is one. */
async function assetForValue(
  value: string | null
): Promise<StoredAsset | null> {
  if (!value) return null;
  const m = value.match(/^\/api\/uploads\/([0-9a-f-]{36})$/i);
  if (!m) return null;
  return getChannelAsset(m[1]);
}

function extensionFor(mime: string): string {
  if (mime.includes("png")) return "png";
  if (mime.includes("webp")) return "webp";
  if (mime.includes("gif")) return "gif";
  return "jpg";
}

/**
 * Pushes the edit to the REAL backend.
 *
 * VERIFIED live: `PUT /api/v1/channel` exists (answers 401 "Access Denied. No
 * Token Provided." without a token, NOT "Route not found"), alongside
 * POST /channel (create) and DELETE /channel. There is no separate image
 * route (`/channel/logo`, `/channel/banner`, `/upload`, ... all answer
 * "Route not found"), so newly picked images are sent as file parts on this
 * same request — the backend is Cloudinary-backed per its own env contract.
 *
 * Two attempts, because we cannot know which body style this Express handler
 * parses: multipart first (only when a new file is actually being sent),
 * then JSON. A 401 is never retried.
 */
export async function syncChannelToBackend(
  token: string,
  patch: ChannelPatch
): Promise<SyncResult> {
  const [logo, banner] = await Promise.all([
    assetForValue(patch.profilePhotoUrl),
    assetForValue(patch.bannerUrl),
  ]);

  const textFields: Record<string, string> = {
    channelName: patch.channelName,
    handle: patch.handle,
    description: patch.description,
  };

  const readBody = async (res: Response) => {
    try {
      return await res.json();
    } catch {
      return null;
    }
  };

  const interpret = (status: number, payload: any): SyncResult => {
    const message = String(payload?.message || payload?.error || "");
    const ok = status >= 200 && status < 300 && payload?.success !== false;
    const data = unwrapEnvelope(payload);
    const raw = (data.channel ?? data) as Record<string, any> | null;
    return {
      synced: ok,
      status,
      message,
      raw: ok && raw && typeof raw === "object" ? raw : null,
    };
  };

  /* Attempt 1 — multipart, only when a freshly uploaded file exists. */
  if (logo || banner) {
    try {
      const form = new FormData();
      for (const [k, v] of Object.entries(textFields)) form.append(k, v);
      if (logo) {
        form.append(
          "logo",
          new Blob([new Uint8Array(logo.data)], { type: logo.mimeType }),
          `logo.${extensionFor(logo.mimeType)}`
        );
      }
      if (banner) {
        form.append(
          "banner",
          new Blob([new Uint8Array(banner.data)], { type: banner.mimeType }),
          `banner.${extensionFor(banner.mimeType)}`
        );
      }
      // Keep any untouched image as its existing URL.
      if (!logo && patch.profilePhotoUrl) {
        form.append("logo", patch.profilePhotoUrl);
      }
      if (!banner && patch.bannerUrl) {
        form.append("banner", patch.bannerUrl);
      }

      const res = await fetch(`${BACKEND_BASE}/channel`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}` },
        body: form,
        cache: "no-store",
      });
      const payload = await readBody(res);
      const result = interpret(res.status, payload);
      if (result.synced || res.status === 401 || res.status === 403) {
        return result;
      }
    } catch {
      /* fall through to the JSON attempt */
    }
  }

  /* Attempt 2 — JSON, mirroring the field names POST /channel already uses. */
  try {
    const res = await fetch(`${BACKEND_BASE}/channel`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ...textFields,
        logo: patch.profilePhotoUrl ?? "",
        banner: patch.bannerUrl ?? "",
      }),
      cache: "no-store",
    });
    const payload = await readBody(res);
    return interpret(res.status, payload);
  } catch (err) {
    return {
      synced: false,
      status: 0,
      message: String((err as Error)?.message || "network error"),
      raw: null,
    };
  }
}

export interface StoredAsset {
  id: string;
  mimeType: string;
  sizeBytes: number;
  data: Buffer;
}

/** Stores an uploaded image and returns its public same-origin URL. */
export async function saveChannelAsset(
  userId: string,
  kind: "photo" | "banner",
  file: { type: string; size: number; bytes: Buffer }
): Promise<{ id: string; url: string }> {
  const [row] = await db
    .insert(channelAssets)
    .values({
      userId,
      kind,
      mimeType: file.type,
      sizeBytes: file.size,
      data: file.bytes,
    })
    .returning({ id: channelAssets.id });
  return { id: String(row.id), url: `/api/uploads/${row.id}` };
}

export async function getChannelAsset(id: string): Promise<StoredAsset | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const rows = await db
    .select({
      id: channelAssets.id,
      mimeType: channelAssets.mimeType,
      sizeBytes: channelAssets.sizeBytes,
      data: channelAssets.data,
    })
    .from(channelAssets)
    .where(eq(channelAssets.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    id: String(row.id),
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    data: Buffer.from(row.data),
  };
}

/** Image limits shared with the client UI. */
export const IMAGE_LIMITS = {
  maxBytes: Math.min(MAX_IMAGE_BYTES, 8 * 1024 * 1024),
  allowedPrefixes: ["image/png", "image/jpeg", "image/webp", "image/gif"],
};

/** Deletes assets no longer referenced by any channel override. */
export async function pruneOrphanAssets(): Promise<void> {
  await db.execute(
    sql`delete from ${channelAssets} where ${channelAssets.createdAt} < now() - interval '7 days'`
  );
}
