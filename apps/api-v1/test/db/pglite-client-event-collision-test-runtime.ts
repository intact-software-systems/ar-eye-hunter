import assert from 'node:assert/strict';

import { PSqlClientStateEventRepository } from '@shared-server/postgres/rallar-system/PSqlStateEventRepository.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/postgres/runtime-state/PSqlRuntimeStateRepository.ts';
import { AuthSessionRepository } from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';
import { createClientStateService } from '@shared-server/rallar-system/client-state/client-state-service.ts';
import { toClientMutationIssuedSessionAuthority } from '@shared-server/rallar-system/client-state/mutation/client-mutation-authority.ts';
import {
    toClientMutationCommand,
    toUpsertInstanceCommandInput,
    toUpsertPrincipalCommandInput
} from '@shared-server/rallar-system/client-state/mutation/client-mutation-command.ts';
import { ClientStateRepository } from '@shared-server/rallar-system/client-state/persistence/client-state-repository.ts';
import type { TopologyAppInboxCommand } from '@shared-server/rallar-system/topology/inbox/topology-app-inbox-contracts.ts';

import type { PGliteSql } from '../../src/db/pglite-sql-adapter.ts';

const FUTURE_MS = Date.parse('9999-12-31T23:59:59.999Z');

interface ResourceInboxStatusRow {
    readonly ri_type_id: string;
    readonly ri_status: string;
}

interface NumericCountRow {
    readonly count: string | number;
}

interface StringCountRow {
    readonly count: string;
}

interface ResourceInboxLifecycleRow {
    readonly ri_resource_id: string;
    readonly ri_topic_id: string;
    readonly ri_type_id: string;
    readonly ri_status: string;
    readonly ri_resource: string;
}

interface ResourceInboxForeignKeyRow {
    readonly ri_topic_id: string;
    readonly ri_resource_id: string;
    readonly fk_ext_bank_id: string;
}

interface ResourceInboxTopicTypeRow {
    readonly ri_topic_id: string;
    readonly ri_type_id: string;
}

interface NumericValueRow {
    readonly value: number;
}

interface StringValueRow {
    readonly value: string;
}

interface RuntimeStateExpiryRow {
    readonly store_key: string;
    readonly expire_at_ts: string;
}

interface ResourceInboxAttemptStatusRow {
    readonly ri_attempts: string | number;
    readonly ri_status: string;
}

interface ResourceInboxPayloadRow {
    readonly ri_resource: string;
}

interface EpochMillisecondsRow {
    readonly epoch_ms: string | number;
}

interface GroupEventWorkspaceRow {
    readonly workspace_key: string;
}

interface CreatedTimestampRow {
    readonly created_ts: string;
}

interface ExpireTimestampRow {
    readonly expire_ts: string;
}

interface StartTimestampRow {
    readonly start_ts: string;
}

interface EndTimestampRow {
    readonly end_ts: string;
}

interface TopologyCommandPayload {
    readonly data: TopologyAppInboxCommand;
}

interface DurableTopologyAuthorityProof {
    readonly principalId: string;
    readonly sessionId: string;
    readonly sessionIssuedAtEpochMs: number;
}

interface DurableTopologyAuthorityValue {
    readonly proof: DurableTopologyAuthorityProof;
}

interface DurableTopologyAuthority {
    readonly authority: DurableTopologyAuthorityValue;
}

interface ResourceInboxKeyFields {
    readonly topicId: string;
    readonly resourceId: string;
    readonly contextId: string;
}

interface RtcTopologyDeliveryState {
    readonly headSequence: number;
    readonly sequences: readonly number[];
}

interface RtcTopologyDeliveryStreamRow {
    readonly head_sequence: number;
}

interface RtcTopologyDeliveryEntryRow {
    readonly sequence: number;
}
export async function createPGliteClientEventCollisionFixture(
    sql: PGliteSql,
    prefix: string
) {
    const runtime = new PSqlRuntimeStateRepository(sql);
    const authSessions = new AuthSessionRepository(runtime);
    const events = new PSqlClientStateEventRepository(sql);
    const repository = new ClientStateRepository(runtime, { events });
    const service = createClientStateService({
        runtimeRepository: runtime,
        createClientStateEventStore: () => events,
        serviceId: 'pglite-client-service'
    });
    const scope = {
        applicationId: `${prefix}-app`,
        workspaceId: `${prefix}-workspace`
    };
    const principalId = `${prefix}-client`;
    const authority = {
        clientId: principalId,
        accessToken: `${prefix}-client-token`,
        username: principalId,
        sessionId: `${prefix}-client-session`,
        issuedAtEpochMs: 1_000,
        expiresAtEpochMs: FUTURE_MS
    } as const;
    await authSessions.putSession(authority);

    interface ComputeInput {
        readonly commandInput: ReturnType<typeof toUpsertPrincipalCommandInput>;
        readonly operation: 'upsertPrincipal' | 'upsertInstance';
        readonly eventId: string;
        readonly nowEpochMs: number;
    }
    const compute = async (input: ComputeInput) => {
        const { commandInput, operation, eventId, nowEpochMs } = input;
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
        const computed = service.compute(command, read);
        service.validate(command, read, computed);
        assert.equal(computed.outcome, 'write');
        if (computed.outcome !== 'write') {
            throw new Error('Expected applied client write');
        }
        return computed;
    };

    const seedRequestId = `${prefix}-seed`;
    const seed = await compute({
        commandInput: toUpsertPrincipalCommandInput(
            scope,
            principalId,
            {
                username: principalId,
                displayName: `Before ${prefix}`,
                actorPrincipalId: principalId,
                actorSessionId: authority.sessionId,
                requestId: seedRequestId
            },
            seedRequestId
        ),
        operation: 'upsertPrincipal',
        eventId: `${seedRequestId}-event`,
        nowEpochMs: 2_000
    });
    await sql.begin(async (transaction) => {
        await service.write(transaction, seed);
    });
    const before = await repository.readSnapshot({ ...scope, principalId });
    assert.ok(before);

    const requestId = `${prefix}-instance`;
    const clientInstanceId = `${prefix}-browser`;
    const computed = await compute({
        commandInput: toUpsertInstanceCommandInput(
            scope,
            principalId,
            clientInstanceId,
            {
                platform: 'web',
                deviceLabel: prefix,
                actorPrincipalId: principalId,
                actorSessionId: authority.sessionId,
                requestId
            },
            requestId
        ),
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
