import { describe, expect, it, vi } from "vitest";
import type { StateScope } from "@shared/api/state-types.ts";
import {
  groupStateGroupStorageKey,
  groupStateIdempotencyStorageKey,
  groupStateMemberStorageKey,
  groupStatePresenceAdmissionStorageKey,
} from "@shared-server/rallar-system/group-state-storage-keys.ts";
import {
  AuthSessionRepository,
  type IssuedAuthSession,
} from "@shared-server/rallar-system/repositories/AuthSessionRepository.ts";
import { createGroupStateRuntime } from "@shared-server/rallar-system/services/group-state-service.ts";
import type { RuntimeStateReadBatchSelector } from "@shared-server/runtime-state/RuntimeStateReadBatch.ts";
import { ReadBatchFakeRuntimeStateRepository } from "./read-batch-fake-runtime-state-repository.ts";

const SCOPE: StateScope = {
  applicationId: "batch-retry-app",
  workspaceId: "batch-retry-workspace",
};

describe("GroupStateService mutation exact-read retries", () => {
  it("repeats the complete exact read and authority verification after a group CAS conflict", async () => {
    const runtime = new ReadBatchFakeRuntimeStateRepository();
    const authSessions = new AuthSessionRepository(runtime);
    const authority: IssuedAuthSession = {
      clientId: "owner",
      sessionId: "owner-session",
      accessToken: "owner-access-token",
      username: "owner",
      issuedAtEpochMs: 1,
      expiresAtEpochMs: Number.MAX_SAFE_INTEGER,
    };
    await authSessions.putSession(authority);

    let generatedId = 0;
    const sleep = vi.fn((_delayMs: number) => Promise.resolve());
    const service = createGroupStateRuntime({
      runtimeRepository: runtime,
      authSessionRepository: authSessions,
      now: () => 1_000,
      randomId: () => `batch-retry-id-${++generatedId}`,
      sleep,
      serviceId: "batch-retry-service",
    }).service;
    const groupId = "retry-group";
    const ref = { ...SCOPE, groupId };
    await service.createGroup(
      SCOPE,
      {
        groupId,
        displayName: groupId,
        kind: "room",
        joinMode: "open",
        createdByPrincipalId: authority.clientId,
        requestId: "seed-retry-group",
      },
      authority,
    );

    runtime.readBatchCalls.length = 0;
    const findBySessionId = vi.spyOn(authSessions, "findBySessionId");
    let injectedConflict = false;
    runtime.beforeConditionalWrite = async (operation, namespace, key) => {
      if (
        injectedConflict ||
        operation !== "upsertIfRevision" ||
        namespace !== "group-state:groups" ||
        key !== groupStateGroupStorageKey(ref)
      ) {
        return;
      }
      injectedConflict = true;
      const current = await runtime.findEntry(namespace, key);
      if (!current) throw new Error("Expected the seeded group entry");
      await runtime.upsert(
        namespace,
        key,
        current.value,
        current.expireAtTimestamp,
      );
    };

    await service.updateGroup(
      SCOPE,
      groupId,
      {
        displayName: "Updated after retry",
        actorPrincipalId: authority.clientId,
        requestId: "retry-update",
      },
      authority,
    );

    const mutationCalls = mutationReadCalls(runtime);
    const expectedSelectors: RuntimeStateReadBatchSelector[] = [
      {
        selectorId: "group",
        kind: "key",
        namespace: "group-state:groups",
        key: groupStateGroupStorageKey(ref),
      },
      {
        selectorId: "presence-summary",
        kind: "key",
        namespace: "group-state:presence-summaries",
        key: groupStateGroupStorageKey(ref),
      },
      {
        selectorId: "idempotency:0",
        kind: "key",
        namespace: "group-state:idempotent",
        key: groupStateIdempotencyStorageKey(ref, "retry-update"),
      },
      {
        selectorId: "member:0",
        kind: "key",
        namespace: "group-state:members",
        key: groupStateMemberStorageKey({
          ...ref,
          principalId: authority.clientId,
        }),
      },
      {
        selectorId: "admission:0",
        kind: "key",
        namespace: "group-state:presence-admissions",
        key: groupStatePresenceAdmissionStorageKey({
          ...ref,
          principalId: authority.clientId,
        }),
      },
    ];
    expect(injectedConflict).toBe(true);
    expect(mutationCalls).toEqual([expectedSelectors, expectedSelectors]);
    expect(findBySessionId).toHaveBeenCalledTimes(1 + mutationCalls.length);
    expect(findBySessionId.mock.calls).toEqual([
      [authority.sessionId],
      [authority.sessionId],
      [authority.sessionId],
    ]);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(2);
  });
});

function mutationReadCalls(
  runtime: ReadBatchFakeRuntimeStateRepository,
): RuntimeStateReadBatchSelector[][] {
  return runtime.readBatchCalls.filter((selectors) =>
    selectors.some((selector) =>
      selector.selectorId.startsWith("idempotency:"),
    ),
  );
}
