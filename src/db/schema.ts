// BharatTube reads and writes ALL of its data through the existing deployed
// backend (https://bharattube-ylmq.onrender.com/api/v1), which uses the
// existing MongoDB. The frontend defines no PostgreSQL tables.
//
// This file stays as an empty entrypoint so the template's Drizzle tooling
// resolves, without adding any build-time database dependency.
export {};
