import { describe, expect, it } from 'vitest';

import { computeClientMutation } from '@shared-server/rallar-system/client-state/mutation/compute/compute-client-mutation.ts';
import { validateClientMutation } from '@shared-server/rallar-system/client-state/mutation/result-validation/validate-client-mutation.ts';
import { ClientStateRepository } from '@shared-server/rallar-system/client-state/persistence/client-state-repository.ts';
import {
  createClientStateService as createClientMutationService,
  toClientMutationCommand,
  toClientMutationSystemAuthority,
  toExpiryCommandInput,
} from '@shared-server/rallar-system/services/client-state-service.ts';
import { toClientSessionExpiryCandidate } from '@shared-server/rallar-system/repositories/session-expiry.ts';

import { emptyRead, principalCommand } from './client-mutation-compute-test-fixtures.ts';
import {
  CLIENT_MUTATION_BASE_EPOCH_MS as BASE_EPOCH_MS,
  PrincipalChangeAfterFirstReadRepository,
  connect,
} from './client-mutation-concurrency-test-runtime.ts';
import { clientMutationPrincipalRef as principalRef } from './client-mutation-validation-test-fixtures.ts';

describe('client mutation pure retry compute', () => {
  it('is deterministic and does not mutate a frozen command or read', async () => {
    const command = deepFreeze(await principalCommand());
    const read = deepFreeze(emptyRead(command));

    const first = computeClientMutation({ command, read });
    const second = computeClientMutation({ command, read });
    validateClientMutation({ command, read, computed: first });
    validateClientMutation({ command, read, computed: second });

    expect(second).toEqual(first);
    expect(command).toEqual(structuredClone(command));
    expect(read).toEqual(structuredClone(read));
  });
});

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

describe('client mutation stable-read concurrency', () => {
  it('reads the principal guard and snapshot from one stable aggregate observation', async () => {
    const runtime = new PrincipalChangeAfterFirstReadRepository();
    await connect(runtime, 'session-a', 'generation-a', BASE_EPOCH_MS);
    const repository = new ClientStateRepository(runtime);
    const session = await repository.findSession({
      ...principalRef('alice'),
      clientInstanceId: 'browser',
      sessionId: 'session-a',
    });
    if (!session) throw new Error('Expected a stored client session');
    const command = await toClientMutationCommand(
      toExpiryCommandInput(toClientSessionExpiryCandidate(session)),
      {
        nowEpochMs: session.expiresAtEpochMs,
        serviceId: 'client-service',
        eventId: 'stable-client-read-event',
        attemptCount: 1,
        expireAtEpochMs: session.expiresAtEpochMs + 60_000,
        formationDamping: 'damped',
      },
      toClientMutationSystemAuthority('client-service'),
    );

    runtime.armPrincipalChangeAfterRead();
    const read = await createClientMutationService({
      runtimeRepository: runtime,
      serviceId: 'client-service',
    }).read(command);

    expect(read.principal).not.toBeNull();
    expect(read.snapshot).not.toBeNull();
    expect(read.snapshot?.stateRevision).toBe((read.principal?.entry.revision ?? -1) + 1);
    expect(read.snapshot?.principal).toEqual(read.principal?.value);
  });
});
