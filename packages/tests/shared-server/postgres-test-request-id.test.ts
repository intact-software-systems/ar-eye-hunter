import { describe, expect, it } from "vitest";
import { createPostgresTestRequestIdFactory } from
  "./fixtures/create-postgres-test-request-id-factory.ts";

const RUN_A = "00000000-0000-4000-8000-000000000001";
const RUN_B = "00000000-0000-4000-8000-000000000002";

describe("Postgres test request ids", () => {
  it("keeps one semantic id stable within a parent test run", () => {
    const requestIdFor = createPostgresTestRequestIdFactory(RUN_A);

    expect(requestIdFor("worker-presence-heartbeat-0"))
      .toBe(requestIdFor("worker-presence-heartbeat-0"));
    expect(requestIdFor("worker-presence-heartbeat-0"))
      .toMatch(/worker-presence-heartbeat-0$/u);
  });

  it("separates retained evidence from different parent test runs", () => {
    const firstRun = createPostgresTestRequestIdFactory(RUN_A);
    const secondRun = createPostgresTestRequestIdFactory(RUN_B);

    expect(firstRun("worker-presence-heartbeat-0"))
      .not.toBe(secondRun("worker-presence-heartbeat-0"));
  });

  it("keeps concurrent contenders distinct within one run", () => {
    const requestIdFor = createPostgresTestRequestIdFactory(RUN_A);

    expect(requestIdFor("postgres-join-bob"))
      .not.toBe(requestIdFor("postgres-join-carol"));
  });

  it("keeps the longest current semantic id within the public request limit", () => {
    const requestIdFor = createPostgresTestRequestIdFactory(RUN_A);

    expect(requestIdFor("postgres-reconnect-generation-2")).toHaveLength(82);
    expect(requestIdFor("postgres-reconnect-generation-2").length)
      .toBeLessThanOrEqual(128);
  });

  it("rejects empty or over-limit semantic ids before database mutation", () => {
    const requestIdFor = createPostgresTestRequestIdFactory(RUN_A);

    expect(() => requestIdFor(" ")).toThrow("semantic id must be non-empty");
    expect(() => requestIdFor("x".repeat(78))).toThrow("must not exceed 128");
  });
});
