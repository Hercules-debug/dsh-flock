/**
 * Identifier hygiene.
 *
 * A cluster name becomes a directory name, so it must not be able to escape the
 * flock root. Kept in its own module so both the plugin entry point and the
 * tests can import it without pulling in the DSH runtime.
 */

/** Turn a caller-supplied cluster name into a safe single path segment. */
export function safeClusterId(raw) {
  const s = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s === "" ? "cluster" : s.slice(0, 40);
}
