import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { API } from 'typescript/unstable/sync';
import * as ts from 'typescript/unstable/ast';
import { afterAll, describe, expect, it } from 'vitest';
type Selector =
    | readonly [kind: 'function' | 'method' | 'variable', name: string]
    | readonly [kind: 'callback', ownerKind: 'function' | 'method',
        ownerName: string,
          name: string,
      ];
type Branch = readonly [condition: string, side: 'then' | 'else'];
type CallExpectation = Readonly<{
    name: string; callee: string; arguments?: readonly string[];
    awaited: boolean; branch?: Branch;
}>;
type CallSpec = string | readonly [name: string, branch: Branch] | CallExpectation;
type ExpectedCall = Partial<CallExpectation> & Pick<CallExpectation, 'name'>;
type PathContract = Readonly<{
    family: string; name: string; file: string; owner: Selector; retry: string | null;
    phases: readonly [CallSpec, CallSpec, CallSpec, CallSpec];
}>;
type SeamContract = Readonly<{
    family: string; file: string; owner: Selector; guards: readonly string[];
    dependent: readonly string[];
    guardChecks: readonly GuardCheck[];
    transaction: 'owned' | 'received';
}>;
type GuardCheck = Readonly<{
    call: CallExpectation; wrapper?: string; binding?: string; condition?: string;
    terminal?: 'throw' | 'throw-or-return'; protects?: CallExpectation;
}>;
type PropertySpec = readonly [name: string, types: readonly string[]];
type VariantDescriptor = Readonly<{ outcome: string; property?: PropertySpec }>;
type AtomicMapping = Readonly<{
    outcome: string; property: PropertySpec; seam: SeamContract;
    calls: readonly CallSpec[];
}>;
type ReplayMapping = Readonly<{
    outcome: string; property: PropertySpec; file: string; owner: Selector;
    claim: string;
    calls: readonly CallSpec[];
}>;
type EffectContract = Readonly<{
    family: string; type: readonly [file: string, name: string];
    noExternalEffectOutcomes: readonly string[];
    noExternalEffectVariants?: readonly VariantDescriptor[];
    atomic: readonly AtomicMapping[]; replay?: readonly ReplayMapping[];
}>;
const clientFile = 'packages/shared-server/rallar-system/services/client-state-service.ts';
const clientMutationFile =
    'packages/shared-server/rallar-system/services/client-state-mutations.ts';
const appClientFile =
    'packages/shared-server/rallar-system/services/AppClientInboxService.ts';
const clientRepositoryFile =
    'packages/shared-server/rallar-system/repositories/ClientStateRepository.ts';
const groupFile = 'packages/shared-server/rallar-system/services/group-state-service.ts';
const groupWriteFile = groupFile.replace('-service', '-guarded-batch');
const configFile = 'packages/shared-server/rallar-system/services/group-topology-management-service.ts';
const rtcWorkerFile = 'packages/shared-server/rallar-system/services/RtcTopologyOutboxWork.ts';
const rtcRepositoryFile = 'packages/shared-server/rallar-system/repositories/RtcTopologyExecutionRepository.ts';
const rttFile = 'packages/shared-server/rallar-system/services/rtc-rtt-mutation-service.ts';
const guardedCapability = 'isRuntimeStateGuardedBatchRepositoryLike(transaction)';
const clientSeam = seam(
    'client mutation', clientFile, ['function', 'writeClientMutation'],
    ['insertPrincipal', 'updatePrincipal'],
    [
        'writeChildCandidate',
        'appendEvent', 'writeIfAbsentOrMatch',
    ],
    [
        wrapped('repository.insertPrincipal'),
        wrapped('repository.updatePrincipal'),
        wrapped('repository.insertIdempotentClientStateWritten',
            ['computed.idempotency', 'then']),
    ],
    'received',
);
const groupSeam = seam(
    'group mutation', groupWriteFile, ['function', 'writeGroupMutation'],
    ['insertGroup', 'updateGroup', 'insertPresence', 'updatePresence', 'deletePresence'],
    [
        'insertPresenceAdmission', 'updatePresenceAdmission', 'putMember',
        'insertPresenceSummary', 'insertIdempotentGroupMutationReceipt',
        'insertForAuthoritativeWrite', 'appendEvent',
    ],
    [
        wrapped('repository.insertGroup', ["computed.guard.kind === 'group'", 'then']),
        wrapped('repository.updateGroup', ["computed.guard.kind === 'group'", 'then']),
        wrapped('repository.insertPresence', ["computed.guard.kind === 'group'", 'else']),
        wrapped('repository.updatePresence', ["computed.guard.kind === 'group'", 'else']),
        wrapped('repository.deletePresence', ["computed.guard.kind === 'group'", 'else']),
        wrapped('repository.insertPresenceAdmission', ['computed.presenceAdmission', 'then']),
        wrapped('repository.updatePresenceAdmission', ['computed.presenceAdmission', 'then']),
        wrapped('repository.insertPresenceSummary', ['computed.initialPresenceSummary', 'then']),
        wrapped('repository.insertIdempotentGroupMutationReceipt', [
            'computed.idempotency',
            'then',
        ]),
    ],
);
const configSeam = seam(
    'topology config mutation', configFile,
    ['function', 'writeTopologyConfigMutation'],
    ['advanceAuthorityFence'],
    [
        'deleteConfig', 'deleteOverride', 'commitConfig', 'commitOverride',
        'commitInvariantGeneration', 'commitGeneration', 'insertMutationRecord',
        'insertForAuthoritativeWrite',
    ],
    [
        checked('new GroupStateRepository(transaction).advanceAuthorityFence',
            'authorityFence',
            "authorityFence.status === 'conflict' || authorityFence.revision !== computed.groupAuthorityGuard.entry.revision + 1", undefined, 'throw', exact('repository.deleteConfig', undefined, true, [
                "computed.outcome === 'write'",
                'then',
            ]),
        ),
        ...['deleteConfig', 'deleteOverride', 'commitConfig', 'commitOverride']
            .map((name) => checked(`repository.${name}`, 'state',
                "state.status === 'conflict'",
                ["computed.outcome === 'write'", 'then'], 'throw', exact('repository.commitInvariantGeneration', undefined, true, [
                    "computed.outcome === 'write'",
                    'then',
                ]),
            ),
        ),
        checked(
            'repository.commitInvariantGeneration', 'invariantGeneration',
            "invariantGeneration.status === 'conflict'",
            ["computed.outcome === 'write'", 'then'], 'throw', exact('repository.commitGeneration', undefined, true, [
                "computed.outcome === 'write'",
                'then',
            ]),
        ),
        checked(
            'repository.commitGeneration', 'generation',
            "generation.status === 'conflict'",
            ["computed.outcome === 'write'", 'then'], 'throw', exact('new StateMutationOutboxRepository(transaction).insertForAuthoritativeWrite', undefined, true, ["computed.outcome === 'write'", 'then'],
            ),
        ),
        checked('repository.insertMutationRecord', 'claimed', "claimed.status === 'conflict'", [
            'computed.idempotency',
            'then',
        ]),
    ],
);
const rtcSeam = seam(
    'RTC topology mutation', rtcRepositoryFile,
    ['method', 'writeTopologyMutation'], ['commitSnapshotGuard'],
    ['insertWorkClaim', 'insertPublication'],
    [
        checked('snapshots.commitSnapshotGuard', 'guard',
            "guard.status === 'conflict'", undefined, 'throw', exact('publications.insertWorkClaim', undefined, true, ['publicationWrite', 'then']),
        ),
        checked(
            'publications.insertWorkClaim', 'claimed', '!claimed',
            ['publicationWrite', 'then'], 'throw', exact('publications.insertPublication', undefined, true, ['publicationWrite', 'then']),
        ),
    ],
);
const rttSeam = seam(
    'RTC RTT mutation', rttFile, ['function', 'writeRttMutation'],
    ['commitEndpointAdmission'],
    ['commitMeasurement', 'insertMutationReceipt', 'insertRecomputeIntent'],
    [
        checked('repository.commitEndpointAdmission', 'written',
            "written.status === 'conflict'", undefined, 'throw-or-return', exact('repository.commitMeasurement', undefined, true),
        ),
        checked(
            'repository.commitMeasurement', 'measurement',
            "measurement.status === 'conflict'", undefined, 'throw', exact('repository.insertMutationReceipt', undefined, true),
        ),
        checked(
            'repository.insertMutationReceipt', 'receipt',
            "receipt.status === 'conflict'", undefined, 'throw', exact('repository.insertRecomputeIntent', undefined, true),
        ),
        checked('repository.insertRecomputeIntent', 'inserted',
            "inserted.status === 'conflict'"),
    ],
);
const seams = [clientSeam, groupSeam, configSeam, rtcSeam, rttSeam] as const;
const rtcWorkerOwner = [
    'callback', 'function', 'createRtcTopologyWorkHandler', 'onMessage',
] as const satisfies Selector;
const paths: readonly PathContract[] = [
    {
        family: clientSeam.family,
        name: 'client AppInbox effectful path',
        file: appClientFile,
        owner: ['method', 'processCommand'],
        retry: null,
        phases: [
            exact('this.clientStateService.read', ['command'], true),
            exact('this.clientStateService.compute', ['command', 'read'], false),
            exact('this.clientStateService.validate', ['command', 'read', 'computed'], false),
            exact('this.commitComputed', ['context', 'computed'], true),
        ],
    },
    {
        family: groupSeam.family,
        name: 'group effectful path',
        file: groupFile,
        owner: ['variable', 'executeReceiptWithRetry'],
        retry: 'attempt < DEFAULT_RUNTIME_STATE_WRITE_ATTEMPTS',
        phases: [
            'readGroupMutation',
            under('computeGroupMutation', "idempotency.outcome !== 'miss'", 'else'),
            under('validateGroupMutation', 'resolvedFromIdempotency', 'else'),
            'writeGroupMutation',
        ],
    },
    {
        family: configSeam.family,
        name: 'topology config effectful path',
        file: configFile,
        owner: ['method', 'executeTopologyConfigMutationWithRetry'],
        retry: 'attempt < DEFAULT_RUNTIME_STATE_WRITE_ATTEMPTS',
        phases: [
            'readTopologyConfigMutation',
            under('computeTopologyConfigMutation',
                "idempotency.outcome !== 'miss'", 'else'),
            under('validateTopologyConfigMutation',
                "computed.outcome === 'replay' || computed.outcome === 'idempotency-conflict'",
                'else',
            ),
            'writeTopologyConfigMutation',
        ],
    },
    {
        family: rtcSeam.family,
        name: 'RTC topology externally effectful worker path',
        file: rtcWorkerFile,
        owner: rtcWorkerOwner,
        retry: 'attempt < 3',
        phases: [
            exact('options.executionRepository.readTopologyMutation',
                ['work.groupSnapshot.group', 'workId'],
                true,
            ),
            exact(
                'computeTopologyMutation',
                ['{ read, candidate: planned.snapshot, publication, facts, }'],
                false,
            ),
            exact(
                'validateTopologyMutation',
                ['{ read, candidate: planned.snapshot, publication, facts, computed, }'],
                false,
            ),
            exact('options.executionRepository.writeTopologyMutation',
                ['computed'], true),
        ],
    },
    {
        family: rtcSeam.family,
        name: 'RTC topology publication-null internal path',
        file: configFile,
        owner: ['method', 'commitTopologyWithRetry'],
        retry: 'attempt < 3',
        phases: [
            'readTopologyMutation', 'computeTopologyMutation',
            'validateTopologyMutation',
            under('writeTopologyMutation',
                "computed.observation !== 'duplicate'", 'then'),
        ],
    },
    {
        family: rttSeam.family,
        name: 'RTC RTT effectful path',
        file: rttFile,
        owner: ['function', 'executeRttMutation'],
        retry: 'attempt < 3',
        phases: [
            'readRttMutation', 'computeRttMutation',
            'validateRttMutation', 'writeRttMutation',
        ],
    },
];
const effects: readonly EffectContract[] = [
    {
        family: clientSeam.family,
        type: [clientMutationFile, 'ClientMutationComputed'],
        noExternalEffectOutcomes: ['replay', 'idempotency-conflict'],
        noExternalEffectVariants: [{
            outcome: 'no-op',
            property: ['persistIdempotency', ['false']],
        }],
        atomic: [
            {
                outcome: 'no-op',
                property: ['persistIdempotency', ['true']],
                seam: clientSeam,
                calls: [exact(
                    'repository.insertIdempotentClientStateWritten',
                    [
                        'computed.aggregateRef', 'computed.idempotency.requestId',
                        'computed.idempotency',
                    ],
                    true,
                    ["computed.outcome === 'no-op'", 'then'],
                )],
            },
            {
                outcome: 'write',
                property: ['outboxEntries', ['readonly ResourceEntry[]']],
                seam: clientSeam,
                calls: [exact(
                    'outbox.writeIfAbsentOrMatch',
                    ['entry'],
                    true,
                )],
            },
        ],
    },
    {
        family: groupSeam.family,
        type: [
            'packages/shared-server/rallar-system/services/group-state-mutations.ts',
            'GroupMutationComputed',
        ],
        noExternalEffectOutcomes: [
            'replay', 'idempotency-conflict', 'no-op', 'rejected'],
        atomic: [{
            outcome: 'write', property: ['outbox', ['GroupMutationOutboxCandidate']],
            seam: groupSeam, calls: [exact(
                'new StateMutationOutboxRepository(transaction).insertForAuthoritativeWrite',
                ['materialized.outbox'],
                        true,
                    ),
                ],
            },
        ],
    },
    {
        family: configSeam.family,
        type: [
            'packages/shared-server/rallar-system/services/group-topology-config-mutations.ts',
            'GroupTopologyConfigMutationComputed',
        ],
        noExternalEffectOutcomes: [
            'claim', 'no-op', 'replay', 'idempotency-conflict'],
        atomic: [{
            outcome: 'write', property: ['outbox', ['GroupTopologyConfigOutboxInput']],
            seam: configSeam,
            calls: [exact(
                'new StateMutationOutboxRepository(transaction).insertForAuthoritativeWrite',
                ['materialized.outbox'], true,
                ["computed.outcome === 'write'", 'then'],
                    ),
                ],
            },
        ],
    },
    {
        family: rtcSeam.family,
        type: [
            'packages/shared-server/rallar-system/services/rtc-topology-mutations.ts',
            'RtcTopologyMutationComputed',
        ],
        noExternalEffectOutcomes: ['retry', 'superseded'],
        noExternalEffectVariants: [{
            outcome: 'write', property: ['publication', ['null']],
            },
        ],
        atomic: [{
            outcome: 'write',
            property: ['publication', ['RtcTopologyPublication']],
            seam: rtcSeam,
            calls: [
                exact('publications.insertWorkClaim',
                        ['receipt', 'publicationWrite.expireAtTimestamp'],
                        true,
                        ['publicationWrite', 'then'],
                    ),
                    exact(
                        'publications.insertPublication',
                        ['publicationWrite.publication', 'publicationWrite.expireAtTimestamp'],
                        true,
                        ['publicationWrite', 'then'],
                    ),
                ],
            },
        ],
        replay: [{
            outcome: 'loaded',
            property: ['publication', ['RtcTopologyPublication']],
            file: rtcWorkerFile,
            owner: rtcWorkerOwner,
            claim: 'read.publicationClaim',
            calls: [
                exact('options.publicationFanout.publish',
                    ['computed.publication'], true, [
                        'read.publicationClaim',
                        'then',
                    ]),
                    exact('options.topologyManagement.recordTopologyPublication', ['true'], false, [
                        'read.publicationClaim',
                        'then',
                    ]),
                ],
            },
        ],
    },
    {
        family: rttSeam.family,
        type: [
            'packages/shared-server/rallar-system/services/rtc-topology-mutations.ts',
            'RtcRttMutationComputed',
        ],
        noExternalEffectOutcomes: ['replay', 'rejected'],
        atomic: [{
            outcome: 'write',
            property: ['recomputeIntents', ['readonly RtcRttRecomputeIntent[]']],
            seam: rttSeam,
            calls: [exact('repository.insertRecomputeIntent',
                        ['intent', 'mutationExpireAtTimestamp'],
                        true,
                    ),
                ],
            },
        ],
    },
];
const pureMutationModules = [...new Set(effects.map(({ type }) => type[0]))];
const astFiles = [...new Set([
    ...paths.map(({ file }) => file),
    ...seams.map(({ file }) => file),
    ...pureMutationModules,
    ]),
];
const compiler = openCompiler(astFiles.map((file) => path.join(process.cwd(), file)));
const compilerSnapshot = compiler.snapshot;
afterAll(() => {
    compilerSnapshot.dispose();
    compiler.api.close();
});
describe('read/compute/validate/write implementation contract', () => {
    it('keeps client mutation in the structural seam, path, and effect inventories', () => {
        expect(seams.map(({ family }) => family)).toContain(clientSeam.family);
        expect(paths.map(({ family }) => family)).toContain(clientSeam.family);
        expect(effects.map(({ family }) => family)).toContain(clientSeam.family);
    });

    it('requires the exact received SQL transaction for all client write repositories', () => {
        const service = readRepo(clientFile);
        const repository = readRepo(clientRepositoryFile);
        expect(service).not.toContain('bindRuntimeStateTransaction');
        expect(repository).not.toContain('createEventStore?:');
        expect(repository).toContain('new PSqlRuntimeStateRepository(transaction)');
        expect(repository).toContain('new PSqlClientStateEventRepository(transaction)');
    });

    it('keeps persisted and non-persisted client no-op variants explicit', () => {
        const mutations = readRepo(clientMutationFile);
        expect(mutations).not.toContain('as ClientMutationComputed');
        expect(mutations).toContain('assertNeverClientMutationComputed');
    });

    it('keeps client outer retry and four self-retrying operation families inventoried', () => {
        expect(new Set(paths.map(({ family }) => family)).size).toBe(5);
        expect(paths.map(({ family, name, file, owner }) =>
            [family, name, file, owner])).toEqual([
            [
                clientSeam.family,
                'client AppInbox effectful path',
                appClientFile,
                ['method', 'processCommand'],
            ],
            [
                groupSeam.family,
                'group effectful path',
                groupFile,
                ['variable', 'executeReceiptWithRetry'],
            ],
            [
                configSeam.family,
                'topology config effectful path',
                configFile,
                ['method', 'executeTopologyConfigMutationWithRetry'],
            ],
            [
                rtcSeam.family,
                'RTC topology externally effectful worker path',
                rtcWorkerFile,
                rtcWorkerOwner,
            ],
            [
                rtcSeam.family,
                'RTC topology publication-null internal path',
                configFile,
                ['method', 'commitTopologyWithRetry'],
            ],
            [rttSeam.family, 'RTC RTT effectful path', rttFile, ['function', 'executeRttMutation']],
        ]);
        expect(effects[0]!.noExternalEffectVariants).toContainEqual({
            outcome: 'no-op',
            property: ['persistIdempotency', ['false']],
        });
        expect(effects[2]!.noExternalEffectOutcomes).toContain('claim');
    });
    it('keeps client phases visible while AppInbox owns transaction and retry', () => {
        const client = readFileSync(clientFile, 'utf8');
        const appClient = readFileSync(
            'packages/shared-server/rallar-system/services/AppClientInboxService.ts',
            'utf8',
        );
        expect(client).not.toContain('runtime.begin(');
        expect(client).not.toContain('sleep(');
        expect(client).toContain('write(\n        transaction: PSqlTransactionSql');
        expect(client).toContain('new ResourceInboxRepository(transaction)');
        expect(appClient).toContain('this.clientStateService.read(command)');
        expect(appClient).toContain('this.clientStateService.compute(command, read)');
        expect(appClient).toContain('this.clientStateService.validate(command, read, computed)');
        expect(appClient).toContain('this.writeMutation(context');
    });
    it('keeps every client write repository on the exact received transaction', () => {
        assertClientTransactionAffinity(repoSource(clientFile));
    });
    it.each([
        [
            'an omitted AppClient compute phase',
            `class Fixture {
                async processCommand(command: unknown) {
                    const read = await this.clientStateService.read(command);
                    const computed = read;
                    this.clientStateService.validate(command, read, computed);
                    return await this.commitComputed(command, computed);
                }
            }`,
            /compute/,
        ],
        [
            'a reordered AppClient validate phase',
            `class Fixture {
                async processCommand(command: unknown) {
                    const read = await this.clientStateService.read(command);
                    this.clientStateService.validate(command, read, computed);
                    const computed = this.clientStateService.compute(command, read);
                    return await this.commitComputed(command, computed);
                }
            }`,
            /effectful path|greater/,
        ],
    ])('rejects %s', (_name, fixture, error) => {
        withFixture(fixture, (source) => {
            expect(() => assertPath(source, {
                family: 'client fixture',
                name: 'client fixture effectful path',
                file: source.fileName,
                owner: ['method', 'processCommand'],
                retry: null,
                phases: [
                    exact('this.clientStateService.read', ['command'], true),
                    exact('this.clientStateService.compute', ['command', 'read'], false),
                    exact(
                        'this.clientStateService.validate',
                        ['command', 'read', 'computed'],
                        false,
                    ),
                    exact('this.commitComputed', ['command', 'computed'], true),
                ],
            })).toThrow(error);
        });
    });
    it('rejects a client service write that starts its own retry transaction', () => {
        withFixture(`async function writeClientMutation(transaction: unknown) {
            return await runtime.begin(async () => {
                await repository.insertPrincipal();
                await repository.appendEvent();
            });
        }`, (source) => {
            expect(() => assertSeam(source, seam(
                'client fixture', source.fileName, ['function', 'writeClientMutation'],
                ['insertPrincipal'], ['appendEvent'], [], 'received',
            ))).toThrow(/nested begin|begin/);
        });
    });
    it.each([
        [
            'a principal CAS after its dependent write',
            `async function writeClientMutation(transaction: unknown) {
                await repository.appendEvent();
                await repository.insertPrincipal();
            }`,
            /client fixture/,
        ],
        [
            'an unawaited principal CAS',
            `async function writeClientMutation(transaction: unknown) {
                repository.insertPrincipal();
                await repository.appendEvent();
            }`,
            /await/,
        ],
    ])('rejects %s', (_name, fixture, error) => {
        withFixture(fixture, (source) => {
            expect(() => assertSeam(source, seam(
                'client fixture', source.fileName, ['function', 'writeClientMutation'],
                ['insertPrincipal'], ['appendEvent'], [], 'received',
            ))).toThrow(error);
        });
    });
    it('rejects ResourceInbox construction from anything except the received transaction', () => {
        withFixture(`async function writeClientMutation(transaction: unknown) {
            await repository.insertPrincipal();
            const outbox = new ResourceInboxRepository(unrelatedTransaction);
            await outbox.writeIfAbsentOrMatch(entry);
        }`, (source) => {
            expect(() => assertClientTransactionAffinity(source)).toThrow(/ResourceInbox/);
        });
    });
    it('rejects an intermediate StateMutationOutbox result from client write', () => {
        withFixture(`async function writeClientMutation(transaction: unknown) {
            await repository.insertPrincipal();
            return new StateMutationOutboxWork(transaction);
        }`, (source) => {
            expect(() => assertClientTransactionAffinity(source))
                .toThrow(/StateMutationOutbox/);
        });
    });
    it.each(paths)(
        '$name keeps one syntax-aware branch-local read/compute/validate/write path',
        (contract) => assertPath(repoSource(contract.file), contract),
    );
    it.each(seams)(
        '$family lets only its write seam own begin and guards dependent writes',
        (contract) => assertSeam(repoSource(contract.file), contract),
    );
    it.each(effects)(
        '$family categorizes every discriminant and maps every external effect',
        (contract) => assertEffect(contract),
    );
    it('commits the publication-bearing RTC worker result before fanout', () => {
        assertRtcWorker(repoSource(rtcWorkerFile));
        const internal = findFunction(repoSource(paths[4]!.file), paths[4]!.owner);
        expect(ownedCalls(internal).filter(({ name }) => name === 'publish'))
            .toHaveLength(0);
    });
    it.each(pureMutationModules)('%s keeps compute and validate AST-pure', (file) => {
        assertPure(repoSource(file));
    });
    it('rejects phase names hidden in comments, strings, or nested callbacks', () => {
        withFixture(`async function executeMutation() {
            for (let attempt = 0; attempt < 3; attempt += 1) {
                readMutation(); const text = 'computeMutation()';
                const unrelated = () => computeMutation(); // validateMutation();
                writeMutation();
            }
        }`, (source) => {
            expect(() => assertPath(source, {
                family: 'fixture', name: 'nested fixture', file: source.fileName,
                owner: ['function', 'executeMutation'], retry: 'attempt < 3',
                phases: [
                    'readMutation', 'computeMutation',
                    'validateMutation', 'writeMutation',
                        ],
                    }),
                ).toThrow(/computeMutation|validateMutation/);
            },
        );
    });
    it('rejects a new unmapped externally effectful discriminant', () => {
        withFixture(`type FixtureComputed =
            | { outcome: 'write'; outbox: Outbox }
            | { outcome: 'publish-alert'; alert: Alert };
            async function writeFixture(computed: FixtureComputed) {
                return runtime.begin(async () => {
                    insertGuard(); await repository.insertOutbox(computed);
                });
            }`, (source) => {
            expect(() => assertEffect(fixtureEffect(source), source))
                .toThrow(/publish-alert/);
            },
        );
    });
    it('rejects an effectful discriminant whose atomic writer mapping is removed', () => {
        withFixture(`type FixtureComputed = { outcome: 'write'; outbox: Outbox };
            async function writeFixture() {
                return runtime.begin(async () => insertGuard());
            }`, (source) => {
            expect(() => assertEffect(fixtureEffect(source), source))
                .toThrow(/insertOutbox/);
            },
        );
    });
    it.each([
        ['a null publication on the external RTC path',
            'const computed = computeTopologyMutation({\n                    read,\n                    candidate: planned.snapshot,\n                    publication,\n                    facts,\n                });',
            'const computed = computeTopologyMutation({\n                    read,\n                    candidate: planned.snapshot,\n                    publication: null,\n                    facts,\n                });',
            /publication/,
        ],
        [
            'removed RTC claim-hit replay validation',
            'validateTopologyMutation({ ...replayInput, computed });',
            'void computed;',
            /validateTopologyMutation/,
        ],
        [
            'substituted RTC replay fanout data',
            'publish(computed.publication)',
            'publish(unrelatedPublication)',
            /computed\.publication/,
        ],
    ])('rejects %s', (_name, before, after, error) => {
        withFixture(replaceOnce(readRepo(rtcWorkerFile), before, after), (source) => {
            expect(() => assertRtcWorker(source)).toThrow(error);
        });
    });
    it('rejects a duplicate effectful discriminant without its outbox', () => {
        withFixture(`type FixtureComputed =
                | { outcome: 'write'; outbox: Outbox }
                | { outcome: 'write'; receipt: Receipt };
            async function writeFixture(computed: FixtureComputed) {
                return runtime.begin(async () => {
                    insertGuard(); await repository.insertOutbox(computed);
                });
            }`, (source) => {
            expect(() => assertEffect(fixtureEffect(source), source))
                .toThrow(/write|outbox/);
            },
        );
    });
    it.each([
        [
            'atomic writer receiver substitution',
            'await fake.insertOutbox(computed)',
            /repository\.insertOutbox/,
        ],
        ['an unawaited atomic writer call',
            'repository.insertOutbox(computed)', /await/],
    ])('rejects %s', (_name, write, error) => {
        withFixture(`type FixtureComputed = { outcome: 'write'; outbox: Outbox };
            async function writeFixture(computed: FixtureComputed) {
                return runtime.begin(async () => {
                    await repository.insertGuard(); ${write};
                });
            }`, (source) => {
            expect(() => assertEffect(fixtureEffect(source), source))
                .toThrow(error);
            },
        );
    });
    it('rejects an unawaited conditional guard', () => {
        withFixture(`async function writeFixture() {
            return runtime.begin(async () => repository.insertGuard());
        }`, (source) => {
            expect(() => assertSeam(source, seam(
                'fixture', source.fileName, ['function', 'writeFixture'],
                ['insertGuard'],
                            [],
                        ),
                    ),
                ).toThrow(/await/);
            },
        );
    });
    it('rejects removed conditional-guard conflict handling', () => {
        const mutated = replaceOnce(
            readRepo(rtcRepositoryFile),
            "if (guard.status === 'conflict') {",
            'if (false) {',
        );
        withFixture(mutated, (source) => {
            expect(() => assertSeam(source, rtcSeam)).toThrow(/guard|conflict/);
        });
    });
    it('rejects an RTC guard failure branch after its protected write', () => {
        const failure = "                if (guard.status === 'conflict') {\n                    throw new RuntimeStateWriteConflictError();\n                }\n";
        const marker =
            '                    if (!claimed) throw new RuntimeStateWriteConflictError();';
        const mutated = replaceOnce(
            replaceOnce(readRepo(rtcRepositoryFile), failure, ''),
            marker,
            `${failure}${marker}`,
        );
        withFixture(mutated, (source) => {
            expect(() => assertSeam(source, rtcSeam)).toThrow(/insertWorkClaim|protected/);
        });
    });
    it('rejects ambient crypto randomUUID in a pure module', () => {
        withFixture('export const compute = () => crypto.randomUUID();', (source) => {
            expect(() => assertPure(source)).toThrow(/randomUUID/);
        });
    });
    it('keeps the architecture inventory synchronized with all guarded paths', () => {
        const architecture = readRepo('packages/shared-server/architecture.md');
        for (const contract of paths.filter(({ family }) => family !== clientSeam.family)) {
            for (const phase of contract.phases) {
                const name = readCallSpec(phase).name;
                expect(architecture, `${contract.name}: ${name}`)
                    .toContain(`\`${name}\``);
            }
        }
        expect(architecture).toContain('createRtcTopologyWorkHandler');
        expect(architecture).toContain('commitTopologyWithRetry');
        expect(architecture).toContain('may persist compact authority receipts');
        expect(architecture).toContain('no external fanout or outbox is required');
    });
});
function seam(family: string, file: string, owner: Selector,
    guards: readonly string[], dependent: readonly string[],
    guardChecks: readonly GuardCheck[] = [],
    transaction: SeamContract['transaction'] = 'owned',
): SeamContract {
    return { family, file, owner, guards, dependent, guardChecks, transaction }; }
function under(name: string, condition: string,
    side: 'then' | 'else'): CallSpec {
    return [name, [condition, side]]; }
function exact(callee: string, arguments_: readonly string[] | undefined,
    awaited: boolean,
    branch?: Branch,
): CallExpectation {
    return { name: callee.slice(callee.lastIndexOf('.') + 1),
        callee: normalize(callee), arguments: arguments_?.map(normalize),
        awaited,
        branch,
    };
}
function wrapped(callee: string, branch?: Branch): GuardCheck {
    return { call: exact(callee, undefined, true, branch), wrapper: 'requireConditionalWrite' };
}
function checked(callee: string, binding: string, condition: string,
    branch?: Branch, terminal: GuardCheck['terminal'] = 'throw',
    protects?: CallExpectation,
): GuardCheck {
    return { call: exact(callee, undefined, true, branch), binding, condition,
        terminal, protects };
}
function fixtureEffect(source: ts.SourceFile): EffectContract {
    return {
        family: 'fixture', type: [source.fileName, 'FixtureComputed'],
        noExternalEffectOutcomes: [],
        atomic: [{
            outcome: 'write', property: ['outbox', ['Outbox']],
            seam: seam('fixture', source.fileName, ['function', 'writeFixture'],
                ['insertGuard'],
                    [],
                ),
                calls: [exact('repository.insertOutbox', ['computed'], true)],
            },
        ],
    };
}
function assertPath(source: ts.SourceFile, contract: PathContract): void {
    const owner = findFunction(source, contract.owner);
    const calls = contract.phases.map((phase) => findCall(source, owner, phase));
    if (contract.retry !== null) {
        const loops = calls.map((call) => nearestLoop(call, owner));
        for (const loop of loops) {
            expect(normalize(loop.condition?.getText(source) ?? ''), contract.name)
                .toBe(contract.retry);
        }
        expect(new Set(loops.map(({ pos, end }) => `${pos}:${end}`)).size).toBe(1);
    } else {
        for (const call of calls) {
            expect(() => nearestLoop(call, owner), contract.name).toThrow(/Missing retry loop/);
        }
    }
    for (let index = 1; index < calls.length; index += 1) {
        expect(calls[index]!.pos, contract.name).toBeGreaterThan(calls[index - 1]!.pos);
    }
}
function assertRtcWorker(source: ts.SourceFile): void {
    const external = paths[3]!;
    assertPath(source, external);
    const owner = findFunction(source, external.owner);
    const publication = findCall(source, owner, 'toTopologyPublication');
    const compute = findCall(source, owner, external.phases[1]);
    const write = findCall(source, owner, external.phases[3]);
    const conflict = findIf(owner, "written === 'conflict'");
    const fanout = findCall(source, owner, exact(
        'options.publicationFanout.publish', ['publication!'], true),
    );
    const recorded = findCall(source, owner, exact(
        'options.topologyManagement.recordTopologyPublication', ['true'], false),
    );
    expect(publication.pos).toBeLessThan(compute.pos);
    expect(compute.pos).toBeLessThan(write.pos);
    expect(write.pos).toBeLessThan(conflict.pos);
    expect(hasKind(conflict.thenStatement, ts.SyntaxKind.ContinueStatement))
        .toBe(true);
    expect(conflict.end).toBeLessThan(fanout.pos);
    expect(fanout.pos).toBeLessThan(recorded.pos);
    const replayBranch = ['read.publicationClaim', 'then'] as const;
    const replayCompute = findCall(source, owner, exact(
        'computeTopologyMutation', ['replayInput'], false, replayBranch),
    );
    const replayValidate = findCall(source, owner, exact(
        'validateTopologyMutation', ['{ ...replayInput, computed }'], false, replayBranch),
    );
    const loaded = findIf(owner, "computed.outcome !== 'loaded'");
    const replayFanout = findCall(source, owner, exact(
        'options.publicationFanout.publish', ['computed.publication'], true, replayBranch),
    );
    const replayRecorded = findCall(source, owner, exact(
        'options.topologyManagement.recordTopologyPublication', ['true'], false,
            replayBranch,
        ),
    );
    expect(replayCompute.pos).toBeLessThan(replayValidate.pos);
    expect(replayValidate.pos).toBeLessThan(loaded.pos);
    expect(hasKind(loaded.thenStatement, ts.SyntaxKind.ThrowStatement)).toBe(true);
    expect(loaded.end).toBeLessThan(replayFanout.pos);
    expect(replayFanout.pos).toBeLessThan(replayRecorded.pos);
}
function assertSeam(source: ts.SourceFile, contract: SeamContract): void {
    const owner = findFunction(source, contract.owner);
    const ownedBegin = ownedCalls(owner).filter(({ name }) => name === 'begin');
    const transaction = contract.transaction === 'owned'
        ? requireOwnedTransaction(source, contract, owner, ownedBegin)
        : requireReceivedTransaction(source, contract, owner, ownedBegin);
    const calls = ownedCalls(transaction).filter(({ node }) =>
        !readBranches(node, transaction, source).flat().includes(guardedCapability),
    );
    const guards = requireCalls(calls, contract.guards, `${contract.family}: guard`);
    const dependent = requireCalls(
        calls, contract.dependent, `${contract.family}: dependent`);
    if (dependent.length > 0) {
        expect(Math.max(...guards.map(({ node }) => node.pos)), contract.family)
            .toBeLessThan(Math.min(...dependent.map(({ node }) => node.pos)),
        );
    }
    for (const guard of guards) {
        expect(isAwaited(guard.node), `${contract.family}:${guard.name}: await`)
            .toBe(true);
    }
    for (const check of contract.guardChecks) {
        assertGuardCheck(source, transaction, check);
    }
}

function assertClientTransactionAffinity(source: ts.SourceFile): void {
    const writer = findFunction(source, ['function', 'writeClientMutation']);
    const resourceInboxes: ts.NewExpression[] = [];
    const intermediateOutboxes: ts.NewExpression[] = [];
    walkOwned(writer, (node) => {
        if (!ts.isNewExpression(node)) return;
        const constructor = normalize(node.expression.getText(source));
        if (constructor === 'ResourceInboxRepository') resourceInboxes.push(node);
        if (constructor === 'StateMutationOutboxWork') intermediateOutboxes.push(node);
    });
    expect(intermediateOutboxes, 'StateMutationOutbox intermediate result')
        .toHaveLength(0);
    expect(resourceInboxes, 'ResourceInbox must be constructed once by client write')
        .toHaveLength(1);
    expect(
        resourceInboxes[0]!.arguments?.map((argument) =>
            normalize(argument.getText(source))) ?? [],
        'ResourceInbox must use the received transaction',
    ).toEqual(['transaction']);
}

function requireOwnedTransaction(
    source: ts.SourceFile,
    contract: SeamContract,
    owner: ts.FunctionLikeDeclaration,
    begin: readonly NamedCall[],
): ts.FunctionLikeDeclaration {
    expect(begin, `${contract.family}: owned begin`).toHaveLength(1);
    expect(allCalls(source).filter(({ name }) => name === 'begin'), contract.family)
        .toHaveLength(1);
    return callCallback(begin[0]!.node, source);
}

function requireReceivedTransaction(
    source: ts.SourceFile,
    contract: SeamContract,
    owner: ts.FunctionLikeDeclaration,
    begin: readonly NamedCall[],
): ts.FunctionLikeDeclaration {
    expect(begin, `${contract.family}: no nested begin`).toHaveLength(0);
    expect(allCalls(source).filter(({ name }) => name === 'begin'), contract.family)
        .toHaveLength(0);
    expect(owner.parameters.map((parameter) => normalize(parameter.name.getText(source))))
        .toContain('transaction');
    return owner;
}
function assertGuardCheck(source: ts.SourceFile,
    transaction: ts.FunctionLikeDeclaration,
    check: GuardCheck,
): void {
    const call = findCall(source, transaction, check.call);
    if (check.wrapper) {
        expect(hasAncestorCall(call, transaction, check.wrapper), check.wrapper).toBe(true);
        return;
    }
    expect(findAncestorVariable(call, transaction), check.call.callee)
        .toBe(check.binding);
    const failure = findIf(transaction, check.condition!);
    expect(call.pos, check.condition).toBeLessThan(failure.pos);
    const throws = hasKind(failure.thenStatement, ts.SyntaxKind.ThrowStatement);
    const returns = hasKind(failure.thenStatement, ts.SyntaxKind.ReturnStatement);
    expect(throws || (check.terminal === 'throw-or-return' && returns), check.condition)
        .toBe(true);
    if (check.protects) expect(failure.end, `${check.protects.callee}: protected`)
        .toBeLessThan(findCall(source, transaction, check.protects).pos,
        );
}
function assertEffect(contract: EffectContract, provided?: ts.SourceFile): void {
    const typeSource = provided ?? repoSource(contract.type[0]);
    const alias = findType(typeSource, contract.type[1]);
    const remaining = [...readVariants(alias, typeSource)];
    for (const outcome of contract.noExternalEffectOutcomes) {
        consumeVariant(remaining, { outcome }, contract.family);
    }
    for (const mapping of contract.noExternalEffectVariants ?? []) {
        consumeVariant(remaining, mapping, contract.family);
    }
    for (const mapping of contract.atomic) {
        consumeVariant(remaining, mapping, contract.family);
        const writerSource = provided ?? repoSource(mapping.seam.file);
        const writer = findFunction(writerSource, mapping.seam.owner);
        const begin = ownedCalls(writer).filter(({ name }) => name === 'begin');
        const transaction = mapping.seam.transaction === 'owned'
            ? requireOwnedTransaction(writerSource, mapping.seam, writer, begin)
            : requireReceivedTransaction(writerSource, mapping.seam, writer, begin);
        for (const call of mapping.calls) findCall(writerSource, transaction, call);
    }
    for (const mapping of contract.replay ?? []) {
        consumeVariant(remaining, mapping, contract.family);
        const source = provided ?? repoSource(mapping.file);
        const owner = findFunction(source, mapping.owner);
        findIf(owner, mapping.claim);
        for (const call of mapping.calls) findCall(source, owner, call);
    }
    expect(remaining, `${contract.family}: unmapped alternatives`).toEqual([]);
}
function assertPure(source: ts.SourceFile): void {
    const forbidden: string[] = [];
    walk(source, (node) => {
        if (ts.isAwaitExpression(node)) forbidden.push('await');
        if (isFunction(node) && node.modifiers?.some(({ kind }) =>
            kind === ts.SyntaxKind.AsyncKeyword)) forbidden.push('async');
        if (ts.isCallExpression(node)) {
            const expression = normalize(node.expression.getText(source));
            if (
                expression === 'Date.now' || expression.startsWith('Temporal.Now.') ||
                expression === 'Math.random' || expression === 'randomUUID' ||
                expression.endsWith('.randomUUID') ||
                expression.endsWith('.begin') || expression.startsWith('performance.') ||
                /^(?:repository|runtimeRepository)\./.test(expression)
            ) forbidden.push(expression);
        }
        if (
            ts.isPropertyAccessExpression(node) &&
            /^(?:process|Deno|Bun)\.env(?:\.|$)/.test(normalize(node.getText(source)))
        ) forbidden.push(normalize(node.getText(source)));
        return true;
    });
    expect(forbidden, source.fileName).toEqual([]);
}
type NamedCall = Readonly<{ name: string; node: ts.CallExpression }>;
function findCall(source: ts.SourceFile, owner: ts.FunctionLikeDeclaration,
    spec: CallSpec,
): ts.CallExpression {
    const expected = readCallSpec(spec);
    const matches = ownedCalls(owner).filter(({ name, node }) =>
        name === expected.name &&
        sameBranches(readBranches(node, owner, source), expected.branch) &&
        (!expected.callee ||
            normalize(node.expression.getText(source)) === expected.callee) &&
        (!expected.arguments || JSON.stringify(node.arguments.map((argument) =>
            normalize(argument.getText(source))),
                ) === JSON.stringify(expected.arguments)) &&
        (expected.awaited === undefined || isAwaited(node) === expected.awaited),
    );
    const label = `${expected.callee ?? expected.name} ${JSON.stringify(
        expected.arguments ?? [])}`;
    expect(matches, `${label} arguments/await in ${owner.getText(source).slice(0, 80)}`,
    ).toHaveLength(1);
    return matches[0]!.node;
}
function readCallSpec(spec: CallSpec): ExpectedCall {
    if (typeof spec === 'string') return { name: spec };
    if (Array.isArray(spec)) return { name: spec[0], branch: spec[1] };
    return spec as CallExpectation;
}
function isAwaited(node: ts.CallExpression): boolean { return ts.isAwaitExpression(node.parent); }
function hasAncestorCall(node: ts.Node, owner: ts.FunctionLikeDeclaration,
    callee: string,
): boolean {
    let current = node.parent;
    while (current && current !== owner) {
        if (ts.isCallExpression(current) && callName(current) === callee) return true;
        current = current.parent;
    }
    return false;
}
function findAncestorVariable(node: ts.Node,
    owner: ts.FunctionLikeDeclaration,
): string | undefined {
    let current = node.parent;
    while (current && current !== owner) {
        if (ts.isVariableDeclaration(current)) return normalize(current.name.getText());
        current = current.parent;
    }
    return undefined;
}
function readBranches(node: ts.Node, owner: ts.FunctionLikeDeclaration,
    source: ts.SourceFile,
): readonly Branch[] {
    const result: Branch[] = [];
    let current: ts.Node = node;
    while (current !== owner && current.parent) {
        const parent = current.parent;
        if (ts.isIfStatement(parent)) {
            result.push([
                normalize(parent.expression.getText(source)),
                within(node, parent.thenStatement) ? 'then' : 'else',
            ]);
        }
        current = parent;
    }
    return result.reverse();
}
function sameBranches(actual: readonly Branch[], expected?: Branch): boolean { return JSON.stringify(actual) === JSON.stringify(expected ? [expected] : []); }
function nearestLoop(node: ts.Node,
    owner: ts.FunctionLikeDeclaration): ts.ForStatement {
    let current: ts.Node | undefined = node.parent;
    while (current && current !== owner) {
        if (ts.isForStatement(current)) return current;
        current = current.parent;
    }
    throw new Error(`Missing retry loop for ${node.getText()}`);
}
function findIf(owner: ts.FunctionLikeDeclaration, condition: string): ts.IfStatement {
    const matches: ts.IfStatement[] = [];
    walkOwned(owner, (node) => {
        if (ts.isIfStatement(node) && normalize(node.expression.getText()) === condition) {
            matches.push(node);
        }
    });
    expect(matches, condition).toHaveLength(1);
    return matches[0]!;
}
function findFunction(source: ts.SourceFile, selector: Selector): ts.FunctionLikeDeclaration {
    if (selector[0] === 'callback') {
        const owner = findFunction(source, [selector[1], selector[2]]);
        const matches: ts.FunctionLikeDeclaration[] = [];
        walkOwned(owner, (node) => {
            if (
                ts.isPropertyAssignment(node) &&
                normalize(node.name.getText(source)) === selector[3] &&
                isFunction(node.initializer)
            ) matches.push(node.initializer);
        });
        expect(matches, `${selector[2]}.${selector[3]}`).toHaveLength(1);
        return matches[0]!;
    }
    const matches: ts.FunctionLikeDeclaration[] = [];
    walk(source, (node) => {
        if (
            selector[0] === 'function' && ts.isFunctionDeclaration(node) &&
            node.name?.text === selector[1]
        ) matches.push(node);
        if (
            selector[0] === 'method' && ts.isMethodDeclaration(node) &&
            normalize(node.name.getText(source)) === selector[1]
        ) matches.push(node);
        if (
            selector[0] === 'variable' && ts.isVariableDeclaration(node) &&
            normalize(node.name.getText(source)) === selector[1] &&
            node.initializer && isFunction(node.initializer)
        ) matches.push(node.initializer);
        return true;
    });
    expect(matches, `${selector[0]}:${selector[1]}`).toHaveLength(1);
    return matches[0]!;
}
function findType(source: ts.SourceFile, name: string): ts.TypeAliasDeclaration {
    const matches: ts.TypeAliasDeclaration[] = [];
    walk(source, (node) => {
        if (ts.isTypeAliasDeclaration(node) && node.name.text === name) {
            matches.push(node);
        }
        return true;
    });
    expect(matches, name).toHaveLength(1);
    return matches[0]!;
}
type ActualVariant = Readonly<{
    outcome: string;
    properties: ReadonlyMap<string, readonly string[]>;
}>;
function readVariants(alias: ts.TypeAliasDeclaration,
    source: ts.SourceFile,
): readonly ActualVariant[] {
    return expandTypeAlternatives(alias.type, source).flatMap((members) => {
        const properties = new Map<string, string[]>();
        for (const member of members) {
            if (!isProperty(member) || !member.type) continue;
            const name = normalize(member.name.getText(source));
            const values = properties.get(name) ?? [];
            values.push(normalize(member.type.getText(source)));
            properties.set(name, values);
        }
        const outcome = members.find((member) =>
            isProperty(member) && normalize(member.name.getText(source)) === 'outcome',
        );
        expect(outcome && isProperty(outcome) && outcome.type, alias.name.text)
            .toBeDefined();
        return readLiterals((outcome as ts.PropertySignatureDeclaration).type!).map((value) => ({
            outcome: value,
            properties,
        }));
    });
}
function expandTypeAlternatives(node: ts.TypeNode,
    source: ts.SourceFile,
): readonly (readonly ts.TypeElement[])[] {
    if (node.kind === ts.SyntaxKind.ParenthesizedType) {
        return expandTypeAlternatives((node as ts.ParenthesizedTypeNode).type, source);
    }
    if (node.kind === ts.SyntaxKind.TypeReference) {
        const reference = node as ts.TypeReferenceNode;
        if (
            normalize(reference.typeName.getText(source)) === 'Readonly' &&
            reference.typeArguments?.length === 1
        ) return expandTypeAlternatives(reference.typeArguments[0]!, source);
        const referencedName = normalize(reference.typeName.getText(source));
        const declaration = source.statements.find((statement) =>
            ts.isTypeAliasDeclaration(statement) && statement.name.text === referencedName
        );
        if (declaration && ts.isTypeAliasDeclaration(declaration)) {
            return expandTypeAlternatives(declaration.type, source);
        }
    }
    if (ts.isUnionTypeNode(node)) {
        return node.types.flatMap((type) => expandTypeAlternatives(type, source));
    }
    if (node.kind === ts.SyntaxKind.IntersectionType) {
        return (node as ts.IntersectionTypeNode).types.reduce<
            readonly (readonly ts.TypeElement[])[]
        >((left, type) => left.flatMap((members) =>
            expandTypeAlternatives(type, source).map((right) => [
                ...members, ...right]),
                ),
            [[]],
        );
    }
    if (ts.isTypeLiteralNode(node)) return [node.members];
    throw new Error(`Unsupported computed variant type: ${node.getText(source)}`);
}
function consumeVariant(remaining: ActualVariant[],
    descriptor: VariantDescriptor,
    family: string,
): void {
    const matches = remaining.flatMap((variant, index) => {
        if (variant.outcome !== descriptor.outcome) return [];
        if (!descriptor.property) return [index];
        const [name, types] = descriptor.property;
        return JSON.stringify([...(variant.properties.get(name) ?? [])].sort()) ===
                JSON.stringify([...types].sort())
            ? [index]
            : [];
    });
    expect(matches, `${family}:${descriptor.outcome}:${descriptor.property?.[0] ?? ''}`,
    ).toHaveLength(1);
    remaining.splice(matches[0]!, 1);
}
function readLiterals(node: ts.Node): string[] {
    const values: string[] = [];
    walk(node, (candidate) => {
        if (
            ts.isLiteralTypeNode(candidate) && ts.isStringLiteral(candidate.literal)
        ) values.push(candidate.literal.text);
        return true;
    });
    return values;
}
function ownedCalls(owner: ts.FunctionLikeDeclaration): readonly NamedCall[] {
    const calls: NamedCall[] = [];
    walkOwned(owner, (node) => {
        if (ts.isCallExpression(node)) calls.push({ name: callName(node), node });
    });
    return calls.sort((left, right) => left.node.pos - right.node.pos);
}
function allCalls(source: ts.SourceFile): readonly NamedCall[] {
    const calls: NamedCall[] = [];
    walk(source, (node) => {
        if (ts.isCallExpression(node)) calls.push({ name: callName(node), node }); return true;
    });
    return calls; }
function requireCalls(calls: readonly NamedCall[], names: readonly string[],
    label: string,
): readonly NamedCall[] {
    return names.flatMap((name) => {
        const matches = calls.filter((call) => call.name === name);
        expect(matches.length, `${label}:${name}`).toBeGreaterThan(0);
        return matches;
    });
}
function callName(call: ts.CallExpression): string {
    if (ts.isIdentifier(call.expression)) return call.expression.text;
    if (ts.isPropertyAccessExpression(call.expression)) return call.expression.name.text;
    return normalize(call.expression.getText()); }
function callCallback(call: ts.CallExpression,
    source: ts.SourceFile): ts.FunctionLikeDeclaration {
    const callback = call.arguments[0];
    expect(callback && isFunction(callback), callback?.getText(source)).toBe(true);
    return callback as ts.FunctionLikeDeclaration;
}
function walkOwned(owner: ts.FunctionLikeDeclaration,
    visit: (node: ts.Node) => void): void {
    walk(owner.body ?? owner, (node) => {
        if (node !== owner.body && isFunction(node)) return false;
        visit(node);
        return true;
    });
}
function walk(node: ts.Node, visit: (node: ts.Node) => boolean): void {
    if (!visit(node)) return;
    node.forEachChild((child) => {
        walk(child, visit); return undefined;
    });
}
function isFunction(node: ts.Node): node is ts.FunctionLikeDeclaration {
    return (
        ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) ||
        ts.isFunctionExpression(node) || ts.isArrowFunction(node) ||
        ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node) ||
        ts.isConstructorDeclaration(node)
    );
}
function isProperty(node: ts.Node): node is ts.PropertySignatureDeclaration {
    return ts.isPropertySignatureDeclaration(node);
}
function within(node: ts.Node, container: ts.Node): boolean { return node.pos >= container.pos && node.end <= container.end; }
function hasKind(node: ts.Node, kind: ts.SyntaxKind): boolean {
    let found = false;
    walk(node, (candidate) => {
        if (candidate.kind === kind) found = true;
        return !found;
    });
    return found;
}
function normalize(value: string): string { return value.replace(/\s+/g, ' ').replace(/\s*\.\s*/g, '.').trim(); }
function repoSource(file: string): ts.SourceFile {
    const absolute = path.join(process.cwd(), file);
    const source = compilerSnapshot.getDefaultProjectForFile(absolute)?.program
        .getSourceFile(absolute);
    expect(source, file).toBeDefined();
    return source!;
}
function withFixture(source: string, run: (source: ts.SourceFile) => void): void {
    const directory = mkdtempSync(path.join(tmpdir(), 'rallar-write-contract-'));
    const file = path.join(directory, 'fixture.ts');
    let compiler: ReturnType<typeof openCompiler> | undefined;
    try {
        writeFileSync(file, source);
        compiler = openCompiler([file]);
        const parsed = compiler.snapshot.getDefaultProjectForFile(file)?.program
            .getSourceFile(file);
        expect(parsed, file).toBeDefined();
        run(parsed!);
    } finally {
        compiler?.snapshot.dispose();
        compiler?.api.close();
        rmSync(directory, { recursive: true, force: true });
    }
}
function openCompiler(openFiles: readonly string[]) {
    const api = new API();
    try {
        return { api, snapshot: api.updateSnapshot({ openFiles: [...openFiles] }) };
    } catch (error) {
        api.close();
        throw error;
    }
}
function readRepo(file: string): string { return readFileSync(path.join(process.cwd(), file), 'utf8'); }
function replaceOnce(source: string, before: string, after: string): string { expect(source.split(before), before).toHaveLength(2); return source.replace(before, after); }
