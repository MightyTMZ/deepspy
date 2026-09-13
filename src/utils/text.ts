import { createHash } from "node:crypto";

/**
 * Collapse whitespace, strip zero-width chars, normalize Unicode.
 */
export function normalizeText(raw: string): string {
  return raw
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "") // zero-width chars
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Split text into meaningful blocks (by double-newline or significant gap).
 */
export function splitBlocks(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((b) => normalizeText(b))
    .filter((b) => b.length > 0);
}

/**
 * Return new text blocks in `after` that don't appear in `before` or `seen`.
 */
export function diffText(
  before: string,
  after: string,
  seen: Set<string>,
): string[] {
  const beforeBlocks = new Set(splitBlocks(before));
  const afterBlocks = splitBlocks(after);
  const novel: string[] = [];

  for (const block of afterBlocks) {
    if (!beforeBlocks.has(block) && !seen.has(block)) {
      novel.push(block);
      seen.add(block);
    }
  }

  return novel;
}

/**
 * Deduplicate nav elements: "Home" rendered 3 times for 3 layouts => 1 entry.
 */
export function deduplicateNav(texts: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const t of texts) {
    const normalized = normalizeText(t);
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }
  return result;
}

/**
 * Hash for observation dedup and screen identification.
 */
export function textHash(text: string): string {
  return createHash("sha256").update(normalizeText(text)).digest("hex");
}
