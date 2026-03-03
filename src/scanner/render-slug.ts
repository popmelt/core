/**
 * Deterministic slug for a component render route.
 * Used by both the generator (file paths) and the sidebar (URLs).
 * Must produce the same output in Node and browser environments.
 */
export function renderSlug(filePath: string, exportName: string): string {
  const key = `${filePath}::${exportName}`;
  // djb2 hash — fast, deterministic, no crypto dependency
  let hash = 5381;
  for (let i = 0; i < key.length; i++) {
    hash = ((hash << 5) + hash + key.charCodeAt(i)) & 0xffffffff;
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
