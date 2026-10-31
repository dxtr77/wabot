# Code structure

The bot uses focused service modules while keeping its existing command entry
points and persistent file locations. This layout preserves the current chat,
media, memory, and API behavior.

```text
src/
  index.js                     # process startup and context maintenance
  config.js                    # environment configuration
  whatsapp.js                  # socket lifecycle and message delivery
  messages/                    # parsing, reply context, triggers, message actions
  commands/                    # command routing and user-facing handlers
  downloads/
    youtube-access.js          # anonymous extraction and compatible authentication retry
  context/
    store.js                   # expiring group archive and retrieval
    service.js                 # capture, turn snapshots, history lookup, replies
    summaries.js               # batch summaries, retry cooldown, in-flight guard
  media/
    prepare.js                 # prepare current/quoted attachments for the model
    whatsapp-download.js       # bounded downloads, cancellation, timeout
    mime.js                    # signature detection and declared MIME validation
    image.js                   # image normalization and sticker frame sampling
    gif.js                     # sample WhatsApp GIF-style video frames
    audio.js                   # bounded audio decoding and duration checks
    errors.js                  # actionable media errors
    limits.js                  # shared processing limits
  reminders/
    azkar-content.js           # reviewed adhkar and Friday reading references
    clock.js                   # group-local dates and schedule validation
    store.js                   # atomic settings and daily delivery claims
    scheduler.js               # morning/evening/bedtime and Friday delivery
    service.js                 # active WhatsApp connection and service composition
  ai/
    chat.js                    # turn queue, prompt, history, replies, memory update
    ai-provider.js             # Gemini request assembly and tool loop integration
    instructions.js            # shared tool and attachment instructions
    tool-loop.js               # call limits, allowlist, result reuse, deduplication
    llm.js                     # stable interface used by chat, memory and commands
    providers/
      gemini.js                # key pool, cooldowns, model fallback, cancellation
      fallback.js              # optional compatible text-only backup endpoint
    tools/
      agent-tools.js           # compose the enabled tools with application services
      registry.js              # declarations, visibility, execution, unknown-tool denial
      access.js                # shared owner, Minecraft-admin and group access checks
      minecraft.js             # Minecraft status, players and controls
      server.js                # VPS diagnostics
      services.js              # KATIMSD availability
      conversation.js          # scoped group history search
      web.js                   # web search and YouTube captions
      media.js                 # image search and requested downloads
  security/
  store.js                     # personal facts and bot settings
```

## Entry points and dependencies

`commands/ai.js` is a small command-facing facade for `ai/chat.js` and the memory
commands. The message handler and command router continue to use it. AI turn
orchestration owns its per-chat queue, rate limits, prompt construction and
memory revision guards.

`media/prepare.js` combines transport and format-specific processors. The
processors share the same error type and limits; command routing does not need
to know how a sticker, GIF or audio recording is decoded.

The context service owns the archive instance and turn snapshots. Its store is
independently constructible, and its summary module receives the store explicitly.
Passive group context remains separate from personal memory.

Each AI tool domain keeps its schema, access rule and handler together. The
registry applies the same access rules to model visibility and execution. Tool
builders receive application services explicitly, allowing handlers to be checked
without running server commands or external requests. Existing operational
helpers still live in the corresponding command modules.

`ai/llm.js` composes the providers and exposes the existing generation, streaming,
status and error functions. The Gemini provider owns its clients, key cursor and
cooldowns; its factory receives configuration, client creation and file access.
Chat and memory use the same provider instance. The backup provider owns the
compatible HTTP request format.

## Compatibility and persistent data

These old imports remain as small re-export facades:

- `commands/media.js` → `media/prepare.js` and `media/errors.js`
- `context-store.js` → `context/store.js`
- `ai/chat-context.js` → `context/service.js`

The entry script remains `src/index.js`. `soul.md` is still loaded from the working
directory and hot reloaded for each AI turn. Database and authentication locations
remain stable: `data/db.json`, `data/chat-context.json`, and `data/auth`. Gemini key
state remains at the repository's `data/ai-key-state.json`, even though the
provider implementation moved deeper in the source tree.

Group reminder settings and independent morning/evening/bedtime/Friday claims live in `data/daily-azkar.json`.
The reminder scheduler starts on WhatsApp connection and stops on disconnect.
Only the protected `commands/azkar.js` handler changes per-group enablement or
sends previews. Sources and delivery semantics are documented in
[DAILY-AZKAR.md](docs/DAILY-AZKAR.md).

## Verification

Run `npm test`. Besides behavior tests for chat, permissions, context, tools,
rotation and media, the suite includes a real import check in a temporary working
directory. It loads application modules without starting WhatsApp, checks that
compatibility exports share the same functions/classes, and verifies context
storage stays under the working directory. Provider tests also check the exact
persistent key-state path.

Further splits should follow actual complexity. Server operations can eventually
move out of command modules; retrieval can leave `context/store.js` if it grows.

Image search: `src/commands/image-search.js` handles delivery and fallback;
`src/images/providers.js` handles Tavily/Commons queries and the bounded Tavily
cache; `src/images/history.js` compares image fingerprints and serializes recent
sends per chat; `src/images/download.js` validates public destinations, pins DNS answers,
bounds downloads and decodes image pixels. See [image search](docs/IMAGE-SEARCH.md).

Attached-video music removal: `commands/nomusic.js` validates the request and
cleans its workspace after sending. `media/video-input.js` streams WhatsApp video
to disk and validates it with ffprobe. `media/vocals.js` contains the Demucs
pipeline shared with URL downloads; processing uses the downloader's existing
queue through `withMediaSlot`.
