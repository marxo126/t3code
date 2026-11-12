import {
  type AssistantCitation,
  EnvironmentId,
  MessageId,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  ThreadId,
} from "@t3tools/contracts";
import { serializeAssistantCitation } from "@t3tools/shared/assistantCitations";
import { describe, expect, it } from "vite-plus/test";

import { assistantCitationInsertion } from "./assistantCitationInsertion";

const citation: AssistantCitation = {
  version: 1,
  environmentId: EnvironmentId.make("env"),
  threadId: ThreadId.make("thread"),
  messageId: MessageId.make("message"),
  text: "quoted text",
  start: 10,
  end: 21,
  prefix: "before ",
  suffix: " after",
};
const source = serializeAssistantCitation(citation);

describe("assistantCitationInsertion", () => {
  it("inserts the citation with spacing at the caret", () => {
    expect(assistantCitationInsertion({ text: "", start: 0, end: 0 }, citation)).toEqual({
      kind: "insert",
      value: `${source} `,
    });
    expect(assistantCitationInsertion({ text: "Explain", start: 7, end: 7 }, citation)).toEqual({
      kind: "insert",
      value: ` ${source} `,
    });
  });

  it("refuses a citation that pushes the draft over the input limit", () => {
    const text = "x".repeat(PROVIDER_SEND_TURN_MAX_INPUT_CHARS - source.length);
    expect(assistantCitationInsertion({ text, start: 0, end: 0 }, citation)).toEqual({
      kind: "too-long",
    });
  });

  it("measures the draft with citations expanded for the provider", () => {
    // Fits as an encoded link, but the provider expansion adds the quote block.
    const text = "x".repeat(PROVIDER_SEND_TURN_MAX_INPUT_CHARS - source.length - 2);
    expect(
      assistantCitationInsertion({ text, start: text.length, end: text.length }, citation),
    ).toEqual({ kind: "too-long" });
    const roomy = "x".repeat(PROVIDER_SEND_TURN_MAX_INPUT_CHARS - 2_000);
    expect(
      assistantCitationInsertion({ text: roomy, start: roomy.length, end: roomy.length }, citation)
        .kind,
    ).toBe("insert");
  });

  it("measures the raw draft, which the editor caps, not the trimmed prompt", () => {
    // Whitespace counts against the editor's limit even though sending trims it.
    const text = " ".repeat(PROVIDER_SEND_TURN_MAX_INPUT_CHARS - source.length);
    const draft = `${text}${source} `;
    expect(draft.length).toBe(PROVIDER_SEND_TURN_MAX_INPUT_CHARS + 1);
    expect(
      assistantCitationInsertion({ text, start: text.length, end: text.length }, citation),
    ).toEqual({ kind: "too-long" });
    const fits = text.slice(1);
    expect(
      assistantCitationInsertion({ text: fits, start: fits.length, end: fits.length }, citation)
        .kind,
    ).toBe("insert");
  });

  it("counts the replaced selection as removed", () => {
    const text = "y".repeat(PROVIDER_SEND_TURN_MAX_INPUT_CHARS);
    expect(assistantCitationInsertion({ text, start: 0, end: 5_000 }, citation).kind).toBe(
      "insert",
    );
  });
});
