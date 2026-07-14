import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
  type Route,
  type TestInfo,
} from "@playwright/test";
import type {
  ControlDistributedRunSnapshot,
  ControlRunSnapshot,
} from "../../../packages/shared-test/rallar-bb-test/control-snapshots.ts";
import { ADVANCED_SURFACE_CATALOG } from "../../../apps/rallar-black-box/src/recipe-console/advanced/advanced-surface-catalog.ts";
import {
  installRecipeConsoleMonitorFixture,
  MONITOR_CONTROL_RUN_ID,
  MONITOR_DISTRIBUTED_RUN_ID,
  MONITOR_FAILURE_AGENT_ID,
  MONITOR_FAILURE_COMMAND_ID,
  MONITOR_FAILURE_RECIPE_ID,
  MONITOR_ROUTE,
} from "./recipe-console-monitor-fixture.ts";

const CONTROL_ROUTE = /https?:\/\/(?:localhost|127\.0\.0\.1):5180\/.*/;
const PRODUCTION_BASE_URL = "http://127.0.0.1:4176";
const PRIMARY_VIEWS = [
  "Execute",
  "Monitor",
  "Analyze",
  "Tune",
  "Fleet",
  "Advanced",
] as const;
const DIRECT_DIAGNOSTIC_LABELS = [
  "Quick Test",
  "Auth",
  "Groups/Clients",
  "WebSocket",
  "RTC/Realtimes",
  "Topology",
  "RTC Diagnostics",
  "Rallar Data",
  "CRDT",
  "Media",
  "Rallar Server",
  "Rallar Trace",
  "Event Stream",
] as const;
const MONITOR_HANDOFFS = [
  {
    label: "Auth",
    owner: "#panel-auth",
    surfaceId: "direct.auth",
    tab: "auth",
    workspace: "rallar",
  },
  {
    label: "WebSocket",
    owner: "#panel-websocket",
    surfaceId: "direct.websocket",
    tab: "websocket",
    workspace: "rallar",
  },
  {
    label: "RTC Diagnostics",
    owner: "#panel-rtc-diagnostics",
    surfaceId: "direct.rtc-diagnostics",
    tab: "rtc-diagnostics",
    workspace: "rallar",
  },
  {
    label: "Groups/Clients",
    owner: "#panel-rooms-clients",
    surfaceId: "direct.groups-clients",
    tab: "rooms-clients",
    workspace: "rallar",
  },
  {
    label: "Rallar Server",
    owner: "#panel-rallar-server",
    surfaceId: "direct.rallar-server",
    tab: "rallar-server",
    workspace: "rallar",
  },
] as const;
const LONG_BIDI_AGENT_ID = `agent/${"receiver-".repeat(12)}\u2067exact-agent\u2069`;
const LONG_BIDI_RECIPE_ID = `recipe/${"later-".repeat(14)}\u2067exact-recipe\u2069`;
const LONG_BIDI_COMMAND_ID = `command/${"start-".repeat(16)}\u2067exact-command\u2069`;
const LONG_BIDI_GROUP_ID = `group/${"monitor-".repeat(12)}\u2067exact-group\u2069`;
const COMBINED_FAILURE_MESSAGE =
  "Unauthorized ticket; missing group; Rallar Server status 503; no route.";

const OWNER_SELECTORS: Readonly<Record<string, string>> = {
  "direct.quick-test": "#panel-quick-test",
  "direct.auth": "#panel-auth",
  "direct.groups-clients": "#panel-rooms-clients",
  "direct.websocket": "#panel-websocket",
  "direct.rtc-realtimes": "#panel-rtc-realtime",
  "direct.topology": "#panel-topology",
  "direct.rtc-diagnostics": "#panel-rtc-diagnostics",
  "direct.rallar-data": "#panel-rallar-data",
  "direct.crdt": "#panel-crdt-health",
  "direct.media": "#panel-media",
  "direct.rallar-server": "#panel-rallar-server",
  "direct.rallar-trace": "#panel-rallar-trace",
  "diagnostic.event-stream": "#panel-event-stream",
  "runner.recipes": "#panel-recipes",
  "runner.runs": "#panel-runs",
  "runner.fleet": "#panel-fleet",
  "runner.builder": "#panel-builder",
  "legacy.manual-rallar": "#panel-manual-rallar",
  "legacy.local-workbench": "#panel-local-workbench",
  "legacy.run-manager": "#panel-run-manager",
  "legacy.distributed-recipes": "#panel-distributed-recipes",
  "legacy.shared-test-catalog": "#panel-shared-test",
};

const LAZY_TARGETS = [
  ["runner.recipes", "RunnerRecipesPanel"],
  ["runner.runs", "RunnerRunsPanel"],
  ["runner.fleet", "RunnerFleetPanel"],
  ["runner.builder", "FlowBuilderPanel"],
  ["legacy.distributed-recipes", "DistributedRecipesPanel"],
  ["legacy.run-manager", "RunManagerPanel"],
  ["legacy.shared-test-catalog", "SharedTestPanel"],
  ["direct.groups-clients", "RoomsClientsPanel"],
  ["direct.topology", "TopologyGraphPanel"],
  ["direct.rtc-diagnostics", "RtcDiagnosticsPanel"],
] as const;
const STATEFUL_EXCEPTION_SELECTORS = [
  "#panel-quick-test",
  "#panel-auth",
  "#panel-websocket",
  "#panel-rtc-realtime",
  "#panel-rallar-data",
  "#panel-crdt-health",
  "#panel-media",
  "#panel-local-workbench",
  "#panel-manual-rallar",
  "#panel-rallar-trace",
  "#panel-event-stream",
  "#panel-rallar-server",
] as const;

test("keeps direct Rallar diagnostics out of primary navigation and opens them from Advanced", async ({
  browser,
  context,
  page,
}, testInfo) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await installCombinedFailureMonitorFixture(context);
  await page.goto(MONITOR_ROUTE);

  const primary = page.getByRole("navigation", { name: "Recipe Console" });
  await expect(primary.getByRole("button")).toHaveText(PRIMARY_VIEWS);
  for (const legacyLabel of DIRECT_DIAGNOSTIC_LABELS) {
    await expect(primary.getByText(legacyLabel, { exact: true })).toHaveCount(
      0,
    );
  }

  const handoffs = page.getByRole("navigation", {
    name: "Relevant legacy diagnostics",
  });
  await expect(handoffs).toBeVisible();
  await expect(handoffs.getByRole("link")).toHaveText(
    MONITOR_HANDOFFS.map(({ label }) => label),
  );
  for (const link of await handoffs.getByRole("link").all()) {
    const href = await link.getAttribute("href");
    expect(href).toBeTruthy();
    const url = new URL(href ?? "", page.url());
    expect(url.searchParams.get("experience")).toBe("legacy");
    expect(url.searchParams.get("diagnosticContext")).toBe("1");
    expect(url.searchParams.get("view")).toBe("monitor");
    expect(url.searchParams.get("provider")).toBe("simulated");
    expect(url.searchParams.get("contextApplicationId")).toBe("rallar-server");
    expect(url.searchParams.get("contextWorkspaceId")).toBe("default");
    expect(url.searchParams.get("contextGroupId")).toBe(LONG_BIDI_GROUP_ID);
    expect(url.searchParams.get("controlRunId")).toBe(MONITOR_CONTROL_RUN_ID);
    expect(url.searchParams.get("distributedRunId")).toBe(
      MONITOR_DISTRIBUTED_RUN_ID,
    );
    expect(url.searchParams.get("agentId")).toBe(LONG_BIDI_AGENT_ID);
    expect(url.searchParams.get("recipeId")).toBe(LONG_BIDI_RECIPE_ID);
    expect(url.searchParams.get("commandId")).toBe(LONG_BIDI_COMMAND_ID);
    expect(url.href).not.toMatch(/controlToken|returnTo|password|secret/i);
    expect(
      new TextEncoder().encode(url.search.slice(1)).byteLength,
    ).toBeLessThanOrEqual(4_096);
  }

  for (const [handoffIndex, handoff] of MONITOR_HANDOFFS.entries()) {
    if (handoffIndex > 0) {
      await page.goto(MONITOR_ROUTE);
      await expect(
        page.getByRole("navigation", {
          name: "Relevant legacy diagnostics",
        }),
      ).toBeVisible();
    }
    const link = page
      .getByRole("navigation", { name: "Relevant legacy diagnostics" })
      .getByRole("link", {
        name: `Open ${handoff.label} with selected failure context`,
      });
    await expect(link).toHaveAttribute("data-diagnostic-surface", handoff.tab);
    await link.focus();
    await expect(link).toBeFocused();
    await link.press("Enter");

    const legacyUrl = currentUrl(page);
    expect(legacyUrl.searchParams.get("legacySurface")).toBe(handoff.surfaceId);
    expect(legacyUrl.searchParams.get("workspace")).toBe(handoff.workspace);
    expect(legacyUrl.searchParams.get("tab")).toBe(handoff.tab);
    await expect(page.locator(handoff.owner)).toHaveCount(1);
    await expect(page.locator(handoff.owner)).toBeVisible();
    await expectLegacyContext(page, {
      commandId: LONG_BIDI_COMMAND_ID,
      contextGroupId: LONG_BIDI_GROUP_ID,
      controlRunId: MONITOR_CONTROL_RUN_ID,
      distributedRunId: MONITOR_DISTRIBUTED_RUN_ID,
    });

    if (handoff.surfaceId === "direct.auth") {
      await expectLegacyContext(page, {
        agentId: LONG_BIDI_AGENT_ID,
        recipeId: LONG_BIDI_RECIPE_ID,
      });
      await expect(page.getByLabel("Global Application")).toHaveValue(
        "rallar-server",
      );
      await expect(page.getByLabel("Global Workspace")).toHaveValue("default");
      await expect(page.getByLabel("Global Room")).toHaveValue(
        LONG_BIDI_GROUP_ID,
      );
    }

    const monitorReturn = page.locator("[data-legacy-diagnostic-return]");
    const monitorReturnUrl = new URL(
      (await monitorReturn.getAttribute("href")) ?? "",
      page.url(),
    );
    expect(monitorReturnUrl.searchParams.get("view")).toBe("monitor");
    if (handoff.surfaceId === "direct.auth") {
      expect(Object.fromEntries(monitorReturnUrl.searchParams)).toEqual({
        provider: "simulated",
        v: "1",
        experience: "recipe-console",
        view: "monitor",
        controlRunId: MONITOR_CONTROL_RUN_ID,
        distributedRunId: MONITOR_DISTRIBUTED_RUN_ID,
        agentId: LONG_BIDI_AGENT_ID,
        recipeId: LONG_BIDI_RECIPE_ID,
        commandId: LONG_BIDI_COMMAND_ID,
      });
    }
    await monitorReturn.focus();
    await expect(monitorReturn).toBeFocused();
    await monitorReturn.press("Enter");
    await expect(
      page.locator('.recipe-console[data-view="monitor"]'),
    ).toBeVisible();
    await expect(
      page
        .getByRole("navigation", { name: "Recipe Console" })
        .getByRole("button", { name: "Monitor", exact: true }),
    ).toBeFocused();

    if (handoff.surfaceId === "direct.auth") {
      await expect(
        page
          .locator("[data-monitor-inspector] [data-exact-identifier]")
          .first(),
      ).toHaveText(LONG_BIDI_COMMAND_ID);
      expect(currentUrl(page).searchParams.get("controlRunId")).toBe(
        MONITOR_CONTROL_RUN_ID,
      );
      expect(currentUrl(page).searchParams.get("distributedRunId")).toBe(
        MONITOR_DISTRIBUTED_RUN_ID,
      );
      expect(currentUrl(page).searchParams.has("diagnosticContext")).toBe(
        false,
      );
      expect(currentUrl(page).searchParams.has("legacySurface")).toBe(false);
    }
  }

  const persistentCommandBarFocus = page.getByRole("button", {
    name: "Copy canonical link",
  });
  await persistentCommandBarFocus.focus();
  await expect(persistentCommandBarFocus).toBeFocused();
  const analyzeUrl = currentUrl(page);
  analyzeUrl.searchParams.set("view", "analyze");
  await navigateInApp(page, analyzeUrl.pathname + analyzeUrl.search);
  await expect(
    page.locator('.recipe-console[data-view="analyze"]'),
  ).toBeVisible();
  await expect(persistentCommandBarFocus).toBeFocused();
  const monitorUrl = currentUrl(page);
  monitorUrl.searchParams.set("view", "monitor");
  await navigateInApp(page, monitorUrl.pathname + monitorUrl.search);
  await expect(
    page.locator('.recipe-console[data-view="monitor"]'),
  ).toBeVisible();
  await expect(persistentCommandBarFocus).toBeFocused();

  const monitorNavigation = primary.getByRole("button", {
    name: "Monitor",
    exact: true,
  });
  await monitorNavigation.focus();
  await monitorNavigation.press("End");
  const advancedNavigation = primary.getByRole("button", {
    name: "Advanced",
    exact: true,
  });
  await expect(advancedNavigation).toBeFocused();
  await advancedNavigation.press("Enter");

  const advanced = page.locator("[data-advanced-workspace]");
  await expect(advanced).toBeVisible();
  await expect(advanced.locator("[data-advanced-surface-link]")).toHaveCount(
    22,
  );
  await expect(
    advanced.locator(
      '[data-advanced-category="direct-diagnostics"] [data-advanced-surface-link]',
    ),
  ).toHaveCount(13);
  await expect(
    advanced.locator(
      '[data-advanced-category="workflow-fallbacks"] [data-advanced-surface-link]',
    ),
  ).toHaveCount(4);
  await expect(
    advanced.locator(
      '[data-advanced-category="advanced-legacy"] [data-advanced-surface-link]',
    ),
  ).toHaveCount(5);
  await expect(
    advanced.locator(
      '[data-context-field="commandId"] [data-exact-identifier]',
    ),
  ).toHaveText(LONG_BIDI_COMMAND_ID);
  await expect(
    advanced.locator(
      '[data-context-field="commandId"] [data-exact-identifier]',
    ),
  ).toHaveAttribute("dir", "ltr");
  await expect(page.locator(".app-shell")).toHaveCount(0);
  expect(await documentOverflow(page)).toEqual({ x: 0, y: 0 });
  await attachScreenshot(
    page,
    testInfo,
    "advanced-direction-a-desktop-1440x900",
  );

  const groupsLink = advanced.locator(
    '[data-surface-id="direct.groups-clients"]',
  );
  await groupsLink.focus();
  await expect(groupsLink).toBeFocused();
  await groupsLink.press("Enter");
  await expect(page.locator("#panel-rooms-clients")).toBeVisible();
  await expectLegacyContext(page, {
    commandId: LONG_BIDI_COMMAND_ID,
    contextGroupId: LONG_BIDI_GROUP_ID,
    controlRunId: MONITOR_CONTROL_RUN_ID,
    distributedRunId: MONITOR_DISTRIBUTED_RUN_ID,
  });
  const advancedReturn = page.locator("[data-legacy-diagnostic-return]");
  expect(
    new URL(
      (await advancedReturn.getAttribute("href")) ?? "",
      page.url(),
    ).searchParams.get("view"),
  ).toBe("advanced");
  await advancedReturn.focus();
  await expect(advancedReturn).toBeFocused();
  await advancedReturn.press("Enter");
  await expect(advanced).toBeVisible();
  await expect(advancedNavigation).toBeFocused();

  await page.setViewportSize({ width: 900, height: 900 });
  expect(await documentOverflow(page)).toEqual({ x: 0, y: 0 });
  await expectMinimumTarget(page, "[data-primary-navigation] button");
  await expectMinimumTarget(page, '[data-surface-id="direct.auth"]');

  await proveTouchAdvancedLayout(browser, testInfo, {
    height: 932,
    name: "advanced-direction-a-touch-portrait-430x932",
    width: 430,
  });
  await proveTouchAdvancedLayout(browser, testInfo, {
    height: 430,
    name: "advanced-direction-a-touch-landscape-932x430",
    width: 932,
  });
});

test("opens every registered legacy surface from its alias and contextual route", async ({
  browser,
  context,
  page,
}) => {
  test.setTimeout(240_000);
  await installEmptyControlFixture(context);
  await page.goto(
    "/?provider=simulated&v=1&experience=recipe-console&view=advanced",
  );
  const advanced = page.locator("[data-advanced-workspace]");
  await expect(advanced).toBeVisible();
  const contextualHrefs = new Map(
    await advanced
      .locator("[data-advanced-surface-link]")
      .evaluateAll((links) =>
        links.map(
          (link) =>
            [
              link.getAttribute("data-surface-id") ?? "",
              link.getAttribute("href") ?? "",
            ] as const,
        ),
      ),
  );
  expect(contextualHrefs.size).toBe(ADVANCED_SURFACE_CATALOG.length);

  for (const surface of ADVANCED_SURFACE_CATALOG) {
    const href = contextualHrefs.get(surface.id);
    expect(href, `${surface.id}: contextual href`).toBeTruthy();
    await page.goto(href ?? "about:blank");
    await expectSurfaceOwner(page, surface.id);
    const url = currentUrl(page);
    expect(url.searchParams.get("legacySurface")).toBe(surface.id);
    expect(url.searchParams.get("diagnosticContext")).toBe("1");
    expect(url.searchParams.get("workspace")).toBe(surface.route.workspace);
    expect(url.searchParams.get("tab")).toBe(surface.route.tab);
    expect(url.searchParams.get("advancedSurface")).toBe(
      surface.route.advancedSurface ?? null,
    );
    await expect(
      page.locator("[data-legacy-diagnostic-context]"),
    ).toHaveAttribute("data-context-status", "ready");
    await expect(
      page.locator("[data-legacy-diagnostic-return]"),
    ).toHaveAttribute("href", /experience=recipe-console/);
  }

  await page.goto(
    "/?provider=simulated&experience=legacy&workspace=rallar&tab=auth",
  );
  for (const surface of ADVANCED_SURFACE_CATALOG) {
    for (const alias of surface.aliases) {
      const aliasUrl = new URL("/", page.url());
      aliasUrl.searchParams.set("provider", "simulated");
      aliasUrl.searchParams.set("experience", "legacy");
      aliasUrl.searchParams.set("workspace", surface.route.workspace);
      aliasUrl.searchParams.set("tab", alias);
      await navigateInApp(page, aliasUrl.pathname + aliasUrl.search);
      await expectSurfaceOwner(page, surface.id);
      expect(
        currentUrl(page).searchParams.get("tab"),
        `${surface.id}:${alias}`,
      ).toBe(alias);
    }
    if (surface.route.advancedSurface) {
      for (const field of ["advancedSurface", "advanced"] as const) {
        const childUrl = new URL("/", page.url());
        childUrl.searchParams.set("provider", "simulated");
        childUrl.searchParams.set("experience", "legacy");
        childUrl.searchParams.set("workspace", "black-box-runner");
        childUrl.searchParams.set("tab", "advanced");
        childUrl.searchParams.set(field, surface.route.advancedSurface);
        await navigateInApp(page, childUrl.pathname + childUrl.search);
        await expectSurfaceOwner(page, surface.id);
      }
    }
  }

  await navigateInApp(
    page,
    "/?provider=simulated&experience=legacy&workspace=rallar&tab=quick-test",
  );
  const quickPayload = page
    .locator("#panel-quick-test")
    .getByLabel("Payload JSON");
  const statefulDraft = JSON.stringify({ statefulDraft: "preserved" }, null, 2);
  await quickPayload.fill(statefulDraft);
  await page.getByRole("tab", { name: "Auth", exact: true }).click();
  await expect(page.locator("#panel-auth")).toBeVisible();
  await page.getByRole("tab", { name: "Quick Test", exact: true }).click();
  await expect(quickPayload).toHaveValue(statefulDraft);
  for (const selector of STATEFUL_EXCEPTION_SELECTORS) {
    await expect(
      page.locator(selector),
      `${selector}: one stateful owner`,
    ).toHaveCount(1);
  }

  for (const [surfaceId, chunkName] of LAZY_TARGETS) {
    const targetContext = await browser.newContext({
      baseURL: PRODUCTION_BASE_URL,
    });
    const control = await installEmptyControlFixture(targetContext);
    const targetPage = await targetContext.newPage();
    const resources: string[] = [];
    targetPage.on("request", (request) => {
      if (
        request.resourceType() === "script" ||
        request.resourceType() === "stylesheet"
      ) {
        resources.push(request.url());
      }
    });
    try {
      await targetPage.goto(
        "/?provider=simulated&experience=legacy&workspace=rallar&tab=auth",
      );
      await expect(targetPage.locator("#panel-auth")).toBeVisible();
      for (const [, lazyChunk] of LAZY_TARGETS) {
        expect(
          hasNamedChunk(resources, lazyChunk),
          `${surfaceId}: ${lazyChunk} absent before target`,
        ).toBe(false);
      }

      await targetPage.goto(contextualHrefs.get(surfaceId) ?? "about:blank");
      await expectSurfaceOwner(targetPage, surfaceId);
      expect(
        hasNamedChunk(resources, chunkName),
        `${surfaceId}: target chunk`,
      ).toBe(true);
      for (const [otherId, otherChunk] of LAZY_TARGETS) {
        if (otherId !== surfaceId) {
          expect(
            hasNamedChunk(resources, otherChunk),
            `${surfaceId}: unrelated ${otherChunk}`,
          ).toBe(false);
        }
      }

      await navigateInApp(
        targetPage,
        "/?provider=simulated&experience=legacy&workspace=rallar&tab=auth",
      );
      await expect(targetPage.locator(ownerSelectorFor(surfaceId))).toHaveCount(
        0,
      );
      await expect(targetPage.locator("#panel-auth")).toBeVisible();

      if (surfaceId === "runner.runs") {
        const readsAfterUnmount = control.runReads();
        await targetPage.waitForTimeout(5_500);
        expect(control.runReads()).toBe(readsAfterUnmount);
      }
    } finally {
      await targetContext.close();
    }
  }
});

test("default Recipe Console does not load or poll inactive legacy routes except registered stateful exceptions", async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const recipeFirst = await browser.newContext({
    baseURL: PRODUCTION_BASE_URL,
  });
  await installTimerProbe(recipeFirst);
  await installEmptyControlFixture(recipeFirst);
  const page = await recipeFirst.newPage();
  const resources: string[] = [];
  page.on("request", (request) => {
    if (
      request.resourceType() === "script" ||
      request.resourceType() === "stylesheet"
    ) {
      resources.push(request.url());
    }
  });
  try {
    await page.goto(
      "/?provider=simulated&v=1&experience=recipe-console&view=execute",
    );
    await expect(
      page.locator('.recipe-console[data-view="execute"]'),
    ).toBeVisible();
    await expect(page.locator(".app-shell")).toHaveCount(0);
    await expect
      .poll(() => activeFiveSecondTimers(page))
      .toEqual({
        intervals: 0,
        timeouts: 1,
      });
    const coldResources = [...resources];
    expect(hasNamedChunk(coldResources, "RecipeConsoleApp")).toBe(true);
    expect(hasNamedChunk(coldResources, "LegacyExperience")).toBe(false);
    for (const [, chunk] of LAZY_TARGETS) {
      expect(hasNamedChunk(coldResources, chunk), chunk).toBe(false);
    }
    for (const selector of Object.values(OWNER_SELECTORS)) {
      await expect(page.locator(selector)).toHaveCount(0);
    }

    await navigateInApp(
      page,
      "/?provider=simulated&v=1&experience=recipe-console&view=advanced",
    );
    await expect(page.locator("[data-advanced-workspace]")).toBeVisible();
    const coldAdvancedCss = await captureAdvancedCss(page);

    await navigateInApp(
      page,
      "/?provider=simulated&experience=legacy&workspace=rallar&tab=auth",
    );
    await expect(page.locator("#panel-auth")).toBeVisible();
    await expect(page.locator(".recipe-console")).toHaveCount(0);
    await expect
      .poll(() => activeFiveSecondTimers(page))
      .toEqual({
        intervals: 0,
        timeouts: 0,
      });
    expect(hasNamedChunk(resources, "LegacyExperience")).toBe(true);
    for (const selector of STATEFUL_EXCEPTION_SELECTORS) {
      await expect(
        page.locator(selector),
        `${selector}: one stateful owner`,
      ).toHaveCount(1);
    }
    for (const [, chunk] of LAZY_TARGETS) {
      expect(hasNamedChunk(resources, chunk), `${chunk}: still inactive`).toBe(
        false,
      );
    }

    await navigateInApp(
      page,
      "/?provider=simulated&v=1&experience=recipe-console&view=advanced",
    );
    await expect(page.locator("[data-advanced-workspace]")).toBeVisible();
    await expect(page.locator(".app-shell")).toHaveCount(0);
    await expect
      .poll(() => activeFiveSecondTimers(page))
      .toEqual({
        intervals: 0,
        timeouts: 1,
      });
    expect(await captureAdvancedCss(page)).toEqual(coldAdvancedCss);
    expect(await documentOverflow(page)).toEqual({ x: 0, y: 0 });

    const legacyFirst = await browser.newContext({
      baseURL: PRODUCTION_BASE_URL,
    });
    await installTimerProbe(legacyFirst);
    await installEmptyControlFixture(legacyFirst);
    const reversePage = await legacyFirst.newPage();
    try {
      await reversePage.goto(
        "/?provider=simulated&experience=legacy&workspace=rallar&tab=auth",
      );
      await expect(reversePage.locator("#panel-auth")).toBeVisible();
      await navigateInApp(
        reversePage,
        "/?provider=simulated&v=1&experience=recipe-console&view=advanced",
      );
      await expect(
        reversePage.locator("[data-advanced-workspace]"),
      ).toBeVisible();
      await expect(reversePage.locator(".app-shell")).toHaveCount(0);
      await expect(
        reversePage.locator("[data-primary-navigation]"),
      ).toHaveAttribute("aria-label", "Recipe Console");
      await expect
        .poll(() => activeFiveSecondTimers(reversePage))
        .toEqual({
          intervals: 0,
          timeouts: 1,
        });
      expect(await captureAdvancedCss(reversePage)).toEqual(coldAdvancedCss);
      expect(await documentOverflow(reversePage)).toEqual({ x: 0, y: 0 });
    } finally {
      await legacyFirst.close();
    }
  } finally {
    await recipeFirst.close();
  }
});

async function installCombinedFailureMonitorFixture(
  context: BrowserContext,
): Promise<void> {
  const fixture = await installRecipeConsoleMonitorFixture(context);
  const replacements = new Map([
    [MONITOR_FAILURE_AGENT_ID, LONG_BIDI_AGENT_ID],
    [MONITOR_FAILURE_RECIPE_ID, LONG_BIDI_RECIPE_ID],
    [MONITOR_FAILURE_COMMAND_ID, LONG_BIDI_COMMAND_ID],
    ["monitor-group", LONG_BIDI_GROUP_ID],
  ]);
  const controlRun = replaceExactStrings(
    structuredClone(fixture.snapshot.runs[0]),
    replacements,
  ) as ControlRunSnapshot;
  const distributedRun = replaceExactStrings(
    structuredClone(fixture.snapshot.distributedRuns[0]),
    replacements,
  ) as ControlDistributedRunSnapshot;
  const failure = controlRun.results.find(
    (result) => result.commandId === LONG_BIDI_COMMAND_ID,
  );
  if (!failure)
    throw new Error("Combined Monitor fixture lost its failed result.");
  const error = { code: "BAD_AUTH", message: COMBINED_FAILURE_MESSAGE };
  Object.assign(failure, { error });
  Object.assign(failure.result, { error });
  const diagnostic = controlRun.events.find(
    (event) =>
      event.kind === "diagnostic" && event.commandId === LONG_BIDI_COMMAND_ID,
  );
  if (!diagnostic || !isRecord(diagnostic.payload)) {
    throw new Error("Combined Monitor fixture lost its correlated diagnostic.");
  }
  Object.assign(diagnostic.payload, {
    diagnosticTypeId: "rallar.browser.rtc.no_route",
    topic: "rallar.browser.rtc.no_route",
    message: "RTC no route for selected failure.",
  });

  await context.route(CONTROL_ROUTE, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: corsHeaders() });
      return;
    }
    if (request.method() === "GET" && url.pathname === "/runs") {
      await fulfillJson(route, { runs: [controlRun] });
      return;
    }
    if (request.method() === "GET" && url.pathname === "/distributed-runs") {
      await fulfillJson(route, { distributedRuns: [distributedRun] });
      return;
    }
    await fulfillJson(route, { error: "Fixture endpoint unavailable." }, 404);
  });
}

async function installEmptyControlFixture(
  context: BrowserContext,
): Promise<Readonly<{ runReads(): number }>> {
  let runReads = 0;
  await context.route(CONTROL_ROUTE, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: corsHeaders() });
      return;
    }
    if (url.pathname === "/runs") {
      runReads += 1;
      await fulfillJson(route, { runs: [] });
      return;
    }
    if (url.pathname === "/distributed-runs") {
      await fulfillJson(route, { distributedRuns: [] });
      return;
    }
    if (url.pathname === "/fleet/reports") {
      await fulfillJson(route, emptyFleetReportsResponse());
      return;
    }
    if (
      url.pathname.startsWith("/runs/") ||
      url.pathname.startsWith("/distributed-runs/")
    ) {
      await fulfillJson(route, { error: "Fixture item not found." }, 404);
      return;
    }
    await fulfillJson(route, {
      agents: [],
      distributedRuns: [],
      ok: true,
      reports: [],
      runs: [],
    });
  });
  return { runReads: () => runReads };
}

async function expectLegacyContext(
  page: Page,
  values: Readonly<Record<string, string>>,
): Promise<void> {
  const context = page.locator("[data-legacy-diagnostic-context]");
  await expect(context).toHaveAttribute("data-context-status", "ready");
  for (const [field, value] of Object.entries(values)) {
    const row = context.locator(`[data-context-field="${field}"]`);
    await expect(
      row.locator("[data-legacy-diagnostic-context-value]"),
    ).toHaveText(value);
    await expect(
      row.locator("[data-legacy-diagnostic-context-value]"),
    ).toHaveAttribute("dir", "ltr");
  }
}

async function expectSurfaceOwner(
  page: Page,
  surfaceId: string,
): Promise<void> {
  const selector = ownerSelectorFor(surfaceId);
  try {
    await expect(
      page.locator(selector),
      `${surfaceId}: exactly one DOM owner`,
    ).toHaveCount(1);
  } catch (error) {
    const body = await page
      .locator("body")
      .innerText()
      .catch(() => "");
    throw new Error(
      `${surfaceId}: owner ${selector} missing at ${page.url()}\n` +
        `${body.slice(0, 1_000)}\n${String(error)}`,
    );
  }
  await expect(
    page.locator(selector),
    `${surfaceId}: visible owner`,
  ).toBeVisible();
}

function ownerSelectorFor(surfaceId: string): string {
  const selector = OWNER_SELECTORS[surfaceId];
  if (!selector)
    throw new Error(`Missing browser owner selector for ${surfaceId}.`);
  return selector;
}

async function navigateInApp(page: Page, href: string): Promise<void> {
  await page.evaluate((nextHref) => {
    history.pushState({}, "", nextHref);
    dispatchEvent(new PopStateEvent("popstate"));
  }, href);
}

async function proveTouchAdvancedLayout(
  browser: Browser,
  testInfo: TestInfo,
  viewport: Readonly<{ width: number; height: number; name: string }>,
): Promise<void> {
  const context = await browser.newContext({
    baseURL: PRODUCTION_BASE_URL,
    hasTouch: true,
    reducedMotion: "reduce",
    viewport,
  });
  await installEmptyControlFixture(context);
  const page = await context.newPage();
  try {
    await page.goto(
      "/?provider=simulated&v=1&experience=recipe-console&view=advanced",
    );
    await expect(page.locator("[data-advanced-workspace]")).toBeVisible();
    await expect(page.locator('[data-surface-id="direct.auth"]')).toContainText(
      "Auth",
    );
    expect(
      await page.evaluate(() => ({
        coarse: matchMedia("(pointer: coarse)").matches,
        reduced: matchMedia("(prefers-reduced-motion: reduce)").matches,
        touchPoints: navigator.maxTouchPoints,
      })),
    ).toEqual({ coarse: true, reduced: true, touchPoints: 1 });
    expect(await documentOverflow(page)).toEqual({ x: 0, y: 0 });
    await expectMinimumTarget(page, "[data-primary-navigation] button");
    await expectMinimumTarget(page, '[data-surface-id="direct.auth"]');
    if (viewport.width === 430) {
      await attachScreenshot(page, testInfo, viewport.name);
    }
  } finally {
    await context.close();
  }
}

async function expectMinimumTarget(
  page: Page,
  selector: string,
): Promise<void> {
  const first = page.locator(selector).first();
  await first.scrollIntoViewIfNeeded();
  const box = await first.boundingBox();
  expect(box, `${selector}: bounding box`).not.toBeNull();
  expect(
    box?.height ?? 0,
    `${selector}: 44px minimum target`,
  ).toBeGreaterThanOrEqual(44);
}

async function captureAdvancedCss(page: Page): Promise<
  Readonly<{
    link: Readonly<Record<string, string>>;
    navigation: Readonly<Record<string, string>>;
  }>
> {
  const styles = async (selector: string, properties: readonly string[]) =>
    page
      .locator(selector)
      .first()
      .evaluate((element, names) => {
        const computed = getComputedStyle(element);
        return Object.fromEntries(
          names.map((name) => [name, computed.getPropertyValue(name)]),
        );
      }, properties);
  return {
    navigation: await styles("[data-primary-navigation]", [
      "background-color",
      "border-top-color",
      "display",
      "font-family",
    ]),
    link: await styles('[data-surface-id="direct.auth"]', [
      "background-color",
      "border-radius",
      "border-top-color",
      "color",
      "display",
      "min-height",
      "padding",
    ]),
  };
}

async function attachScreenshot(
  page: Page,
  testInfo: TestInfo,
  name: string,
): Promise<void> {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path, animations: "disabled", caret: "hide" });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

async function installTimerProbe(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const timeouts = new Map<number, number>();
    const intervals = new Map<number, number>();
    const nativeSetTimeout = window.setTimeout.bind(window);
    const nativeClearTimeout = window.clearTimeout.bind(window);
    const nativeSetInterval = window.setInterval.bind(window);
    const nativeClearInterval = window.clearInterval.bind(window);
    Object.defineProperty(window, "setTimeout", {
      configurable: true,
      value: (handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
        let id = 0;
        const wrapped = (...callbackArgs: unknown[]) => {
          timeouts.delete(id);
          if (typeof handler === "function") handler(...callbackArgs);
        };
        id = nativeSetTimeout(wrapped, timeout, ...args);
        timeouts.set(id, timeout ?? 0);
        return id;
      },
    });
    Object.defineProperty(window, "clearTimeout", {
      configurable: true,
      value: (id?: number) => {
        if (id !== undefined) {
          timeouts.delete(id);
          nativeClearTimeout(id);
        }
      },
    });
    Object.defineProperty(window, "setInterval", {
      configurable: true,
      value: (handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
        const id = nativeSetInterval(handler, timeout, ...args);
        intervals.set(id, timeout ?? 0);
        return id;
      },
    });
    Object.defineProperty(window, "clearInterval", {
      configurable: true,
      value: (id?: number) => {
        if (id !== undefined) {
          intervals.delete(id);
          nativeClearInterval(id);
        }
      },
    });
    Object.defineProperty(window, "__advancedTimerProbe", {
      configurable: true,
      value: {
        activeFiveSecondTimers: () => ({
          intervals: [...intervals.values()].filter((value) => value === 5_000)
            .length,
          timeouts: [...timeouts.values()].filter((value) => value === 5_000)
            .length,
        }),
      },
    });
  });
}

function activeFiveSecondTimers(page: Page): Promise<
  Readonly<{
    intervals: number;
    timeouts: number;
  }>
> {
  return page.evaluate(() =>
    (
      window as Window & {
        __advancedTimerProbe: {
          activeFiveSecondTimers(): { intervals: number; timeouts: number };
        };
      }
    ).__advancedTimerProbe.activeFiveSecondTimers(),
  );
}

function hasNamedChunk(resources: readonly string[], name: string): boolean {
  return resources.some((resource) =>
    new RegExp(`/assets/${escapeRegExp(name)}-[^/]+\\.(?:js|css)$`).test(
      resource,
    ),
  );
}

function replaceExactStrings(
  value: unknown,
  replacements: ReadonlyMap<string, string>,
): unknown {
  if (typeof value === "string") return replacements.get(value) ?? value;
  if (Array.isArray(value)) {
    return value.map((entry) => replaceExactStrings(entry, replacements));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        replaceExactStrings(entry, replacements),
      ]),
    );
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function currentUrl(page: Page): URL {
  return new URL(page.url());
}

function documentOverflow(
  page: Page,
): Promise<Readonly<{ x: number; y: number }>> {
  return page.evaluate(() => ({
    x:
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
    y:
      document.documentElement.scrollHeight -
      document.documentElement.clientHeight,
  }));
}

async function fulfillJson(
  route: Route,
  body: unknown,
  status = 200,
): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    headers: corsHeaders(),
    body: JSON.stringify(body),
  });
}

function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "authorization, content-type",
  };
}

function emptyFleetReportsResponse() {
  return {
    reports: [],
    aggregate: {
      generatedAtEpochMs: 1,
      reportCount: 0,
      runCount: 0,
      agentCount: 0,
      regionCount: 0,
      passRate: 0,
      staleAgentCount: 0,
      flakyAgentCount: 0,
      failureGroupCount: 0,
      timing: {
        runs: { count: 0, p95Ms: 0 },
        commands: { count: 0, p95Ms: 0 },
      },
      regions: [],
      failureSignatures: [],
    },
  } as const;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
