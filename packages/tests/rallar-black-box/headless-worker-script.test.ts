import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "../../..");

describe("rallar-black-box headless worker script", () => {
  it("launches the configured Playwright browser engine", async () => {
    const source = await readFile(
      path.join(repoRoot, "apps/rallar-black-box/scripts/headless-worker.ts"),
      "utf8",
    );

    expect(source).toContain("type BrowserType");
    expect(source).toContain("chromium,");
    expect(source).toContain("firefox,");
    expect(source).toContain("webkit,");
    expect(source).toContain(
      "satisfies Record<HeadlessWorkerBrowserEngine, BrowserType>",
    );
    expect(source).toContain("browserTypes[config.browserEngine].launch");
    expect(source).toContain("engine=${config.browserEngine}");
  });
});
