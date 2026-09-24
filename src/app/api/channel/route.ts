import { NextResponse } from "next/server";
import {
  BACKEND_BASE,
  adaptChannelDoc,
  readToken,
  unwrap,
  validateImage,
  validatePatch,
} from "@/lib/channel-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Channel read/write for the signed-in user.
 *
 * BUILD REQUIREMENT: this handler has ZERO dependencies on PostgreSQL,
 * Drizzle, `@/db`, `@/db/schema` or DATABASE_URL. It is a thin authenticated
 * proxy to the existing deployed backend
 * (https://bharattube-ylmq.onrender.com/api/v1), which keeps its data in the
 * existing MongoDB. Nothing here may import a database client, otherwise
 * `next build` fails while collecting page data.
 *
 * Verified backend routes used:
 *   GET /channel/me  → the caller's channel
 *   PUT /channel     → update the caller's channel (PATCH is 404 there)
 */

function jsonError(error: string, status: number) {
  return NextResponse.json({ success: false, error }, { status });
}

/** GET /api/channel — the signed-in user's channel from the backend. */
export async function GET(req: Request) {
  const token = readToken(req);
  if (!token) {
    return jsonError("Sign in to view your channel.", 401);
  }

  try {
    const res = await fetch(`${BACKEND_BASE}/channel/me`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });

    const payload = await res.json().catch(() => null);

    if (res.status === 401 || res.status === 403) {
      return jsonError("Your session expired. Please sign in again.", 401);
    }

    if (!res.ok) {
      // The account simply has no channel record yet — report that truthfully
      // instead of inventing one.
      return NextResponse.json({
        success: true,
        data: { ...adaptChannelDoc(null), exists: false },
      });
    }

    return NextResponse.json({
      success: true,
      data: adaptChannelDoc(unwrap(payload)),
    });
  } catch (err) {
    console.error("GET /api/channel failed:", err);
    return jsonError(
      "Could not reach the video service. Please try again.",
      502
    );
  }
}

/**
 * PATCH /api/channel — saves the channel through the backend's PUT /channel.
 *
 * Accepts multipart/form-data so newly chosen artwork travels as real file
 * parts (the backend stores them with its own Cloudinary setup — it exposes
 * no standalone image route). Text-only saves are forwarded as JSON.
 */
export async function PATCH(req: Request) {
  const token = readToken(req);
  if (!token) {
    return jsonError("Sign in to edit your channel.", 401);
  }

  /* ---------------- read the incoming edit ---------------- */

  let fields: Record<string, unknown> = {};
  let logoFile: File | null = null;
  let bannerFile: File | null = null;

  const contentType = req.headers.get("content-type") || "";

  try {
    if (contentType.includes("multipart/form-data")) {
      const form = await req.formData();
      for (const [key, value] of form.entries()) {
        if (value instanceof File) {
          if (key === "logo") logoFile = value;
          else if (key === "banner") bannerFile = value;
        } else {
          fields[key] = value;
        }
      }
    } else {
      fields = (await req.json()) as Record<string, unknown>;
    }
  } catch {
    return jsonError("Invalid request.", 400);
  }

  const validated = validatePatch(fields);
  if (!validated.ok) {
    return jsonError(validated.error, 400);
  }
  const patch = validated.value;

  for (const [file, label] of [
    [logoFile, "profile picture"],
    [bannerFile, "banner"],
  ] as const) {
    if (file) {
      const problem = validateImage(file, label);
      if (problem) return jsonError(problem, 400);
    }
  }

  /* ---------------- forward to the backend ---------------- */

  const interpret = (status: number, payload: any) => {
    const ok = status >= 200 && status < 300 && payload?.success !== false;
    return {
      ok,
      status,
      message: String(payload?.message || payload?.error || ""),
      doc: ok ? unwrap(payload) : null,
    };
  };

  try {
    let result: ReturnType<typeof interpret>;

    if (logoFile || bannerFile) {
      // New artwork: multipart so the backend receives real files.
      const out = new FormData();
      out.append("channelName", patch.channelName);
      out.append("handle", patch.handle);
      out.append("description", patch.description);
      if (patch.contactEmail) out.append("contactEmail", patch.contactEmail);
      out.append("links", JSON.stringify(patch.links));

      if (logoFile) out.append("logo", logoFile, logoFile.name || "logo");
      else if (patch.logoUrl) out.append("logo", patch.logoUrl);

      if (bannerFile) out.append("banner", bannerFile, bannerFile.name || "banner");
      else if (patch.bannerUrlValue) out.append("banner", patch.bannerUrlValue);

      const res = await fetch(`${BACKEND_BASE}/channel`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}` },
        body: out,
        cache: "no-store",
      });
      result = interpret(res.status, await res.json().catch(() => null));
    } else {
      // Text-only edit.
      const res = await fetch(`${BACKEND_BASE}/channel`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          channelName: patch.channelName,
          handle: patch.handle,
          description: patch.description,
          contactEmail: patch.contactEmail,
          links: patch.links,
          logo: patch.logoUrl ?? "",
          banner: patch.bannerUrlValue ?? "",
        }),
        cache: "no-store",
      });
      result = interpret(res.status, await res.json().catch(() => null));
    }

    if (result.status === 401 || result.status === 403) {
      return jsonError("Your session expired. Please sign in again.", 401);
    }

    if (!result.ok) {
      // Surface the backend's own reason (e.g. "Handle already taken").
      return jsonError(
        result.message || "The video service could not save your channel.",
        result.status >= 400 && result.status < 500 ? result.status : 502
      );
    }

    // Prefer the document the backend returned; re-read it when the update
    // response carried no channel body, so the UI always shows stored truth.
    let doc = result.doc;
    if (!doc || !doc.handle) {
      const verify = await fetch(`${BACKEND_BASE}/channel/me`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      if (verify.ok) {
        doc = unwrap(await verify.json().catch(() => null)) ?? doc;
      }
    }

    return NextResponse.json({
      success: true,
      data: adaptChannelDoc(doc),
    });
  } catch (err) {
    console.error("PATCH /api/channel failed:", err);
    return jsonError(
      "Could not reach the video service. Please check your connection and try again.",
      502
    );
  }
}
