import { decodeJsonWireValue, type JsonWireObject, type JsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import { describe, expect, it } from 'vitest';

import { readApiV1Matrix, readApiV1Recipe, toFlatApiV1RecipeSteps } from './api-v1-recipe-test-fixture.ts';

const RECIPE_ID = 'api-v1-idempotency-contract';
const GROUP_MUTATION_PATH = '/api/state/apps/{applicationId}/workspaces/{workspaceId}' +
    '/groups/{groupId}/requests/idem-contract-group-replay-{runId}';
const EQUAL_CONTENDER_PATH = '/api/state/apps/{applicationId}/workspaces/{workspaceId}' +
    '/groups/{groupId}/topology/config/requests/' +
    'idem-contract-equal-contenders-{runId}';
const DIFFERENT_CONTENDER_PATH = '/api/state/apps/{applicationId}/workspaces/{workspaceId}' +
    '/groups/{groupId}/topology/override/requests/' +
    'idem-contract-different-contenders-{runId}';
const ADMIN_PRUNE_EQUAL_PATH = '/api/admin/operations/maintenance/prune-expired/requests/' +
    'idem-contract-admin-prune-equal-{runId}';
const ADMIN_PRUNE_DIFFERENT_PATH = '/api/admin/operations/maintenance/prune-expired/requests/' +
    'idem-contract-admin-prune-different-{runId}';

describe('API-v1 equal AppInbox HTTP idempotency contract recipe', () => {
    it('is a Tier 2 three-node cluster recipe', () => {
        const entry = readApiV1Matrix().entries.find((candidate) => candidate.id === RECIPE_ID);

        expect(entry).toMatchObject({
            recipe: `tests/api-v1/${RECIPE_ID}.json`,
            category: 'api-v1-black-box',
            mode: 'run',
            tier: 2,
            profiles: ['api-v1-black-box-cluster'],
            expectedExitCode: 0
        });
        expect(entry?.requires?.httpServices?.map((service) => service.env)).toEqual([
            'RALLAR_API_BASE_URL',
            'RALLAR_API_BASE_URL_SECONDARY',
            'RALLAR_API_BASE_URL_TERTIARY'
        ]);
    });

    it('owns every locked behavior and durable evidence block', () => {
        const steps = readSteps();
        const names = new Set(steps.map((step) => step.name));

        for (
            const name of [
                'firstGroupMutation',
                'exactGroupReplayAfterSessionRenewal',
                'normalizedGroupReplay',
                'rejectChangedGroupIntent',
                'rejectBodyRequestIdentity',
                'rejectHeaderRequestIdentity',
                'rejectOldMutationPath',
                'acceptMinimumRequestId',
                'acceptMaximumRequestId',
                'replayNoOpMutation',
                'raceEqualContendersAcrossThreeNodes',
                'assertEqualContenderResults',
                'raceDifferentContendersAcrossNodes',
                'assertOneDifferentIntentWinner',
                'proveOperationIsolation',
                'proveActorIsolation',
                'deriveCrdtAdminAuthHeader',
                'proveScopeIsolation',
                'proveDocumentIsolation',
                'replayTerminalFailure',
                'replayLogout',
                'issueWebSocketTicket',
                'issueSingleUseAgentTicket',
                'raceSingleUseAgentTicketConsumption',
                'assertSingleTicketConsumption',
                'appendCrdtUpdateThroughWebSocket',
                'redeliverCrdtUpdateWithDistinctDeliveryId',
                'readCrdtThroughTertiary',
                'replayCrdtHttpMutation',
                'rejectChangedCrdtHttpIntent',
                'replayNormalizedPruneCategories',
                'assertNormalizedPruneReplay',
                'rejectChangedNormalizedPruneIntent',
                'rejectMismatchedAdminClientHeader',
                'proveAdminActorIsolation',
                'assertAdminActorIsolationEvidence',
                'raceEqualAdminPruneAcrossThreeNodes',
                'assertEqualAdminPruneResults',
                'assertEqualAdminPruneEvidence',
                'raceDifferentAdminPruneIntentsAcrossThreeNodes',
                'assertOneDifferentAdminPruneWinner',
                'assertDifferentAdminPruneEvidence',
                'proveAdminCrdtOperationIsolation',
                'proveAdminTopologyOperationIsolation',
                'proveAdminPruneOperationIsolation',
                'replayTopologyAfterRestartBoundary',
                'exposeStateWriteEvidence',
                'assertAtomicAppInboxCompletion',
                'assertSecretsStayRedacted'
            ]
        ) {
            expect(names.has(name), name).toBe(true);
        }
    });

    it('reuses identity only for replay and contender sets', () => {
        const byName = new Map(
            readSteps().flatMap((step) => typeof step.name === 'string' ? [[step.name, step] as const] : [])
        );
        expect(
            paths(byName, [
                'firstGroupMutation',
                'exactGroupReplayAfterSessionRenewal',
                'normalizedGroupReplay',
                'rejectChangedGroupIntent'
            ])
        ).toEqual(new Set([GROUP_MUTATION_PATH]));
        expect(
            paths(byName, ['equalContenderPrimary', 'equalContenderSecondary', 'equalContenderTertiary'])
        ).toEqual(new Set([EQUAL_CONTENDER_PATH]));
        expect(paths(byName, ['differentContenderPrimary', 'differentContenderSecondary'])).toEqual(
            new Set([DIFFERENT_CONTENDER_PATH])
        );
        expect(
            paths(byName, [
                'equalAdminPrunePrimary',
                'equalAdminPruneSecondary',
                'equalAdminPruneTertiary'
            ])
        ).toEqual(new Set([ADMIN_PRUNE_EQUAL_PATH]));
        expect(
            paths(byName, [
                'differentAdminPrunePrimary',
                'differentAdminPruneSecondary',
                'differentAdminPruneTertiary'
            ])
        ).toEqual(new Set([ADMIN_PRUNE_DIFFERENT_PATH]));
    });

    it('proves admin operation, actor, and three-node effect isolation', () => {
        const byName = new Map(
            readSteps().flatMap((step) => typeof step.name === 'string' ? [[step.name, step] as const] : [])
        );
        const operationPaths = paths(byName, [
            'proveAdminCrdtOperationIsolation',
            'proveAdminTopologyOperationIsolation',
            'proveAdminPruneOperationIsolation'
        ]);
        expect(operationPaths.size).toBe(3);
        for (const path of operationPaths) {
            expect(path).toContain('/requests/idem-contract-admin-operation-isolation-{runId}');
        }
        expect(byName.get('loginSecondAdmin')).toMatchObject({
            request: {
                body: {
                    username: '{secondAdminUsername}',
                    password: '{secondAdminPassword}'
                },
                outputs: {
                    secondAdminClientId: 'body.clientId',
                    secondAdminAccessToken: { path: 'body.accessToken', secret: true }
                }
            },
            expect: { status: 200, body: { clientId: 'bob' } }
        });
        expect(byName.get('exposeAdminActorIsolationEvidence')).toMatchObject({
            request: {
                stateWriteEvidence: {
                    commandTypes: ['ADMIN_PRUNE_EXPIRED'],
                    minimumMatchedRows: 2,
                    expectedEffectsByCommandType: {
                        ADMIN_PRUNE_EXPIRED: ['admin-prune-page']
                    }
                }
            }
        });
        expect(byName.get('exposeEqualAdminPruneEvidence')).toMatchObject({
            request: {
                stateWriteEvidence: {
                    commandTypes: ['ADMIN_PRUNE_EXPIRED'],
                    minimumMatchedRows: 1,
                    expectedEffectsByCommandType: {
                        ADMIN_PRUNE_EXPIRED: ['admin-prune-page']
                    }
                }
            }
        });
    });

    it('encodes the CRDT path-bearing operation as literal JSON', () => {
        const encode = readSteps().find((step) => step.name === 'encodeContractCrdtUpdate');
        const transform = optionalObject(encode?.transform);
        const update = optionalObject(transform?.jsonStringify);
        const payload = optionalObject(update?.payload);
        const operations = payload?.operations;
        const operation = Array.isArray(operations) ? optionalObject(operations[0]) : undefined;

        expect(operation).toHaveProperty('jsonParse');
        expect(operation).not.toHaveProperty('path');
    });

    it('uses the CRDT document type authorized by the managed cluster profile', () => {
        const recipe = readRecipe();
        const variables = optionalObject(recipe.variables);
        const crdtSteps = readSteps().filter((step) => JSON.stringify(step).includes('"documentType":"black-box-map"'));

        expect(variables?.crdtApplicationId).toBe('rallar-server');
        expect(variables?.crdtWorkspaceId).toBe('default');
        expect(crdtSteps).toHaveLength(8);
        for (const step of crdtSteps) {
            const serialized = JSON.stringify(step);
            expect(serialized).toContain('"applicationId":"{crdtApplicationId}"');
            expect(serialized).toContain('"workspaceId":"{crdtWorkspaceId}"');
        }
    });

    it('carries the current admin session through every CRDT action', () => {
        const byName = new Map(readSteps().map((step) => [step.name, step]));
        const seedRequest = optionalObject(byName.get('seedActorIsolation')?.request);
        const seedOutputs = optionalObject(seedRequest?.outputs);

        expect(seedOutputs).toMatchObject({
            crdtAdminSessionId: 'body.sessionId',
            crdtAdminAccessToken: { path: 'body.accessToken', secret: true }
        });
        expect(byName.get('deriveCrdtAdminAuthHeader')).toMatchObject({
            type: 'set',
            output: 'crdtAdminAuthHeader',
            secret: true
        });
        for (
            const stepName of [
                'issueWebSocketTicket',
                'readCrdtThroughTertiary',
                'firstCrdtHttpMutation',
                'replayCrdtHttpMutation',
                'rejectChangedCrdtHttpIntent',
                'seedDocumentIsolation',
                'proveDocumentIsolation'
            ]
        ) {
            const request = optionalObject(byName.get(stepName)?.request);
            const headers = optionalObject(request?.headers);
            expect(headers?.Authorization, stepName).toBe('{crdtAdminAuthHeader}');
        }
        for (
            const stepName of [
                'deriveContractWsUrl',
                'encodeContractCrdtUpdate',
                'appendCrdtUpdateThroughWebSocket',
                'redeliverCrdtUpdateWithDistinctDeliveryId'
            ]
        ) {
            expect(JSON.stringify(byName.get(stepName)), stepName).toContain('{crdtAdminSessionId}');
        }
    });

    it('treats missing-document compaction as an isolated terminal failure per document', () => {
        const byName = new Map(readSteps().map((step) => [step.name, step]));

        for (const stepName of ['seedDocumentIsolation', 'proveDocumentIsolation']) {
            expect(byName.get(stepName)?.expect, stepName).toEqual({
                status: 404,
                body: {
                    type: 'api-mutation-failure',
                    version: 'canonical.v2',
                    code: 'crdt-admin-mutation-rejected',
                    status: 404
                }
            });
        }
    });

    it('allows the same credential proof to replay a successful logout', () => {
        const replay = readSteps().find((step) => step.name === 'replayLogout');

        expect(replay?.expect).toEqual({
            status: 200,
            body: { loggedOut: true }
        });
    });

    it('collects exact durable completion without exposing secret selectors', () => {
        const recipe = readRecipe();
        const steps = readSteps();
        const evidence = steps.find((step) => step.name === 'exposeStateWriteEvidence');
        const assertion = steps.find((step) => step.name === 'assertAtomicAppInboxCompletion');
        const serialized = JSON.stringify(recipe);

        expect(evidence).toMatchObject({
            type: 'set.state-write-evidence',
            output: 'stateWriteEvidence',
            request: {
                stateWriteEvidence: {
                    match: 'idem-contract-group-replay-{runId}',
                    commandTypes: ['GROUP_UPDATE'],
                    commandIdPrefixes: ['group-app-inbox:'],
                    minimumMatchedRows: 1,
                    expectedEffectsByCommandType: {
                        GROUP_UPDATE: ['group-presence-summary']
                    }
                }
            }
        });
        expect(assertion).toMatchObject({
            actual: {
                matchedAppInboxCount: '{stateWriteEvidence.matchedAppInboxCount}',
                atomicCompletionFailures: '{stateWriteEvidence.atomicCompletionFailures}',
                intermediateMutationIntentCount: '{stateWriteEvidence.intermediateMutationIntentCount}',
                receiptOutboxIdCount: '{stateWriteEvidence.receiptOutboxIdCount}',
                resourceOutboxCount: '{stateWriteEvidence.resourceOutboxCount}'
            },
            expect: {
                body: {
                    matchedAppInboxCount: 1,
                    completedAppInboxCount: 1,
                    failedAppInboxCount: 0,
                    atomicCompletionFailures: 0,
                    intermediateMutationIntentCount: 0,
                    receiptOutboxIdCount: 1,
                    resourceOutboxCount: 1
                },
                comparators: [
                    { path: 'appInbox', length: 1 },
                    { path: 'receiptOutboxIds', length: 1 },
                    { path: 'resourceOutbox', length: 1 }
                ]
            }
        });
        expect(serialized).not.toMatch(/requests\/[^"}]*\{(?:password|accessToken|authHeader|ticket)/i);
    });
});

function readRecipe(): JsonWireObject {
    const entry = readApiV1Matrix().entries.find((candidate) => candidate.id === RECIPE_ID);
    if (!entry) {
        throw new Error(`Missing ${RECIPE_ID} recipe matrix entry`);
    }
    return requireObject(decodeJsonWireValue(readApiV1Recipe(entry.recipe), `${RECIPE_ID} recipe`));
}

function readSteps(): readonly JsonWireObject[] {
    const recipe = readRecipe();
    if (!Array.isArray(recipe.steps)) {
        throw new TypeError(`${RECIPE_ID} steps must be an array`);
    }
    return toFlatApiV1RecipeSteps(recipe.steps).map((step) => requireObject(decodeJsonWireValue(step, `${RECIPE_ID} step`)));
}

function paths(
    byName: ReadonlyMap<string, JsonWireObject>,
    names: readonly string[]
): ReadonlySet<string | undefined> {
    return new Set(
        names.map((name) => {
            const step = byName.get(name);
            const request = optionalObject(step?.request);
            return typeof request?.path === 'string' ? request.path : undefined;
        })
    );
}

function requireObject(value: JsonWireValue | undefined): JsonWireObject {
    const object = optionalObject(value);
    if (!object) {
        throw new TypeError(`Expected ${RECIPE_ID} JSON object`);
    }
    return object;
}

function optionalObject(value: JsonWireValue | undefined): JsonWireObject | undefined {
    return value !== undefined && isJsonWireObject(value) ? value : undefined;
}

function isJsonWireObject(value: JsonWireValue): value is JsonWireObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
