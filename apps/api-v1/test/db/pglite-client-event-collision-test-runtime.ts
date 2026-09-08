import type { IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';
import type { ClientStateService } from '@shared-server/rallar-system/client-state/client-state-service-contracts.ts';
import type {
    ClientMutationCommandInput,
    ClientMutationComputedAppliedWrite
} from '@shared-server/rallar-system/client-state/mutation/client-mutation-contracts.ts';
import { validateClientMutationAuthorityPolicy } from '@shared-server/rallar-system/client-state/mutation/result-validation/validate-client-mutation-authority-policy.ts';
import type { ClientSnapshot } from '@shared/api/client-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import assert from 'node:assert/strict';

import { AuthSessionRepository } from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';
import { createClientStateService } from '@shared-server/rallar-system/client-state/client-state-service.ts';
import { toClientMutationIssuedSessionAuthority } from '@shared-server/rallar-system/client-state/mutation/client-mutation-authority.ts';
import { toClientMutationCommand } from '@shared-server/rallar-system/client-state/mutation/client-mutation-command.ts';
import { toUpsertClientInstanceMutationInput } from '@shared-server/rallar-system/client-state/mutation/command-input/to-upsert-client-instance-mutation-input.ts';
import { toUpsertClientPrincipalMutationInput } from '@shared-server/rallar-system/client-state/mutation/command-input/to-upsert-client-principal-mutation-input.ts';
import { computeClientMutation } from '@shared-server/rallar-system/client-state/mutation/compute/compute-client-mutation.ts';
import { assertClientMutation } from '@shared-server/rallar-system/client-state/mutation/result-validation/assert-client-mutation.ts';
import { ClientStateRepository } from '@shared-server/rallar-system/client-state/persistence/client-state-repository.ts';
import { PSqlClientStateEventRepository } from '@shared-server/rallar-system/state-events/postgres/p-sql-client-state-event-repository.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';

import type { PGliteSql } from '../../src/db/pglite-sql-adapter.ts';

const FUTURE_MS = Date.parse('9999-12-31T23:59:59.999Z');

interface PGliteClientEventCollisionFixture {
    readonly before: ClientSnapshot;
    readonly clientInstanceId: string;
    readonly computed: ClientMutationComputedAppliedWrite;
    readonly events: PSqlClientStateEventRepository;
    readonly principalId: string;
    readonly repository: ClientStateRepository;
    readonly requestId: string;
    readonly scope: StateScope;
    readonly service: ClientStateService;
}

interface PreparePGliteClientEventInput {
    readonly service: ClientStateService;
    readonly authority: IssuedAuthSession;
    readonly scope: StateScope;
    readonly commandInput: ClientMutationCommandInput;
    readonly operation: 'upsertPrincipal' | 'upsertInstance';
    readonly eventId: string;
    readonly nowEpochMs: number;
}

export async function createPGliteClientEventCollisionFixture(
    sql: PGliteSql,
    prefix: string
): Promise<PGliteClientEventCollisionFixture> {
    const runtime = new PSqlRuntimeStateRepository(sql);
    const authSessions = new AuthSessionRepository(runtime);
    const events = new PSqlClientStateEventRepository(sql);
    const repository = new ClientStateRepository(runtime, events);
    const service = createClientStateService({
        runtimeRepository: runtime,
        clientStateEventStore: events,
        serviceId: 'pglite-client-service'
    });
    const scope = {
        applicationId: `${prefix}-app`,
        workspaceId: `${prefix}-workspace`
    };
    const principalId = `${prefix}-client`;
    const authority = toPGliteClientAuthority(prefix);
    await authSessions.putSession(authority);

    const before = await seedPGliteClientPrincipal({ sql, prefix, scope, principalId, authority, service, repository });

    const requestId = `${prefix}-instance`;
    const clientInstanceId = `${prefix}-browser`;
    const computed = await preparePGliteClientEvent({
        service,
        authority,
        scope,
        commandInput: toUpsertClientInstanceMutationInput({
            scope,
            principalId,
            clientInstanceId,
            request: {
                platform: 'web',
                deviceLabel: prefix,
                actorPrincipalId: principalId,
                actorSessionId: authority.sessionId,
                requestId
            },
            defaultCommandId: requestId
        }),
        operation: 'upsertInstance',
        eventId: `${requestId}-event`,
        nowEpochMs: 3_000
    });
    return {
        before,
        clientInstanceId,
        computed,
        events,
        principalId,
        repository,
        requestId,
        scope,
        service
    };
}

async function preparePGliteClientEvent(
    input: PreparePGliteClientEventInput
): Promise<ClientMutationComputedAppliedWrite> {
    const { commandInput, operation, eventId, nowEpochMs, service, authority, scope } = input;
    const command = await toClientMutationCommand(
        commandInput,
        {
            nowEpochMs,
            serviceId: 'pglite-client-service',
            eventId,
            attemptCount: 1,
            expireAtEpochMs: FUTURE_MS
        },
        toClientMutationIssuedSessionAuthority(authority, scope, operation)
    );
    const read = await service.read(command);
    const computed = computeClientMutation({ command, read });
    assertClientMutation({ command, read, computed });
    assert.deepEqual(validateClientMutationAuthorityPolicy(command, read), []);
    assert.equal(computed.outcome, 'write');
    if (computed.outcome !== 'write') {
        throw new Error('Expected applied client write');
    }
    return computed;
}

interface SeedPGliteClientPrincipalInput {
    readonly sql: PGliteSql;
    readonly prefix: string;
    readonly scope: StateScope;
    readonly principalId: string;
    readonly authority: IssuedAuthSession;
    readonly service: ClientStateService;
    readonly repository: ClientStateRepository;
}
async function seedPGliteClientPrincipal(input: SeedPGliteClientPrincipalInput): Promise<ClientSnapshot> {
    const { sql, prefix, scope, principalId, authority, service, repository } = input;
    const seedRequestId = `${prefix}-seed`;
    const seed = await preparePGliteClientEvent({
        service,
        authority,
        scope,
        commandInput: toUpsertClientPrincipalMutationInput({
            scope,
            principalId,
            request: {
                username: principalId,
                displayName: `Before ${prefix}`,
                actorPrincipalId: principalId,
                actorSessionId: authority.sessionId,
                requestId: seedRequestId
            },
            defaultCommandId: seedRequestId
        }),
        operation: 'upsertPrincipal',
        eventId: `${seedRequestId}-event`,
        nowEpochMs: 2_000
    });
    await sql.begin(async (transaction) => {
        await service.write(transaction, seed);
    });
    const before = await repository.readSnapshot({ ...scope, principalId });
    assert.ok(before);

    return before;
}

function toPGliteClientAuthority(prefix: string): IssuedAuthSession {
    return {
        clientId: `${prefix}-client`,
        accessToken: `${prefix}-client-token`,
        username: `${prefix}-client`,
        sessionId: `${prefix}-client-session`,
        issuedAtEpochMs: 1_000,
        expiresAtEpochMs: FUTURE_MS
    };
}
