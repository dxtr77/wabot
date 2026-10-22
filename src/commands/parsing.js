/**
 * Parse a command from already-trimmed message text.
 * Prefix matching remains case-sensitive, while command names are lowercase.
 */
export function parseCommand(text, prefix) {
  const isPrefixed = text.startsWith(prefix);
  const [rawCmd, ...rest] = isPrefixed
    ? text.slice(prefix.length).trim().split(/\s+/)
    : [''];

  return {
    isPrefixed,
    cmd: rawCmd.toLowerCase(),
    args: rest.join(' '),
  };
}
