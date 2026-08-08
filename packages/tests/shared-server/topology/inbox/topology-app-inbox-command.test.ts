import { readFileSync } from 'node:fs';

import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  fromCanonicalGroupTopologyConfigPatch,
  readCanonicalGroupTopologyConfigPatch,
  toCanonicalGroupTopologyConfigPatch,
} from '@shared/api/group-topology-config-canonical.ts';
import { toTopologyAppInboxCommand } from '@shared-server/rallar-system/services/AppGroupInboxService.ts';
import type {
  CreateTopologyAppInboxCommandInput,
  TopologyAppInboxCommand,
  TopologyAppInboxPayload,
  TopologyAppInboxRequestPayload,
} from '@shared-server/rallar-system/topology/inbox/topology-app-inbox-contracts.ts';
import {
  readAuthenticatedTopologyCommand,
  readDurableTopologyAppInboxCommand,
  toTopologyConfigMutationCommand,
} from '@shared-server/rallar-system/topology/inbox/topology-app-inbox-command.ts';
import { AppInboxType } from '@shared-server/rallar-system/services/AppInboxService.ts';
import {
  serializeCanonicalJsonWire,
  toJsonWireAppInboxEnqueue,
  toLogicalAppInboxCommand,
} from '@shared-server/rallar-system/services/app-inbox-command-wire.ts';

describe('topology AppInbox durable command contract', () => {
  it('names the command map before indexing its exact operation union', () => {
    const contracts = readFileSync(
      'packages/shared-server/rallar-system/topology/inbox/topology-app-inbox-contracts.ts',
      'utf8',
    );

    expect(contracts).toContain('type TopologyAppInboxCommandByOperation = Readonly<{');
    expect(contracts).toContain(
      'TopologyAppInboxCommandByOperation[TopologyAppInboxCommandOperation]',
    );
  });

  it('binds every operation discriminant to exactly its request and durable payload', () => {
    type Operation = TopologyAppInboxCommand['operation'];
    type CommandRelationships = {
      [Current in Operation]: Extract<
        TopologyAppInboxCommand,
        { operation: Current }
      >['payload'] extends TopologyAppInboxPayload<Current>
        ? TopologyAppInboxPayload<Current> extends Extract<
            TopologyAppInboxCommand,
            { operation: Current }
          >['payload']
          ? true
          : false
        : false;
    }[Operation];
    type RequestRelationships = {
      [
        Current in Operation
      ]: CreateTopologyAppInboxCommandInput<Current>['payload'] extends TopologyAppInboxRequestPayload<Current>
        ? true
        : false;
    }[Operation];
    type MismatchedPayloadIsRejected =
      TopologyAppInboxPayload<'deleteConfig'> extends Extract<
        TopologyAppInboxCommand,
        { operation: 'putConfig' }
      >['payload']
        ? false
        : true;

    expectTypeOf<CommandRelationships>().toEqualTypeOf<true>();
    expectTypeOf<RequestRelationships>().toEqualTypeOf<true>();
    expectTypeOf<MismatchedPayloadIsRejected>().toEqualTypeOf<true>();
  });

  it.each([
    {
      operation: 'putConfig',
      type: AppInboxType.TOPOLOGY_CONFIG_PUT,
      payload: { operation: 'putConfig', config: { topologyKind: 'tree' } },
      target: 'config',
    },
    {
      operation: 'deleteConfig',
      type: AppInboxType.TOPOLOGY_CONFIG_DELETE,
      payload: { operation: 'deleteConfig', target: 'config' },
      target: 'config',
    },
    {
      operation: 'putOverride',
      type: AppInboxType.TOPOLOGY_OVERRIDE_PUT,
      payload: {
        operation: 'putOverride',
        config: { degreeLimit: 4 },
        ttlMs: 60_000,
        expiresAtEpochMs: null,
      },
      target: 'override',
    },
    {
      operation: 'deleteOverride',
      type: AppInboxType.TOPOLOGY_OVERRIDE_DELETE,
      payload: { operation: 'deleteOverride', target: 'override' },
      target: 'override',
    },
    {
      operation: 'reconfigureTopology',
      type: AppInboxType.TOPOLOGY_RECONFIGURE,
      payload: {
        operation: 'reconfigureTopology',
        requestOptions: { meshParamK: 3 },
        publish: false,
      },
      target: null,
    },
  ] satisfies readonly Readonly<{
    operation: string;
    type: AppInboxType;
    payload: TopologyAppInboxRequestPayload;
    target: 'config' | 'override' | null;
  }>[])('binds $operation to its exact queue type and durable payload', async (testCase) => {
    const command = await toTopologyAppInboxCommand({
      actor: { principalId: 'owner', sessionId: 'owner-session' },
      groupRef: {
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        groupId: 'room-1',
      },
      requestId: `request-${testCase.operation}`,
      capturedAtEpochMs: 1_000,
      payload: testCase.payload,
    });
    const durable = structuredClone(command);

    expect(readDurableTopologyAppInboxCommand(durable)).toBe(durable);
    await expect(
      readAuthenticatedTopologyCommand(
        {
          type: testCase.type,
          resourceId: command.requestId,
          data: command,
        },
        {
          clientId: command.actor.principalId,
          sessionId: command.actor.sessionId,
        } as never,
      ),
    ).resolves.toBe(command);
    await expect(
      readAuthenticatedTopologyCommand(
        {
          type: AppInboxType.GROUP_UPDATE,
          resourceId: command.requestId,
          data: command,
        },
        {
          clientId: command.actor.principalId,
          sessionId: command.actor.sessionId,
        } as never,
      ),
    ).rejects.toThrow(/does not match authenticated authority/i);

    if (testCase.target === null) {
      expect(() => toTopologyConfigMutationCommand(command)).toThrow(
        'Reconfigure is not a topology config mutation',
      );
    } else {
      expect(toTopologyConfigMutationCommand(command)).toMatchObject({
        operation: testCase.operation,
        aggregateRef: command.groupRef,
        commandId: command.requestId,
        requestId: command.requestId,
        input: { updatedByPrincipalId: command.actor.principalId },
      });
    }
  });

  it('keeps HTTP topology identity stable across retry clocks and durable preparation changes', async () => {
    const first = await topologyCommand(1_000);
    const replay = await topologyCommand(9_000);
    expect(replay.commandHash).toBe(first.commandHash);

    const firstIdentity = logicalIdentity({
      type: AppInboxType.TOPOLOGY_CONFIG_PUT,
      resourceId: first.requestId,
      data: first,
      authority: {
        kind: 'topology-config',
        proof: { commandHash: first.commandHash, commandMac: 'first' },
        preparation: { mutableDeleteTarget: 'first' },
      },
    });
    const replayIdentity = logicalIdentity({
      type: AppInboxType.TOPOLOGY_CONFIG_PUT,
      resourceId: replay.requestId,
      data: replay,
      authority: {
        kind: 'topology-config',
        proof: { commandHash: replay.commandHash, commandMac: 'second' },
        preparation: { mutableDeleteTarget: 'second' },
      },
    });
    expect(replayIdentity).toBe(firstIdentity);
  });

  it('collides divergent stable topology semantics behind the same request id', async () => {
    const first = await topologyCommand(1_000);
    const divergent = await toTopologyAppInboxCommand({
      actor: first.actor,
      groupRef: first.groupRef,
      requestId: first.requestId,
      capturedAtEpochMs: 2_000,
      payload: {
        operation: 'putConfig',
        config: { topologyKind: 'mesh' },
      },
    });

    expect(divergent.commandHash).not.toBe(first.commandHash);
    expect(
      logicalIdentity({
        type: AppInboxType.TOPOLOGY_CONFIG_PUT,
        resourceId: first.requestId,
        data: first,
      }),
    ).not.toBe(
      logicalIdentity({
        type: AppInboxType.TOPOLOGY_CONFIG_PUT,
        resourceId: divergent.requestId,
        data: divergent,
      }),
    );
  });

  it('rejects unknown sparse request keys before durable enqueue', async () => {
    await expect(
      toTopologyAppInboxCommand({
        actor: { principalId: 'owner', sessionId: 'owner-session' },
        groupRef: {
          applicationId: 'app-1',
          workspaceId: 'workspace-1',
          groupId: 'room-1',
        },
        requestId: 'topology-request-1',
        capturedAtEpochMs: 1_000,
        payload: {
          operation: 'putConfig',
          config: {
            topologyKind: 'tree',
            unexpected: true,
          },
        } as never,
      }),
    ).rejects.toThrow(/unknown|canonical|invalid/i);
  });

  it('canonicalizes omitted, set, and JSON-null clear actions exactly', () => {
    const canonical = toCanonicalGroupTopologyConfigPatch({
      topologyKind: null,
      degreeLimit: 7,
    });

    expect(canonical).toEqual({
      topologyKind: { action: 'clear' },
      degreeLimit: { action: 'set', value: 7 },
      treeMinSize: { action: 'preserve' },
      meshMinSize: { action: 'preserve' },
      meshParamK: { action: 'preserve' },
    });
    expect(fromCanonicalGroupTopologyConfigPatch(canonical)).toEqual({
      topologyKind: null,
      degreeLimit: 7,
    });
    expect(() =>
      readCanonicalGroupTopologyConfigPatch({
        ...canonical,
        topologyKind: { action: 'clear', value: 'tree' },
      }),
    ).toThrow(/exactly|clear/i);
    expect(() =>
      readCanonicalGroupTopologyConfigPatch({
        topologyKind: { action: 'clear' },
        degreeLimit: { action: 'set', value: 7 },
        treeMinSize: { action: 'preserve' },
        meshMinSize: { action: 'preserve' },
      }),
    ).toThrow(/exactly|missing/i);
  });

  it('treats set and clear as divergent stable topology semantics', async () => {
    const set = await topologyCommand(1_000);
    const clear = await toTopologyAppInboxCommand({
      actor: set.actor,
      groupRef: set.groupRef,
      requestId: set.requestId,
      capturedAtEpochMs: 2_000,
      payload: {
        operation: 'putConfig',
        config: { topologyKind: null },
      },
    });

    expect(clear.commandHash).not.toBe(set.commandHash);
  });

  it('validates and hashes an observable payload exactly once per required phase', async () => {
    const command = await topologyCommand(1_000);
    const observations = { ownKeys: 0, operationReads: 0, configReads: 0 };
    const payload = new Proxy(command.payload, {
      ownKeys(target) {
        observations.ownKeys += 1;
        return Reflect.ownKeys(target);
      },
      get(target, property, receiver) {
        if (property === 'operation') observations.operationReads += 1;
        if (property === 'config') observations.configReads += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    const observableCommand = { ...command, payload };

    const result = await readAuthenticatedTopologyCommand(
      {
        type: AppInboxType.TOPOLOGY_CONFIG_PUT,
        resourceId: command.requestId,
        data: observableCommand,
      },
      {
        clientId: command.actor.principalId,
        sessionId: command.actor.sessionId,
      } as never,
    );

    expect(result).toBe(observableCommand);
    expect(observations).toEqual({ ownKeys: 3, operationReads: 4, configReads: 2 });
    expect(result.payload).toEqual(command.payload);
    expect(result.commandHash).toBe(command.commandHash);
  });
});

async function topologyCommand(capturedAtEpochMs: number) {
  return await toTopologyAppInboxCommand({
    actor: { principalId: 'owner', sessionId: 'owner-session' },
    groupRef: {
      applicationId: 'app-1',
      workspaceId: 'workspace-1',
      groupId: 'room-1',
    },
    requestId: 'topology-request-1',
    capturedAtEpochMs,
    payload: {
      operation: 'putConfig',
      config: { topologyKind: 'tree' },
    },
  });
}

function logicalIdentity(enqueue: Parameters<typeof toJsonWireAppInboxEnqueue>[0]): string {
  return serializeCanonicalJsonWire(toLogicalAppInboxCommand(toJsonWireAppInboxEnqueue(enqueue)));
}
