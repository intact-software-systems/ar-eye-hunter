import { describe, expect, it } from "vitest";
import {
  controlRunSnapshotUrlFromControlUrl,
  createHeadlessWorkerAgentUrl,
  readHeadlessWorkerConfig,
} from "../../../apps/rallar-black-box/src/headless-worker-config.ts";

describe("rallar-black-box headless worker config", () => {
  it("builds control-agent URLs for multiple browser agents", () => {
    const config = readHeadlessWorkerConfig({
      env: {
        RALLAR_BLACK_BOX_SPA_URL: "https://blackbox.example.test/",
        RALLAR_BLACK_BOX_CONTROL_URL: "wss://control.example.test/control",
        RALLAR_API_BASE_URL: "https://api.example.test/",
        RALLAR_BLACK_BOX_RUN_ID: "run-1",
        RALLAR_BLACK_BOX_ROOM_ID: "room-1",
        RALLAR_BLACK_BOX_AGENT_PREFIX: "fsn1-worker",
        RALLAR_BLACK_BOX_AGENT_COUNT: "2",
        RALLAR_BLACK_BOX_USERNAME: "alice",
        RALLAR_BLACK_BOX_PASSWORD: "secret",
        RALLAR_BLACK_BOX_CONTROL_TOKEN: "run-token",
        RALLAR_BLACK_BOX_STATS_INTERVAL_MS: "2000",
        RALLAR_BLACK_BOX_HEARTBEAT_INTERVAL_MS: "3000",
        RALLAR_BLACK_BOX_ENVIRONMENT: "hetzner-fsn1",
        RALLAR_AGENT_REGION: "eu-north",
        RALLAR_AGENT_PROVIDER: "hetzner",
        RALLAR_AGENT_DATACENTER: "fsn1",
        RALLAR_AGENT_POOL_ID: "pool-a",
        RALLAR_AGENT_DEPLOYMENT_ID: "deploy-2026-06-11",
        RALLAR_AGENT_BROWSER_NAME: "chromium",
        RALLAR_AGENT_BROWSER_VERSION: "126",
        RALLAR_AGENT_OS: "linux",
        RALLAR_AGENT_TAGS: "canary,rtc",
        RALLAR_APPLICATION_ID: "rallar-server",
        RALLAR_WORKSPACE_ID: "default",
      },
    });

    expect(config.spaUrl).toBe("https://blackbox.example.test");
    expect(config.apiBaseUrl).toBe("https://api.example.test");
    expect(config.headlessEntry).toBe("operator-spa");
    expect(config.agentCount).toBe(2);
    expect(config.fleetRegion).toBe("eu-north");
    expect(config.fleetProvider).toBe("hetzner");
    expect(config.fleetTags).toEqual(["canary", "rtc"]);
    expect(config.browserLogLevel).toBe("warning");
    expect(config.agents.map((agent) => agent.agentId)).toEqual([
      "fsn1-worker-01",
      "fsn1-worker-02",
    ]);

    const firstUrl = new URL(config.agents[0].url);
    expect(firstUrl.origin).toBe("https://blackbox.example.test");
    expect(firstUrl.searchParams.get("mode")).toBe("control");
    expect(firstUrl.searchParams.get("provider")).toBe("browser-rallar");
    expect(firstUrl.searchParams.get("autoConnect")).toBe("1");
    expect(firstUrl.searchParams.get("tab")).toBe("local-workbench");
    expect(firstUrl.searchParams.get("controlUrl")).toBe(
      "wss://control.example.test/control",
    );
    expect(firstUrl.searchParams.get("runId")).toBe("run-1");
    expect(firstUrl.searchParams.get("agentId")).toBe("fsn1-worker-01");
    expect(firstUrl.searchParams.get("apiBaseUrl")).toBe(
      "https://api.example.test",
    );
    expect(firstUrl.searchParams.get("roomId")).toBe("room-1");
    expect(firstUrl.searchParams.get("rallarUsername")).toBe("alice");
    expect(firstUrl.searchParams.get("rallarPassword")).toBe("secret");
    expect(firstUrl.searchParams.get("rallarLeaveRoomOnClose")).toBe("0");
    expect(firstUrl.searchParams.get("controlToken")).toBe("run-token");
    expect(firstUrl.searchParams.get("statsIntervalMs")).toBe("2000");
    expect(firstUrl.searchParams.get("heartbeatIntervalMs")).toBe("3000");
    expect(firstUrl.searchParams.get("environment")).toBe("hetzner-fsn1");
    expect(firstUrl.searchParams.get("fleetRegion")).toBe("eu-north");
    expect(firstUrl.searchParams.get("fleetProvider")).toBe("hetzner");
    expect(firstUrl.searchParams.get("fleetDatacenter")).toBe("fsn1");
    expect(firstUrl.searchParams.get("fleetAgentPoolId")).toBe("pool-a");
    expect(firstUrl.searchParams.get("fleetDeploymentId")).toBe(
      "deploy-2026-06-11",
    );
    expect(firstUrl.searchParams.get("fleetBrowserName")).toBe("chromium");
    expect(firstUrl.searchParams.get("fleetBrowserVersion")).toBe("126");
    expect(firstUrl.searchParams.get("fleetOs")).toBe("linux");
    expect(firstUrl.searchParams.get("fleetTags")).toBe("canary,rtc");
    expect(firstUrl.searchParams.get("applicationId")).toBe("rallar-server");
    expect(firstUrl.searchParams.get("workspaceId")).toBe("default");
  });

  it("targets the headless SPA when RALLAR_BLACK_BOX_HEADLESS_ENTRY=headless", () => {
    const config = readHeadlessWorkerConfig({
      env: {
        RALLAR_BLACK_BOX_SPA_URL: "https://blackbox.example.test/",
        RALLAR_BLACK_BOX_CONTROL_URL: "wss://control.example.test/control",
        RALLAR_API_BASE_URL: "https://api.example.test/",
        RALLAR_BLACK_BOX_RUN_ID: "run-headless",
        RALLAR_BLACK_BOX_ROOM_ID: "room-headless",
        RALLAR_BLACK_BOX_USERNAME: "alice",
        RALLAR_BLACK_BOX_PASSWORD: "secret",
        RALLAR_BLACK_BOX_HEADLESS_ENTRY: "headless",
      },
    });

    expect(config.headlessEntry).toBe("headless");
    const url = new URL(config.agents[0].url);
    expect(url.origin).toBe("https://blackbox.example.test");
    expect(url.pathname).toBe("/headless/");
    expect(url.searchParams.get("mode")).toBe("control");
    expect(url.searchParams.get("provider")).toBe("browser-rallar");
    expect(url.searchParams.get("autoConnect")).toBe("1");
    expect(url.searchParams.get("tab")).toBeNull();
  });

  it("keeps the operator SPA local-workbench route for rollback", () => {
    const config = readHeadlessWorkerConfig({
      env: {
        RALLAR_BLACK_BOX_SPA_URL: "https://blackbox.example.test/",
        RALLAR_BLACK_BOX_CONTROL_URL: "wss://control.example.test/control",
        RALLAR_API_BASE_URL: "https://api.example.test/",
        RALLAR_BLACK_BOX_RUN_ID: "run-operator",
        RALLAR_BLACK_BOX_ROOM_ID: "room-operator",
        RALLAR_BLACK_BOX_USERNAME: "alice",
        RALLAR_BLACK_BOX_PASSWORD: "secret",
        RALLAR_BLACK_BOX_HEADLESS_ENTRY: "operator-spa",
      },
    });

    expect(config.headlessEntry).toBe("operator-spa");
    const url = new URL(config.agents[0].url);
    expect(url.pathname).toBe("/");
    expect(url.searchParams.get("tab")).toBe("local-workbench");
  });

  it("supports per-agent credentials and messages.rtc transport", () => {
    const config = readHeadlessWorkerConfig({
      env: {
        RALLAR_BLACK_BOX_SPA_URL: "https://blackbox.example.test",
        RALLAR_BLACK_BOX_CONTROL_URL: "wss://control.example.test/control",
        RALLAR_API_BASE_URL: "https://api.example.test",
        RALLAR_BLACK_BOX_RUN_ID: "run-2",
        RALLAR_BLACK_BOX_ROOM_ID: "room-2",
        RALLAR_BLACK_BOX_AGENT_COUNT: "2",
        RALLAR_BLACK_BOX_TRANSPORT: "messages.rtc",
        RALLAR_BLACK_BOX_AGENT_1_USERNAME: "alice",
        RALLAR_BLACK_BOX_AGENT_1_PASSWORD: "alice-secret",
        RALLAR_BLACK_BOX_AGENT_2_USERNAME: "bob",
        RALLAR_BLACK_BOX_AGENT_2_PASSWORD: "bob-secret",
        RALLAR_BLACK_BOX_REGISTER: "1",
        RALLAR_BLACK_BOX_RESTORE_SESSION: "true",
        RALLAR_BLACK_BOX_LEAVE_ROOM_ON_CLOSE: "yes",
      },
    });

    expect(config.transport).toBe("messages.rtc");
    expect(config.agentCredentials).toEqual([
      { username: "alice", password: "alice-secret" },
      { username: "bob", password: "bob-secret" },
    ]);

    const secondUrl = new URL(config.agents[1].url);
    expect(secondUrl.searchParams.get("transport")).toBe("messages.rtc");
    expect(secondUrl.searchParams.get("rallarUsername")).toBe("bob");
    expect(secondUrl.searchParams.get("rallarPassword")).toBe("bob-secret");
    expect(secondUrl.searchParams.get("rallarRegister")).toBe("1");
    expect(secondUrl.searchParams.get("rallarRestoreSession")).toBe("1");
    expect(secondUrl.searchParams.get("rallarLeaveRoomOnClose")).toBe("1");
  });

  it("parses browser log levels for headless worker page events", () => {
    const baseEnv = {
      RALLAR_BLACK_BOX_SPA_URL: "https://blackbox.example.test",
      RALLAR_BLACK_BOX_CONTROL_URL: "wss://control.example.test/control",
      RALLAR_API_BASE_URL: "https://api.example.test",
      RALLAR_BLACK_BOX_RUN_ID: "run-browser-logs",
      RALLAR_BLACK_BOX_ROOM_ID: "room-browser-logs",
      RALLAR_BLACK_BOX_USERNAME: "alice",
      RALLAR_BLACK_BOX_PASSWORD: "secret",
    };

    expect(readHeadlessWorkerConfig({ env: baseEnv }).browserLogLevel).toBe(
      "warning",
    );
    expect(readHeadlessWorkerConfig({
      env: {
        ...baseEnv,
        RALLAR_BLACK_BOX_BROWSER_LOG_LEVEL: "info",
      },
    }).browserLogLevel).toBe("info");
    expect(readHeadlessWorkerConfig({
      env: {
        ...baseEnv,
        RALLAR_BLACK_BOX_BROWSER_LOG_LEVEL: "debug",
      },
    }).browserLogLevel).toBe("debug");

    expect(() =>
      readHeadlessWorkerConfig({
        env: {
          ...baseEnv,
          RALLAR_BLACK_BOX_BROWSER_LOG_LEVEL: "verbose",
        },
      })
    ).toThrow(
      /RALLAR_BLACK_BOX_BROWSER_LOG_LEVEL must be warning, info, or debug/,
    );
  });

  it("reports missing required env and credentials clearly", () => {
    expect(() => readHeadlessWorkerConfig({ env: {} })).toThrow(
      /Missing required headless worker env: RALLAR_BLACK_BOX_SPA_URL/,
    );

    expect(() =>
      readHeadlessWorkerConfig({
        env: {
          RALLAR_BLACK_BOX_SPA_URL: "https://blackbox.example.test",
          RALLAR_BLACK_BOX_CONTROL_URL: "wss://control.example.test/control",
          RALLAR_API_BASE_URL: "https://api.example.test",
          RALLAR_BLACK_BOX_RUN_ID: "run-3",
          RALLAR_BLACK_BOX_ROOM_ID: "room-3",
        },
      })
    ).toThrow(/Missing credentials for headless worker agent 1/);
  });

  it("rejects invalid numeric and transport env values", () => {
    const baseEnv = {
      RALLAR_BLACK_BOX_SPA_URL: "https://blackbox.example.test",
      RALLAR_BLACK_BOX_CONTROL_URL: "wss://control.example.test/control",
      RALLAR_API_BASE_URL: "https://api.example.test",
      RALLAR_BLACK_BOX_RUN_ID: "run-4",
      RALLAR_BLACK_BOX_ROOM_ID: "room-4",
      RALLAR_BLACK_BOX_USERNAME: "alice",
      RALLAR_BLACK_BOX_PASSWORD: "secret",
    };

    expect(() =>
      readHeadlessWorkerConfig({
        env: {
          ...baseEnv,
          RALLAR_BLACK_BOX_AGENT_COUNT: "0",
        },
      })
    ).toThrow(/RALLAR_BLACK_BOX_AGENT_COUNT must be a positive integer/);

    expect(() =>
      readHeadlessWorkerConfig({
        env: {
          ...baseEnv,
          RALLAR_BLACK_BOX_TRANSPORT: "bad-transport",
        },
      })
    ).toThrow(/RALLAR_BLACK_BOX_TRANSPORT must be realtime or messages\.rtc/);

    expect(() =>
      readHeadlessWorkerConfig({
        env: {
          ...baseEnv,
          RALLAR_BLACK_BOX_HEADLESS_ENTRY: "dashboard",
        },
      })
    ).toThrow(
      /RALLAR_BLACK_BOX_HEADLESS_ENTRY must be operator-spa or headless/,
    );
  });

  it("can build a URL from an explicit config object", () => {
    const url = createHeadlessWorkerAgentUrl({
      spaUrl: "https://blackbox.example.test",
      controlUrl: "wss://control.example.test/control",
      apiBaseUrl: "https://api.example.test",
      headlessEntry: "operator-spa",
      runId: "run-direct",
      agentPrefix: "direct",
      agentCount: 1,
      roomId: "room-direct",
      transport: "realtime",
      register: false,
      restoreSession: false,
      logoutOnClose: false,
      leaveRoomOnClose: false,
      headless: true,
      launchTimeoutMs: 30_000,
      readyTimeoutMs: 45_000,
      agentId: "agent-direct",
      actor: "agent-direct",
      sessionId: "agent-direct",
      credentials: {
        username: "alice",
        password: "secret",
      },
    });

    expect(new URL(url).searchParams.get("agentId")).toBe("agent-direct");
  });

  it("derives control run snapshot URLs from worker control URLs", () => {
    expect(
      controlRunSnapshotUrlFromControlUrl(
        "ws://127.0.0.1:5180/control",
        "run-1",
      ),
    ).toBe("http://127.0.0.1:5180/runs/run-1");

    expect(
      controlRunSnapshotUrlFromControlUrl(
        "wss://control.example.test/control?token=ignored",
        "run 2",
      ),
    ).toBe("https://control.example.test/runs/run%202");

    expect(() =>
      controlRunSnapshotUrlFromControlUrl("ftp://example.test/control", "run")
    ).toThrow(/Control URL must use ws, wss, http, or https/);
  });
});
