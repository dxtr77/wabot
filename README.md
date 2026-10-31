# wabot — WhatsApp server bot

System stats · Minecraft control · video/audio downloads · AI chat with soul & memory.
Built on [Baileys](https://github.com/WhiskeySockets/Baileys) (runs as a *linked device* on your own number — no browser needed).

See [ARCHITECTURE.md](ARCHITECTURE.md) for the code layout, module responsibilities,
compatibility entry points, and persistent data locations. Run `npm test` for the
behavior suite and isolated application import check.

For YouTube cookie/client handling and the complete standalone Python downloader,
see [YOUTUBE-DOWNLOADS.md](docs/YOUTUBE-DOWNLOADS.md).

## How it behaves
| Where | What happens |
|---|---|
| **Self-chat** ("Message yourself") | Everything works. Plain text → AI chat. A bare link → auto-download. `!commands` work. |
| **Groups** | Off by default. Type `!bot on` in a group to enable it. Members can use `!dl`, `!ai`, `!mc status/players`. Owner-only: status, mc control, ban. |
| **Your chats with other people** | Ignored completely. |
| **Banned users** | Silently ignored everywhere. |

Because it runs on *your* number, replies appear as sent by you. Every reply carries an invisible marker so the bot never answers itself.

## Server setup (Ubuntu/Debian)
```bash
# 1. Dependencies
sudo apt update && sudo apt install -y ffmpeg tmux curl
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install -y nodejs
sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
sudo chmod a+rx /usr/local/bin/yt-dlp          # keep updated: sudo yt-dlp -U

# 2. Bot
sudo useradd -m -s /bin/bash wabot
sudo mkdir -p /opt/wabot && sudo cp -r . /opt/wabot && sudo chown -R wabot: /opt/wabot
cd /opt/wabot && sudo -u wabot npm install --omit=dev
sudo -u wabot cp .env.example .env && sudo -u wabot nano .env

# 3. First run (pair your phone), then Ctrl+C
sudo -u wabot node src/index.js
#   QR: WhatsApp → Settings → Linked devices → Link a device
#   or set PAIRING_NUMBER in .env to get an 8-character code instead

# 4. Run as a service
sudo cp bot.service /etc/systemd/system/ && sudo systemctl daemon-reload
sudo systemctl enable --now bot && journalctl -u bot -f
```

## Minecraft setup
In the server's `server.properties`:
```
enable-rcon=true
rcon.port=25575
rcon.password=your-password
```
Put the same password in `.env` (`RCON_PASSWORD`) and set `MC_DIR` to the server folder.
The bot starts the server inside a `tmux` session named `minecraft` (attach any time: `tmux attach -t minecraft`).
Using systemd/Docker for Minecraft instead? Change `MC_START_CMD` / `MC_STOP_CMD`
(e.g. `sudo systemctl start minecraft` — add a sudoers rule for that user).

## Commands
```
!status            CPU, RAM, disk, uptime, temp
!top               top processes by CPU / RAM
!mc status         online? version, players, latency
!mc players        who is online
!mc start|stop|restart
!mc logs           last 15 log lines
!mc say <msg>      broadcast in-game
!mc cmd <command>  any server/RCON command (op, whitelist add, …)
!dl <url>          download video (!dl 480 <url> for lower quality)
!audio <url>       download mp3
!ai <text>         chat (also: @mention in groups)
!remember <fact>   !memory   !forget   !reset
!ban @user  !unban @user  !banlist  !bot on|off
```

## AI: soul & memory (Google Gemini)
Get a key at https://aistudio.google.com/apikey and set `GEMINI_API_KEY`. Models are configurable via `AI_MODEL` (chat) and `AI_MEMORY_MODEL` (memory extraction).

- **Soul** = `soul.md`. Edit it any time — it's re-read on every message, no restart.
- **Short-term memory**: last `AI_HISTORY` messages per chat.
- **Long-term memory**: per-person facts, auto-extracted every `AI_MEMORY_EVERY` messages by a small Gemini model, plus `!remember`. Stored in `data/db.json`. `!forget` wipes it.

## Adhkar and Friday reading reminders

Inside an enabled group, an owner can use `!azkar on` for morning, evening and
bedtime adhkar, plus a Surah al-Kahf reading reminder on Fridays. New settings
use **06:00**, **18:00**, **22:00**, and **Friday 10:00**, in **Asia/Kolkata**.
Set the daytime schedules with `!azkar on 06:00 18:00 Asia/Kolkata`; adjust bedtime
with `!azkar bedtime 22:30` and the Friday reminder with `!azkar friday on 10:00`.

Owner-only `!azkar test all` sends all four labelled previews without changing
settings or consuming scheduled sends. Individual previews are `!azkar test
morning`, `evening`, `bedtime` or `friday`. `!azkar off` disables all reminders;
`!azkar friday off` disables only the weekly reading reminder. Members can use
`!azkar status` and `!azkar sources`. Every reminder includes its source links.
The Friday message links to the surah without copying verses into chat.

Each reminder has a separate persisted claim. Morning reminders are skipped
after noon, and Friday reminders are sent only during the configured local
Friday daytime window. See [sources, migration and delivery details](docs/DAILY-AZKAR.md).

## Group conversation context

An owner can opt an enabled group into conversation capture:

```
!bot on
!context on
!context status
!context search trip
!context retention 7
!context clear
!context off
```

Capture is off by default. Enabling it announces in the group that text/captions,
author identities, timestamps, quoted text, and reply references will be saved
and may be sent to the configured AI provider. Attachments themselves are not
archived. Capture starts with new messages; old WhatsApp history is not imported.
The bot continues to answer only through its existing commands and AI triggers.
Sticker-only messages are treated as reactions and do not trigger an explanation;
send a question or address Sol to ask about a sticker. Quoted WhatsApp GIF-style
video messages are converted into a few sampled frames for visual questions.

For each AI reply, Sol receives the latest 30 messages with sender names and
WhatsApp author IDs, timestamps, reply ancestors (up to eight links when retained),
summaries of older batches, and keyword matches from the same group. Long messages
are excerpted to keep all 30 recent speakers visible within the context budget. The current request is kept separate from this reference material.
The AI can also call `search_chat_history` with keywords, author, and ISO date
filters. Searches cannot access another group or private chat. Members can use
`!context status` and `!context search`; capture, retention, and clearing require
an owner.

Defaults: 30 recent messages, 2,000 archived messages per group, seven days of
retention, and an 18,000-character context budget (roughly 4,500 English tokens;
token counts vary by language). Environment settings are listed in `.env.example`.
Prompts may contain fewer messages to stay within the budget. Searches are
keyword-based, not semantic; alternate wording can miss a match.

Older discussion is summarized in independent batches of 20 using the configured
memory models. Summaries preserve proposals, decisions, speakers and uncertainty;
they are conversation context, not personal facts. Up to six batches are retained,
with the latest two included in prompts. Summary failures leave raw messages
available and retry on later traffic after a cooldown. Gemini requests rotate across
configured keys for each model before trying a fallback model; transient failures
honor provider retry hints, and timed-out requests are aborted before rotation.

Context lives in `data/chat-context.json`, separate from `data/db.json`. Expired
messages and summaries are pruned on access and every minute while running;
summaries expire with their oldest source message. Raw messages are also bounded
by the archive size limit. Personal memory extraction continues to use only
messages directed to the AI, never passive group chatter. With capture enabled,
new AI turns use the expiring archive instead of non-expiring legacy chat history.

`!context off` stops capture and erases captured messages, summaries and that
group's legacy AI history. `!context clear` erases the same data while keeping the
capture setting. `!bot off` also stops and clears active capture. Personal facts
remain separate and are managed with the memory commands. `!reset` clears legacy
AI history; captured group discussion requires the owner's `!context clear`.
Retention changes can range from 1 to 30 days and immediately prune expired data.
Clearing or changing settings invalidates pending context summaries and AI replies.
Deletion affects the bot's local storage; existing backups and WhatsApp messages
are separate.

Personal memory commands also invalidate older automatic extraction requests.
Pre-forget AI turns are excluded from subsequent extraction for that speaker.
Messages also retain source-time revisions for mentioned and quoted people, so
another speaker's old message cannot restore facts those people have forgotten.
Queued AI follow-ups can use completed answers to preceding turns, while later
unrelated user messages remain outside their incoming-message snapshot.

## Notes & caveats
- Baileys is an **unofficial** WhatsApp client. Automating a personal number carries a (small) risk of WhatsApp restricting it — keep the bot quiet in big groups, avoid spamming, and consider a spare number if it matters.
- Downloads: videos ≤ `DL_VIDEO_MB` go as normal videos, bigger ones as documents. The downloader refuses localhost/private-network URLs.
- Group `!ban` by number only matches reliably via @mention or replying to a message (WhatsApp sometimes hides real numbers behind IDs).
- Back up `data/` (WhatsApp session + memory). Never commit it.

Image search uses Tavily web images with Wikimedia Commons as a fallback. It reuses
the existing Tavily key and its free monthly credit allowance. See
[image search setup and limits](docs/IMAGE-SEARCH.md).

Remove instrumental music from an attached or quoted video using `!nomusic`
(alias `!vocals`). Vocals are retained, the processed video is sent back without
captions, and temporary files are deleted afterward. See
[video music removal](docs/REMOVE-MUSIC.md) for limits and behavior.
