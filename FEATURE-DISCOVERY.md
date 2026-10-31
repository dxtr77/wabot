# Feature discovery

Reviewed 29 October 2026. These are proposals, not implemented commands. This
report refines the earlier `FEATURE-RECOMMENDATIONS.md` against the current source.
No production data, credentials or external APIs were accessed; no services were
changed. Effort is relative implementation scope, including the checks below.

## Already available

- Opt-in group capture, the last 30 messages with authors, reply ancestors,
  older summaries, and group-scoped keyword/date/author search.
- Personal facts, manual remember/forget/reset, and revision guards against
  stale memory extraction and context replies.
- Current and quoted images, GIF-style videos, stickers and audio; explicit
  transcription; silent sticker-only reactions.
- Key rotation, model fallback, cooldowns, limited tool execution and access rules.
- Owner-managed morning/evening/bedtime adhkar and Friday reading reminders,
  independent durable delivery claims, and test previews.
- YouTube quality selection, downloading and caption summaries, with anonymous
  extraction before compatible cookie retries where needed.
- Tavily image search with Commons fallback, content-based duplicate filtering,
  recent-send history per chat, **five images maximum per call**, and **no captions**.

These are foundations to extend, not new feature recommendations.

## Prioritized additions

### 1. Catch-up summaries with visible history coverage — medium

**Example:** `!catchup 24h` → topics, confirmed decisions and open questions, with
speaker/time evidence and the actual covered interval. Show any missing history.

**Benefit:** People can rejoin a busy group without asking the bot several recall
questions. **Gap:** `src/context/store.js:125` supports date-filtered search but
caps retrieval at ten messages; `src/context/service.js:73` asks for only five.
`src/commands/context.js:10` reports counts, not capture start or archive gaps.
Add bounded chronological range retrieval rather than summarizing a handful of
ranked search hits. Require existing group capture and preserve retention rules.

**Verify:** A range with over ten messages includes its early and late decisions;
cross-group access fails; capture starting halfway through the requested range is
disclosed; clear/off during generation invalidates the result.

### 2. Explicit language, dialect and reply-length preferences — small

**Example:** `!prefs language Arabic`, `!prefs dialect Sudanese`, `!prefs length short`,
plus show/reset. These are deterministic settings belonging to the sender.

**Benefit:** Consistent, more natural answers without repeatedly requesting the
same style. **Gap:** `src/ai/chat.js:27` builds prompts from free-form personal
facts and the global soul; `src/commands/router.js:16` has no preferences command.
Keep preferences separate from extracted facts and subordinate to authorization
and factual accuracy. Define whether a current explicit request overrides them.

**Verify:** Same-name users have separate preferences; settings persist across a
reload; invalid values are rejected; reset restores defaults; an English request
can override a saved Arabic default for that turn.

### 3. Personal and group event reminders — medium–large

**Example:** “Remind me tomorrow at 8 PM to call Ahmed,” with list, cancel and snooze.
Confirm resolved date/time/timezone before committing an ambiguous request.

**Benefit:** Turn group plans and personal requests into useful follow-through.
**Gap:** `src/reminders/store.js:66` and `src/reminders/scheduler.js:22` model four
fixed religious periods, not arbitrary jobs. Add a separate job store and scheduler;
reuse their claim-before-send and uncertain-delivery patterns without changing
existing adhkar behavior. Group-wide reminder policy should remain owner-controlled.

**Verify:** Restart, timezone/DST boundaries, offline reconnect and duplicate ticks
do not repeat a job; cancellation invalidates a pending send; users cannot cancel
another person's reminder; uncertain delivery is reported without blind retry.

### 4. Cancel and inspect queued work — medium

**Example:** `!jobs` and `!cancel <id>` for the sender's queued AI/download work.
Show queued, running, awaiting selection and completed states consistently.

**Benefit:** Users can correct an accidental download or stop waiting behind an
obsolete request. **Gap:** `src/ai/chat.js:119` chains turns without a user-visible
job handle; `src/commands/download.js:16` has a queue and pending selections, while
the router exposes no cancel command. Provider transport cancellation already
exists in `src/ai/providers/gemini.js:71`, but still needs end-to-end job ownership
and pre-send cancellation guards. Stopping local work cannot promise a refund or
undo a message/tool side effect already completed.

**Verify:** Cancel queued and running jobs separately; prevent late replies/uploads;
release download slots and temporary files; deny cancellation across users/groups;
keep the queue usable after cancellation or failure.

### 5. Group quiet hours and feature switches — medium

**Example:** Owner-only `!group quiet 23:00 07:00 Asia/Kolkata` and
`!group images off`, without disabling useful text chat.

**Benefit:** Keep the bot helpful without filling a group with media or overnight
responses. **Gap:** `src/commands/admin.js:75` stores group enablement as a boolean;
`src/messages/handler.js:186` routes addressed messages without a quiet schedule.
Define precedence explicitly for commands, autonomous reminders and owner overrides.
Enforce disabled features both in direct handlers and AI tool visibility/execution.

**Verify:** Overnight/timezone boundaries, owner-only changes, and independent group
settings; hidden tools also fail if called directly; existing azkar slots obey the
documented quiet-hours policy without resetting delivery claims.

### 6. Shared task lists with explicit assignment — medium

**Example:** `!task add Bring drinks`, `!task assign 12 @Ahmed`, `!task done 12`.
Store author, assignee, creation time and completion history per group.

**Benefit:** Preserve actionable plans beyond ordinary conversational recall.
**Gap:** The router and `src/ai/tools/registry.js` contain no task/list capability;
`src/context/store.js:52` intentionally expires discussion. Task persistence should
be explicit, with its own retention/deletion policy. Casual jokes or historical
messages must not create tasks, and assignments must use verified WhatsApp identities.

**Verify:** Duplicate tool calls create one task; same-name members remain distinct;
members cannot edit another group's tasks; completion permissions and deletion
work after restart; expired discussion is not silently restored by a task.

### 7. More reliable Arabic and mixed-language recall — small–medium

**Example:** A search for an unvowelled Arabic word can find its vocalized form,
while the response still quotes the exact original message.

**Benefit:** Fewer “I cannot find that” answers in the language already used by the
group. **Gap:** `src/context/store.js:6` uses lowercase/NFKC and token matching;
`:136` scores only exact tokens. Add a separate conservative search normalization
for diacritics/tatweel, then phrase and exact-match weighting. Avoid aggressive
stemming or semantic infrastructure until a small evaluation set shows the need.

**Verify:** Paired Arabic spellings, Arabic/English mixed messages, names, numeric
dates and meaningful near-neighbours; preserve original evidence and measure both
recovered matches and false positives against the current search.

### 8. Member controls for their captured messages — medium–large

**Example:** `!context me off`, `!context me status`, `!context me erase` scoped to
the verified sender in the current group.

**Benefit:** Members can control their own contribution to group recall while
owners retain group-wide enablement. **Gap:** `src/commands/context.js:26` has only
owner-managed capture changes; records and derived summaries have no member-level
exclusion path. Excluding a sender must also handle copied quotes, AI history and
summaries derived from their messages. Add source provenance and revision guards
before claiming erasure is complete; existing backups remain separate.

**Verify:** An excluded member's words do not re-enter through another person's
quote; affected summaries are removed/rebuilt; in-flight extraction cannot restore
erased content; one member cannot erase another's data.

## Suggested sequence

Start with **catch-up and coverage**, **explicit reply preferences**, and **Arabic
retrieval**. They extend the current chat experience with limited new machinery.
Then add event reminders and task lists. Implement cancellation and group policy
as shared services used by new features. Member-level erasure needs a separate
provenance design rather than a filter added only at capture time.

No new external provider is inherently required for these proposals. New summary
or scheduling interpretations can still consume the configured model's quota.
This was source/documentation discovery only; tests were not rerun and no
recommendation has been implemented.
