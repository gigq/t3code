import { describe, expect, it } from "vitest";

import {
  isClaudeOauthCredentialExpired,
  parseClaudeOauthCredentialExpiry,
} from "./ClaudeProvider.ts";

describe("ClaudeProvider credential expiry helpers", () => {
  it("extracts Claude OAuth credential expiry without reading token values", () => {
    expect(
      parseClaudeOauthCredentialExpiry(
        JSON.stringify({
          claudeAiOauth: {
            accessToken: "secret",
            refreshToken: "secret",
            expiresAt: 1_776_208_977_716,
          },
        }),
      ),
    ).toEqual({
      expiresAtMs: 1_776_208_977_716,
      expiresAtIso: "2026-04-14T23:22:57.716Z",
    });
  });

  it("detects expired Claude OAuth credentials with a small safety skew", () => {
    const expiry = parseClaudeOauthCredentialExpiry(
      JSON.stringify({ claudeAiOauth: { expiresAt: 1_000 } }),
    );

    expect(isClaudeOauthCredentialExpired(expiry, 0)).toBe(true);
    expect(isClaudeOauthCredentialExpired(expiry, 120_000)).toBe(true);
  });

  it("ignores missing or malformed credential files", () => {
    expect(parseClaudeOauthCredentialExpiry("{}")).toBeNull();
    expect(parseClaudeOauthCredentialExpiry("not json")).toBeNull();
    expect(isClaudeOauthCredentialExpired(null)).toBe(false);
  });

  it("can report auth via OAuth token without relying on local credential expiry", () => {
    const expiry = parseClaudeOauthCredentialExpiry(
      JSON.stringify({ claudeAiOauth: { expiresAt: 1_000 } }),
    );

    expect(expiry?.expiresAtMs).toBe(1_000);
    expect(isClaudeOauthCredentialExpired(expiry, 2_000)).toBe(true);
  });
});
