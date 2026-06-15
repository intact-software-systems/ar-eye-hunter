import { expect, test } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  expectFullStackApiReady,
  loginThroughUi,
  readFullStackConfig,
  sendWsTicketFromRestWorkbench,
  uniqueSuffix,
} from "./full-stack-helpers.ts";

const config = readFullStackConfig();
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const artifactFixtureDir = path.join(
  repoRoot,
  "packages/shared-test/black-box-runner/fixtures/schema/v1/artifact-bundle",
);

test.describe("full-stack command-center QA matrix", () => {
  test.skip(!config.enabled, config.skipReason);

  test("covers auth negative and missing-token REST behavior with actionable evidence", async ({ page, request }) => {
    test.setTimeout(90_000);
    await expectFullStackApiReady(request, config);

    const suffix = uniqueSuffix();
    const loginQuery = new URLSearchParams({
      provider: "browser-rallar",
      apiBaseUrl: config.apiBaseUrl,
      roomId: `${config.roomId}-negative-${suffix}`,
      actor: config.userA.actor,
      sessionId: `${config.userA.actor}-negative-${suffix}`,
      tab: "auth",
    });

    await page.goto(`/?${loginQuery.toString()}`);
    await expect(page.getByRole("heading", { name: "Rallar Server Login" }))
      .toBeVisible();
    await page.getByLabel("API Base URL").fill(config.apiBaseUrl);
    await page.getByLabel("Username").fill(
      `${config.userA.username}-bad-${suffix}`,
    );
    await page.getByLabel("Password").fill(`wrong-${suffix}`);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.locator(".auth-panel")).toContainText(
      /login|auth|invalid|failed/i,
    );

    const protectedResponse = await request.get(
      `${config.apiBaseUrl}/api/state/apps/ar-eye-hunter/workspaces/default/groups`,
      {
        headers: {
          origin: "http://localhost:5176",
        },
      },
    );
    expect([401, 403]).toContain(protectedResponse.status());
  });

  test("cross-checks WS command center, recipe catalog, and artifact import surfaces", async ({ page, request }) => {
    test.setTimeout(120_000);
    await expectFullStackApiReady(request, config);

    const suffix = uniqueSuffix();
    await loginThroughUi(page, config, config.userA, {
      suffix: `qa-matrix-${suffix}`,
      tab: "rallar-server",
    });

    const ticketHeaders = await sendWsTicketFromRestWorkbench(page, config);
    expect(ticketHeaders.authorization).toMatch(/^Bearer /);

    await page.getByRole("tab", { name: "WebSocket" }).click();
    const wsPanel = page.locator("#panel-websocket");
    await expect(wsPanel).toBeVisible();
    await wsPanel.getByRole("button", { name: "Configure WS" }).click();
    await expect(wsPanel).toContainText(
      "rallar.direct.raw_ws.configure.completed",
    );
    await wsPanel.getByRole("button", { name: "Missing ticket open" }).click();
    await expect(wsPanel).toContainText("Raw WebSocket emitted an error.");
    await expect(wsPanel).toContainText("rallar.direct.raw_ws.error");

    await page.getByRole("button", { name: /Rallar black-box-runner/ }).click();
    await page.getByRole("tab", { name: "Advanced", exact: true }).click();
    await page.locator("#panel-advanced")
      .getByRole("button", { name: "Shared Test", exact: true })
      .click();
    const sharedPanel = page.locator("#panel-shared-test");
    await expect(sharedPanel).toContainText("Recipe Catalog");
    await expect(sharedPanel).toContainText("Memory Delivery");
    await sharedPanel.locator('input[type="file"]').setInputFiles([
      path.join(artifactFixtureDir, "report.json"),
      path.join(artifactFixtureDir, "events.jsonl"),
      path.join(artifactFixtureDir, "failures.json"),
      path.join(artifactFixtureDir, "metadata.json"),
      path.join(artifactFixtureDir, "expanded-plan.json"),
      path.join(artifactFixtureDir, "matrix-summary.json"),
    ]);
    await expect(sharedPanel).toContainText("valid");
    await expect(sharedPanel).toContainText("Imported Summary");
  });
});
