import { cfg } from '../config.js';
import { db } from '../store.js';
import * as llm from '../ai/llm.js';

const memoryBusy = new Set(); // one memory update at a time per person

const getUser = (num, name) => {
  const u = (db.data.users[num] ||= { name: name || num, facts: [], turns: 0 });
  if (name) u.name = name;
  return u;
};

// Stable, unambiguous speaker tag: two people named "Alex" still look different.

export async function updateMemory(ctx, user, hist) {
  const speakerId = String(ctx.senderNum);
  const speakerRevision = user.memoryRevision || 0;
  const mine = hist
    .filter((h) => h.role === 'user' && h.who && String(h.who) === speakerId)
    .filter((h) => (h.memoryRevision || 0) === speakerRevision)
    .filter((h) => [...(h.mentions || []), h.quotedWho].filter((id) =>
      id && String(id) !== speakerId && String(id) !== String(ctx.meNum))
      .every((id) => (h.memoryTargets?.[id] || 0) === (db.data.users[id]?.memoryRevision || 0)))
    .slice(-10);

  if (!mine.length) {
    user.memoryPending = false;
    return;
  }

  // Only identities explicitly present as real WhatsApp mentions or quoted authors
  // can be memory targets. The model cannot invent a target ID.
  const allowedTargets = new Set();
  for (const h of mine) {
    for (const id of h.mentions || []) {
      if (id && String(id) !== speakerId && String(id) !== String(ctx.meNum)) {
        allowedTargets.add(String(id));
      }
    }
    const quoted = String(h.quotedWho || '');
    if (quoted && quoted !== speakerId && quoted !== String(ctx.meNum)) {
      allowedTargets.add(quoted);
    }
  }

  const targets = [...allowedTargets].map((id) => {
    const target = getUser(id, db.data.users[id]?.name || id);
    return { id, name: target.name, facts: target.facts || [], memoryRevision: target.memoryRevision || 0 };
  });

  const lockIds = [speakerId, ...targets.map((t) => t.id)];
  if (lockIds.some((id) => memoryBusy.has(id))) return;
  for (const id of lockIds) memoryBusy.add(id);

  try {
    const messages = mine.map((h) => ({
      speaker: h.name || user.name,
      text: String(h.content).replace(/^\[[^\]]*\]:\s*/, '').slice(0, 600),
      mentionedPeople: (h.mentions || []).map(String),
      quotedPerson: h.quotedWho ? String(h.quotedWho) : null,
    }));

    const input = {
      speaker: { id: speakerId, name: user.name, currentFacts: user.facts || [] },
      allowedOtherPeople: targets,
      recentMessages: messages,
    };

    const res = await llm.generate('memory', {
      contents: JSON.stringify(input),
      config: {
        systemInstruction:
          'You maintain separate long-term memories for people in a WhatsApp assistant. ' +
          'The JSON input identifies the actual speaker, explicitly mentioned WhatsApp IDs, quoted-message authors, and existing memories. ' +
          'Return ONLY JSON with shape {"speakerFacts":["..."],"otherUpdates":[{"id":"exact allowed ID","facts":["..."]}]}. ' +
          'speakerFacts is the complete updated list for the current speaker. ' +
          'otherUpdates may contain only IDs from allowedOtherPeople, and each facts list is that person’s complete updated list. ' +
          'Never invent IDs, names, relationships, or facts. Never copy a speaker fact to another person. ' +
          'A tag or quote alone is not evidence of a fact. Save facts about another person only when a message clearly attributes a durable, non-sensitive fact to that exact person. ' +
          'When attribution is ambiguous, do not add the fact. Do not treat questions, speculation, jokes, or unverified accusations as facts. ' +
          'Save useful durable preferences, interests, projects, skills, goals, and routines. ' +
          'Never save passwords, API keys, financial or ID numbers, health details, sexual information, or other sensitive personal information. ' +
          'Merge duplicates, remove clearly outdated facts, keep at most 40 concise facts per person, and limit each fact to 200 characters.',
        responseMimeType: 'application/json',
        maxOutputTokens: 2048,
      },
    });

    const raw = (res.text || '').replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(raw);
    // Manual remember/forget commands invalidate older extraction requests.
    if ((user.memoryRevision || 0) !== speakerRevision) return;

    // Accept the old response shape as a compatibility fallback.
    const speakerFacts = Array.isArray(parsed.speakerFacts)
      ? parsed.speakerFacts
      : Array.isArray(parsed.facts) ? parsed.facts : null;

    const cleanFacts = (facts) => facts
      .filter((f) => typeof f === 'string' && f.trim())
      .map((f) => f.trim().slice(0, 200))
      .slice(0, 40);

    if (speakerFacts) user.facts = cleanFacts(speakerFacts);

    const allowed = new Map(targets.map((t) => [t.id, t]));
    if (Array.isArray(parsed.otherUpdates)) {
      for (const update of parsed.otherUpdates) {
        const id = String(update?.id || '');
        if (!allowed.has(id) || !Array.isArray(update.facts)) continue;
        const target = db.data.users[id];
        if (target && (target.memoryRevision || 0) === allowed.get(id).memoryRevision) {
          target.facts = cleanFacts(update.facts);
        }
      }
    }

    user.memoryPending = false;
    db.save();
  } finally {
    for (const id of lockIds) memoryBusy.delete(id);
  }
}

export async function memoryCommand(ctx, cmd, args) {
  // Owner can inspect/clear someone else's memory: !memory @user · !forget 2499… · or reply to their message.
  let num = ctx.senderNum;
  let other = false;
  if (ctx.isOwner && (cmd === 'memory' || cmd === 'forget')) {
    const digits = String(args || '').replace(/\D/g, '');
    const t = ctx.mentioned?.[0] ? ctx.num(ctx.mentioned[0])
      : ctx.quotedSender ? ctx.num(ctx.quotedSender)
      : digits.length >= 8 ? digits : null;
    if (t && t !== ctx.senderNum && t !== ctx.meNum) { num = t; other = true; }
  }
  const user = getUser(num, other ? undefined : ctx.name);
  const label = other ? user.name : 'you';

  switch (cmd) {
    case 'remember':
      if (!args) return ctx.reply(`Usage: ${cfg.prefix}remember <fact about you>`);
      user.facts.push(args.slice(0, 200));
      user.memoryRevision = (user.memoryRevision || 0) + 1;
      db.save();
      return ctx.reply('🧠 Got it.');
    case 'memory':
      return ctx.reply(
        user.facts.length
          ? `🧠 *What I know about ${label}*\n` + user.facts.map((f, i) => `${i + 1}. ${f}`).join('\n')
          : `I don't know much about ${label} yet.`,
      );
    case 'forget':
      user.facts = [];
      user.memoryRevision = (user.memoryRevision || 0) + 1;
      user.turns = 0;
      user.memoryPending = false;
      if (!other) delete db.data.history[ctx.jid];
      db.save();
      return ctx.reply(other ? `🧹 Memory about ${label} erased.`
        : ctx.contextEnabled
          ? `🧹 Personal memory and legacy AI history erased. Captured group conversation remains; an owner can use ${cfg.prefix}context clear.`
          : '🧹 Memory and chat history erased.');
    case 'reset':
      delete db.data.history[ctx.jid];
      db.save();
      return ctx.reply(ctx.contextEnabled
        ? `🔄 Legacy AI history cleared. Captured group conversation remains; an owner can use ${cfg.prefix}context clear.`
        : '🔄 Chat history cleared.');
  }
}
