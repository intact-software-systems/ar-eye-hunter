import { describe, expect, it } from 'vitest';

import type {
  GroupMutationComputed,
  GroupMutationRead,
} from '@shared-server/rallar-system/group-state/mutation/group-mutation-contracts.ts';
import type {
  GroupStateMutationCommand,
  GroupStateMutationService,
} from '@shared-server/rallar-system/group-state/group-state-service-contracts.ts';
import { processGroupPresenceConnect } from '@shared-server/rallar-system/group-state/presence/group-presence-service.ts';
import type {
  WsSessionGenerationLifecycleComputed,
  WsSessionGenerationLifecycleRead,
  WsSessionGenerationLifecycleService,
} from '@shared-server/rallar-system/services/ws-session-generation-lifecycle.ts';

describe('group presence connect decision', () => {
  it('returns inactive without reading or computing a group mutation', async () => {
    const phases: string[] = [];
    const dependencies = createDecisionDependencies({
      phases,
      closedAtObservation: true,
    });

    const outcome = await processGroupPresenceConnect({
      command: dependencies.command,
      mutationService: dependencies.mutationService,
      sessionGenerationLifecycle: dependencies.sessionGenerationLifecycle,
    });

    expect(JSON.stringify(outcome)).toBe('{"status":"inactive","sessionId":"session-1","generationId":"generation-1"}');
    expect(phases).toEqual(['lifecycle-read', 'lifecycle-closed-check']);
  });

  it('returns the exact computed mutation and lifecycle guard ' + 'for the handler to commit', async () => {
    const phases: string[] = [];
    const dependencies = createDecisionDependencies({
      phases,
      closedAtObservation: false,
    });

    const outcome = await processGroupPresenceConnect({
      command: dependencies.command,
      mutationService: dependencies.mutationService,
      sessionGenerationLifecycle: dependencies.sessionGenerationLifecycle,
    });

    expect(outcome).toEqual({
      status: 'ready-to-commit',
      computed: dependencies.computed,
      lifecycleGuard: dependencies.lifecycleGuard,
    });
    if (outcome.status !== 'ready-to-commit') {
      throw new Error('Expected a ready-to-commit presence decision');
    }
    expect(outcome.computed).toBe(dependencies.computed);
    expect(outcome.lifecycleGuard).toBe(dependencies.lifecycleGuard);
    expect(phases).toEqual([
      'lifecycle-read',
      'lifecycle-closed-check',
      'mutation-read',
      'mutation-compute',
      'mutation-validate',
      'lifecycle-compute-guard',
    ]);
  });
});

interface CreateDecisionDependenciesInput {
  readonly phases: string[];
  readonly closedAtObservation: boolean;
}

interface DecisionDependencies {
  readonly command: GroupStateMutationCommand;
  readonly computed: GroupMutationComputed;
  readonly lifecycleGuard: WsSessionGenerationLifecycleComputed;
  readonly mutationService: GroupStateMutationService;
  readonly sessionGenerationLifecycle: WsSessionGenerationLifecycleService;
}

interface MutationServiceFixture {
  readonly computed: GroupMutationComputed;
  readonly service: GroupStateMutationService;
}

interface LifecycleServiceFixture {
  readonly lifecycleGuard: WsSessionGenerationLifecycleComputed;
  readonly service: WsSessionGenerationLifecycleService;
}

function createDecisionDependencies(input: CreateDecisionDependenciesInput): DecisionDependencies {
  const command = connectCommand();
  const mutation = createMutationServiceFixture(command, input.phases);
  const lifecycle = createLifecycleServiceFixture(input);
  return {
    command,
    computed: mutation.computed,
    lifecycleGuard: lifecycle.lifecycleGuard,
    mutationService: mutation.service,
    sessionGenerationLifecycle: lifecycle.service,
  };
}

function createMutationServiceFixture(command: GroupStateMutationCommand, phases: string[]): MutationServiceFixture {
  const read = {} as GroupMutationRead;
  const computed = {
    outcome: 'no-op',
    receipt: {},
  } as GroupMutationComputed;
  const service: GroupStateMutationService = {
    read: async (receivedCommand) => {
      expect(receivedCommand).toBe(command);
      phases.push('mutation-read');
      return read;
    },
    compute: (receivedCommand, receivedRead) => {
      expect(receivedCommand).toBe(command);
      expect(receivedRead).toBe(read);
      phases.push('mutation-compute');
      return computed;
    },
    validate: (receivedCommand, receivedRead, receivedComputed) => {
      expect(receivedCommand).toBe(command);
      expect(receivedRead).toBe(read);
      expect(receivedComputed).toBe(computed);
      phases.push('mutation-validate');
    },
    write: async () => {
      throw new Error('The presence decision must not own the transaction write');
    },
  };
  return { computed, service };
}

function createLifecycleServiceFixture(input: CreateDecisionDependenciesInput): LifecycleServiceFixture {
  const lifecycleRead = lifecycleReadFixture();
  const lifecycleGuard = lifecycleGuardFixture(lifecycleRead);
  const service: WsSessionGenerationLifecycleService = {
    read: async (identity) => {
      expect(identity).toEqual(lifecycleRead.identity);
      input.phases.push('lifecycle-read');
      return lifecycleRead;
    },
    isGenerationClosed: () => false,
    isObservedAtClosed: (identity, observedAtEpochMs, receivedRead) => {
      expect(identity).toEqual(lifecycleRead.identity);
      expect(observedAtEpochMs).toBe(1_000);
      expect(receivedRead).toBe(lifecycleRead);
      input.phases.push('lifecycle-closed-check');
      return input.closedAtObservation;
    },
    computeClosed: () => {
      throw new Error('Connect does not compute a close lifecycle state');
    },
    computeConnectGuard: (facts, receivedRead) => {
      expect(facts).toEqual({
        ...lifecycleRead.identity,
        generationId: 'generation-1',
        generationStartedAtEpochMs: 1_000,
        expireAtEpochMs: 422_240,
      });
      expect(receivedRead).toBe(lifecycleRead);
      input.phases.push('lifecycle-compute-guard');
      return lifecycleGuard;
    },
    write: async () => {
      throw new Error('The presence decision must not own the lifecycle write');
    },
  };
  return { lifecycleGuard, service };
}

function lifecycleReadFixture(): WsSessionGenerationLifecycleRead {
  return {
    identity: {
      scope: {
        kind: 'group',
        applicationId: 'ar-eye-hunter',
        workspaceId: 'default',
        principalId: 'owner',
      },
      sessionId: 'session-1',
    },
    key: 'lifecycle-key',
    entry: null,
    state: null,
  };
}

function lifecycleGuardFixture(lifecycleRead: WsSessionGenerationLifecycleRead): WsSessionGenerationLifecycleComputed {
  return {
    outcome: 'insert',
    key: lifecycleRead.key,
    expectedRevision: null,
    state: {
      version: 3,
      status: 'open',
      ...lifecycleRead.identity,
      generationId: 'generation-1',
      generationStartedAtEpochMs: 1_000,
      expireAtEpochMs: 422_240,
    },
  };
}

function connectCommand(): GroupStateMutationCommand {
  return {
    authorityProof: null,
    descriptor: null,
    command: {
      operation: 'connectPresence',
      aggregateRef: {
        applicationId: 'ar-eye-hunter',
        workspaceId: 'default',
        groupId: 'group-1',
      },
      commandId: 'connect-command',
      requestId: 'connect-request',
      sessionId: 'session-1',
      input: {
        principalId: 'owner',
        generationId: 'generation-1',
        connectedAtEpochMs: 1_000,
        lastHeartbeatAtEpochMs: 1_000,
        expiresAtEpochMs: 61_000,
        actorPrincipalId: 'owner',
        actorSessionId: 'session-1',
        reason: null,
        traceId: null,
      },
    },
    facts: {
      nowEpochMs: 2_000,
      expireAtEpochMs: 604_802_000,
      serviceId: 'server-1',
      eventId: 'event-1',
      commandHash: 'sha256:command',
      attemptCount: 1,
      resolvedJoinCode: null,
      joinCodeVerifier: null,
      internalAuthority: 'none',
      formationDamping: 'legacy',
      authenticatedAuthority: { principalId: 'owner', sessionId: 'session-1' },
    },
  };
}
