// Silence harmless libsignal decrypt noise (old/undecryptable messages)
const noisy = /^(Session error|Failed to decrypt|Closing (open )?session|Closing stale|Removing old closed session|Opening session)/;
for (const level of ['error', 'warn', 'info', 'log']) {
  const orig = console[level].bind(console);
  console[level] = (...a) => {
    if (typeof a[0] === 'string' && noisy.test(a[0])) return;
    orig(...a);
  };
}
