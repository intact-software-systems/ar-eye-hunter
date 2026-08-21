import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

import { deriveApiV1StateWriteEvidence } from '@shared-test/black-box-runner/api-v1-state-write-evidence.ts';
import { executeBlackBox } from '@shared-test/black-box-runner/execute-black-box.ts';
import { explainBlackBoxRunnerPlan } from '@shared-test/black-box-runner/preflight/plan-preflight.ts';
import { toExactPersistedEvidenceMatches } from '@shared-test/black-box-runner/state-write-evidence/to-exact-persisted-evidence-matches.ts';
import { toRallarCrdtDocumentKey } from '@shared/crdt/mod.ts';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const recipeRoot = path.join(
    repoRoot,
    'packages/shared-test/black-box-runner/tests/api-v1'
);
const taskRecipes = [
    'api-v1-state-write-convergence.json',
    'api-v1-state-medium-scale-churn.json',
    'api-v1-auth-session.json',
    'api-v1-admin-operations.json',
    'api-v1-crdt-app-inbox.json',
    'api-v1-idempotency-contract.json'
];

describe('API-v1 state-write recipe evidence', () => {
    it('selects auth ticket races by the redacted secret and exact durable digest', async () => {
        const recipe = JSON.parse(readFileSync(
            path.join(
                recipeRoot,
                'api-v1-auth-session.json'
            ),
            'utf8'
        )) as { steps: Array<Record<string, any>>; };
        const evidence = recipe.steps.find((step) => step.name === 'exposeStateWriteEvidence');
        expect(evidence?.request.stateWriteEvidence.match).toBe('{singleUseAgentTicket}');
        const matches = await toExactPersistedEvidenceMatches('race-ticket-secret');
        expect(matches).toEqual({
            raw: 'race-ticket-secret',
            digest: '6dy-jINE4zGcAta17d3GOaDkncYQn5DMJ_GF-DwGQS8'
        });
    });

    it('executes the topology exact-revision assertions before every cleanup step', async () => {
        const recipe = JSON.parse(readFileSync(
            path.join(
                recipeRoot,
                'api-v1-rtc-topology-convergence.json'
            ),
            'utf8'
        )) as { steps: Array<Record<string, any>>; };
        const terminalNames = [
            'assertPrimaryExactRevisions',
            'assertTertiaryExactRevisions',
            'assertEnvelopePayloadsAcrossPrimaryAndTertiary',
            'closeAliceWebSocket',
            'closeBobWebSocket',
            'logoutAliceThroughPrimary',
            'logoutBobThroughSecondary'
        ];
        expect(recipe.steps).toHaveLength(32);
        expect(recipe.steps.slice(-terminalNames.length).map((step) => step.name))
            .toEqual(terminalNames);

        const assertionSteps = recipe.steps.slice(-terminalNames.length, -4);
        expect(assertionSteps[0].actual).toEqual({
            firstRevision: '{primaryFirstEnvelope.resultingCausalRevision.groupRevision}',
            secondRevision: '{primarySecondEnvelope.resultingCausalRevision.groupRevision}'
        });
        const group = {
            applicationId: 'app',
            workspaceId: 'workspace',
            groupId: 'group'
        };
        // The delta envelope carries the revision the mutation produced as
        // resultingCausalRevision; the retired snapshot frame carried it as
        // causalRevision.
        const envelope = (groupRevision: number, presenceRevision: number) => ({
            resultingCausalRevision: { groupRevision, presenceRevision },
            group
        });
        const variables = {
            applicationId: 'app',
            workspaceId: 'workspace',
            groupId: 'group',
            roleMutationRevision: 3,
            groupMutationRevision: 4,
            primaryFirstEnvelope: envelope(3, 7),
            primarySecondEnvelope: envelope(4, 8),
            tertiaryFirstEnvelope: envelope(4, 8),
            tertiarySecondEnvelope: envelope(3, 7)
        };
        const interactions = [
            ...assertionSteps.map((step, index) => ({
                ASSERT: {
                    request: {
                        actual: step.actual,
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: index + 1
                    },
                    response: step.expect
                },
                [step.name]: { type: 'assert' }
            })),
            ...terminalNames.slice(-4).map((name, index) => ({
                SET: {
                    request: {
                        output: `${name}Observed`,
                        value: true,
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: assertionSteps.length + index + 1
                    },
                    response: {}
                },
                [name]: { type: 'set' }
            }))
        ];
        const report = await executeBlackBox(interactions, 0, {
            failFast: true,
            variables
        });

        expect(report.summary).toMatchObject({ total: 7, success: 7, failure: 0 });
        for (const name of terminalNames) {
            expect(report.resultsByName[name], name).toHaveLength(1);
        }
    });

    it('observes committed socket authorization before clustered WS effects', () => {
        for (
            const [name, terminalStep, socketConnections] of [
                [
                    'api-v1-rtc-topology-convergence.json',
                    'commitConcurrentGroupRevisions',
                    ['wsPrimary', 'wsTertiary']
                ],
                [
                    'api-v1-crdt-app-inbox.json',
                    'appendCrdtUpdateThroughPrimary',
                    ['wsPrimary', 'wsTertiary']
                ]
            ] as const
        ) {
            const recipe = JSON.parse(
                readFileSync(path.join(recipeRoot, name), 'utf8')
            ) as { steps: Array<Record<string, unknown>>; };
            const terminalIndex = recipe.steps.findIndex((step) => step.name === terminalStep);
            for (const connection of socketConnections) {
                const readyIndex = recipe.steps.findIndex((step) => step.name === `${connection}AuthorizationReady`);
                expect(readyIndex, `${name}:${connection}`).toBeGreaterThan(-1);
                expect(readyIndex, `${name}:${connection}`).toBeLessThan(terminalIndex);
                expect(recipe.steps[readyIndex]).toMatchObject({
                    type: 'ws.wait',
                    connection,
                    expect: {
                        consume: true,
                        messages: [{ payload: { typeId: 'client-state.snapshot' } }]
                    }
                });
            }
        }
    });

    it('isolates CRDT AppInbox evidence by recipe command prefixes', () => {
        const recipe = JSON.parse(readFileSync(
            path.join(
                recipeRoot,
                'api-v1-crdt-app-inbox.json'
            ),
            'utf8'
        )) as { steps: Array<Record<string, any>>; };
        const evidence = recipe.steps.find((step) => step.name === 'exposeStateWriteEvidence');

        expect(evidence?.request.stateWriteEvidence).toMatchObject({
            match: 'crdt-update-{runId}',
            commandIdPrefixes: ['crdt-delivery-', 'crdt-update-']
        });
    });

    it('selects strict group evidence by its scoped internal command identity', () => {
        for (
            const [name, retainedPrefixes] of [
                ['api-v1-idempotency-contract.json', []],
                ['api-v1-state-write-convergence.json', ['put-', 'delete-']],
                ['api-v1-state-medium-scale-churn.json', ['control-']]
            ] as const
        ) {
            const recipe = JSON.parse(
                readFileSync(path.join(recipeRoot, name), 'utf8')
            ) as { steps: Array<Record<string, any>>; };
            const evidence = recipe.steps.find((step) => step.name === 'exposeStateWriteEvidence');

            expect(evidence?.request.stateWriteEvidence.commandIdPrefixes).toEqual([
                'group-app-inbox:',
                ...retainedPrefixes
            ]);
        }
    });

    it('forbids literal SET values from claiming durable state-write evidence', () => {
        for (const name of taskRecipes) {
            const recipe = JSON.parse(
                readFileSync(path.join(recipeRoot, name), 'utf8')
            ) as { steps: Array<Record<string, unknown>>; };
            const evidence = recipe.steps.find((step) => step.output === 'stateWriteEvidence');

            expect(evidence, name).toMatchObject({
                type: 'set.state-write-evidence',
                request: { stateWriteEvidence: expect.any(Object) }
            });
            expect(evidence, name).not.toHaveProperty('value');
        }
    });

    it('uses one bounded execution identity for the command and its evidence', () => {
        const recipe = JSON.parse(readFileSync(
            path.join(
                recipeRoot,
                'api-v1-admin-operations.json'
            ),
            'utf8'
        )) as {
            variables: Record<string, unknown>;
            steps: Array<Record<string, any>>;
        };
        const boundedPrune = recipe.steps.find((step) => step.name === 'runBoundedPruneToCompletion');
        const evidence = recipe.steps.find((step) => step.output === 'stateWriteEvidence');

        expect(boundedPrune?.request.path)
            .toBe(
                '/api/admin/operations/maintenance/prune-expired/requests/' +
                    'bb-request-prune-{executionToken}'
            );
        expect(boundedPrune?.request.body).not.toHaveProperty('requestId');
        expect(evidence?.request.stateWriteEvidence.match)
            .toBe('bb-request-prune-{executionToken}');
        expect(recipe.variables.executionToken).toEqual({
            env: 'RALLAR_BB_EXECUTION_TOKEN',
            required: true
        });
    });

    it('rejects a literal stateWriteEvidence output in strict preflight', () => {
        const config = {
            steps: [{
                name: 'fabricateEvidence',
                type: 'set',
                output: 'stateWriteEvidence',
                value: { atomicCompletionFailures: 0 }
            }]
        };
        const preflight = explainBlackBoxRunnerPlan({
            rawConfig: config,
            expandedConfig: config,
            profile: 'strict'
        });

        expect(preflight.issues).toContainEqual(expect.objectContaining({
            code: 'STRICT_STATE_WRITE_EVIDENCE_SOURCE',
            severity: 'error'
        }));
    });

    it('stores only the injected asynchronous collector result', async () => {
        const observed = {
            source: 'postgres.resource_inbox',
            atomicCompletionFailures: 0,
            intermediateMutationIntents: []
        };
        const collector = vi.fn(async () => observed);
        const report = await executeBlackBox(
            [{
                SET: {
                    request: {
                        output: 'stateWriteEvidence',
                        stateWriteEvidence: { match: 'scope-1' },
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 1,
                        repeatIndex: 1
                    },
                    response: {}
                },
                exposeStateWriteEvidence: {
                    type: 'set.state-write-evidence'
                }
            }],
            0,
            { stateWriteEvidenceCollector: collector }
        );

        expect(collector).toHaveBeenCalledWith({ match: 'scope-1' });
        expect(report.outputs.stateWriteEvidence).toEqual(observed);
    });

    it('links final effects only through the outer canonical envelope identity', () => {
        const inbox = [{
            ri_row_id: 1,
            ri_resource_id: 'inbox-1',
            ri_topic_id: 'app-inbox.group-state',
            fk_ext_bank_id: 'scope',
            ri_status: 'COMPLETED',
            ri_attempts: 2,
            start_ts: new Date(1),
            end_ts: new Date(2),
            next_ts: null,
            result_status: 'COMPLETED',
            result_resource: JSON.stringify({
                status: 'ok',
                result: { right: { snapshot: {}, event: null } }
            }),
            ri_resource: JSON.stringify({
                payload: {
                    typeId: 'GROUP_MEMBER_UPSERT',
                    resource: JSON.stringify({ command: { commandId: 'cmd-1', requestId: 'cmd-1' } })
                }
            })
        }];
        const canonical = {
            ri_resource_id: 'effect-1',
            ri_topic_id: 'app-outbox.group-presence-summary',
            ri_type_id: 'APP_OUTBOX',
            ri_status: 'COMPLETED',
            ri_resource: JSON.stringify({
                id: { msgId: 'cmd-1:group-presence-summary:effect' },
                payload: { resource: JSON.stringify({ requestId: 'misleading-nested-id' }) }
            })
        };
        const nestedOnly = {
            ...canonical,
            ri_resource_id: 'effect-unrelated',
            ri_resource: JSON.stringify({
                id: { msgId: 'unrelated' },
                payload: { requestId: 'cmd-1' }
            })
        };
        const spec = {
            match: 'scope',
            commandTypes: ['GROUP_MEMBER_UPSERT'],
            expectedEffectsByCommandType: { GROUP_MEMBER_UPSERT: ['group-presence-summary'] }
        };

        const valid = deriveApiV1StateWriteEvidence(spec, inbox, [canonical, nestedOnly]);
        expect(valid).toMatchObject({
            atomicCompletionFailures: 0,
            resourceOutbox: [{
                resourceId: 'effect-1',
                commandId: 'cmd-1',
                effectKind: 'group-presence-summary'
            }]
        });
        const duplicate = deriveApiV1StateWriteEvidence(spec, inbox, [canonical, {
            ...canonical,
            ri_resource_id: 'effect-duplicate'
        }]);
        expect(duplicate).toMatchObject({
            atomicCompletionFailures: 1,
            finalEffectFailures: ['inbox-1']
        });
        const truncated = deriveApiV1StateWriteEvidence(
            { ...spec, evidenceSampleLimit: 0 },
            inbox,
            [canonical, { ...canonical, ri_resource_id: 'effect-duplicate' }]
        );
        expect(truncated).toMatchObject({
            atomicCompletionFailures: 1,
            finalEffectFailureCount: 1,
            finalEffectFailures: [],
            resourceOutboxCount: 2,
            resourceOutbox: []
        });
        const unexpectedDirect = deriveApiV1StateWriteEvidence(spec, inbox, [canonical, {
            ...canonical,
            ri_resource_id: 'effect-unexpected',
            ri_type_id: 'WS_OUTBOX',
            ri_topic_id: 'client-state.event',
            ri_resource: JSON.stringify({ id: { msgId: 'cmd-1:principal-state:event' } })
        }]);
        expect(unexpectedDirect).toMatchObject({
            atomicCompletionFailures: 1,
            finalEffectFailures: ['inbox-1']
        });
    });

    it('links typed CRDT reply and fanout identities to one append command', () => {
        const inbox = [{
            ri_row_id: 2,
            ri_resource_id: 'delivery-1',
            ri_topic_id: 'app-inbox.crdt-state',
            fk_ext_bank_id: 'document-1',
            ri_status: 'COMPLETED',
            ri_attempts: 1,
            start_ts: new Date(1),
            end_ts: new Date(2),
            next_ts: null,
            result_status: 'COMPLETED',
            result_resource: JSON.stringify({
                version: 1,
                operation: 'append',
                status: 'rejected',
                commandId: 'update-1',
                documentKey: toRallarCrdtDocumentKey({
                    applicationId: 'app-1',
                    scope: 'app',
                    documentType: 'test',
                    documentId: 'document-1'
                }),
                documentRevision: null,
                appendSequence: null,
                code: 'quota-exceeded',
                appendResult: {
                    status: 'rejected',
                    code: 'quota-exceeded',
                    reason: 'The CRDT document quota would be exceeded.',
                    retryable: false,
                    update: {
                        protocolVersion: 1,
                        document: {
                            applicationId: 'app-1',
                            scope: 'app',
                            documentType: 'test',
                            documentId: 'document-1'
                        },
                        updateId: 'update-1',
                        replicaId: 'replica-1',
                        lamport: 1,
                        parents: [],
                        schemaVersion: 1,
                        operationVersion: 1,
                        createdAtEpochMs: 1,
                        payload: {
                            kind: 'batch',
                            operations: [{
                                kind: 'register.set',
                                path: ['title'],
                                policy: 'lww',
                                value: 'value'
                            }]
                        }
                    }
                }
            }),
            ri_resource: JSON.stringify({
                payload: {
                    typeId: 'CRDT_UPDATE_APPEND',
                    resource: JSON.stringify({
                        commandId: 'update-1',
                        deliveryId: 'delivery-1'
                    })
                }
            })
        }];
        const outbox = [
            ['crdt:delivery-1:reply', 'rallar.crdt.append-response.v1'],
            ['crdt:update-1:fanout', 'rallar.crdt.update.v1']
        ].map(([msgId, typeId]) => ({
            ri_resource_id: msgId,
            ri_topic_id: 'app.crdt',
            ri_type_id: 'WS_OUTBOX',
            ri_status: 'NEW',
            ri_resource: JSON.stringify({ id: { msgId }, payload: { typeId } })
        }));
        const evidence = deriveApiV1StateWriteEvidence(
            {
                match: 'update-1',
                commandTypes: ['CRDT_UPDATE_APPEND'],
                expectedEffectsByCommandType: {
                    CRDT_UPDATE_APPEND: ['crdt-append-reply', 'crdt-update-fanout']
                }
            },
            inbox,
            outbox
        );

        expect(evidence).toMatchObject({
            atomicCompletionFailures: 0,
            resourceOutbox: [
                { commandId: 'delivery-1', effectKind: 'crdt-append-reply' },
                { commandId: 'update-1', effectKind: 'crdt-update-fanout' }
            ]
        });
    });

    it('derives exactly one typed admin prune page effect per category', () => {
        const inbox = [{
            ri_row_id: 3,
            ri_resource_id: 'admin-inbox-1',
            ri_topic_id: 'app-inbox.admin',
            fk_ext_bank_id: 'admin-job-1',
            ri_status: 'COMPLETED',
            ri_attempts: 1,
            start_ts: new Date(1),
            end_ts: new Date(2),
            next_ts: null,
            result_status: 'COMPLETED',
            result_resource: JSON.stringify({
                generatedAtEpochMs: 1,
                serverId: 'server-1',
                warnings: [],
                operation: 'maintenance.prune-expired',
                status: 'queued',
                changed: false,
                jobId: 'admin-job-1',
                results: [
                    { category: 'sessions', expiredRows: 1, deletedRows: 0, dryRun: false },
                    { category: 'groups', expiredRows: 1, deletedRows: 0, dryRun: false }
                ]
            }),
            ri_resource: JSON.stringify({
                payload: {
                    typeId: 'ADMIN_PRUNE_EXPIRED',
                    resource: JSON.stringify({ jobId: 'admin-job-1' })
                }
            })
        }];
        const page = (category: string, suffix = '') => ({
            ri_resource_id: `admin-page-${category}${suffix}`,
            ri_topic_id: 'rallar.admin.prune-expired',
            ri_type_id: 'APP_OUTBOX',
            ri_status: 'NEW',
            ri_resource: JSON.stringify({
                id: { msgId: `admin-job-1:${category}${suffix}` },
                route: { contextId: 'admin-job-1' },
                payload: {
                    typeId: 'ADMIN_PRUNE_EXPIRED',
                    resource: JSON.stringify({ kind: 'page', jobId: 'admin-job-1', category })
                }
            })
        });
        const spec = {
            match: 'admin-job-1',
            commandTypes: ['ADMIN_PRUNE_EXPIRED'],
            expectedEffectsByCommandType: {
                ADMIN_PRUNE_EXPIRED: ['admin-prune-page', 'admin-prune-page']
            }
        };

        expect(deriveApiV1StateWriteEvidence(spec, inbox, [page('sessions'), page('groups')]))
            .toMatchObject({ atomicCompletionFailures: 0, resourceOutboxCount: 2 });
        expect(deriveApiV1StateWriteEvidence(spec, inbox, [page('sessions')]))
            .toMatchObject({ atomicCompletionFailures: 1, finalEffectFailureCount: 1 });
        expect(deriveApiV1StateWriteEvidence(
            spec,
            inbox,
            [page('sessions'), page('groups'), page('groups', '-duplicate')]
        )).toMatchObject({ atomicCompletionFailures: 1, finalEffectFailureCount: 1 });
    });
});
