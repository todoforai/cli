/**
 * Client credentials store — re-exported from the shared @shared/credentials
 * package (single source of truth across all TODOforAI CLIs). The store path,
 * both token shapes (URL-keyed + top-level apiToken/apiKey bridge fields) and the
 * device-session refresh all live there. This barrel keeps the CLI's local import
 * sites stable.
 */

export { readCredential, writeCredential, refreshDeviceToken } from "@shared/credentials";
