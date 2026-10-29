# Chat feature recommendations

These are recommendations from two independent code reviews, not newly implemented features.
They build on the bot's current message routing, AI tools and opt-in group context archive.

## User-facing features

| Priority | Feature | Example | Scope and foundations |
|---|---|---|---|
| 1 | Time-range catch-up | “What did I miss since yesterday?” | Medium. Retrieve a bounded date range from the archive and report topics, decisions and open questions. Clearly state capture gaps. Requires group context capture. |
| 2 | Explicit reply preferences | `!prefs language Arabic`, `!prefs length short` | Small. Add validated per-person language, dialect and length settings to prompt construction, with show/reset commands. |
| 3 | Shared lists and assigned tasks | “Add drinks to our picnic list”; “Assign transport to @Ahmed” | Medium. Add deterministic CRUD tools, group-scoped storage, authorship and assignment permissions. Confirm tasks instead of inferring permanent commitments from casual conversation. |
| 4 | Persistent reminders | “Remind me tomorrow at 8 PM to call Ahmed” | Medium–large. Add durable scheduled jobs, timezone preferences, list/cancel/snooze commands, reconnect retries and delivery deduplication. Resolve ambiguous times before scheduling. |
| 5 | Voice-note output modes | `!transcribe`, `!voice summary`, “Extract the tasks” | Small–medium. Reuse Gemini audio input and add explicit output modes. Transcript capture needs a clear opt-in and the same retention controls; passive audio currently leaves only a placeholder. |
| 6 | Group polls | `!poll "When?" Friday \| Saturday` | Medium. Store poll IDs, choices, voter identities and closing times. Use explicit vote commands to avoid collisions with numeric download-quality selections. |
| 7 | Saved decisions and messages | Reply with `!save trip-plan` | Medium. Save explicit confirmed decisions with source author, date and quote. Define retention/deletion separately so saving does not silently defeat ordinary chat expiry. |

Start with catch-up and reply preferences, then shared tasks and reminders.
No new external service is inherently required for these features.

## Better context and recall

1. **Show context coverage — small scope.** Extend `!context status` with capture start,
   oldest retained message, last successful summary, backlog and archive-limit gaps.
   This lets replies explain what history was actually available.
2. **Improve Arabic and mixed-language search — small–medium scope.** Add conservative
   diacritic/tatweel normalization, phrase matching and common-word weighting while
   retaining the original text for evidence. Exact token matching currently misses
   equivalent spellings; semantic search can be considered after measuring this.
3. **Show evidence for historical answers — small–medium scope.** Return a short quote,
   speaker and timestamp for claims about dates or agreements. Distinguish summary
   evidence from original messages, and avoid presenting missing context as certainty.
4. **Let users focus a thread — medium scope.** A reply-based focus command can prefer
   reply ancestors and descendants over unrelated group traffic. Explicit reply
   references are more dependable than automatic topic classification.
5. **Add individual capture controls — medium scope.** Member-scoped status, opt-out and
   deletion need verified identities, quote handling and summary provenance. Removing
   raw messages alone would leave their contents in derived summaries.
6. **Track corrections and summary sources — medium scope.** Preserve corrections as
   attributed evidence, attach source references to summaries and regenerate affected
   batches. A correction must not silently rewrite another member's statement.

Recommended order: coverage visibility, Arabic search, evidence-backed recall, thread
focus, then individual controls and correction provenance.
