/**
 * Pull `<script>` blocks out of a document, without a DOM.
 *
 * Nothing in this package traverses HTML — the listing-page parser wants the
 * JSON payloads Airbnb embeds in script tags and nothing else. A script
 * element's content ends at the first `</script`, by the HTML spec's own
 * rules for raw-text elements, so a non-greedy match is not an approximation
 * of a parser here; it is the same rule a parser applies. That saves
 * building a 500 KB page into a tree to read two of its leaves, and saves a
 * dependency.
 */

export interface ScriptTag {
  /** The `type` attribute, lowercased, or `''` when absent. */
  type: string;
  /** The element's raw text content. */
  text: string;
}

const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const TYPE_RE = /\btype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;

export function scriptTags(html: string): ScriptTag[] {
  const tags: ScriptTag[] = [];
  for (const match of html.matchAll(SCRIPT_RE)) {
    const attributes = match[1] ?? '';
    const type = TYPE_RE.exec(attributes);
    tags.push({
      type: (type?.[1] ?? type?.[2] ?? type?.[3] ?? '').trim().toLowerCase(),
      text: match[2] ?? '',
    });
  }
  return tags;
}
