import 'dotenv/config';

const list = (s) => (s || '').split(',').map((x) => x.trim()).filter(Boolean);
const bool = (s, d) => (s === undefined || s === '' ? d : /^(1|true|yes|on)$/i.test(s));
const uniq = (a) => [...new Set(a.filter(Boolean))];
const int = (s, d) => (Number.isFinite(parseInt(s, 10)) ? parseInt(s, 10) : d);

export const cfg = {
  botName: process.env.BOT_NAME || 'Sol',
  prefix: process.env.PREFIX || '!',
  owners: new Set(list(process.env.OWNER_NUMBERS).map((n) => n.replace(/\D/g, '')).filter(Boolean)),
  pairingNumber: (process.env.PAIRING_NUMBER || '').replace(/\D/g, ''),
  diskMounts: list(process.env.DISK_MOUNTS),
  context: {
    retentionDays: Math.min(30, Math.max(1, int(process.env.CHAT_CONTEXT_RETENTION_DAYS, 7))),
    maxMessages: Math.min(10000, Math.max(100, int(process.env.CHAT_CONTEXT_MAX_MESSAGES, 2000))),
    recentMessages: Math.min(50, Math.max(10, int(process.env.CHAT_CONTEXT_RECENT_MESSAGES, 30))),
    promptChars: Math.min(24000, Math.max(4000, int(process.env.CHAT_CONTEXT_PROMPT_CHARS, 18000))),
    summaryBatch: 20,
  },
  mc: {
    dir: process.env.MC_DIR || process.cwd(),
    host: process.env.MC_HOST || '127.0.0.1',
    port: int(process.env.MC_PORT, 25565),
    startCmd:
      process.env.MC_START_CMD ||
      'tmux new-session -d -s minecraft "java -Xms1G -Xmx2G -jar server.jar nogui"',
    stopCmd: process.env.MC_STOP_CMD || 'tmux send-keys -t minecraft stop Enter',
    rconPort: int(process.env.RCON_PORT, 25575),
    rconPassword: process.env.RCON_PASSWORD || '',
  },
  dl: {
    auto: bool(process.env.AUTO_DL, true),
    videoMb: int(process.env.DL_VIDEO_MB, 60),
    maxMb: int(process.env.DL_MAX_MB, 1500),
    concurrency: int(process.env.DL_CONCURRENCY, 2),
    cookies: process.env.YTDLP_COOKIES || '',
    youtubeClients: uniq(list(process.env.YTDLP_YOUTUBE_CLIENTS)),
  },
  tavily: {
    enabled: bool(process.env.TAVILY_ENABLED, true),
    apiKey: process.env.TAVILY_API_KEY || '',
    timeoutMs: Math.max(1000, int(process.env.TAVILY_TIMEOUT_MS, 8000)),
    maxResults: Math.min(5, Math.max(1, int(process.env.TAVILY_MAX_RESULTS, 3))),
  },
  ai: {
    keys: uniq([...list(process.env.AI_GEMINI_API_KEYS), process.env.AI_GEMINI_API_KEY || '', process.env.MEMORY_GEMINI_API_KEY || '']),
    key: process.env.AI_GEMINI_API_KEY || '',
    memoryKey: process.env.MEMORY_GEMINI_API_KEY || '',
    // Models are tried in order; each model has its own quota, so a limit on one falls through to the next.
    models: uniq([...list(process.env.AI_MODELS), process.env.AI_MODEL || 'gemini-3.8-flash', 'gemini-3.1-flash-lite']),
    memoryModels: uniq([
      ...list(process.env.AI_MEMORY_MODELS),
      process.env.AI_MEMORY_MODEL || 'gemini-2.5-flash-lite',
      'gemini-2.5-flash',
    ]),
    history: int(process.env.AI_HISTORY, 24),
    memoryEvery: int(process.env.AI_MEMORY_EVERY, 4),
    userPerHour: int(process.env.AI_USER_PER_HOUR, 30), // non-owners; 0 = unlimited
    timeoutMs: int(process.env.AI_TIMEOUT_MS, 40000),
    mediaTimeoutMs: int(process.env.AI_MEDIA_TIMEOUT_MS, 30000),
  },
  // Optional backup brain for when Gemini is out of quota or down (OpenAI-compatible API).
  fallback: {
    baseUrl: (process.env.FALLBACK_BASE_URL || '').replace(/\/+$/, ''),
    apiKey: process.env.FALLBACK_API_KEY || '',
    model: process.env.FALLBACK_MODEL || '',
  },
};
