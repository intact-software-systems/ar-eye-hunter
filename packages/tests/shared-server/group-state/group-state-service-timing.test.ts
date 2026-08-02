import { existsSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { RallarTimingEvent } from '@shared-server/rallar-system/services/timing.ts';
import { FakeRuntimeStateRepository } from '../fake-runtime-state-repository.ts';
import { createTestGroupStateRuntime } from './group-state-test-runtime.ts';

const groupStateRoot = 'packages/shared-server/rallar-system/group-state';
const servicePath = `${groupStateRoot}/group-state-service.ts`;
const timingPath = `${groupStateRoot}/group-state-service-timing.ts`;
const scope = { applicationId: 'app-1', workspaceId: 'workspace-1' };

describe('group-state service timing boundary', () => {
  it('characterizes the predecessor dynamic timing boundary', () => {
    const source = readFileSync(servicePath, 'utf8');

    expect(source).toContain('function withGroupStateServiceTiming(');
    expect(source).toContain('new Proxy(service, {');
    expect(source).toContain('Reflect.get(target, property, receiver)');
    expect(source).toContain('value.apply(target, args)');
    expect(source).toContain('if (!timing) return service;');
  });

  it('times one asynchronous service call with its exact return value and details', async () => {
    const timingEvents: RallarTimingEvent[] = [];
    const runtime = createTestGroupStateRuntime({
      runtimeRepository: new FakeRuntimeStateRepository(),
      now: () => 1_000,
      serviceId: 'timing-service',
      timing: (event) => timingEvents.push(event),
    });

    await expect(runtime.durable.listSnapshots(scope)).resolves.toEqual([]);
    expect(timingEvents).toEqual([
      expect.objectContaining({
        component: 'group-state-service',
        operation: 'listSnapshots',
        serviceId: 'timing-service',
        applicationId: scope.applicationId,
        workspaceId: scope.workspaceId,
        status: 'ok',
      }),
    ]);
  });

  it('characterizes every asynchronous predecessor service operation and leaves compute/validate untimed', async () => {
    const timingEvents: RallarTimingEvent[] = [];
    const runtime = createTestGroupStateRuntime({
      runtimeRepository: new FakeRuntimeStateRepository(),
      now: () => 1_000,
      serviceId: 'timing-service',
      timing: (event) => timingEvents.push(event),
    });
    const created = await runtime.service.createGroup(scope, {
      groupId: 'timing-room',
      displayName: 'Timing room',
      kind: 'room',
      joinMode: 'open',
      createdByPrincipalId: 'owner',
      requestId: 'timing-create',
    });
    const snapshot = created.result.right?.snapshot;
    if (!snapshot) throw new Error('Expected a created group snapshot');
    const ref = { ...scope, groupId: 'timing-room' };

    await expect(runtime.durable.prepareExpiredPresenceMutations(1_000)).resolves.toEqual([]);
    await expect(
      runtime.durable.prepareSessionCleanupMutations({
        scope,
        authSession: {
          clientId: 'owner',
          sessionId: 'owner-session',
          username: 'owner',
          issuedAtEpochMs: 1,
          expiresAtEpochMs: 253_402_300_799_999,
        },
        principalId: 'owner',
        disconnectedAtEpochMs: 1_000,
      }),
    ).resolves.toEqual([]);
    await expect(runtime.durable.listSnapshots(scope)).resolves.toEqual([snapshot]);
    await expect(runtime.durable.listSnapshotsPage(scope, { limit: 1 })).resolves.toEqual({
      snapshots: [snapshot],
      scannedGroupCount: 1,
      hasMore: false,
      nextGroupKey: 'app=app-1:ws=workspace-1:group=timing-room',
    });
    await expect(runtime.durable.readSnapshot(ref)).resolves.toEqual(snapshot);
    await expect(runtime.durable.readStateRevision(ref)).resolves.toBe(1);
    await expect(runtime.durable.readCausalRevision(ref)).resolves.toEqual({
      groupRevision: 1,
      presenceRevision: 0,
    });
    await expect(runtime.durable.readIssuedAuthSession('owner-session')).resolves.toMatchObject({
      clientId: 'owner',
      sessionId: 'owner-session',
    });
    await expect(runtime.durable.listEvents(ref)).resolves.toHaveLength(1);
    await expect(runtime.durable.listRecentEvents!(ref, { limit: 1 })).resolves.toHaveLength(1);
    await expect(runtime.durable.listEventPage(ref, { limit: 1 })).resolves.toMatchObject({
      hasMore: false,
    });
    await expect(runtime.durable.observeSnapshot(snapshot)).resolves.toBe(snapshot);

    const operationCounts = Map.groupBy(timingEvents, (event) => event.operation);
    expect([...operationCounts.keys()]).toEqual([
      'prepareMutation',
      'read',
      'prepareExpiredPresenceMutations',
      'prepareSessionCleanupMutations',
      'listSnapshots',
      'listSnapshotsPage',
      'readSnapshot',
      'readStateRevision',
      'readCausalRevision',
      'readIssuedAuthSession',
      'listEvents',
      'listRecentEvents',
      'listEventPage',
      'observeSnapshot',
    ]);
    for (const operation of operationCounts.keys()) {
      expect(operationCounts.get(operation), operation).toHaveLength(1);
    }
    expect(operationCounts.has('compute')).toBe(false);
    expect(operationCounts.has('validate')).toBe(false);
    expect(operationCounts.get('prepareMutation')?.[0]).toMatchObject({
      component: 'group-state-service',
      operation: 'prepareMutation',
      serviceId: 'timing-service',
      applicationId: undefined,
      workspaceId: undefined,
      groupId: undefined,
      principalId: undefined,
      sessionId: undefined,
      requestId: undefined,
      status: 'ok',
    });
    expect(operationCounts.get('listSnapshots')?.[0]).toMatchObject({
      component: 'group-state-service',
      operation: 'listSnapshots',
      serviceId: 'timing-service',
      applicationId: scope.applicationId,
      workspaceId: scope.workspaceId,
      status: 'ok',
    });
  });

  it('propagates a predecessor rejection and records one matching error timing event', async () => {
    const timingEvents: RallarTimingEvent[] = [];
    const runtime = createTestGroupStateRuntime({
      runtimeRepository: new FakeRuntimeStateRepository(),
      now: () => 1_000,
      serviceId: 'timing-service',
      timing: (event) => timingEvents.push(event),
    });

    await expect(
      runtime.durable.prepareSessionCleanupMutations({
        scope,
        authSession: {
          clientId: 'missing-owner',
          sessionId: 'missing-owner-session',
          username: 'missing-owner',
          issuedAtEpochMs: 1,
          expiresAtEpochMs: 253_402_300_799_999,
        },
        principalId: 'missing-owner',
        disconnectedAtEpochMs: 1_000,
      }),
    ).rejects.toThrow('Group session cleanup authority is no longer valid');
    expect(timingEvents).toEqual([
      expect.objectContaining({
        component: 'group-state-service',
        operation: 'prepareSessionCleanupMutations',
        serviceId: 'timing-service',
        applicationId: undefined,
        workspaceId: undefined,
        principalId: 'missing-owner',
        sessionId: undefined,
        requestId: undefined,
        groupId: undefined,
        status: 'error',
      }),
    ]);
  });

  it('requires the future explicit timing owner without dynamic dispatch', () => {
    expect(existsSync(timingPath), timingPath).toBe(true);

    const source = readFileSync(timingPath, 'utf8');
    expect(source).toContain('export function createTimedGroupStateService(');
    expect(source).not.toContain('new Proxy(');
    expect(source).not.toContain('Reflect.get(');
    expect(source).not.toContain('.apply(');
    expect(source).toContain('if (!timing) return service;');
    expect(source).toContain('createTimedGroupStateService');
  });
});
