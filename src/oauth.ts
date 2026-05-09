// src/oauth.ts
// PKCE OAuth 2.0 flow for HTTP MCP servers.
// Discovers endpoints via /.well-known/oauth-authorization-server,
// runs the browser-based authorization flow, and persists tokens to disk.

import { createServer } from "http";
import { createHash, randomBytes } from "crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve } from "path";
import { homedir } from "os";
import { execSync } from "child_process";

export interface OAuthConfig {
  clientId: string;
  callbackPort: number;
  scopes?: string[];         // if omitted, all scopes from discovery are requested
}

interface TokenSet {
  access_token: string;
  refresh_token?: string;
  expires_at?: number;       // unix ms
  token_type?: string;
}

interface OAuthMeta {
  authorization_endpoint: string;
  token_endpoint: string;
  scopes_supported?: string[];
  code_challenge_methods_supported?: string[];
}

const TOKEN_DIR = resolve(homedir(), ".config", "context-broker", "tokens");

function tokenPath(serverName: string): string {
  return resolve(TOKEN_DIR, `${serverName}.json`);
}

function loadToken(serverName: string): TokenSet | null {
  const p = tokenPath(serverName);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as TokenSet;
  } catch {
    return null;
  }
}

function saveToken(serverName: string, token: TokenSet): void {
  mkdirSync(TOKEN_DIR, { recursive: true });
  writeFileSync(tokenPath(serverName), JSON.stringify(token, null, 2) + "\n");
}

function isExpired(token: TokenSet): boolean {
  if (!token.expires_at) return false;
  return Date.now() > token.expires_at - 60_000; // 1 min buffer
}

async function discoverOAuthMeta(serverUrl: string): Promise<OAuthMeta> {
  const base = new URL(serverUrl).origin;
  const res = await fetch(`${base}/.well-known/oauth-authorization-server`);
  if (!res.ok) throw new Error(`OAuth discovery failed for ${base}: HTTP ${res.status}`);
  return res.json() as Promise<OAuthMeta>;
}

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

function openBrowser(url: string): void {
  try {
    execSync(`open "${url}"`, { stdio: "ignore" });
  } catch {
    console.error(`[oauth] Could not open browser. Open this URL manually:\n  ${url}`);
  }
}

async function waitForCallback(port: number): Promise<{ code: string; state: string }> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${port}`);
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const error = url.searchParams.get("error");

      res.writeHead(200, { "Content-Type": "text/html" });
      if (code) {
        res.end("<html><body><h2>✓ Authenticated. You can close this tab.</h2></body></html>");
        server.close();
        resolve({ code, state: state ?? "" });
      } else {
        res.end(`<html><body><h2>Error: ${error ?? "unknown"}</h2></body></html>`);
        server.close();
        reject(new Error(`OAuth error: ${error ?? "unknown"}`));
      }
    });

    server.listen(port, "127.0.0.1", () => {
      console.error(`[oauth] Waiting for OAuth callback on port ${port}...`);
    });

    server.on("error", reject);

    // Timeout after 5 minutes
    setTimeout(() => {
      server.close();
      reject(new Error("OAuth callback timed out after 5 minutes"));
    }, 5 * 60 * 1000);
  });
}

async function exchangeCode(
  tokenEndpoint: string,
  clientId: string,
  code: string,
  verifier: string,
  redirectUri: string
): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId,
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri,
  });

  const res = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  const data = await res.json() as Record<string, unknown>;
  if (!res.ok || data.error) {
    throw new Error(`Token exchange failed: ${data.error ?? res.status} — ${data.error_description ?? ""}`);
  }

  const token: TokenSet = {
    access_token: data.access_token as string,
    refresh_token: data.refresh_token as string | undefined,
    token_type: data.token_type as string | undefined,
  };
  if (typeof data.expires_in === "number") {
    token.expires_at = Date.now() + data.expires_in * 1000;
  }
  return token;
}

async function refreshToken(
  tokenEndpoint: string,
  clientId: string,
  refreshTok: string
): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: refreshTok,
  });

  const res = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  const data = await res.json() as Record<string, unknown>;
  if (!res.ok || data.error) {
    throw new Error(`Token refresh failed: ${data.error ?? res.status}`);
  }

  const token: TokenSet = {
    access_token: data.access_token as string,
    refresh_token: (data.refresh_token as string | undefined) ?? refreshTok,
    token_type: data.token_type as string | undefined,
  };
  if (typeof data.expires_in === "number") {
    token.expires_at = Date.now() + data.expires_in * 1000;
  }
  return token;
}

// Returns a valid Bearer token for the given server, running the OAuth flow if needed.
export async function getAccessToken(
  serverName: string,
  serverUrl: string,
  config: OAuthConfig
): Promise<string> {
  const meta = await discoverOAuthMeta(serverUrl);

  let token = loadToken(serverName);

  // Try refresh if expired
  if (token && isExpired(token) && token.refresh_token) {
    console.error(`[oauth] Refreshing token for ${serverName}...`);
    try {
      token = await refreshToken(meta.token_endpoint, config.clientId, token.refresh_token);
      saveToken(serverName, token);
    } catch (err) {
      console.error(`[oauth] Refresh failed: ${(err as Error).message} — re-authorizing`);
      token = null;
    }
  }

  if (token && !isExpired(token)) {
    return token.access_token;
  }

  // Full authorization flow
  console.error(`[oauth] Authorizing ${serverName} — a browser window will open`);

  const { verifier, challenge } = generatePKCE();
  const state = base64url(randomBytes(16));
  const redirectUri = `http://localhost:${config.callbackPort}/callback`;
  const scopes = config.scopes ?? meta.scopes_supported ?? [];

  const authUrl = new URL(meta.authorization_endpoint);
  authUrl.searchParams.set("client_id", config.clientId);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", scopes.join(" "));
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");

  openBrowser(authUrl.toString());

  const { code } = await waitForCallback(config.callbackPort);
  token = await exchangeCode(meta.token_endpoint, config.clientId, code, verifier, redirectUri);
  saveToken(serverName, token);

  console.error(`[oauth] ${serverName} authorized successfully`);
  return token.access_token;
}
