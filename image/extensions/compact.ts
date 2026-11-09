/**
 * compact — fold a long round instead of paying a model to summarize it.
 *
 * The default compaction sends the span to the session model and keeps its prose. In geng
 * the raw session is readable through `recall(sources:["sessions"])`, so that summary buys
 * nothing and costs exactly the tokens it was meant to save. This returns a pointer and
 * keeps the round's first user message, which is the wake packet.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { compactSummary } from "./lib/compact.ts";

export default function (pi: ExtensionAPI): void {
  pi.on("session_before_compact", (event) => {
    const { preparation, branchEntries } = event;
    return {
      compaction: {
        summary: compactSummary(
          branchEntries,
          preparation.messagesToSummarize.length + preparation.turnPrefixMessages.length,
        ),
        firstKeptEntryId: preparation.firstKeptEntryId,
        tokensBefore: preparation.tokensBefore,
      },
    };
  });
}
