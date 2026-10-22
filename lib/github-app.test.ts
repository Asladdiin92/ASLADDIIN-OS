import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { isGitHubConfigured } from "./github-app";

const originalAppId = process.env.GITHUB_APP_ID;
const originalInstallationId = process.env.GITHUB_INSTALLATION_ID;
const originalPrivateKey = process.env.GITHUB_PRIVATE_KEY;

test.after(() => {
  if (originalAppId === undefined) delete process.env.GITHUB_APP_ID;
  else process.env.GITHUB_APP_ID = originalAppId;
  if (originalInstallationId === undefined) delete process.env.GITHUB_INSTALLATION_ID;
  else process.env.GITHUB_INSTALLATION_ID = originalInstallationId;
  if (originalPrivateKey === undefined) delete process.env.GITHUB_PRIVATE_KEY;
  else process.env.GITHUB_PRIVATE_KEY = originalPrivateKey;
});

test("GitHub configuration requires all three non-empty App credentials", () => {
  delete process.env.GITHUB_APP_ID;
  delete process.env.GITHUB_INSTALLATION_ID;
  delete process.env.GITHUB_PRIVATE_KEY;
  assert.equal(isGitHubConfigured(), false);

  process.env.GITHUB_APP_ID = "app-id";
  process.env.GITHUB_INSTALLATION_ID = "installation-id";
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  process.env.GITHUB_PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  assert.equal(isGitHubConfigured(), true);

  process.env.GITHUB_PRIVATE_KEY = "not-a-private-key";
  assert.equal(isGitHubConfigured(), false);
});
