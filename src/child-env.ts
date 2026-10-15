// src/child-env.ts
// Builds the environment for a spawned stdio MCP server.

/**
 * Variables every child realistically needs to run (shell, temp dirs, locale,
 * proxies/CAs, npm config for `npx`, Windows system vars). A trailing `*`
 * means "prefix". Matching is case-insensitive.
 */
export const BASE_ENV_KEYS = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TERM", "TZ", "LANG", "LC_*",
  "TMPDIR", "TEMP", "TMP",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
  "NPM_CONFIG_*", "XDG_*",
  "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SYSTEMROOT", "SYSTEMDRIVE", "COMSPEC",
  "PATHEXT", "WINDIR", "PROGRAMFILES", "PROGRAMDATA", "HOMEDRIVE", "HOMEPATH",
];

function matcher(patterns: string[]): (key: string) => boolean {
  const exact = new Set<string>();
  const prefixes: string[] = [];
  for (const p of patterns) {
    const u = p.toUpperCase();
    if (u.endsWith("*")) prefixes.push(u.slice(0, -1));
    else exact.add(u);
  }
  return (key) => {
    const k = key.toUpperCase();
    return exact.has(k) || prefixes.some((p) => k.startsWith(p));
  };
}

/**
 * @param inherit  undefined | true  → whole parent environment (default, backwards compatible)
 *                 false             → only BASE_ENV_KEYS
 *                 string[]          → BASE_ENV_KEYS plus the listed names (`PREFIX_*` allowed)
 * @param extra    the server's own resolved `env` entries (always applied last)
 */
export function buildChildEnv(
  parent: NodeJS.ProcessEnv,
  inherit: boolean | string[] | undefined,
  extra: Record<string, string>
): NodeJS.ProcessEnv {
  if (inherit === undefined || inherit === true) return { ...parent, ...extra };

  const allowed = matcher([...BASE_ENV_KEYS, ...(Array.isArray(inherit) ? inherit : [])]);
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(parent)) {
    if (allowed(k)) out[k] = v;
  }
  return { ...out, ...extra };
}
