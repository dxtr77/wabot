import fs from 'node:fs';
import path from 'node:path';

const DAY = 86400_000;
const clip = (value, limit) => String(value || '').slice(0, limit);
const words = (text) => [...new Set(String(text).toLowerCase().normalize('NFKC')
  .match(/[\p{L}\p{N}]{2,}/gu) || [])];
const evidence = (message) => ({ ...message, timestamp: new Date(message.at).toISOString() });
const targetRevisions = (values = {}) => Object.fromEntries(Object.entries(values)
  .filter(([, revision]) => Number.isInteger(revision) && revision >= 0).slice(0, 40));

// Separate from db.json: passive group conversation never becomes personal memory.
export function createContextStore({ file, now = Date.now, limits = {} } = {}) {
  const options = {
    retentionDays: 7, maxMessages: 2000, recentMessages: 30,
    promptChars: 18000, summaryBatch: 20, ...limits,
  };
  let groups = {};
  let dirty = false;
  let saveTimer;
  let sweepTimer;
  if (file && fs.existsSync(file)) {
    // Fail visibly rather than overwrite an unreadable archive with an empty one.
    const loaded = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (loaded.version !== 1 || !loaded.groups || typeof loaded.groups !== 'object') {
      throw new Error('Unsupported chat context archive');
    }
    groups = loaded.groups;
  }

  function flush() {
    clearTimeout(saveTimer);
    saveTimer = undefined;
    if (!dirty || !file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, groups }), { mode: 0o600 });
    fs.renameSync(tmp, file);
    dirty = false;
  }

  function save() {
    dirty = true;
    if (!file || saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = undefined;
      try { flush(); } catch (error) { console.error('Context save failed:', error.message); }
    }, 500);
    saveTimer.unref();
  }

  function prune(group) {
    const cutoff = now() - group.retentionDays * DAY;
    const messages = group.messages.filter((m) => m.at >= cutoff).slice(-options.maxMessages);
    const summaries = group.summaries.filter((s) => s.fromAt >= cutoff).slice(-6);
    if (messages.length !== group.messages.length || summaries.length !== group.summaries.length) {
      group.messages = messages;
      group.summaries = summaries;
      save();
    }
    return group;
  }

  const get = (jid) => groups[jid] ? prune(groups[jid]) : undefined;
  const enabled = (jid) => !!get(jid)?.enabled;
  const revision = (jid) => get(jid)?.revision;

  function configure(jid, changes) {
    if (!jid?.endsWith('@g.us')) throw new Error('Context capture is available only in groups.');
    if (changes.retentionDays !== undefined &&
        (!Number.isInteger(changes.retentionDays) || changes.retentionDays < 1 || changes.retentionDays > 30)) {
      throw new Error('Retention must be a whole number from 1 to 30 days.');
    }
    const group = groups[jid] ||= {
      enabled: false, retentionDays: options.retentionDays, revision: 0,
      nextSeq: 1, summarizedThrough: 0, messages: [], summaries: [],
    };
    group.revision++;
    if (changes.enabled !== undefined) group.enabled = changes.enabled;
    if (changes.retentionDays !== undefined) group.retentionDays = changes.retentionDays;
    if (changes.clear || changes.enabled === false) {
      group.messages = [];
      group.summaries = [];
      group.summarizedThrough = group.nextSeq - 1;
    }
    prune(group);
    save();
    return status(jid);
  }

  function status(jid) {
    const group = get(jid);
    return {
      enabled: !!group?.enabled,
      retentionDays: group?.retentionDays ?? options.retentionDays,
      messages: group?.messages.length || 0,
      summaries: group?.summaries.length || 0,
    };
  }

  function record(jid, message, expectedRevision) {
    const group = get(jid);
    if (!group?.enabled || (expectedRevision !== undefined && group.revision !== expectedRevision)) return;
    if (!message.id || !message.author || !String(message.text || '').trim()) return;
    const existing = group.messages.find((m) => m.id === message.id && m.author === message.author);
    if (existing) return existing.seq;
    const at = Number(message.at);
    if (!Number.isFinite(at) || at < now() - group.retentionDays * DAY || at > now() + 60_000) return;
    const entry = {
      seq: group.nextSeq++, id: clip(message.id, 160), at,
      author: clip(message.author, 160), name: clip(message.name, 80),
      text: clip(message.text, 2000), bot: !!message.bot,
      replyTo: clip(message.replyTo, 160), replyAuthor: clip(message.replyAuthor, 160),
      quote: clip(message.quote, 1000),
      aiTurn: !!message.aiTurn, mentions: (message.mentions || []).slice(0, 20).map((id) => clip(id, 160)),
      memoryRevision: Number.isInteger(message.memoryRevision) ? message.memoryRevision : 0,
      memoryTargets: targetRevisions(message.memoryTargets),
    };
    group.messages.push(entry);
    prune(group);
    save();
    return entry.seq;
  }

  function search(jid, { query = '', after, before, author, limit = 8, through = Infinity } = {}) {
    const group = get(jid);
    if (!group?.enabled) return [];
    const terms = words(query).slice(0, 40);
    const start = after ? Date.parse(after) : -Infinity;
    const end = before ? Date.parse(before) : Infinity;
    if (Number.isNaN(start) || Number.isNaN(end)) throw new Error('Use ISO dates for after and before.');
    if (!terms.length && !after && !before && !author) return [];
    return group.messages.filter((m) => m.seq <= through && m.at >= start && m.at <= end &&
      (!author || m.author === author || m.name.toLowerCase().includes(String(author).toLowerCase())))
      .map((m) => {
        const tokens = new Set(words(m.text + ' ' + m.name));
        const score = terms.reduce((sum, term) => sum + (tokens.has(term) ? 1 : 0), 0);
        return { m, score };
      })
      .filter(({ score }) => !terms.length || score > 0)
      .sort((a, b) => b.score - a.score || b.m.at - a.m.at || b.m.seq - a.m.seq)
      .slice(0, Math.min(10, Math.max(1, Number(limit) || 8)))
      .map(({ m }) => evidence(m));
  }

  function summaryJob(jid) {
    const group = get(jid);
    if (!group?.enabled) return;
    const older = group.messages.slice(0, -options.recentMessages)
      .filter((m) => m.seq > group.summarizedThrough);
    if (older.length < options.summaryBatch) return;
    const messages = older.slice(0, options.summaryBatch);
    return { revision: group.revision, messages: structuredClone(messages).map(evidence) };
  }

  function commitSummary(jid, job, text) {
    const group = get(jid);
    const fromAt = Math.min(...job.messages.map((m) => m.at));
    const last = job.messages.at(-1);
    if (!group?.enabled || group.revision !== job.revision || !text?.trim() ||
        fromAt < now() - group.retentionDays * DAY || last.seq <= group.summarizedThrough) return false;
    group.summaries.push({ fromAt, through: last.seq, text: clip(text.trim(), 2500) });
    group.summarizedThrough = last.seq;
    prune(group);
    save();
    return true;
  }

  function buildContext(jid, { query = '', messageId, author, through = Infinity } = {}) {
    const group = get(jid);
    if (!group?.enabled) return '';
    const messages = visibleMessages(group, through);
    const current = messages.find((m) => m.id === messageId && (!author || m.author === author));
    const recent = messages.filter((m) => m !== current).slice(-options.recentMessages);
    const chain = [];
    const visited = new Set();
    let child = current;
    for (let depth = 0; child?.replyTo && depth < 8; depth++) {
      const parent = messages.find((m) => m.id === child.replyTo &&
        (!child.replyAuthor || m.author === child.replyAuthor));
      if (!parent || visited.has(parent.seq)) break;
      visited.add(parent.seq);
      chain.unshift(parent);
      child = parent;
    }
    const seen = new Set([current?.seq]);
    function select(rows, budget) {
      const selected = [];
      for (const m of rows) {
        if (seen.has(m.seq)) continue;
        const entry = evidence(m);
        const line = JSON.stringify(entry);
        if (line.length > budget) continue;
        budget -= line.length + 1;
        selected.push(entry);
        seen.add(m.seq);
      }
      return selected.sort((a, b) => a.seq - b.seq);
    }
    // Reserve room for the reply chain before spending the recent-message budget.
    const recentMessages = recent.map((m) => ({ seq: m.seq, id: m.id, at: m.at,
      timestamp: new Date(m.at).toISOString(), author: m.author, name: m.name || m.author,
      text: m.text, bot: m.bot, replyTo: m.replyTo, replyAuthor: m.replyAuthor }));
    const recentBudget = Math.max(1500, options.promptChars - 1500);
    const fitRecent = (length) => recentMessages.map((m) => ({ ...m, text: m.text.slice(0, length) }));
    if (JSON.stringify(fitRecent(1)).length > recentBudget) {
      for (const m of recentMessages) {
        delete m.id; delete m.replyTo; delete m.replyAuthor;
        m.name = m.name.slice(0, 32); m.author = m.author.slice(0, 32);
      }
    }
    // Extremely small custom budgets may not fit even attribution alone.
    // Default budgets retain all thirty messages, including long-message excerpts.
    while (recentMessages.length && JSON.stringify(fitRecent(1)).length > recentBudget) recentMessages.shift();
    let low = 1, high = 2000;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (JSON.stringify(fitRecent(middle)).length <= recentBudget) low = middle;
      else high = middle - 1;
    }
    for (const m of recentMessages) { m.text = m.text.slice(0, low); seen.add(m.seq); }
    // Keep every recent sender represented; spend remaining space on older context.
    const replyChain = select(chain.slice().reverse(), 4000);
    const retrieved = select(search(jid, { query, through }), 3000);
    const summaries = group.summaries.filter((s) => s.through <= through).slice(-2)
      .map((s) => ({ ...s }));
    const quotedMessage = current?.quote && !chain.some((m) => m.id === current.replyTo)
      ? { id: current.replyTo, author: current.replyAuthor, text: current.quote,
        note: 'Quote supplied with the current message; the original is not in retained history.' }
      : null;
    const payload = { summaries, replyChain, recentMessages, retrieved, quotedMessage };
    // Drop whole records rather than truncate JSON or cut an author's attribution.
    while (JSON.stringify(payload).length > options.promptChars) {
      const list = [retrieved, summaries, replyChain].find((rows) => rows.length);
      if (!list) break;
      list.shift();
    }
    return JSON.stringify(payload);
  }

  function startMaintenance() {
    if (sweepTimer) return;
    for (const group of Object.values(groups)) prune(group);
    sweepTimer = setInterval(() => {
      for (const group of Object.values(groups)) prune(group);
    }, 60_000);
    sweepTimer.unref();
  }

  function markAiTurn(jid, seq, mentions = [], memoryRevision = 0, memoryTargets = {}) {
    const group = get(jid);
    const message = group?.enabled && group.messages.find((m) => m.seq === seq);
    if (!message) return;
    message.aiTurn = true;
    message.mentions = mentions.slice(0, 20).map((id) => clip(id, 160));
    message.memoryRevision = memoryRevision;
    message.memoryTargets = targetRevisions(memoryTargets);
    save();
  }

  function aiHistory(jid, through = Infinity, limit = 24) {
    const group = get(jid);
    if (!group?.enabled) return [];
    return visibleMessages(group, through).filter((m) => m.seq !== through && (m.aiTurn || m.bot))
      .slice(-limit).map((m) => ({
        role: m.bot ? 'assistant' : 'user',
        content: m.bot ? m.text : `[${m.name} (…${m.author.slice(-4)})]: ${m.text}`,
        who: m.author, name: m.name, mentions: m.mentions, quotedWho: m.replyAuthor,
        memoryRevision: m.memoryRevision || 0,
        memoryTargets: { ...m.memoryTargets },
      }));
  }

  function visibleMessages(group, through) {
    const precedingTurns = new Set(group.messages.filter((m) => m.seq < through && m.aiTurn)
      .map((m) => JSON.stringify([m.id, m.author])));
    // A previous queued turn can finish after the next incoming message was
    // captured. Its answer is causally prior to processing that next turn.
    return group.messages.filter((m) => m.seq <= through ||
      (m.bot && precedingTurns.has(JSON.stringify([m.replyTo, m.replyAuthor]))));
  }

  function close() {
    clearInterval(sweepTimer);
    sweepTimer = undefined;
    clearTimeout(saveTimer);
    saveTimer = undefined;
    flush();
  }

  return { enabled, revision, configure, status, record, search, summaryJob,
    commitSummary, buildContext, markAiTurn, aiHistory, startMaintenance, flush, close };
}
