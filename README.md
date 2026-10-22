# wabot — WhatsApp server bot

System stats · Minecraft control · video/audio downloads · AI chat with soul & memory.
Built on [Baileys](https://github.com/WhiskeySockets/Baileys) (runs as a *linked device* on your own number — no browser needed).

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

## Notes & caveats
- Baileys is an **unofficial** WhatsApp client. Automating a personal number carries a (small) risk of WhatsApp restricting it — keep the bot quiet in big groups, avoid spamming, and consider a spare number if it matters.
- Downloads: videos ≤ `DL_VIDEO_MB` go as normal videos, bigger ones as documents. The downloader refuses localhost/private-network URLs.
- Group `!ban` by number only matches reliably via @mention or replying to a message (WhatsApp sometimes hides real numbers behind IDs).
- Back up `data/` (WhatsApp session + memory). Never commit it.
