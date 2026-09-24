import { NextResponse } from "next/server";
import {
  loadMergedChannel,
  readToken,
  saveChannelPatch,
  syncChannelToBackend,
  validatePatch,
} from "@/lib/channel-store";

export const dynamic = "force-dynamic";

/**
 * GET /api/channel — the signed-in user's channel, merged from the external
 * backend (subscribers/videos/views) and this deployment's local edits
 * (name, handle, description, photo, banner, links, contact email).
 *
 * The backend has no channel-update or image-upload route, so Edit channel
 * reads and writes through here.
 */
export async function GET(req: Request) {
  const token = readToken(req);
  if (!token) {
    return NextResponse.json(
      { success: false, error: "Sign in to view your channel." },
      { status: 401 }
    );
  }

  try {
    const loaded = await loadMergedChannel(token);
    if (!loaded) {
      return NextResponse.json(
        { success: false, error: "Your session expired. Please sign in again." },
        { status: 401 }
      );
    }
    return NextResponse.json({ success: true, data: loaded.channel });
  } catch (err) {
    console.error("GET /api/channel failed:", err);
    return NextResponse.json(
      { success: false, error: "Could not load your channel. Please try again." },
      { status: 500 }
    );
  }
}

/**
 * PATCH /api/channel — saves the editable channel fields for the signed-in
 * user. Validates everything server-side, then returns the merged channel so
 * the UI can render the confirmed values (never optimistic ones).
 */
export async function PATCH(req: Request) {
  const token = readToken(req);
  if (!token) {
    return NextResponse.json(
      { success: false, error: "Sign in to edit your channel." },
      { status: 401 }
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid request." },
      { status: 400 }
    );
  }

  const validated = validatePatch(body);
  if (!validated.ok) {
    return NextResponse.json(
      { success: false, error: validated.error },
      { status: 400 }
    );
  }

  try {
    // Re-resolves the user id (JWT subject, or authenticated /auth/me).
    const loaded = await loadMergedChannel(token);
    if (!loaded) {
      return NextResponse.json(
        { success: false, error: "Your session expired. Please sign in again." },
        { status: 401 }
      );
    }

    const patch = { ...validated.value };

    // 1) Push to the REAL backend (PUT /channel) so the change is public and
    //    visible to every other viewer, not just this deployment.
    const sync = await syncChannelToBackend(token, patch);

    if (sync.status === 401 || sync.status === 403) {
      return NextResponse.json(
        { success: false, error: "Your session expired. Please sign in again." },
        { status: 401 }
      );
    }

    // When the backend stored the images it returns its own hosted URLs.
    // Prefer those so other viewers load the public copy.
    if (sync.synced && sync.raw) {
      const hostedLogo = sync.raw.logo;
      const hostedBanner = sync.raw.banner;
      if (typeof hostedLogo === "string" && /^https?:\/\//i.test(hostedLogo)) {
        patch.profilePhotoUrl = hostedLogo;
      }
      if (
        typeof hostedBanner === "string" &&
        /^https?:\/\//i.test(hostedBanner)
      ) {
        patch.bannerUrl = hostedBanner;
      }
    }

    // 2) Persist locally. This is the only home for the fields the backend
    //    does not model (contact email, channel links) and keeps the edit
    //    intact if the backend rejected the write.
    await saveChannelPatch(loaded.userId, patch);

    // Read back the merged channel so the response is the confirmed truth.
    const reloaded = await loadMergedChannel(token);
    return NextResponse.json({
      success: true,
      data: reloaded?.channel ?? loaded.channel,
      /** Tells the UI whether the change reached the public backend. */
      syncedToBackend: sync.synced,
      syncMessage: sync.synced ? "" : sync.message,
    });
  } catch (err) {
    console.error("PATCH /api/channel failed:", err);
    return NextResponse.json(
      { success: false, error: "Could not save your channel. Please try again." },
      { status: 500 }
    );
  }
}
