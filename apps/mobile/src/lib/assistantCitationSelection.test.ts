import {
  ASSISTANT_CITATION_CONTEXT_LENGTH,
  EnvironmentId,
  MessageId,
  ThreadId,
} from "@t3tools/contracts";
import {
  expandAssistantCitationsForProvider,
  serializeAssistantCitation,
} from "@t3tools/shared/assistantCitations";
import { codexArtifactTemplatePresentationLabel } from "@t3tools/shared/codexArtifactTemplates";
import { describe, expect, it } from "vite-plus/test";

import {
  assistantCitationFromNativeSelection,
  assistantMarkdownViewSegments,
  buildAssistantCitationTextModel,
  placeAssistantCitationSelection,
} from "./assistantCitationSelection";

function onlyKey(markdown: string): string {
  const segment = assistantMarkdownViewSegments(markdown).find(
    (entry) => entry.kind === "markdown",
  );
  if (segment?.kind !== "markdown") throw new Error("no markdown segment");
  return segment.key;
}

function place(
  markdown: string,
  selectedText: string,
  selection: { start: number; end: number },
  key = onlyKey(markdown),
) {
  return placeAssistantCitationSelection(
    buildAssistantCitationTextModel(markdown),
    key,
    selectedText,
    selection,
    "ios",
  );
}

describe("buildAssistantCitationTextModel", () => {
  it("joins rendered blocks with one separator and drops Markdown syntax", () => {
    const model = buildAssistantCitationTextModel(
      "# Title\n\nSome **bold** and `code` with [a link](https://example.com).\n\n- one\n- two",
    );
    expect(model.text).toBe("Title Some bold and code with a link. one two");
  });

  it("counts folded content whether or not the fold is open", () => {
    const closed = buildAssistantCitationTextModel(
      "Before\n\n<details>\n<summary>More</summary>\n\nHidden body\n\n</details>\n\nAfter",
    );
    const open = buildAssistantCitationTextModel(
      "Before\n\n<details open>\n<summary>More</summary>\n\nHidden body\n\n</details>\n\nAfter",
    );
    expect(closed.text).toBe("Before Hidden body After");
    expect(open.text).toBe(closed.text);
  });
});

// Native view texts captured on an iPad simulator (iOS 27) from the component's own text
// storage, with trailing newlines trimmed as the renderer trims them.
const STEPS_MARKDOWN = Array.from(
  { length: 10 },
  (_, step) => `## Step ${step}\n\n- Run it.\n- Check it.`,
).join("\n\n---\n\n");
const STEPS_NATIVE = `\n${Array.from(
  { length: 10 },
  (_, step) => `Step ${step}\nRun it.\nCheck it.`,
).join("\n\n\uFFFC\n\n")}`;

function nativeTexts(markdown: string) {
  return [...buildAssistantCitationTextModel(markdown).segments.values()].flatMap((segment) =>
    // Table cells draw on their own and are never placed, so they are left out.
    segment.views.flatMap((view) => (view.exactUntil > 0 ? [view.text.replace(/\n+$/, "")] : [])),
  );
}

describe("native view reconstruction", () => {
  it("reproduces the text iOS draws, spacers and attachments included", () => {
    expect(nativeTexts(STEPS_MARKDOWN)).toEqual([STEPS_NATIVE]);
    expect(
      nativeTexts(
        [
          "# Notes",
          "Alpha ok.",
          "- one ok\n- two ok",
          "Beta ok.",
          "---",
          "## Next",
          "Gamma ok.  \nDelta ok.",
          "> Quote ok.\n>\n> Second ok.",
          "Epsilon ok.",
          "1. First ok\n   - nested ok\n2. Second ok",
          "Zeta  ok.",
        ].join("\n\n"),
      ),
    ).toEqual([
      "\nNotes\nAlpha ok.\none ok\ntwo ok\n\nBeta ok.\n\uFFFC\n\nNext\nGamma ok.\u2028Delta ok.",
      "Quote ok.\nSecond ok.",
      "Epsilon ok.\nFirst ok\nnested ok\nSecond ok\n\nZeta  ok.",
    ]);
    expect(
      nativeTexts(
        "Intro ok.\n\n```ts\nconst ok = 1;\n```\n\nAfter ok.\n\n| a | b |\n| - | - |\n| ok | 2 |\n\nTail ok.\n\n## Head ok\n\n### Sub ok\n\nLast ok.",
      ),
    ).toEqual(["Intro ok.", "const ok = 1;", "After ok.", "Tail ok.\nHead ok\nSub ok\nLast ok."]);
    // Paragraphs alone add no spacers: "is" in "Item 25 is ok." was reported at 373.
    const items = Array.from({ length: 30 }, (_, item) => `Item ${item} is ok.`);
    expect(nativeTexts(items.join("\n\n"))).toEqual([items.join("\n")]);
  });
});

describe("placeAssistantCitationSelection", () => {
  it("places a single passage at its message offset with context", () => {
    const markdown = "First paragraph here.\n\nThe second paragraph quotes something.";
    const placement = place(markdown, "quotes", { start: 18, end: 24 });
    expect(placement).toEqual({
      text: "quotes",
      start: "First paragraph here. The second paragraph ".length,
      end: "First paragraph here. The second paragraph quotes".length,
      prefix: "First paragraph here. The second paragraph ".slice(
        -ASSISTANT_CITATION_CONTEXT_LENGTH,
      ),
      suffix: " something.",
    });
    expect(placement?.start).not.toBe(0);
  });

  it("tells repeated text within one block apart by its native offset", () => {
    const markdown = "Use the cache. Then use the cache again.";
    const first = place(markdown, "the cache", { start: 4, end: 13 });
    const second = place(markdown, "the cache", { start: 24, end: 33 });
    expect(first?.start).toBe(4);
    expect(second?.start).toBe(24);
    expect(first?.suffix.startsWith(". Then")).toBe(true);
    expect(second?.suffix.startsWith(" again")).toBe(true);
  });

  it("tells repeated text across blocks apart, keeping both citations distinct", () => {
    const markdown = "Run the tests.\n\n- Run the tests.\n- Ship it.";
    const first = place(markdown, "Run the tests.", { start: 0, end: 14 });
    // The list item sits on the next line of the same native text view.
    const second = place(markdown, "Run the tests.", { start: 15, end: 29 });
    expect(first?.start).toBe(0);
    expect(second?.start).toBe(15);

    const citation = (placement: NonNullable<typeof first>) =>
      serializeAssistantCitation({
        version: 1,
        environmentId: EnvironmentId.make("env"),
        threadId: ThreadId.make("thread"),
        messageId: MessageId.make("message"),
        ...placement,
      });
    const one = citation(first!);
    const two = citation(second!);
    expect(one).not.toBe(two);
    // Different occurrences are separate sources for the provider, not one deduplicated quote.
    const expanded = expandAssistantCitationsForProvider(`${one} ${two}`);
    expect(expanded).toContain("[assistant-quote-1] [assistant-quote-2]");
  });

  it("resolves native offsets that restart after a table", () => {
    const markdown = [
      "Please check the log.",
      "",
      "| a | b |",
      "| - | - |",
      "| 1 | 2 |",
      "",
      "Now check the log.",
    ].join("\n");
    const model = buildAssistantCitationTextModel(markdown);
    // The paragraph after the table is its own native view, so its offsets restart at 0.
    const after = placeAssistantCitationSelection(
      model,
      onlyKey(markdown),
      "check the log.",
      {
        start: 4,
        end: 18,
      },
      "ios",
    );
    const before = placeAssistantCitationSelection(
      model,
      onlyKey(markdown),
      "check the log.",
      {
        start: 7,
        end: 21,
      },
      "ios",
    );
    expect(after?.start).toBe(model.text.lastIndexOf("check the log."));
    expect(before?.start).toBe(7);
  });

  it("places a selection by the native view's own offsets, not the model's", () => {
    // "Run" under Step 6 was reported at native offset 182; spacers before each heading and
    // after each list and rule shift it 25 units past its model offset. The model offset of
    // Step 7's "Run" is 182, so comparing model offsets would cite the wrong step.
    const model = buildAssistantCitationTextModel(STEPS_MARKDOWN);
    expect(STEPS_NATIVE.indexOf("Step 6\nRun") + "Step 6\n".length).toBe(182);
    const step = (index: number) =>
      model.text.indexOf(`Step ${index} Run`) + `Step ${index} `.length;
    expect(step(7)).toBe(182);
    const placement = place(STEPS_MARKDOWN, "Run", { start: 182, end: 185 });
    expect(placement).toMatchObject({ start: step(6), end: step(6) + 3 });
    expect(placement?.prefix.endsWith("Step 6 ")).toBe(true);
    expect(place(STEPS_MARKDOWN, "Run", { start: 8, end: 11 })?.start).toBe(step(0));
    // An offset no occurrence sits at means the reconstruction is off; nothing is guessed.
    expect(place(STEPS_MARKDOWN, "Run", { start: 157, end: 160 })).toBeNull();
  });

  it("only reconstructs iOS views; elsewhere repeated text is not placed", () => {
    const markdown = "Use the cache. Then use the cache again.";
    const key = onlyKey(markdown);
    const model = buildAssistantCitationTextModel(markdown);
    expect(
      placeAssistantCitationSelection(model, key, "the cache", { start: 24, end: 33 }, "android"),
    ).toBeNull();
    expect(
      placeAssistantCitationSelection(model, key, "Then", { start: 15, end: 19 }, "android")?.start,
    ).toBe(15);
  });

  it("refuses repeated text once unmodelled content shifts the native view", () => {
    // A link may draw as a one-unit pill, so offsets after it are unknown.
    const markdown = "See [the docs](https://example.com/docs). Use the cache. Use the cache.";
    expect(place(markdown, "Use the cache.", { start: 42, end: 56 })).toBeNull();
  });

  it("refuses repeated text after spoilers, Windows paths and model mentions", () => {
    // iOS draws ||x|| as a spoiler without the bars, so offsets after it shift by 4.
    expect(place("Say ||hi|| yes yes", "yes", { start: 11, end: 14 })).toBeNull();
    expect(place("Say ||hi|| yes yes", "yes", { start: 15, end: 18 })).toBeNull();
    // iOS keeps the backslashes of a Windows path in prose; the Markdown model drops escapes.
    expect(place("Open C:\\me\\x then yes yes", "yes", { start: 22, end: 25 })).toBeNull();
    // Model mentions draw as one-character pills.
    expect(place("Ask model:codex/gpt then yes yes", "yes", { start: 29, end: 32 })).toBeNull();
    // Unique text is still placed.
    expect(place("Say ||hi|| yes no", "no", { start: 11, end: 13 })?.start).toBe(15);
  });

  it("refuses to guess between occurrences at the same native offset", () => {
    const markdown = ["Check the log.", "", "```", "code", "```", "", "Check the log."].join("\n");
    // Both sit at offset 0 of their own native view; picking one could cite the wrong claim.
    expect(place(markdown, "Check the log.", { start: 0, end: 14 })).toBeNull();
  });

  it("uses the selected native view inside a fold", () => {
    const markdown = [
      "Retry the job.",
      "",
      "<details>",
      "<summary>Log</summary>",
      "",
      "Retry the job.",
      "",
      "</details>",
    ].join("\n");
    const segments = assistantMarkdownViewSegments(markdown);
    const keys = segments.flatMap((segment) => (segment.kind === "markdown" ? [segment.key] : []));
    expect(keys).toHaveLength(2);
    const model = buildAssistantCitationTextModel(markdown);
    const outside = placeAssistantCitationSelection(
      model,
      keys[0]!,
      "Retry the job.",
      {
        start: 0,
        end: 14,
      },
      "ios",
    );
    const inside = placeAssistantCitationSelection(
      model,
      keys[1]!,
      "Retry the job.",
      {
        start: 0,
        end: 14,
      },
      "ios",
    );
    expect(outside?.start).toBe(0);
    // Desktop skips the summary, which sits inside the fold's trigger button.
    expect(model.text).toBe("Retry the job. Retry the job.");
    expect(inside).toMatchObject({ start: 15, end: 29, prefix: "Retry the job. " });
  });

  it("collapses whitespace the way desktop selectors measure it", () => {
    const markdown = "Alpha\nbeta gamma.\n\nDelta.";
    const placement = place(markdown, "beta gamma.\n\nDelta", { start: 6, end: 24 });
    expect(placement).toMatchObject({ start: 6, end: 6 + "beta gamma. Delta".length });
    expect(placement?.text).toBe("beta gamma.\n\nDelta");
  });

  it("returns null so callers fall back when the quote cannot be placed", () => {
    expect(place("Some text.", "not in the message", { start: 0, end: 18 })).toBeNull();
    expect(place("Some text.", "   ", { start: 0, end: 3 })).toBeNull();
    // Repeated text without a native offset is ambiguous.
    expect(
      placeAssistantCitationSelection(
        buildAssistantCitationTextModel("one one"),
        "missing",
        "one",
        undefined,
        "ios",
      ),
    ).toBeNull();
  });

  it("accepts a unique quote even when the native view key is unknown", () => {
    expect(place("Only once here.", "once", { start: 5, end: 9 }, "missing")?.start).toBe(5);
  });
});

describe("placement edge cases", () => {
  it("moves past leading whitespace the native selection included", () => {
    // The selection starts on the newline before "Run", one unit before the quote.
    expect(place(STEPS_MARKDOWN, "\nRun", { start: 181, end: 185 })).toMatchObject({
      text: "Run",
      start: buildAssistantCitationTextModel(STEPS_MARKDOWN).text.indexOf("Step 6 Run") + 7,
    });
  });

  it("does not cut a surrogate pair at either end of the context", () => {
    const before = `\u{1F600}${"a".repeat(31)}QUOTE`;
    expect(place(before, "QUOTE", { start: 33, end: 38 })).toMatchObject({
      start: 33,
      prefix: "a".repeat(31),
    });
    const after = `QUOTE${"b".repeat(31)}\u{1F600}`;
    expect(place(after, "QUOTE", { start: 0, end: 5 })).toMatchObject({
      start: 0,
      suffix: "b".repeat(31),
    });
  });

  it("requires the rebuilt view to hold the selected text at the selection", () => {
    // The offset matches an occurrence, but the range does not hold the quote there.
    const markdown = "Use the cache. Then use the cache again.";
    expect(place(markdown, "the cache", { start: 24, end: 33 })?.start).toBe(24);
    expect(place(markdown, "the cache", { start: 24, end: 40 })).toBeNull();
  });

  it("only falls back to the whole message for a quote found there once", () => {
    // An unknown view key leaves no view to read offsets in.
    expect(
      place("Same text. Same text.", "Same text.", { start: 0, end: 10 }, "missing"),
    ).toBeNull();
  });

  it("treats a CRLF soft break as the one space iOS draws", () => {
    const markdown = "a\r\nb\r\nc\r\nd\r\nyes yes";
    expect(place(markdown, "yes", { start: 12, end: 15 })?.start).toBe(12);
    expect(place(markdown, "yes", { start: 8, end: 11 })?.start).toBe(8);
  });

  it("refuses repeated text after a Windows path whose escapes Markdown drops", () => {
    const markdown = "Open C:\\.config\\.cache\\.local\\.bin " + "x".repeat(40) + " yes yes";
    expect(place(markdown, "yes", { start: 76, end: 79 })).toBeNull();
    expect(place("Open C:\\.config\\_x aaaa", "a", { start: 21, end: 22 })).toBeNull();
  });

  it("checks a unique match against the native offset when raw HTML may draw text", () => {
    const markdown = 'Intro. Run the tests.\n\n<div align="center">Run the tests.</div>\n\nDone.';
    // The selection is the HTML's copy, which the model does not hold.
    expect(place(markdown, "Run the tests.", { start: 22, end: 36 })).toBeNull();
    expect(place(markdown, "Run the tests.", { start: 7, end: 21 })?.start).toBe(7);
    const model = buildAssistantCitationTextModel(markdown);
    expect(
      placeAssistantCitationSelection(
        model,
        onlyKey(markdown),
        "Run the tests.",
        { start: 7, end: 21 },
        "android",
      ),
    ).toBeNull();
  });

  it("stops desktop context at a code block inside a list item", () => {
    const markdown = "1. Do this:\n\n   ```ts\n   x\n   ```\n2. Run it. Run it.";
    // Desktop heads the code with its language, so its offsets differ from "Do this:" on.
    expect(buildAssistantCitationTextModel(markdown).desktopExactUntil).toBe("Do this:".length);
    expect(place(markdown, "Run it.", { start: 0, end: 7 })).toBeNull();
  });

  it("keeps placing text after a plain blockquote inside a list item", () => {
    const markdown = "1. Item\n\n   > quoted\n2. Next\n\nTail text here.";
    expect(buildAssistantCitationTextModel(markdown).desktopExactUntil).toBe(
      Number.POSITIVE_INFINITY,
    );
  });

  it("refuses a match whose twin may sit in another view's raw HTML", () => {
    const markdown = "Run the tests.\n\n```\nx\n```\n\n<div>Run the tests.</div>";
    expect(place(markdown, "Run the tests.", { start: 0, end: 14 })).toBeNull();
  });

  it("ignores HTML without text, such as generics in prose", () => {
    const markdown = "Returns Promise<void> here.\n\nThen more.";
    const model = buildAssistantCitationTextModel(markdown);
    expect(model.dropsNativeText).toBe(false);
    // Text before the HTML is still placed off iOS, where no native view is read.
    expect(
      placeAssistantCitationSelection(
        model,
        onlyKey(markdown),
        "Returns",
        { start: 0, end: 7 },
        "android",
      )?.start,
    ).toBe(0);
  });

  it("keeps placing repeated text after ordinary Markdown escapes", () => {
    const markdown = "Use \\*literal\\* stars. yes yes";
    expect(place(markdown, "yes", { start: 21, end: 24 })?.start).toBe(21);
    expect(place(markdown, "yes", { start: 25, end: 28 })?.start).toBe(25);
  });

  it("only keeps refusing after a backslash while a drive path runs on", () => {
    // Native text drops the escapes: the second "yes" sits at its rendered offset.
    for (const [markdown, rendered] of [
      ["Q: Use \\*literal\\* stars? yes yes", "Q: Use *literal* stars? yes yes"],
      ["Use \\_x\\_ then option B: yes yes", "Use _x_ then option B: yes yes"],
    ] as const) {
      const at = rendered.lastIndexOf("yes");
      expect(place(markdown, "yes", { start: at, end: at + 3 })?.start).toBe(at);
    }
    // The path continues across emphasis, so the backslash after it still shifts the view.
    expect(place("Open C:*\\.x* then yes yes", "yes", { start: 18, end: 21 })).toBeNull();
  });

  it("refuses when HTML holds a fence iOS draws as a view of its own", () => {
    const markdown = "Run the tests.\n\n<div>\n```\nRun the tests.\n```\n</div>";
    expect(place(markdown, "Run the tests.", { start: 0, end: 14 })).toBeNull();
  });

  it("does not place a unique quote when a footnote's text may draw natively", () => {
    const markdown = "See note.[^1] Done.\n\n[^1]: Done.";
    expect(buildAssistantCitationTextModel(markdown).dropsNativeText).toBe(true);
  });

  it("treats a CRLF inside inline code as the one space iOS draws", () => {
    const markdown = "`a\r\nb` xx";
    expect(place(markdown, "x", { start: 5, end: 6 })?.start).toBe(5);
  });

  it("refuses repeated text after a standalone image, which may draw in its own view", () => {
    const markdown = "Check this.\n\n![diagram](diagram.png)\n\nCheck this.";
    expect(place(markdown, "Check this.", { start: 0, end: 11 })).toBeNull();
    expect(place(markdown, "Check this.", { start: 13, end: 24 })).toBeNull();
  });
});

describe("text desktop renders but Markdown does not spell out", () => {
  const TEMPLATE =
    '::artifact-template{skill_name="artifact-template-hello-world" skill_directory="/Users/test/.codex/skills/artifact-template-hello-world" display_name="Hello World" artifact_kind="document"}';

  it("counts an artifact template card's name and kind, as desktop's card shows them", () => {
    const markdown = `Pick one.\n\n${TEMPLATE}\n\nThen pick one.`;
    const model = buildAssistantCitationTextModel(markdown);
    const label = codexArtifactTemplatePresentationLabel("document");
    expect(model.text).toBe(`Pick one. Hello World ${label} Then pick one.`);
    const keys = assistantMarkdownViewSegments(markdown).flatMap((segment) =>
      segment.kind === "markdown" ? [segment.key] : [],
    );
    expect(
      placeAssistantCitationSelection(model, keys[1]!, "pick one.", { start: 5, end: 14 }, "ios"),
    ).toMatchObject({
      start: model.text.lastIndexOf("pick one."),
      prefix: `Hello World ${label} Then `.slice(-ASSISTANT_CITATION_CONTEXT_LENGTH),
    });
  });

  it("falls back after content desktop labels on its own", () => {
    const cases = [
      // File links and path-like inline code become chips with shortened labels.
      "Open [the file](src/lib/thing.ts) now. Unique words here.",
      "Open `apps/mobile/src/lib/thing.ts` now. Unique words here.",
      // A code block gets a language header.
      "```ts\nconst a = 1;\n```\n\nUnique words here.",
      // Footnote references render as numbered links, and alerts with their own label.
      "See this[^1]. Unique words here.\n\n[^1]: A note.",
      "> [!NOTE]\n> Mind this.\n\nUnique words here.",
      "Run $deploy first. Unique words here.",
    ];
    for (const markdown of cases) {
      const model = buildAssistantCitationTextModel(markdown);
      expect(model.text).toContain("Unique words here.");
      expect(
        placeAssistantCitationSelection(
          model,
          onlyKey(markdown),
          "Unique words",
          { start: 0, end: 12 },
          "ios",
        ),
        markdown,
      ).toBeNull();
    }
  });

  it("keeps placing text before such content, with context cut where it starts", () => {
    const markdown = "Unique words here, then [the file](src/lib/thing.ts).";
    const placement = place(markdown, "Unique words", { start: 0, end: 12 });
    expect(placement).toMatchObject({ start: 0, end: 12, suffix: " here, then " });
    // Web links read the same on desktop.
    expect(
      place("Read [the docs](https://example.com). Unique words here.", "Unique words", {
        start: 0,
        end: 12,
      })?.start,
    ).toBe("Read the docs. ".length);
  });
});

describe("assistantCitationFromNativeSelection", () => {
  const source = {
    environmentId: EnvironmentId.make("env"),
    threadId: ThreadId.make("thread"),
    messageId: MessageId.make("message"),
  };

  it("cites the selected occurrence at its message offset", () => {
    const markdown = "Use the cache. Then use the cache again.";
    expect(
      assistantCitationFromNativeSelection({
        ...source,
        markdown,
        segmentKey: onlyKey(markdown),
        selectedText: "the cache",
        selection: { start: 24, end: 33 },
        platform: "ios",
      }),
    ).toEqual({
      version: 1,
      ...source,
      text: "the cache",
      start: 24,
      end: 33,
      prefix: "Use the cache. Then use ",
      suffix: " again.",
    });
  });

  it("keeps the previous context-free quote when placement fails", () => {
    expect(
      assistantCitationFromNativeSelection({
        ...source,
        markdown: "one one",
        segmentKey: "missing",
        selectedText: "one",
        selection: undefined,
        platform: "ios",
      }),
    ).toEqual({ version: 1, ...source, text: "one", start: 0, end: 3, prefix: "", suffix: "" });
  });
});
