import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveConfig } from "../src/config.js";

test("BILDY_GATEWAY_CACHE_DIR overrides repo-local sqlite cache path", () => {
  const previous = process.env.BILDY_GATEWAY_CACHE_DIR;
  const cacheDir = mkdtempSync(path.join(tmpdir(), "llm-gateway-cache-"));
  process.env.BILDY_GATEWAY_CACHE_DIR = cacheDir;

  try {
    const config = resolveConfig({ cwd: mkdtempSync(path.join(tmpdir(), "llm-gateway-cwd-")) });
    assert.equal(config.cache.path, path.join(cacheDir, "cache.sqlite"));
  } finally {
    if (previous === undefined) {
      delete process.env.BILDY_GATEWAY_CACHE_DIR;
    } else {
      process.env.BILDY_GATEWAY_CACHE_DIR = previous;
    }
  }
});
