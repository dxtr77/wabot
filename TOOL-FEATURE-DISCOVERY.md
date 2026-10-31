# AI tool feature discovery

Reviewed 30 October 2026. These are **proposed AI-callable capabilities**, not
implemented tools. No external APIs, credentials, production data or live service
operations were used for this review. No claim about a new provider's current
pricing is required: the shortlist uses local processing or existing integrations.

## Current coverage

The registry currently exposes web search, YouTube caption summaries, VPS status,
top processes, approved OS diagnostics, Minecraft status/players/start/stop,
KATIMSD health, retained-chat search, image search/sending, and media downloads.
`search_web` is conditional on existing configuration. See
[composition](src/ai/tools/agent-tools.js), [registry](src/ai/tools/registry.js)
and the schemas beside each domain handler.

Quoted images/GIFs/stickers/audio are already supplied directly to the model;
adding an `understand_image` tool would duplicate existing capability. Likewise,
image search already sends up to five different images without captions.

## Prioritized tool proposals

### 1. `calculate` and `convert_units` — new tools; small effort

**Example:** “Split 1,750 among seven people” or “Convert 72 Fahrenheit to Celsius.”
Suggested inputs: `{expression}` with a restricted arithmetic grammar;
`{value, from_unit, to_unit}` with explicit unit enums.

**Gap:** No deterministic arithmetic/conversion handler exists in the registry;
ordinary model answers can make calculation errors. **Requirements:** Local parser
and fixed unit definitions; no API/key. Exclude live currency conversion unless a
separate verified rate source is added. **Access:** Any already authorized bot
user, read-only. Never evaluate arbitrary JavaScript or shell commands.

**Verify:** Operator precedence, negatives, division by zero, expression limits,
temperature offsets, incompatible units and attempted code execution.

### 2. `read_webpage` — new web tool; medium effort

**Example:** “Summarize this article” with a current or quoted public URL.
Suggested input: `{url, focus?}`; return title, canonical URL, bounded extracted
text and whether extraction was truncated.

**Gap:** [Web tools](src/ai/tools/web.js) offer search and YouTube captions, not
fetching a specific ordinary webpage. **Requirements:** Direct public HTTPS fetch
and a local HTML text extractor; no paid API/key is inherently needed. Start with
static HTML/text, not browser automation or paywall/account access. **Access:**
Authorized users; only URLs in their current request/quote or a returned search
result. Reuse the public-address/DNS-pinning pattern from
[image downloads](src/images/download.js), with page-specific limits.

**Verify:** Private-address redirects/DNS rebinding, huge/compressed bodies, missing
pages, non-HTML responses, truncation, and embedded instructions treated as data.

### 3. `read_document` — new attachment tool; medium effort

**Example:** Reply to a PDF: “Find the submission deadline and cite its page.”
Suggested input: `{attachment_id, pages?, query?}`; IDs must come from the current
message's verified attachments, never a model-supplied server path or arbitrary URL.

**Gap:** [Media preparation](src/media/prepare.js:20) supports only image, sticker,
audio and GIF. Document captions can be parsed, but PDF contents are not extracted.
**Requirements:** Bounded local PDF/text parsing; select and review a parser before
implementation. Scanned PDFs would need a separately measured OCR phase. No new
remote provider is necessary for text-based PDFs. **Access:** Current/quoted
attachment visible to this requester; temporary extraction, no automatic archive.

**Verify:** Page citations, multilingual text, encrypted/scanned PDFs, malformed
files, decompression/time limits, cleanup, and refusal of unrelated attachment IDs.

### 4. `create_sticker` — new outbound media tool; small–medium effort

**Example:** Reply to an image: “Make this a sticker.”
Suggested input: `{attachment_id, crop: 'contain'|'square'}`. Begin with static
images; add animated GIF input only after validating WhatsApp limits separately.

**Gap:** Stickers are understood as input, but there is no creation/sending tool.
**Requirements:** Existing Sharp plus the installed WhatsApp transport; local,
no API/key. This converts supplied media; it does not generate new images or
promise automatic background removal. **Access:** Explicit request by the current
sender; send only to the current chat. Keep sticker-only reactions silent.

**Verify:** Transparency, orientation, output dimensions/bytes, malformed inputs,
one send for repeated tool calls, and uncertain-upload handling without duplicates.

### 5. `create_poll`, `vote_poll`, `get_poll_results` — new group tools; medium effort

**Example:** “Poll the group: Friday or Saturday?”
Suggested inputs: `{question, options, closes_at?}`, `{poll_id, option_id}`,
and `{poll_id}`. Start with deterministic text votes if native poll integration
has not been verified against the installed transport.

**Gap:** No poll state, vote handler or poll tool exists. **Requirements:** Local
group-scoped storage; no external API/key. **Access:** Owner-enabled per-group
creation policy; each member can change only their own vote. Owners/creators can
close their allowed polls. Use explicit vote syntax so download-quality numeric
selections remain unambiguous.

**Verify:** Same-name voters, one active vote per identity, closure, restart,
cross-group denial, duplicate creation, and coexistence with download menus.

### 6. `find_shared_links` — extends existing context integration; small–medium effort

**Example:** “Find the GitHub link Ahmed shared last week.”
Suggested input: `{query?, domain?, author?, after?, before?}`; return only retained
links with original sender/time and a short message excerpt.

**Gap:** [Chat search](src/context/store.js:125) scores word tokens, not URL/domain
fields, so finding a specific shared resource is indirect. **Requirements:** Local
URL extraction/indexing from the existing archive; no API/key. Initially search
links, not files: file contents/metadata are not currently archived. **Access:**
Existing `group-context` policy and service-side current-group/snapshot checks.

**Verify:** URL punctuation, domain lookalikes, author/date filters, retention,
clear/off invalidation, and no links recovered from another group.

### 7. `create_reminder`, `list_reminders`, `cancel_reminder` — new tools; medium–large effort

**Example:** “Remind us tomorrow at 8 PM about the match.”
Suggested creation input: `{text, due_at, time_zone}` using a resolved ISO date;
return a durable job ID, resolved local time and actual scheduling status.

**Gap:** Existing [reminders](src/reminders/store.js) handle fixed adhkar/Friday
periods, not arbitrary event jobs. **Requirements:** Separate local job store and
scheduler; reuse durable claim/uncertain-delivery patterns. Existing model calls
may consume quota, but no new provider is necessary. **Access:** Explicit current
request; owner-enabled group policy; creator-scoped list/cancel plus owner controls.
Clarify ambiguous time before writing. Keep fixed religious reminders independent.

**Verify:** Restart, DST/local dates, offline reconnect, cancellation races, job
ownership, duplicate tool calls and uncertain sends without automatic duplicates.

### 8. `get_chat_range` — extends context tools; medium effort

**Example:** “What did I miss since yesterday?”
Suggested input: `{after, before, topic?}`; return bounded chronological evidence,
coverage metadata and explicit truncation. Let the existing model compose the
summary from returned evidence rather than hiding a second model call in the tool.

**Gap:** [Current history tool](src/ai/tools/conversation.js) returns ranked keyword
hits; service retrieval is capped at five. It cannot establish complete coverage
of a busy time range. **Requirements:** Local date-range retrieval and coverage
tracking; existing model quota only. **Access:** `group-context`, current group,
turn snapshot and existing retention. No silent WhatsApp backfill.

**Verify:** Ranges larger than the hit limit, chronological completeness within
the stated bound, missing-capture warnings, speaker attribution, group isolation
and clear/retention changes while generation is pending.

## Integration rules

- Keep each schema, authorization rule and handler together; inject services via
  the existing domain builders and composition entry point.
- Validate arguments inside handlers: the registry dispatches calls but does not
  itself provide complete schema validation. Reject unsupported IDs/enums/limits.
- New owner/member/creator policies need real enforcement. Arbitrary new `access`
  strings are not sufficient: [access.js](src/ai/tools/access.js) currently handles
  only owner, Minecraft-admin and group-context labels.
- Add poll/reminder/sticker writes to [tool-loop side-effect deduplication](src/ai/tool-loop.js:18),
  then add durable idempotency where a write must survive restart. Current-turn
  result reuse alone is insufficient for persistent operations.
- Preserve the existing tool-call budget, untrusted-content rules, explicit-action
  requirement and structured outcomes. A scheduled/queued action is not completed.

**Suggested first batch:** calculator/conversion, webpage reading and static
sticker creation. Follow with document extraction and shared-link retrieval.
Polls, general reminders and broad catch-up retrieval need more state and policy.

Discovery only: no source implementation, API requests, service changes or test
runs were performed. All tool names above are provisional.
