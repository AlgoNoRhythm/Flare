/**
 * The app's version, written down once.
 *
 * It was in two places: `package.json`, which is what the installer and the
 * filenames get, and a string literal in the MCP server's `serverInfo`, which
 * is what an agent sees when it connects. Nothing kept them in step, and the
 * failure mode is quiet — a release named 1.0.0 whose endpoint introduces
 * itself as 0.1.0 is not wrong in any way that breaks, so nobody finds out
 * until they are already debugging something else and the version misleads
 * them.
 *
 * `tests/version.test.ts` asserts this equals the manifest, so the two cannot
 * drift again without the suite saying so.
 */
export const APP_VERSION = '1.1.0';
