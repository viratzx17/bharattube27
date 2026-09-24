/**
 * ─────────────────────────────────────────────────────────────────────
 * Channel API helpers — EXISTING BACKEND ONLY
 * ─────────────────────────────────────────────────────────────────────
 *
 * BharatTube's data lives in the deployed Node + Express + MongoDB backend:
 *   https://bharattube-ylmq.onrender.com/api/v1
 *
 * This module therefore has ZERO dependencies on PostgreSQL, Drizzle, `@/db`,
 * `@/db/schema` or DATABASE_URL. Importing it from a route handler must never
 * make `next build` require a database — that was the cause of the Vercel
 * failure "DATABASE_URL is required / Failed to collect page data for
 * /api/channel".
 *
 * VERIFIED live against the deployed API (probed, not assumed):
 *   GET    /channel/me      → 401 "Access Denied. No Token Provided." (exists)
 *   GET    /channel/:handle → channel by handle
 *   POST   /channel         → 401 (exists — create)
 *   PUT    /channel         → 401 (exists — UPDATE, used by Edit channel)
 *   DELETE /channel         → 401 (exists)
 *   PATCH  /channel         → 404 "Route not found"  (so PUT is the verb)
 * There is no separate image route (/channel/logo, /channel/banner, /upload,
 * /upload/video ... all answer "Route not found"), so new images are sent as
 * file parts on the same PUT /channel request, which the backend stores via
 * its own Cloudinary configuration.
 */

/** Backend base URL. Same value the client uses, resolved server-side too. */
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

/** Accepted image types and ceiling for channel artwork. */
export const IMAGE_LIMITS = {
  maxBytes: 8 * 1024 * 1024,
  allowedPrefixes: ["image/png", "image/jpeg", "image/webp", "image/gif"],
};

export interface ChannelLink {
  label: string;
  url: string;
}

/** Channel shape the Edit channel + channel pages render. */
export interface ApiChannel {
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
  /** False when the signed-in user has no channel record yet. */
  exists: boolean;
}

export interface ChannelPatch {
  channelName: string;
  handle: string;
  description: string;
  contactEmail: string;
  links: ChannelLink[];
  /** Existing image URLs kept as-is when no new file was chosen. */
  logoUrl: string | null;
  bannerUrlValue: string | null;
}

/* ------------------------------------------------------------------ */
/* auth                                                                */
/* ------------------------------------------------------------------ */

/** Bearer token from the Authorization header or the client session cookie. */
export function readToken(req: Request): string | null {
  const header = req.headers.get("authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (match?.[1]) return match[1].trim();

  const cookie = req.headers.get("cookie") || "";
  for (const name of [
    "bharattube_session_client",
    "bharattube_token",
    "aether_session_client",
  ]) {
    const m = cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
    if (m?.[1]) return decodeURIComponent(m[1]);
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* shaping                                                             */
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

/** Unwraps the backend's `{ success, data: {...} }` envelope. */
export function unwrap(payload: unknown): Record<string, any> | null {
  if (!payload || typeof payload !== "object") return null;
  const root = payload as Record<string, any>;
  const data =
    root.data && typeof root.data === "object" && !Array.isArray(root.data)
      ? root.data
      : root;
  const channel = (data.channel ?? data) as Record<string, any>;
  return channel && typeof channel === "object" ? channel : null;
}

export function normalizeLinks(value: unknown): ChannelLink[] {
  let list = value;
  if (typeof list === "string") {
    try {
      list = JSON.parse(list);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(list)) return [];
  return list
    .map((l) => {
      const item = (l ?? {}) as Record<string, unknown>;
      return {
        label: String(item.label ?? "").trim(),
        url: String(item.url ?? "").trim(),
      };
    })
    .filter((l) => l.label !== "" && l.url !== "");
}

/** Maps a backend channel document onto the shape the UI renders. */
export function adaptChannelDoc(
  raw: Record<string, any> | null,
  fallbackUserId?: string | null
): ApiChannel {
  const owner = (raw?.owner ?? raw?.user ?? {}) as Record<string, any>;
  const subscribers = Array.isArray(raw?.subscribers)
    ? raw.subscribers.length
    : 0;

  return {
    id: firstString(raw?._id, raw?.id) || "",
    ownerUserId:
      firstString(owner?._id, owner?.id, raw?.ownerId, raw?.userId) ||
      String(fallbackUserId ?? ""),
    handle: firstString(raw?.handle, raw?.username, owner?.username),
    channelName: firstString(raw?.channelName, raw?.name, owner?.name),
    description: firstString(raw?.description, raw?.bio),
    contactEmail: firstString(raw?.contactEmail, raw?.email) || null,
    profilePhotoUrl:
      firstString(raw?.logo, raw?.avatar, owner?.profilePhoto) || null,
    bannerUrl: firstString(raw?.banner) || null,
    links: normalizeLinks(raw?.links),
    subscriberCount: firstNumber(
      raw?.subscribersCount,
      raw?.subscriberCount,
      subscribers
    ),
    videoCount: firstNumber(raw?.totalVideos, raw?.videoCount),
    totalViews: firstNumber(raw?.totalViews),
    isVerified: Boolean(raw?.verified),
    createdAt: firstString(raw?.createdAt),
    exists: Boolean(raw),
  };
}

/* ------------------------------------------------------------------ */
/* validation                                                          */
/* ------------------------------------------------------------------ */

/** Server-side guard mirroring the Edit channel form rules. */
export function validatePatch(
  input: Record<string, unknown>
): { ok: true; value: ChannelPatch } | { ok: false; error: string } {
  const channelName = String(input.channelName ?? "").trim();
  if (!channelName) return { ok: false, error: "Channel name cannot be empty." };
  if (channelName.length > MAX_CHANNEL_NAME) {
    return {
      ok: false,
      error: `Channel name must be ${MAX_CHANNEL_NAME} characters or fewer.`,
    };
  }

  const handle = String(input.handle ?? "")
    .trim()
    .toLowerCase();
  if (!HANDLE_RE.test(handle)) {
    return {
      ok: false,
      error:
        "Handle must be 3–30 characters and can only contain lowercase letters, numbers and underscores.",
    };
  }

  const description = String(input.description ?? "").trim();
  if (description.length > MAX_DESCRIPTION) {
    return {
      ok: false,
      error: `Description must be ${MAX_DESCRIPTION} characters or fewer.`,
    };
  }

  const contactEmail = String(input.contactEmail ?? "").trim();
  if (contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) {
    return {
      ok: false,
      error: "Please enter a valid contact email, or leave it empty.",
    };
  }

  const links = normalizeLinks(input.links)
    .slice(0, MAX_LINKS)
    .map((l) => ({
      label: l.label.slice(0, 40),
      url: /^https?:\/\//i.test(l.url) ? l.url.slice(0, 500) : "",
    }));
  for (const l of links) {
    if (!l.url) {
      return { ok: false, error: "Every link needs a valid http(s) URL." };
    }
  }

  // Existing artwork is passed through as the URL the backend already hosts.
  const keepUrl = (v: unknown): string | null => {
    if (v == null || v === "") return null;
    const url = String(v).trim();
    return /^https?:\/\//i.test(url) ? url.slice(0, 1000) : null;
  };

  return {
    ok: true,
    value: {
      channelName,
      handle,
      description,
      contactEmail,
      links,
      logoUrl: keepUrl(input.logoUrl),
      bannerUrlValue: keepUrl(input.bannerUrl),
    },
  };
}

/** Validates an uploaded image part before forwarding it to the backend. */
export function validateImage(file: File, label: string): string | null {
  const mime = (file.type || "").toLowerCase();
  if (!IMAGE_LIMITS.allowedPrefixes.some((p) => mime.startsWith(p))) {
    return `The ${label} must be a PNG, JPEG, WebP or GIF image.`;
  }
  if (file.size <= 0) return `That ${label} file appears to be empty.`;
  if (file.size > IMAGE_LIMITS.maxBytes) {
    const mb = Math.round(IMAGE_LIMITS.maxBytes / (1024 * 1024));
    return `The ${label} is too large. Maximum size is ${mb} MB.`;
  }
  return null;
}
