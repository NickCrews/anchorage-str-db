/**
 * Extract `<script>` blocks from a document without a DOM parser.
 *
 * Per the HTML spec, a script element's content ends at the first
 * `</script`, so a non-greedy regex matches exactly what a parser would.
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
