import { getChannelAsset } from "@/lib/channel-store";

export const dynamic = "force-dynamic";

/**
 * GET /api/uploads/<id> — serves a stored channel image (profile photo or
 * banner). Assets are immutable once written, so responses are cached hard.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const asset = await getChannelAsset(id);
  if (!asset) {
    return new Response("Not found", { status: 404 });
  }

  return new Response(new Uint8Array(asset.data), {
    status: 200,
    headers: {
      "Content-Type": asset.mimeType || "application/octet-stream",
      "Content-Length": String(asset.sizeBytes),
      "Cache-Control": "public, max-age=31536000, immutable",
      ETag: `"${asset.id}"`,
    },
  });
}
