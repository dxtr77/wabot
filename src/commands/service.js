const API_URL = 'https://katimsd.vercel.app/api';
const VALID_PLATFORMS = new Set(['iphone', 'android']);

export async function checkKatimsdPlatform(platform) {
  const normalized = String(platform || '').trim().toLowerCase();
  if (!VALID_PLATFORMS.has(normalized)) {
    throw new Error('Platform must be iphone or android.');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  const started = Date.now();

  try {
    const response = await fetch(
      `${API_URL}?platform=${encodeURIComponent(normalized)}`,
      {
        headers: { accept: 'application/json' },
        signal: controller.signal,
      }
    );
    const networkTimeMs = Date.now() - started;
    const raw = await response.text();
    let data;

    try {
      data = JSON.parse(raw);
    } catch {
      return {
        platform: normalized,
        reachable: true,
        operational: false,
        httpStatus: response.status,
        networkTimeMs,
        error: 'API did not return valid JSON.',
      };
    }

    const operational = response.ok &&
      Number(data.http_status ?? response.status) === 200 &&
      String(data.code) === '1' &&
      String(data.status_key).toLowerCase() === 'optimal';

    return {
      platform: normalized,
      reachable: true,
      operational,
      httpStatus: response.status,
      statusKey: data.status_key ?? 'unknown',
      statusText: data.status_en ?? data.status_text ?? 'No status message',
      responseTime: data.response_time ?? null,
      networkTimeMs,
      error: operational ? null :
        `Service reports status: ${data.status_en ?? data.status_key ?? 'unknown'}`,
    };
  } catch (error) {
    return {
      platform: normalized,
      reachable: false,
      operational: false,
      networkTimeMs: Date.now() - started,
      error: error?.name === 'AbortError'
        ? 'Request timed out after 8 seconds.'
        : (error?.message || 'Network request failed.'),
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function checkKatimsdService(platform = 'both') {
  const normalized = String(platform || 'both').trim().toLowerCase();

  if (normalized === 'both') {
    const results = await Promise.all([
      checkKatimsdPlatform('iphone'),
      checkKatimsdPlatform('android'),
    ]);
    return {
      service: 'KATIMSD',
      operational: results.every((result) => result.operational),
      results,
    };
  }

  const result = await checkKatimsdPlatform(normalized);
  return {
    service: 'KATIMSD',
    operational: result.operational,
    results: [result],
  };
}

export function formatKatimsdStatus(report) {
  const lines = [
    '*KATIMSD service check*',
    `Overall: ${report.operational ? '✅ Operational' : '❌ Not fully operational'}`,
    '',
  ];

  for (const result of report.results) {
    lines.push(`${result.operational ? '✅' : '❌'} *${result.platform.toUpperCase()}*`);

    if (result.reachable) {
      lines.push(`Status: ${result.statusText}`);
      lines.push(`HTTP: ${result.httpStatus ?? 'unknown'} · Network time: ${result.networkTimeMs} ms`);
      if (result.responseTime != null) {
        lines.push(`API-reported response time: ${result.responseTime}`);
      }
      if (result.statusKey) lines.push(`Status key: ${result.statusKey}`);
    } else {
      lines.push(`Error: ${result.error}`);
    }

    lines.push('');
  }

  lines.push('Source: katimsd.vercel.app/api');
  return lines.join('\n').trim();
}

export async function handle(ctx, args = '') {
  const platform = String(args || 'both').trim().toLowerCase() || 'both';

  if (!['both', 'iphone', 'android'].includes(platform)) {
    return ctx.reply('Usage: !bok [iphone|android|both]');
  }

  await ctx.typing?.();
  const report = await checkKatimsdService(platform);
  return ctx.reply(formatKatimsdStatus(report));
}
