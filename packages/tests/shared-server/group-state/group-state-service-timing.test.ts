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

  it('requires the future explicit timing owner without dynamic dispatch', () => {
    expect(existsSync(timingPath), timingPath).toBe(true);

    const source = readFileSync(timingPath, 'utf8');
    expect(source).toContain('export function createTimedGroupStateService(');
    expect(source).not.toContain('new Proxy(');
    expect(source).not.toContain('Reflect.get(');
    expect(source).not.toContain('.apply(');
  });
});
