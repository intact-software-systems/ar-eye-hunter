import type {
    AdminOperationsMutationGateway
} from '@shared-server/rallar-system/admin-operations/admin-operations-mutation-gateway.ts';
import type { AppAdminInboxService } from '@shared-server/rallar-system/admin-operations/inbox/\
app-admin-inbox-service.ts';
import type { IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/\
auth-session-repository.ts';
import type {
    CrdtAdminCompactResult,
    CrdtAdminEraseResult
} from '@shared-server/rallar-system/crdt/mutation/crdt-mutation-contracts.ts';
import {
    toTopologyAppInboxCommand,
    toTopologyHttpMutationSemanticHash,
    type AppGroupInboxService,
    type TopologyReconfigureInboxResult
} from '@shared-server/rallar-system/services/AppGroupInboxService.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { RallarCrdtDocumentMetadata } from '@shared/crdt/mod.ts';

import { decodeJsonWireValue } from '@shared-server/rallar-system/services/\
mutation-command-identity.ts';

import type { CrdtAdminMutations, CrdtAdminPublicResult } from '../crdt/create-crdt-admin-mutations.ts';

export interface ApiAdminPruneMutationPort {
    readonly pruneExpired: AppAdminInboxService['pruneExpired'];
}

export interface ApiTopologyRecomputeMutationPort {
    readonly processAuthenticatedHttpTopologyEntryUntilCompletionResult:
        AppGroupInboxService['processAuthenticatedHttpTopologyEntryUntilCompletionResult'];
}

export interface CreateApiAdminMutationGatewayInput {
    readonly appAdmin: ApiAdminPruneMutationPort;
    readonly crdtAdminMutations: CrdtAdminMutations;
    readonly appGroup: ApiTopologyRecomputeMutationPort;
    readonly now: () => number;
}

export function createApiAdminMutationGateway(
    input: CreateApiAdminMutationGatewayInput
): AdminOperationsMutationGateway {
    return {
        recomputeTopology: async ({ adminSession, requestId, request }) => {
            if (!request.groupRef) {
                throw new TypeError('Admin topology recompute requires groupRef');
            }
            const groupRef = request.groupRef;
            const requestPayload = {
                operation: 'reconfigureTopology' as const,
                requestOptions: request.options ?? {},
                publish: request.publish ?? true
            };
            const semanticHash = await toTopologyHttpMutationSemanticHash({
                principalId: adminSession.clientId,
                groupRef,
                requestId,
                payload: requestPayload
            });
            const result = await input.appGroup
                .processAuthenticatedHttpTopologyEntryUntilCompletionResult(
                    {
                        operation: requestPayload.operation,
                        requestId,
                        callerId: adminSession.clientId,
                        groupRef,
                        semanticHash,
                        materialize: async () =>
                            await toTopologyAppInboxCommand({
                                actor: {
                                    principalId: adminSession.clientId,
                                    sessionId: adminSession.sessionId
                                },
                                groupRef,
                                requestId,
                                capturedAtEpochMs: input.now(),
                                payload: requestPayload
                            })
                    },
                    toIssuedAuthSession(adminSession)
                );
            if (result.right !== undefined) {
                return requireTopologyReconfigureResult(result.right);
            }
            if (result.left !== undefined) {
                throw Object.assign(new Error(result.left.message), result.left);
            }
            throw new Error('Admin topology AppInbox processing failed');
        },
        pruneExpired: async (request) => {
            const result = await input.appAdmin.pruneExpired(request);
            if (result.right !== undefined) {
                return result.right;
            }
            if (result.left !== undefined) {
                throw Object.assign(new Error(result.left.message), {
                    code: result.left.code,
                    status: result.left.status,
                    failure: result.left
                });
            }
            throw new Error('Admin prune AppInbox processing failed');
        },
        compactCrdt: async (request) =>
            requireCrdtCompactResult(
                await input.crdtAdminMutations.writeCrdtAdminMutation({
                    operation: 'compact',
                    adminSession: request.adminSession,
                    requestId: request.requestId,
                    request: decodeJsonWireValue(request.request, 'CRDT compact request')
                })
            ),
        updateCrdtLifecycle: async (request) =>
            requireCrdtLifecycleResult(
                await input.crdtAdminMutations.writeCrdtAdminMutation({
                    operation: 'lifecycle',
                    adminSession: request.adminSession,
                    requestId: request.requestId,
                    request: decodeJsonWireValue(request.request, 'CRDT lifecycle request')
                })
            ),
        eraseCrdt: async (request) =>
            requireCrdtEraseResult(
                await input.crdtAdminMutations.writeCrdtAdminMutation({
                    operation: 'erase',
                    adminSession: request.adminSession,
                    requestId: request.requestId,
                    request: decodeJsonWireValue(request.request, 'CRDT erase request')
                })
            )
    };
}

function requireTopologyReconfigureResult(
    result: Awaited<
        ReturnType<
            ApiTopologyRecomputeMutationPort[
                'processAuthenticatedHttpTopologyEntryUntilCompletionResult'
            ]
        >
    >['right']
): TopologyReconfigureInboxResult {
    if (result === undefined || !('status' in result) || result.status !== 'queued') {
        throw new TypeError('Admin topology reconfigure result is invalid');
    }
    return result;
}

function toIssuedAuthSession(session: AuthSession): IssuedAuthSession {
    const issuedAtEpochMs = Reflect.get(session, 'issuedAtEpochMs');
    if (!Number.isSafeInteger(issuedAtEpochMs) || issuedAtEpochMs < 0) {
        throw new TypeError('Admin topology recompute requires authenticated session issue time');
    }
    return { ...session, issuedAtEpochMs };
}

function requireCrdtCompactResult(result: CrdtAdminPublicResult): CrdtAdminCompactResult {
    if ('snapshot' in result) {
        return result;
    }
    throw new TypeError('CRDT compact mutation returned a different operation result');
}

function requireCrdtLifecycleResult(result: CrdtAdminPublicResult): RallarCrdtDocumentMetadata {
    if ('lifecycle' in result) {
        return result;
    }
    throw new TypeError('CRDT lifecycle mutation returned a different operation result');
}

function requireCrdtEraseResult(result: CrdtAdminPublicResult): CrdtAdminEraseResult {
    if ('request' in result) {
        return result;
    }
    throw new TypeError('CRDT erase mutation returned a different operation result');
}
