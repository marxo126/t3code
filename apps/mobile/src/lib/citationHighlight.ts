const CODE_RANGES = /^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[^\n]*$|`[^`\n]+`/gm;
const WORD_CHAR = /[\p{L}\p{N}]/u;

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// `*` and `~` always mark emphasis; `_` only at a word edge, so snake_case stays text.
function isEmphasisMarker(markdown: string, index: number) {
  const char = markdown[index];
  if (char === "*" || char === "~") return true;
  if (char !== "_") return false;
  const before = markdown[index - 1] ?? "";
  const after = markdown[index + 1] ?? "";
  return !(WORD_CHAR.test(before) && WORD_CHAR.test(after));
}

/**
 * Wraps match `occurrence` of `quote` in `==…==` for the native renderer. Matching skips emphasis
 * markers and wraps each plain run on its own to keep the Markdown valid. Matches in code still
 * count toward `occurrence`, like rendered text, but are not highlighted.
 */
export function highlightQuoteInMarkdown(
  markdown: string,
  quote: string,
  occurrence = 0,
): string | null {
  const words = quote.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  const code = [...markdown.matchAll(CODE_RANGES)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }));
  // Words may wrap onto the next line, but never across a blank line.
  const pattern = new RegExp(words.map(escapeRegExp).join("(?:[ \\t]+|[ \\t]*\\n[ \\t]*)"), "g");
  const outsideCode = (start: number, end: number) =>
    !code.some((range) => start < range.end && end > range.start);
  const sourceIndex: number[] = [];
  let plain = "";
  for (let index = 0; index < markdown.length; index += 1) {
    if (isEmphasisMarker(markdown, index)) continue;
    sourceIndex.push(index);
    plain += markdown[index];
  }
  const match = [...plain.matchAll(pattern)][occurrence];
  if (!match) {
    // A quote with a literal `*` or `_` only matches the raw source.
    const raw = occurrence === 0 ? [...markdown.matchAll(pattern)][0] : undefined;
    if (!raw) return null;
    const end = raw.index + raw[0].length;
    if (!outsideCode(raw.index, end)) return null;
    return `${markdown.slice(0, raw.index)}==${raw[0]}==${markdown.slice(end)}`;
  }
  const start = sourceIndex[match.index]!;
  const end = sourceIndex[match.index + match[0].length - 1]! + 1;
  if (!outsideCode(start, end)) return null;
  let output = markdown.slice(0, start);
  let run = "";
  const flush = () => {
    const text = run.trim();
    if (text) {
      const leading = run.slice(0, run.indexOf(text));
      output += `${leading}==${text}==${run.slice(leading.length + text.length)}`;
    } else output += run;
    run = "";
  };
  for (let index = start; index < end; index += 1) {
    if (isEmphasisMarker(markdown, index)) {
      flush();
      output += markdown[index];
    } else run += markdown[index];
  }
  flush();
  return output + markdown.slice(end);
}
