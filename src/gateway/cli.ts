// src/gateway/cli.ts
// `lazygate serve`, `lazygate token …` and `lazygate secret …`.

import { resolve } from "path";
import { configDir } from "../paths.js";
import { loadRegistry } from "../registry.js";
import { LOG_PREFIX } from "../version.js";
import { SecretStore, secretEnvName } from "./credentials.js";
import { UserVault } from "./vault.js";
import { TokenStore, parseDuration } from "./tokens.js";
import { AuditLog } from "./audit.js";
import { startGateway } from "./server.js";

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
}
const has = (args: string[], name: string) => args.includes(name);

function gatewayDir(): string {
  return resolve(configDir(), "gateway");
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf-8").replace(/\r?\n$/, "");
}

export async function run(subcommand: string, args: string[]): Promise<void> {
  if (subcommand === "serve") return serve(args);
  if (subcommand === "token") return tokenCmd(args);
  return secretCmd(args);
}

async function serve(args: string[]): Promise<void> {
  const dir = gatewayDir();
  const host = flag(args, "--host") ?? "127.0.0.1";
  const port = Number(flag(args, "--port") ?? 8787);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("--port must be 0-65535");

  if (!LOOPBACK.has(host) && !has(args, "--allow-remote")) {
    throw new Error(
      `Refusing to listen on ${host}: the gateway speaks plain HTTP. Bind to 127.0.0.1, or pass --allow-remote ` +
        `and put TLS in front of it (also pass --allowed-host <host:port> for the public name).`
    );
  }

  const tokens = new TokenStore(dir);
  if (tokens.count() === 0) {
    throw new Error("No access tokens yet. Create one first:  lazygate token create --user <you> [--groups eng,sre]");
  }

  const idleMin = Number(flag(args, "--idle-timeout-min") ?? 30);
  const allowedHosts = (flag(args, "--allowed-host") ?? "").split(",").filter(Boolean);

  const registry = loadRegistry(args);
  const gateway = await startGateway({
    registry,
    tokens,
    secrets: new SecretStore(dir),
    vault: new UserVault(dir),
    audit: new AuditLog(resolve(dir, "audit.log")),
    host,
    port,
    idleMs: idleMin * 60_000,
    maxSessions: Number(flag(args, "--max-sessions") ?? 100),
    allowedHosts,
  });

  console.error(`${LOG_PREFIX} HTTP gateway listening on ${gateway.url}`);
  if (!LOOPBACK.has(host)) console.error(`${LOG_PREFIX} warning: listening on ${host} without TLS`);

  const stop = () => {
    void gateway.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  await new Promise<void>(() => undefined); // run until signalled
}

async function tokenCmd(args: string[]): Promise<void> {
  const [action, ...rest] = args;
  const store = new TokenStore(gatewayDir());

  if (action === "create") {
    const user = flag(rest, "--user");
    if (!user) throw new Error("usage: lazygate token create --user <name> [--groups a,b] [--expires 90d] [--label text] [--admin]");
    const expires = flag(rest, "--expires");
    const { id, token } = store.create({
      user,
      groups: (flag(rest, "--groups") ?? "").split(",").filter(Boolean),
      expiresInMs: expires ? parseDuration(expires) : undefined,
      label: flag(rest, "--label"),
      admin: has(rest, "--admin"),
    });
    console.log(`Token ${id} for ${user} (shown once — store it somewhere safe):\n\n  ${token}\n`);
    console.log(`Use it as:  Authorization: Bearer ${token}`);
    console.log(`Web UI:     open /ui on the gateway and paste the token${has(rest, "--admin") ? "" : " (add --admin to manage tokens/secrets/servers)"}`);
    return;
  }

  if (action === "list") {
    const rows = store.list();
    if (!rows.length) return void console.log("No tokens.");
    for (const t of rows) {
      console.log(
        `${t.id}  ${t.user}${t.admin ? " (admin)" : ""}  groups=[${t.groups.join(",")}]  created=${t.createdAt}` +
          (t.expiresAt ? `  expires=${t.expiresAt}` : "") +
          (t.label ? `  label=${t.label}` : "")
      );
    }
    return;
  }

  if (action === "revoke") {
    const id = rest[0];
    if (!id) throw new Error("usage: lazygate token revoke <id>");
    console.log(store.revoke(id) ? `Revoked ${id}` : `No such token: ${id}`);
    return;
  }

  throw new Error("usage: lazygate token create|list|revoke");
}

async function secretCmd(args: string[]): Promise<void> {
  const [action, name, ...rest] = args;
  const store = new SecretStore(gatewayDir());

  if (action === "set") {
    if (!name) throw new Error("usage: echo -n VALUE | lazygate secret set <path>   (e.g. datadog/api_key)");
    const value = flag(rest, "--value") ?? (process.stdin.isTTY ? undefined : await readStdin());
    if (!value) throw new Error("Provide the value on stdin (preferred) or with --value");
    store.set(name, value);
    console.log(`Stored ${name}. It is referenced as \${secret:${name}}; ${secretEnvName(name)} overrides it.`);
    return;
  }
  if (action === "list") {
    const names = store.list();
    console.log(names.length ? names.join("\n") : "No secrets stored.");
    return;
  }
  if (action === "delete") {
    if (!name) throw new Error("usage: lazygate secret delete <path>");
    console.log(store.delete(name) ? `Deleted ${name}` : `No such secret: ${name}`);
    return;
  }
  throw new Error("usage: lazygate secret set|list|delete");
}
