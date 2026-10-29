// Any OpenAI-compatible text-only backup endpoint.
export function createFallbackProvider(settings, timeoutMs) {
  const hasFallback = () => !!(settings.baseUrl && settings.model);

  async function fallbackChat({ system, messages }) {
    const f = settings;
    const body = {
      model: f.model,
      max_tokens: 1024,
      temperature: 0.7,
      messages: [
        { role: 'system', content: system },
        ...messages.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content) })),
      ],
    };
    const res = await fetch(`${f.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(f.apiKey ? { Authorization: `Bearer ${f.apiKey}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`Backup AI provider returned HTTP ${res.status}`);
    const data = await res.json();
    const text = (data.choices?.[0]?.message?.content || '').trim();
    if (!text) throw new Error('Backup AI provider returned an empty answer');
    return text;
  }

  return { hasFallback, fallbackChat };
}
