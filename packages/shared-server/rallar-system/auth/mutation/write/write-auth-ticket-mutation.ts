import { requireConditionalWrite } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import type { RuntimeStateConditionalRepositoryLike } from '@shared-server/runtime-state/runtime-state-repository.ts';
import {
    AGENT_SESSION_TICKETS_NAMESPACE,
    WS_AUTH_TICKETS_NAMESPACE
} from '../../persistence/auth-storage-keys.ts';
import type {
    AuthComputedTicketDeletion,
    AuthComputedTicketWrite,
    AuthMutationComputed
} from '../auth-mutation-contracts.ts';
import { writeAuthSession } from './write-auth-session.ts';

export async function writeAuthTicketMutation(
    runtime: RuntimeStateConditionalRepositoryLike,
    computed: Extract<
        AuthMutationComputed,
        { kind: 'issue-ws-ticket' | 'consume-ws-ticket' | 'issue-agent-tickets' | 'consume-agent-ticket'; }
    >
): Promise<void> {
    switch (computed.kind) {
        case 'issue-ws-ticket':
            return await writeAuthTicket(runtime, computed.ticketWrites[0]);
        case 'consume-ws-ticket':
            return await writeAuthTicketDeletion(
                runtime,
                WS_AUTH_TICKETS_NAMESPACE,
                computed.ticketDeletion
            );
        case 'issue-agent-tickets':
            return await writeAuthAgentTicketsIssue(runtime, computed);
        case 'consume-agent-ticket':
            return await writeAuthTicketDeletion(
                runtime,
                AGENT_SESSION_TICKETS_NAMESPACE,
                computed.ticketDeletion
            );
    }
}

async function writeAuthTicket(
    runtime: RuntimeStateConditionalRepositoryLike,
    computed: AuthComputedTicketWrite
): Promise<void> {
    const result = computed.expectedRevision === null
        ? await runtime.insertIfAbsent(
            computed.namespace,
            computed.storageKey,
            computed.serializedValue,
            computed.expireAtIsoTimestamp
        )
        : await runtime.upsertIfRevision(
            computed.namespace,
            computed.storageKey,
            computed.serializedValue,
            computed.expireAtIsoTimestamp,
            computed.expectedRevision
        );
    requireConditionalWrite(result);
}

async function writeAuthAgentTicketsIssue(
    runtime: RuntimeStateConditionalRepositoryLike,
    computed: Extract<AuthMutationComputed, { kind: 'issue-agent-tickets'; }>
): Promise<void> {
    for (let index = 0; index < computed.sessions.length; index += 1) {
        await writeAuthSession(runtime, computed.sessions[index]);
        await writeAuthTicket(runtime, computed.ticketWrites[index]);
    }
}

async function writeAuthTicketDeletion(
    runtime: RuntimeStateConditionalRepositoryLike,
    namespace: typeof WS_AUTH_TICKETS_NAMESPACE | typeof AGENT_SESSION_TICKETS_NAMESPACE,
    deletion: AuthComputedTicketDeletion
): Promise<void> {
    requireConditionalWrite(
        await runtime.deleteIfRevision(
            namespace,
            deletion.storageKey,
            deletion.expectedRevision
        )
    );
}
