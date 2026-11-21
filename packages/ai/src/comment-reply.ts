import type { CreatorContext, DraftInput } from "./types";

/**
 * What the worker (first draft) and the API (draft again) ask the pipeline
 * for a comment lead: the comment is the one inbound, untrusted message, and
 * the creator's offers answer it. It drafts only; a person sends.
 */
export function commentReplyInput(creator: CreatorContext, comment: { text: string; keyword: string }): DraftInput {
  return {
    kind: "reply",
    classificationLabel: null,
    threadHistory: [{ direction: "inbound", text: comment.text }],
    creator,
    comment: { keyword: comment.keyword },
  };
}
