#!/usr/bin/env node
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { exportJWK, generateKeyPair, SignJWT } from "jose";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DIST_ENTRY = path.join(ROOT, "dist", "index.js");

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

function expectEqual(actual, expected, message) {
  expect(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

async function expectRejected(promise, message) {
  try {
    await promise;
  } catch {
    return;
  }
  throw new Error(message);
}

function runNode(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

function cleanEnvironment(extra = {}) {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.startsWith("AFFINE_") || key === "MCP_TRANSPORT" || key === "PORT") {
      delete environment[key];
    }
  }
  return { ...environment, ...extra };
}

const isolatedConfigHome = path.join(os.tmpdir(), `affine-mcp-oauth-audiences-${process.pid}`);
process.env.XDG_CONFIG_HOME = isolatedConfigHome;
const { loadConfig } = await import("../dist/config.js");
const { buildAudienceList, verifyOAuthAccessToken } = await import("../dist/oauth.js");
const { createHttpAuthState } = await import("../dist/httpAuth.js");

const parserCases = [
  [undefined, []],
  ["", []],
  [" , , \t\n", []],
  ["client-id", ["client-id"]],
  ["one,two", ["one", "two"]],
  ["one two\tthree\nfour", ["one", "two", "three", "four"]],
  ["one, two\tthree,one three", ["one", "two", "three"]],
];

for (const [raw, expected] of parserCases) {
  if (raw === undefined) delete process.env.AFFINE_OAUTH_AUDIENCES;
  else process.env.AFFINE_OAUTH_AUDIENCES = raw;
  expectEqual(loadConfig().oauthAudiences, expected, `parser case ${JSON.stringify(raw)}`);
}
delete process.env.AFFINE_OAUTH_AUDIENCES;

const baseOAuthConfig = {
  publicBaseUrl: "https://mcp.example.com/",
  issuerUrl: "https://issuer.example.com",
  scopes: ["mcp"],
  clockSkewSeconds: 60,
};
expectEqual(
  buildAudienceList(baseOAuthConfig),
  ["https://mcp.example.com", "https://mcp.example.com/mcp"],
  "default audience list",
);
expectEqual(
  buildAudienceList({
    ...baseOAuthConfig,
    audiences: [
      "https://mcp.example.com/mcp",
      "2483a7b3-852b-40ab-8793-646158399750",
      "Client-ID",
      "client-id",
      "2483a7b3-852b-40ab-8793-646158399750",
    ],
  }),
  [
    "https://mcp.example.com",
    "https://mcp.example.com/mcp",
    "2483a7b3-852b-40ab-8793-646158399750",
    "Client-ID",
    "client-id",
  ],
  "extended audience list",
);

const trustedKeys = await generateKeyPair("RS256");
const untrustedKeys = await generateKeyPair("RS256");
const publicJwk = await exportJWK(trustedKeys.publicKey);
Object.assign(publicJwk, { kid: "trusted-key", alg: "RS256", use: "sig" });

const issuerServer = createServer(async (request, response) => {
  const address = issuerServer.address();
  const issuerUrl = `http://127.0.0.1:${address.port}`;
  const sendJson = (body) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body));
  };
  if (request.url === "/") {
    response.writeHead(200);
    response.end("OK");
    return;
  }
  if (request.url === "/graphql") {
    sendJson({
      data: {
        currentUser: { name: "OAuth Audience Test", email: "oauth@example.test" },
        workspaces: [],
      },
    });
    return;
  }
  if (
    request.url === "/.well-known/oauth-authorization-server"
    || request.url === "/.well-known/openid-configuration"
  ) {
    sendJson({
      issuer: issuerUrl,
      authorization_endpoint: `${issuerUrl}/authorize`,
      token_endpoint: `${issuerUrl}/token`,
      jwks_uri: `${issuerUrl}/jwks`,
      response_types_supported: ["code"],
    });
    return;
  }
  if (request.url === "/jwks") {
    sendJson({ keys: [publicJwk] });
    return;
  }
  response.writeHead(404);
  response.end("Not Found");
});
await new Promise((resolve, reject) => {
  issuerServer.once("error", reject);
  issuerServer.listen(0, "127.0.0.1", resolve);
});

try {
  const issuerAddress = issuerServer.address();
  const issuerUrl = `http://127.0.0.1:${issuerAddress.port}`;
  const publicBaseUrl = "https://mcp.example.com";
  const entraClientId = "2483a7b3-852b-40ab-8793-646158399750";
  const verificationConfig = {
    publicBaseUrl,
    issuerUrl,
    scopes: ["mcp"],
    clockSkewSeconds: 60,
  };
  const mint = ({ audience, issuer = issuerUrl, expiresAt, key = trustedKeys.privateKey }) => {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ scope: "mcp", client_id: "client" })
      .setProtectedHeader({ alg: "RS256", kid: "trusted-key" })
      .setIssuer(issuer)
      .setAudience(audience)
      .setIssuedAt(now)
      .setExpirationTime(expiresAt ?? now + 300)
      .sign(key);
  };

  await verifyOAuthAccessToken(await mint({ audience: publicBaseUrl }), verificationConfig);
  await verifyOAuthAccessToken(await mint({ audience: `${publicBaseUrl}/mcp` }), verificationConfig);
  await expectRejected(
    verifyOAuthAccessToken(await mint({ audience: entraClientId }), verificationConfig),
    "Entra client ID was accepted without explicit configuration",
  );
  await verifyOAuthAccessToken(
    await mint({ audience: entraClientId }),
    { ...verificationConfig, audiences: [entraClientId] },
  );
  await verifyOAuthAccessToken(
    await mint({ audience: `${publicBaseUrl}/mcp` }),
    { ...verificationConfig, audiences: [entraClientId] },
  );

  Object.assign(process.env, {
    AFFINE_MCP_AUTH_MODE: "oauth",
    AFFINE_MCP_PUBLIC_BASE_URL: publicBaseUrl,
    AFFINE_OAUTH_ISSUER_URL: issuerUrl,
    AFFINE_OAUTH_AUDIENCES: entraClientId,
  });
  const runtimeConfig = loadConfig();
  const authState = createHttpAuthState(runtimeConfig, { allowAnyOrigin: false });
  expectEqual(authState.oauthConfig?.audiences, [entraClientId], "runtime OAuth audience propagation");
  const runtimeToken = await mint({ audience: entraClientId });
  const middlewareResult = await new Promise((resolve) => {
    const response = {
      statusCode: 200,
      set() { return this; },
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ accepted: false, statusCode: this.statusCode, body }); return this; },
    };
    authState.authMiddleware(
      {
        method: "POST",
        query: {},
        headers: { authorization: `Bearer ${runtimeToken}` },
      },
      response,
      () => resolve({ accepted: true, statusCode: response.statusCode }),
    );
  });
  expect(middlewareResult.accepted, "runtime JWT validator did not receive AFFINE_OAUTH_AUDIENCES");
  await expectRejected(
    verifyOAuthAccessToken(await mint({ audience: "unknown" }), {
      ...verificationConfig,
      audiences: [entraClientId],
    }),
    "unknown audience was accepted",
  );
  await expectRejected(
    verifyOAuthAccessToken(await mint({ audience: entraClientId, key: untrustedKeys.privateKey }), {
      ...verificationConfig,
      audiences: [entraClientId],
    }),
    "token with invalid signature was accepted",
  );
  await expectRejected(
    verifyOAuthAccessToken(await mint({ audience: entraClientId, issuer: `${issuerUrl}/wrong` }), {
      ...verificationConfig,
      audiences: [entraClientId],
    }),
    "token with invalid issuer was accepted",
  );
  await expectRejected(
    verifyOAuthAccessToken(await mint({
      audience: entraClientId,
      expiresAt: Math.floor(Date.now() / 1000) - 120,
    }), {
      ...verificationConfig,
      audiences: [entraClientId],
    }),
    "expired token was accepted",
  );

  const cliEnv = cleanEnvironment({
    XDG_CONFIG_HOME: isolatedConfigHome,
    AFFINE_BASE_URL: issuerUrl,
    AFFINE_API_TOKEN: "test-token",
    MCP_TRANSPORT: "http",
    AFFINE_MCP_AUTH_MODE: "oauth",
    AFFINE_MCP_PUBLIC_BASE_URL: publicBaseUrl,
    AFFINE_OAUTH_ISSUER_URL: issuerUrl,
    AFFINE_OAUTH_AUDIENCES: `${entraClientId}, ${publicBaseUrl}/mcp`,
  });
  const showConfig = await runNode([DIST_ENTRY, "show-config", "--json"], cliEnv);
  expect(showConfig.code === 0, `show-config failed: ${showConfig.stderr}`);
  const summary = JSON.parse(showConfig.stdout);
  expectEqual(summary.oauthAudiences, [entraClientId, `${publicBaseUrl}/mcp`], "show-config audiences");
  expectEqual(
    summary.oauthEffectiveAudiences,
    [publicBaseUrl, `${publicBaseUrl}/mcp`, entraClientId],
    "show-config effective audiences",
  );
  expect(summary.sources.oauthAudiences === "env", "show-config audience source was not env");

  const doctor = await runNode([DIST_ENTRY, "doctor", "--json"], cliEnv);
  expect(doctor.code === 0, `doctor failed: ${doctor.stderr}\n${doctor.stdout}`);
  const doctorPayload = JSON.parse(doctor.stdout);
  expect(
    doctorPayload.checks.some(
      (check) => check.name === "oauth-audiences"
        && check.ok
        && check.detail.includes(entraClientId),
    ),
    "doctor did not report the effective OAuth audiences",
  );
} finally {
  await new Promise((resolve) => issuerServer.close(resolve));
}

console.log(JSON.stringify({
  ok: true,
  cases: [
    "audience parser",
    "default and extended lists",
    "JWT audience validation",
    "ENV-to-runtime validator propagation",
    "signature, issuer, and expiry regressions",
    "show-config and doctor diagnostics",
  ],
}, null, 2));
