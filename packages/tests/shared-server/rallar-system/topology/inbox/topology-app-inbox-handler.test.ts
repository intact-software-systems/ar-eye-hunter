import { describe, expect, it } from 'vitest';

import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { AppInboxType, type AppInboxExecutionMetadata } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import type { AppInboxMutationTransactionWriter } from '@shared-server/rallar-system/app-inbox/handler/app-inbox-transaction-writer.ts';
import { authSessionProofSecret } from '@shared-server/rallar-system/auth/sessions/auth-session-proof-secret.ts';
import type { GroupTopologyConfigMutationAttemptRead } from '@shared-server/rallar-system/topology/config/group-topology-config-mutation-service.ts';
import { resolveGroupTopologyConfig } from '@shared-server/rallar-system/topology/config/group-topology-config.ts';
import { createAuthenticatedTopologyEnqueue } from '@shared-server/rallar-system/topology/inbox/topology-app-inbox-authority.ts';
import { toTopologyAppInboxCommand } from '@shared-server/rallar-system/topology/inbox/topology-app-inbox-command.ts';
import {
    decodeTopologyAppInboxResult,
    TopologyAppInboxHandler,
    type TopologyAppInboxMutationOwners
} from '@shared-server/rallar-system/topology/inbox/topology-app-inbox-handler.ts';
import type { GroupTopologyReconfigureRead } from '@shared-server/rallar-system/topology/reconfigure/group-topology-reconfigure-contracts.ts';
import { newALRoute, newALUntargetedMessage } from '@shared/al-contracts/al-contract.ts';
import { EntityStatus, toResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import {
    createTopologyConfigMutationTestInput,
    createTopologyTestAuthorityGuard,
    createTopologyTestGroupRef,
    createTopologyTestGroupSnapshot
} from '../config/mutation/group-topology-config-mutation-test-fixtures.ts';

const SESSION = {
    clientId: 'owner',
    username: 'owner',
    sessionId: 'owner-session',
    accessToken: 'owner-token',
    issuedAtEpochMs: 500,
    expiresAtEpochMs: 2_000
};

describe('TopologyAppInboxHandler completion boundary', () => {
    it('decodes an exact topology reconfigure result', () => {
        const result = {
            status: 'queued',
            groupRef: createTopologyTestGroupRef(),
            requestId: 'request-1',
            outboxId: 'outbox-1'
        } as const;
        expect(decodeTopologyAppInboxResult(result)).toEqual(result);
        expect(() => decodeTopologyAppInboxResult({ ...result, stale: true })).toThrow(TypeError);
    });

    for (const operation of ['putConfig', 'reconfigureTopology'] as const) {
        it(`finishes ${operation} completion before transaction entry and wakes only after commit`, async () => {
            const phases: string[] = [];
            const context = await createContext(operation);
            const durableResults: object[] = [];
            const handler = await createHandler(phases, {
                readCompletionFacts: (metadata) => {
                    phases.push('completion-read');
                    return { entry: metadata.entry, completedAtEpochMs: 1_500 };
                },
                writeMutation: async (_context, computed, write) => {
                    if (computed.durableResult === null || typeof computed.durableResult !== 'object') {
                        throw new TypeError('Topology completion must carry an object result');
                    }
                    durableResults.push(computed.durableResult);
                    expect(computed.reservationFinish).toMatchObject({
                        expectedAttempts: 7,
                        status: EntityStatus.COMPLETED,
                        completedAt: new Date(1_500)
                    });
                    expect(JSON.parse(computed.resultReplacement.resource)).toEqual(computed.encodedResult);
                    phases.push('transaction');
                    await write(createTopologyWriteTransaction(phases));
                    phases.push('commit');
                    return computed.durableResult;
                }
            });

            const result = await handler.processMutation(context, mutationOwners(phases));
            expect(result).toBe(durableResults[0]);
            expect(result).toMatchObject(
                operation === 'putConfig'
                    ? { receipt: { requestId: 'handler-request', outcome: 'applied', attemptCount: 7 } }
                    : { status: 'queued', outboxId: 'handler-request:rtc-topology-recompute:explicit' }
            );
            expect(phases).toEqual([
                'verify-authority',
                'domain-read',
                'completion-read',
                'transaction',
                'write',
                'commit',
                'record-committed',
                'wake'
            ]);
        });

        it(`rejects invalid ${operation} completion facts before any write`, async () => {
            const phases: string[] = [];
            const handler = await createHandler(phases, {
                readCompletionFacts: (context) => ({
                    entry: { ...context.entry, status: EntityStatus.COMPLETED },
                    completedAtEpochMs: 1_500
                }),
                writeMutation: async () => {
                    phases.push('transaction');
                    throw new Error('Invalid completion must not write');
                }
            });
            await expect(handler.processMutation(await createContext(operation), mutationOwners(phases)))
                .rejects.toThrow('must be RESERVED');
            expect(phases).toEqual(['verify-authority', 'domain-read']);
        });
    }
});

async function createHandler(
    phases: string[],
    transactionWriter: Pick<AppInboxMutationTransactionWriter, 'readCompletionFacts' | 'writeMutation'>
): Promise<TopologyAppInboxHandler> {
    const session = await persistedSession();
    return new TopologyAppInboxHandler({
        groupStateService: {
            readIssuedAuthSession: async () => {
                phases.push('verify-authority');
                return session;
            }
        },
        nowEpochMs: () => 1_000,
        wakeQueue: () => phases.push('wake'),
        transactionWriter
    });
}

function mutationOwners(phases: string[]): TopologyAppInboxMutationOwners {
    return {
        configMutationService: {
            read: async () => {
                phases.push('domain-read');
                return configRead();
            },
            recordCommitted: () => phases.push('record-committed')
        },
        reconfigureMutation: {
            read: async () => {
                phases.push('domain-read');
                return reconfigureRead();
            },
            recordCommitted: () => phases.push('record-committed')
        }
    };
}

function createTopologyWriteTransaction(phases: string[]): PSqlSql {
    let writeStarted = false;
    const transaction = (async <Result>(strings: TemplateStringsArray): Promise<Result> => {
        if (!writeStarted) {
            writeStarted = true;
            phases.push('write');
        }
        const statement = strings.join(' ');
        const rows = statement.includes('returning ri_row_id')
            ? [{ ri_row_id: 1n }]
            : statement.includes('returning revision')
            ? [{ revision: statement.includes('insert into runtime_state_store') ? 0 : 1 }]
            : [];
        return rows as Result;
    }) as PSqlSql;
    transaction.begin = async (write) => await write(transaction);
    return transaction;
}

async function createContext(
    operation: 'putConfig' | 'reconfigureTopology'
): Promise<AppInboxExecutionMetadata> {
    const command = await toTopologyAppInboxCommand({
        actor: { principalId: SESSION.clientId, sessionId: SESSION.sessionId },
        groupRef: createTopologyTestGroupRef(),
        requestId: 'handler-request',
        capturedAtEpochMs: 1_000,
        payload: operation === 'putConfig'
            ? { operation, config: { topologyKind: 'tree' } }
            : { operation, requestOptions: {}, publish: true }
    });
    const session = await persistedSession();
    const enqueue = await createAuthenticatedTopologyEnqueue({
        enqueue: {
            type: operation === 'putConfig' ? AppInboxType.TOPOLOGY_CONFIG_PUT : AppInboxType.TOPOLOGY_RECONFIGURE,
            resourceId: command.requestId,
            data: command
        },
        claimedAuthority: SESSION,
        groupStateService: { readIssuedAuthSession: async () => session },
        nowEpochMs: () => 1_000
    });
    const entry = toResourceEntry('APP_INBOX', enqueue);
    return {
        enqueue,
        entry: { ...entry, status: EntityStatus.RESERVED, dequeueAudit: { attempts: 7 } },
        message: newALUntargetedMessage('test', newALRoute('topology', 'room', 'handler-request'), enqueue.type, enqueue)
    };
}

async function persistedSession() {
    return {
        clientId: SESSION.clientId,
        username: SESSION.username,
        sessionId: SESSION.sessionId,
        accessTokenDigest: await authSessionProofSecret(SESSION),
        issuedAtEpochMs: SESSION.issuedAtEpochMs,
        expiresAtEpochMs: SESSION.expiresAtEpochMs
    };
}

function configRead(): GroupTopologyConfigMutationAttemptRead {
    return {
        state: createTopologyConfigMutationTestInput().read,
        policyNowEpochMs: 1_000,
        actorIsPlatformAdmin: false,
        serverDefaults: {}
    };
}

function reconfigureRead(): GroupTopologyReconfigureRead {
    return {
        authority: {
            group: createTopologyTestGroupSnapshot(),
            config: resolveGroupTopologyConfig({}),
            kindHysteresisWidths: { meshExitWidth: 4, treeExitWidth: 0 },
            rttMeasurements: [],
            replanning: 'auto',
            nowEpochMs: 1_000
        },
        authorityGuard: createTopologyTestAuthorityGuard(),
        actorIsPlatformAdmin: false
    };
}
