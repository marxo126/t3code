import { type AssistantCitation, PROVIDER_SEND_TURN_MAX_INPUT_CHARS } from "@t3tools/contracts";
import {
  expandAssistantCitationsForProvider,
  serializeAssistantCitation,
} from "@t3tools/shared/assistantCitations";

export interface AssistantCitationInsertionTarget {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

export type AssistantCitationInsertion =
  | { readonly kind: "insert"; readonly value: string }
  | { readonly kind: "too-long" };

/**
 * The text to insert for a citation at the composer's caret, or `too-long` when the
 * resulting prompt would exceed the provider input limit. Measures the untrimmed draft,
 * which the native editor caps, and the citations expanded for the provider, as web's
 * send check does.
 */
export function assistantCitationInsertion(
  target: AssistantCitationInsertionTarget,
  citation: AssistantCitation,
): AssistantCitationInsertion {
  const start = Math.max(0, Math.min(target.start, target.text.length));
  const end = Math.max(start, Math.min(target.end, target.text.length));
  const prefix = start > 0 && !/\s/.test(target.text[start - 1]!) ? " " : "";
  const value = `${prefix}${serializeAssistantCitation(citation)} `;
  const draft = target.text.slice(0, start) + value + target.text.slice(end);
  // The editor caps the raw draft, while sending trims it and expands citations.
  const inputLength = Math.max(
    draft.length,
    expandAssistantCitationsForProvider(draft.trim()).length,
  );
  return inputLength > PROVIDER_SEND_TURN_MAX_INPUT_CHARS
    ? { kind: "too-long" }
    : { kind: "insert", value };
}
