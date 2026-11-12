import { ASSISTANT_CITATION_CONTEXT_LENGTH, type AssistantCitation } from "@t3tools/contracts";
import {
  type CodexArtifactTemplate,
  codexArtifactTemplatePresentationLabel,
} from "@t3tools/shared/codexArtifactTemplates";
import {
  renderCodexInlineDirectivesAsMarkdown,
  splitCodexArtifactTemplateMarkdown,
} from "@t3tools/shared/codexMarkdownDirectives";
import { inlineCodeFilePathCandidate } from "@t3tools/shared/markdownLinks";
import type { Nodes, RootContent } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

import { splitMarkdownDetails } from "./markdownDetails";

/**
 * Native selection menus report offsets local to one rendered text view, and each assistant
 * message renders as several of them. This module models the message's rendered text the way
 * desktop reads it (blocks joined by line breaks, whitespace normalized, UTF-16 units) so a
 * native selection can be placed in message coordinates with citation context.
 */

const parser = unified().use(remarkParse).use(remarkGfm);

/** One selectable native Markdown view, keyed the way the thread feed keys it. */
export type AssistantMarkdownViewSegment =
  | { readonly kind: "markdown"; readonly key: string; readonly markdown: string }
  | { readonly kind: "summary"; readonly text: string }
  | { readonly kind: "template"; readonly template: CodexArtifactTemplate };

export function assistantMarkdownSegmentKey(keyPrefix: string, sourceOffset: number): string {
  return `${keyPrefix}${sourceOffset}`;
}

export function assistantMarkdownDetailsKeyPrefix(keyPrefix: string, sourceOffset: number) {
  return `${keyPrefix}${sourceOffset}/`;
}

/**
 * Mirrors the feed's split: `<details>` folds first, then artifact templates. Fold bodies
 * count whether or not the fold is open, so offsets do not move when a fold toggles.
 */
export function assistantMarkdownViewSegments(
  markdown: string,
  keyPrefix = "",
): AssistantMarkdownViewSegment[] {
  const segments: AssistantMarkdownViewSegment[] = [];
  for (const block of splitMarkdownDetails(markdown)) {
    if (block.kind === "details") {
      segments.push({ kind: "summary", text: block.summary });
      segments.push(
        ...assistantMarkdownViewSegments(
          block.body,
          assistantMarkdownDetailsKeyPrefix(keyPrefix, block.sourceOffset),
        ),
      );
      continue;
    }
    for (const segment of splitCodexArtifactTemplateMarkdown(block.markdown)) {
      if (segment.kind === "artifact-template") {
        segments.push({ kind: "template", template: segment.template });
        continue;
      }
      if (segment.markdown.trim().length === 0) continue;
      segments.push({
        kind: "markdown",
        key: assistantMarkdownSegmentKey(keyPrefix, block.sourceOffset + segment.sourceOffset),
        markdown: renderCodexInlineDirectivesAsMarkdown(segment.markdown),
      });
    }
  }
  return segments;
}

const BLOCK_TYPES = new Set<string>([
  "blockquote",
  "code",
  "heading",
  "list",
  "listItem",
  "math",
  "paragraph",
  "table",
  "tableCell",
  "tableRow",
  "thematicBreak",
]);

/**
 * The iOS renderer's spacing with the mobile Markdown style: paragraphs, lists and quotes have
 * no top margin, headings and thematic breaks do, and paragraphs, headings and lists share one
 * bottom margin. A top margin larger than the previous block's bottom margin adds a spacer line.
 */
const HEADING_MARGIN_TOP = 8;
const BLOCK_MARGIN_BOTTOM = 8;

interface RawNativeView {
  readonly units: string[];
  /** Raw model offset of each native unit, or -1 for units desktop does not read. */
  readonly raw: number[];
  /** Native offset from which the reconstruction may drift from what the view draws. */
  exactUntil: number;
  /** Bottom margin of the newline that ended the previous block. */
  lastSpacing: number;
  /** The view may draw text (raw HTML, footnotes) that the model drops. */
  dropsText: boolean;
  /** HTML in the view holds blocks iOS draws as native views the model does not know. */
  splitsViews: boolean;
}

/**
 * Builds desktop's rendered text and, alongside it, each native text view's text as the iOS
 * renderer lays it out, so a native offset maps to a model offset unit by unit.
 */
class RenderedTextBuilder {
  readonly parts: string[] = [];
  readonly views: RawNativeView[] = [];
  length = 0;
  /** Raw offset from which desktop may read text the model does not reproduce. */
  desktopExactUntil = Number.POSITIVE_INFINITY;
  /** Markdown of the segment being rendered; node positions index into it. */
  source = "";
  /** A text run with a drive letter (`C:`) was seen in the current block. */
  driveSeen = false;
  private separator = false;
  private view: RawNativeView | null = null;

  block() {
    this.separator = true;
    this.driveSeen = false;
  }

  /** The segment may draw views the model does not know, so no native offset is unique. */
  nativeSplitsViews() {
    if (this.view) this.view.splitsViews = true;
  }

  /** The current view may draw text the model drops, so a unique match proves nothing. */
  nativeDropsText() {
    if (this.view) this.view.dropsText = true;
  }

  /** Where the next appended text starts. */
  nextOffset() {
    return this.separator && this.length > 0 ? this.length + 1 : this.length;
  }

  /** Appends text desktop reads. `native` is the same text as the native view draws it. */
  append(text: string, native: string | null = text) {
    if (text.length === 0) return;
    if (this.separator && this.length > 0) {
      this.parts.push("\n");
      this.length += 1;
    }
    this.separator = false;
    if (native !== null && this.view) {
      for (let index = 0; index < native.length; index += 1) {
        this.view.units.push(native[index]!);
        this.view.raw.push(this.length + index);
      }
    }
    this.parts.push(text);
    this.length += text.length;
  }

  /** Units only the native view draws: block spacers, line separators, attachments. */
  nativeOnly(units: string) {
    if (!this.view) return;
    for (const unit of units) {
      this.view.units.push(unit);
      this.view.raw.push(-1);
    }
  }

  nativeLength() {
    return this.view?.units.length ?? 0;
  }

  get lastSpacing() {
    return this.view?.lastSpacing ?? 0;
  }

  set lastSpacing(value: number) {
    if (this.view) this.view.lastSpacing = value;
  }

  ensureNativeNewline() {
    const view = this.view;
    if (!view || view.units.length === 0 || view.units[view.units.length - 1] === "\n") return;
    this.nativeOnly("\n");
    view.lastSpacing = 0;
  }

  dropLastNativeUnit() {
    this.view?.units.pop();
    this.view?.raw.pop();
  }

  /** Content the reconstruction does not model; native offsets after it are unreliable. */
  nativeInexact() {
    if (this.view) this.view.exactUntil = Math.min(this.view.exactUntil, this.view.units.length);
  }

  /** Content desktop renders differently from its Markdown; desktop offsets after it differ. */
  desktopInexact() {
    this.desktopExactUntil = Math.min(this.desktopExactUntil, this.length);
  }

  startView(exact: boolean) {
    this.view = {
      units: [],
      raw: [],
      exactUntil: exact ? Number.POSITIVE_INFINITY : 0,
      lastSpacing: 0,
      dropsText: false,
      splitsViews: false,
    };
    this.views.push(this.view);
  }

  endView() {
    this.view = null;
  }
}

/** Desktop's text for nodes no native text view draws as modelled text. */
function visit(node: Nodes, out: RenderedTextBuilder) {
  const block = BLOCK_TYPES.has(node.type);
  if (block) out.block();
  switch (node.type) {
    case "text":
    case "inlineCode":
    case "code":
      out.append(node.value);
      break;
    case "break":
      out.block();
      break;
    case "html":
      // iOS may draw the HTML's text, which then matches a quote the model only holds once.
      if (node.value.replace(/<[^>]*>/g, "").trim() !== "") out.nativeDropsText();
      // Fences, quotes and tables inside HTML become native views of their own, which may hold
      // a twin at the same offset as the matched view.
      if (/^\s*(?:```|~~~|>|\|)/m.test(node.value)) out.nativeSplitsViews();
      break;
    case "footnoteDefinition":
      out.nativeDropsText();
      break;
    case "image":
    case "imageReference":
    case "definition":
      break;
    default: {
      const value = (node as { value?: unknown }).value;
      if (typeof value === "string" && !("children" in node)) out.append(value);
      if ("children" in node) for (const child of node.children) visit(child as Nodes, out);
    }
  }
  if (block) out.block();
}

function isImageParagraph(node: RootContent): boolean {
  return (
    node.type === "paragraph" &&
    node.children.length > 0 &&
    node.children.every(
      (child) => child.type === "image" || (child.type === "text" && child.value.trim() === ""),
    )
  );
}

// Desktop draws other links (files, threads, context) as chips with labels of their own.
const WEB_URL = /^\s*(?:https?|mailto):/i;
// Native rendering turns path-like inline code into file links (see markdownForNativeRendering).
const NATIVE_FILE_LINK_CODE = /[\\/]|^[\w.-]+\.[\w-]+:\d/;

// md4c ends a drive path at whitespace, so only an unbroken `C:…\` keeps its backslashes.
const DRIVE_PATH_ESCAPE = /\b[A-Za-z]:\S*\\/;
const DRIVE_PATH_OPEN = /\b[A-Za-z]:\S*$/;

const NATIVE_SHIFTING_TEXT = /\|\||\b[A-Za-z]:[\\/]|\\|\bmodel:[\w.-]+\/[\w.-]+/;

function sourceOf(node: Nodes, out: RenderedTextBuilder): string {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  return start === undefined || end === undefined ? "" : out.source.slice(start, end);
}

function renderInline(nodes: readonly Nodes[], out: RenderedTextBuilder) {
  for (const node of nodes) {
    switch (node.type) {
      case "text":
        // Currency signs start skill mentions and inline math, which draw as attachments.
        if (/\p{Sc}/u.test(node.value)) out.nativeInexact();
        // iOS draws ||x|| as a spoiler without its bars, keeps the backslashes of Windows
        // paths in prose, and draws model mentions as one-character pills.
        if (NATIVE_SHIFTING_TEXT.test(node.value)) out.nativeInexact();
        // Markdown drops the escapes of `C:\.config` from the value, but iOS keeps them inside a
        // drive path, which may continue across inline formatting.
        {
          const source = sourceOf(node, out);
          if (DRIVE_PATH_ESCAPE.test(source) || (out.driveSeen && /^\S*\\/.test(source))) {
            out.nativeInexact();
          }
          out.driveSeen =
            DRIVE_PATH_OPEN.test(node.value) || (out.driveSeen && !/\s/.test(node.value));
        }
        // Desktop draws skill mentions as chips with display names.
        if (/\p{Sc}[\p{L}\d_-]/u.test(node.value)) out.desktopInexact();
        {
          // One unit per soft break on both sides, so native units map one-to-one onto the model.
          const value = node.value.replace(/\r\n?/g, "\n");
          out.append(value, value.replace(/\n/g, " "));
        }
        break;
      case "emphasis":
      case "strong":
      case "delete":
        renderInline(node.children, out);
        break;
      case "inlineCode": {
        if (NATIVE_FILE_LINK_CODE.test(node.value)) out.nativeInexact();
        // Desktop draws path-like inline code as a file chip with a shortened label.
        if (inlineCodeFilePathCandidate(node.value) !== null) out.desktopInexact();
        const value = node.value.replace(/\r\n?/g, "\n");
        out.append(value, value.replace(/\n/g, " "));
        break;
      }
      case "break":
        out.block();
        out.nativeOnly(" ");
        break;
      case "link":
      case "linkReference":
        // A link may draw as a one-unit pill.
        out.nativeInexact();
        if (node.type === "linkReference" || !WEB_URL.test(node.url)) out.desktopInexact();
        renderInline(node.children, out);
        break;
      default:
        // Images, footnote references and raw HTML.
        out.nativeInexact();
        if (node.type !== "image" && node.type !== "imageReference") out.desktopInexact();
        visit(node, out);
    }
  }
}

function renderList(node: Nodes & { type: "list" }, out: RenderedTextBuilder, depth: number) {
  if (depth > 0) out.ensureNativeNewline();
  for (const item of node.children) {
    out.block();
    const start = out.nativeLength();
    for (const child of item.children) {
      if (child.type === "paragraph") {
        out.block();
        const before = out.nativeLength();
        renderInline(child.children, out);
        // Tight items end the line with the item; loose paragraphs end their own.
        if (out.nativeLength() > before) out.ensureNativeNewline();
        out.block();
      } else if (child.type === "list") {
        renderList(child, out, depth + 1);
      } else {
        out.nativeInexact();
        // Code headers, alerts, HTML and footnotes render differently on desktop, as at the top level.
        if (
          child.type === "code" ||
          child.type === "html" ||
          child.type === "footnoteDefinition" ||
          (child.type === "blockquote" && isAlert(child))
        ) {
          out.desktopInexact();
        }
        visit(child, out);
      }
    }
    if (out.nativeLength() > start) out.ensureNativeNewline();
    out.block();
  }
}

/** One block of a native text view, laid out as the iOS renderer lays it out. */
function renderTextBlock(node: RootContent, out: RenderedTextBuilder) {
  switch (node.type) {
    case "paragraph": {
      if (isImageParagraph(node)) {
        // Standalone images may move to their own view.
        out.nativeInexact();
        visit(node, out);
        return;
      }
      out.block();
      const before = out.nativeLength();
      renderInline(node.children, out);
      if (out.nativeLength() > before) {
        out.nativeOnly("\n");
        out.lastSpacing = BLOCK_MARGIN_BOTTOM;
      }
      out.block();
      return;
    }
    case "heading": {
      out.block();
      out.ensureNativeNewline();
      const contentStart = out.nativeLength();
      const spacer =
        contentStart === 0 || (contentStart !== 1 && out.lastSpacing < HEADING_MARGIN_TOP);
      if (spacer) out.nativeOnly("\n");
      const before = out.nativeLength();
      renderInline(node.children, out);
      if (out.nativeLength() > before) {
        out.nativeOnly("\n");
        out.lastSpacing = BLOCK_MARGIN_BOTTOM;
      } else if (spacer && contentStart !== 0) {
        out.dropLastNativeUnit();
      }
      out.block();
      return;
    }
    case "list":
      out.block();
      renderList(node, out, 0);
      // The list's bottom margin is a spacer line of its own.
      out.nativeOnly("\n");
      out.lastSpacing = BLOCK_MARGIN_BOTTOM;
      out.block();
      return;
    case "thematicBreak":
      out.block();
      out.ensureNativeNewline();
      out.nativeOnly("￼\n");
      out.lastSpacing = 0;
      out.block();
      return;
    case "definition":
      return;
    default:
      // Raw HTML and footnote definitions, which desktop renders as their own section.
      out.nativeInexact();
      out.desktopInexact();
      visit(node, out);
  }
}

function isAlert(node: Nodes & { type: "blockquote" }): boolean {
  const first = node.children[0];
  const text = first?.type === "paragraph" ? first.children[0] : undefined;
  return text?.type === "text" && /^\[!\w+\]/.test(text.value);
}

/** Splits blocks into native views the way the iOS renderer splits them into segments. */
function renderNativeViews(
  nodes: readonly RootContent[],
  out: RenderedTextBuilder,
  exact: boolean,
) {
  let run: RootContent[] = [];
  const flush = () => {
    if (run.length === 0) return;
    out.startView(exact);
    for (const node of run) renderTextBlock(node, out);
    out.endView();
    run = [];
  };
  for (const node of nodes) {
    if (node.type === "code") {
      flush();
      // Desktop heads the block with its language or file name unless an icon stands in.
      out.desktopInexact();
      out.block();
      out.startView(exact);
      out.append(node.value);
      out.endView();
      out.block();
    } else if (node.type === "table") {
      flush();
      // Cells draw separately, so offsets inside a table cannot be placed.
      out.startView(false);
      visit(node, out);
      out.endView();
    } else if (node.type === "blockquote") {
      flush();
      out.block();
      // Desktop replaces an alert's `[!NOTE]` marker with its own label.
      if (isAlert(node)) out.desktopInexact();
      renderNativeViews(node.children, out, exact);
      out.block();
    } else {
      run.push(node);
    }
  }
  flush();
}

/** One native text view, with the model offset of each of its UTF-16 units. */
interface AssistantCitationNativeView {
  readonly text: string;
  /** Normalized model offset of each unit, or -1 for units desktop does not read. */
  readonly modelOffsets: Int32Array;
  /** Native offset from which the reconstruction may drift from what the view draws. */
  readonly exactUntil: number;
  /** The view may draw text (raw HTML, footnotes) that the model drops. */
  readonly dropsText: boolean;
  readonly splitsViews: boolean;
}

interface AssistantCitationTextSegment {
  readonly start: number;
  readonly end: number;
  readonly views: readonly AssistantCitationNativeView[];
  /** Some view of the segment may draw text the model drops. */
  readonly dropsNativeText: boolean;
}

export interface AssistantCitationTextModel {
  /** Rendered text with whitespace collapsed, as desktop citation selectors measure it. */
  readonly text: string;
  readonly segments: ReadonlyMap<string, AssistantCitationTextSegment>;
  /** Normalized offset from which desktop may read text this model does not reproduce. */
  readonly desktopExactUntil: number;
  /** Some native view may draw text (raw HTML, footnotes) that the model drops. */
  readonly dropsNativeText: boolean;
}

function normalizedOffsets(raw: string): { text: string; offsets: Int32Array } {
  const offsets = new Int32Array(raw.length + 1);
  const parts: string[] = [];
  let length = 0;
  let previousSpace = false;
  for (let index = 0; index < raw.length; index += 1) {
    offsets[index] = length;
    const space = /\s/.test(raw[index]!);
    if (space && previousSpace) continue;
    parts.push(space ? " " : raw[index]!);
    length += 1;
    previousSpace = space;
  }
  offsets[raw.length] = length;
  return { text: parts.join(""), offsets };
}

export function buildAssistantCitationTextModel(markdown: string): AssistantCitationTextModel {
  const out = new RenderedTextBuilder();
  const rawSegments = new Map<string, { start: number; end: number; views: RawNativeView[] }>();
  for (const segment of assistantMarkdownViewSegments(markdown)) {
    out.block();
    // Desktop draws the summary inside the fold's trigger button, which its selectors skip.
    if (segment.kind === "summary") continue;
    if (segment.kind === "template") {
      // Desktop's card reads its name and kind; native draws the card as no Markdown text.
      out.append(segment.template.displayName, null);
      out.block();
      out.append(codexArtifactTemplatePresentationLabel(segment.template.artifactKind), null);
      out.block();
      continue;
    }
    // The separator before a segment belongs to neither side.
    const start = out.nextOffset();
    const firstView = out.views.length;
    out.source = segment.markdown;
    renderNativeViews(parser.parse(segment.markdown).children, out, true);
    rawSegments.set(segment.key, {
      start: Math.min(start, out.length),
      end: out.length,
      views: out.views.slice(firstView),
    });
    out.block();
  }
  const raw = out.parts.join("");
  const { text, offsets } = normalizedOffsets(raw);
  const segments = new Map<string, AssistantCitationTextSegment>();
  for (const [key, range] of rawSegments) {
    segments.set(key, {
      start: offsets[range.start]!,
      end: offsets[range.end]!,
      views: range.views.map((view) => ({
        text: view.units.join(""),
        modelOffsets: Int32Array.from(view.raw, (offset) => (offset < 0 ? -1 : offsets[offset]!)),
        exactUntil: view.exactUntil,
        dropsText: view.dropsText,
        splitsViews: view.splitsViews,
      })),
      dropsNativeText: range.views.some((view) => view.dropsText),
    });
  }
  return {
    text,
    segments,
    desktopExactUntil: Number.isFinite(out.desktopExactUntil)
      ? offsets[Math.min(out.desktopExactUntil, raw.length)]!
      : Number.POSITIVE_INFINITY,
    dropsNativeText: out.views.some((view) => view.dropsText),
  };
}

function splitsSurrogatePair(text: string, offset: number): boolean {
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

export interface AssistantCitationPlacement {
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly prefix: string;
  readonly suffix: string;
}

function occurrences(text: string, quote: string, from: number, to: number): number[] {
  const found: number[] = [];
  for (
    let start = text.indexOf(quote, from);
    start !== -1 && start + quote.length <= to;
    start = text.indexOf(quote, start + 1)
  ) {
    found.push(start);
  }
  return found;
}

/**
 * Picks the occurrence the native selection covers. Each occurrence's offset in its native
 * view comes from the reconstructed view text, in the view's own coordinates (spacers and
 * attachments included), so it either equals the selection's offset or it does not.
 */
function nativeOccurrence(
  views: readonly AssistantCitationNativeView[],
  candidates: readonly number[],
  selectedText: string,
  selection: { readonly start: number; readonly end: number },
): number | null {
  if (
    !Number.isSafeInteger(selection.start) ||
    !Number.isSafeInteger(selection.end) ||
    selection.start < 0 ||
    selection.end < selection.start
  ) {
    return null;
  }
  // Leading whitespace the native view selected shifts its offset past the trimmed quote.
  const target = selection.start + selectedText.length - selectedText.trimStart().length;
  const wanted = new Set(candidates);
  const matches: number[] = [];
  const matchedViews = new Set<AssistantCitationNativeView>();
  for (const view of views) {
    for (let offset = 0; offset < view.text.length; offset += 1) {
      const modelOffset = view.modelOffsets[offset]!;
      if (!wanted.has(modelOffset) || /\s/.test(view.text[offset]!)) continue;
      // Past unmodelled content the reconstruction may drift, so no occurrence can be ruled out.
      if (offset >= view.exactUntil) return null;
      if (
        offset === target &&
        selection.end <= view.exactUntil &&
        view.text.slice(selection.start, selection.end) === selectedText
      ) {
        matches.push(modelOffset);
        matchedViews.add(view);
      }
    }
  }
  // Occurrences at the same offset of different views cannot be told apart, and a view that
  // draws text the model drops may hold an unmodelled occurrence at the selection's offset.
  if (matches.length !== 1) return null;
  if (views.some((view) => view.dropsText && !matchedViews.has(view))) return null;
  if (views.some((view) => view.splitsViews)) return null;
  return matches[0]!;
}

/**
 * Places a native selection in message coordinates. `selection` holds offsets local to one
 * text view of the `segmentKey` component; only iOS views are rebuilt to read them. Returns
 * null when the selection cannot be placed, so callers keep a context-free quote.
 */
export function placeAssistantCitationSelection(
  model: AssistantCitationTextModel,
  segmentKey: string,
  selectedText: string,
  selection: { readonly start: number; readonly end: number } | undefined,
  platform: string,
): AssistantCitationPlacement | null {
  const text = selectedText.trim();
  const quote = text.replace(/\s+/g, " ");
  if (quote.length === 0) return null;

  const segment = model.segments.get(segmentKey);
  let candidates = segment ? occurrences(model.text, quote, segment.start, segment.end) : [];
  let start: number | null;
  if (candidates.length === 0) {
    // Native text can differ from the model inside one view; a unique match is still safe.
    candidates = occurrences(model.text, quote, 0, model.text.length);
    start = candidates.length === 1 && !model.dropsNativeText ? candidates[0]! : null;
  } else if (candidates.length === 1 && !segment?.dropsNativeText) {
    start = candidates[0]!;
  } else {
    start =
      platform === "ios" && segment && selection
        ? nativeOccurrence(segment.views, candidates, selectedText, selection)
        : null;
  }
  if (start === null) return null;

  const end = start + quote.length;
  // Desktop renders something before the quote differently, so its offsets would disagree.
  if (model.desktopExactUntil < end) return null;
  let prefixStart = Math.max(0, start - ASSISTANT_CITATION_CONTEXT_LENGTH);
  // Context stops where desktop's text stops matching the model.
  let suffixEnd = Math.min(
    model.text.length,
    model.desktopExactUntil,
    end + ASSISTANT_CITATION_CONTEXT_LENGTH,
  );
  // A split pair becomes a replacement character when the context enters a URL.
  if (splitsSurrogatePair(model.text, prefixStart)) prefixStart += 1;
  if (splitsSurrogatePair(model.text, suffixEnd)) suffixEnd -= 1;
  return {
    text,
    start,
    end,
    prefix: model.text.slice(prefixStart, start),
    suffix: model.text.slice(end, suffixEnd),
  };
}

/**
 * Builds the citation for a native selection. When the selection cannot be placed, the quote
 * is kept without context and navigation falls back to finding it by text alone.
 */
export function assistantCitationFromNativeSelection(input: {
  readonly environmentId: AssistantCitation["environmentId"];
  readonly threadId: AssistantCitation["threadId"];
  readonly messageId: AssistantCitation["messageId"];
  readonly markdown: string;
  readonly segmentKey: string;
  readonly selectedText: string;
  readonly selection: { readonly start: number; readonly end: number } | undefined;
  /** `Platform.OS`; native offsets are only reconstructed for iOS. */
  readonly platform: string;
}): AssistantCitation {
  const source = {
    version: 1 as const,
    environmentId: input.environmentId,
    threadId: input.threadId,
    messageId: input.messageId,
  };
  let placement: AssistantCitationPlacement | null = null;
  try {
    placement = placeAssistantCitationSelection(
      buildAssistantCitationTextModel(input.markdown),
      input.segmentKey,
      input.selectedText,
      input.selection,
      input.platform,
    );
  } catch {
    placement = null;
  }
  if (placement) return { ...source, ...placement };
  return {
    ...source,
    text: input.selectedText,
    start: 0,
    end: input.selectedText.replace(/\s+/g, " ").length,
    prefix: "",
    suffix: "",
  };
}
