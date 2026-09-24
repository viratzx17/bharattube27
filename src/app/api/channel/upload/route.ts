import { NextResponse } from "next/server";
import {
  IMAGE_LIMITS,
  loadMergedChannel,
  readToken,
  resolveUserId,
  saveChannelAsset,
} from "@/lib/channel-store";

export const dynamic = "force-dynamic";

/**
 * POST /api/channel/upload — stores a channel image (profile photo / banner).
 *
 * The backend exposes no image-upload route (POST /upload → "Route not
 * found"), so images are stored in PostgreSQL and served same-origin from
 * /api/uploads/<id>. The returned URL is the only shape the channel save
 * endpoint accepts, which keeps image sources same-origin and verified.
 */
export async function POST(req: Request) {
  const token = readToken(req);
  if (!token) {
    return NextResponse.json(
      { success: false, error: "Sign in to upload images." },
      { status: 401 }
    );
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid upload." },
      { status: 400 }
    );
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json(
      { success: false, error: "No file received. Please choose an image." },
      { status: 400 }
    );
  }

  const kind = form.get("kind") === "banner" ? "banner" : "photo";

  const mime = (file.type || "").toLowerCase();
  if (!IMAGE_LIMITS.allowedPrefixes.some((p) => mime.startsWith(p))) {
    return NextResponse.json(
      {
        success: false,
        error: "That file is not an image. Use PNG, JPEG, WebP or GIF.",
      },
      { status: 400 }
    );
  }
  if (file.size <= 0) {
    return NextResponse.json(
      { success: false, error: "That file appears to be empty." },
      { status: 400 }
    );
  }
  if (file.size > IMAGE_LIMITS.maxBytes) {
    const mb = Math.round(IMAGE_LIMITS.maxBytes / (1024 * 1024));
    return NextResponse.json(
      { success: false, error: `Image is too large. Maximum size is ${mb} MB.` },
      { status: 400 }
    );
  }

  try {
    // Confirms the session is usable before storing anything.
    const userId =
      (await loadMergedChannel(token))?.userId ?? (await resolveUserId(token));
    if (!userId) {
      return NextResponse.json(
        { success: false, error: "Your session expired. Please sign in again." },
        { status: 401 }
      );
    }

    const bytes = Buffer.from(await file.arrayBuffer());
    const asset = await saveChannelAsset(userId, kind, {
      type: mime,
      size: file.size,
      bytes,
    });
    return NextResponse.json({ success: true, url: asset.url });
  } catch (err) {
    console.error("POST /api/channel/upload failed:", err);
    return NextResponse.json(
      { success: false, error: "Upload failed. Please try again." },
      { status: 500 }
    );
  }
}
