import {
  pgTable,
  text,
  timestamp,
  jsonb,
  integer,
  uuid,
  customType,
} from "drizzle-orm/pg-core";

/** PostgreSQL `bytea` column (binary image bytes). */
const bytea = customType<{ data: Buffer; notNull: true }>({
  dataType() {
    return "bytea";
  },
});

/**
 * Channel customizations owned by this deployment.
 *
 * The external BharatTube backend (NEXT_PUBLIC_API_URL) exposes only
 *   GET  /channel/me        (read own channel)
 *   GET  /channel/:handle   (read by handle)
 *   POST /channel           (create)
 * and NO update route and NO image-upload route (verified live: every
 * PATCH/PUT/POST on /channel* and /upload* answers
 * "Route '/api/v1/...' not found").
 *
 * So the Edit channel screen persists here and is merged over the backend
 * channel on every read. The backend stays the source of truth for anything
 * it does return (subscribers, videos, views, verified); only the fields the
 * backend cannot store live in these tables.
 */
export const channelProfiles = pgTable("channel_profiles", {
  /** Stable backend user id (Mongo ObjectId string) — one row per user. */
  userId: text("user_id").primaryKey(),
  channelName: text("channel_name").notNull().default(""),
  handle: text("handle").notNull().default(""),
  description: text("description").notNull().default(""),
  contactEmail: text("contact_email"),
  profilePhotoUrl: text("profile_photo_url"),
  bannerUrl: text("banner_url"),
  links: jsonb("links")
    .$type<{ label: string; url: string }[]>()
    .notNull()
    .default([]),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * Uploaded channel images (profile photo / banner) stored as bytes so they
 * survive restarts and are served same-origin from /api/uploads/<id>.
 */
export const channelAssets = pgTable("channel_assets", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull(),
  kind: text("kind").notNull(), // "photo" | "banner"
  mimeType: text("mime_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  data: bytea("data").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
