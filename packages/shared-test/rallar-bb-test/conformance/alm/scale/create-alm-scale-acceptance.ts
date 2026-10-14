import type { RallarBlackBoxDistributedGroupAssertion } from '../../../distributed/group-assertions.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestParallelCommand,
    RallarBlackBoxTestRecord
} from '../../../rallar-black-box-test-contracts.ts';

interface AlmScaleAcceptanceFact {
    readonly path: string;
    readonly operator: 'lt' | 'lte' | 'equals';
    readonly expected: number | boolean | string;
}

const BUDGET_FACTS: readonly AlmScaleAcceptanceFact[] = [
    { path: 'rallar.alm.own.admissions', operator: 'lte', expected: 1_000 },
    { path: 'rallar.alm.own.bytes', operator: 'lte', expected: 4_194_304 },
    { path: 'rallar.alm.usage.oldestAgeMs', operator: 'lte', expected: 300_000 },
    { path: 'rallar.alm.usage.tracks', operator: 'lte', expected: 64 },
    { path: 'rallar.alm.orderingTracks', operator: 'lte', expected: 512 },
    { path: 'rallar.alm.overloaded', operator: 'equals', expected: false },
    { path: 'rallar.congestion.dropped', operator: 'equals', expected: 0 },
    { path: 'rallar.alm.limits.maxAdmissions', operator: 'equals', expected: 1_000 },
    { path: 'rallar.alm.limits.maxBytes', operator: 'equals', expected: 4_194_304 },
    { path: 'rallar.alm.limits.maxAgeMs', operator: 'equals', expected: 300_000 },
    { path: 'rallar.alm.limits.maxTracks', operator: 'equals', expected: 64 }
];

export function createAlmScaleSampler(prefix: string): RallarBlackBoxTestParallelCommand {
    return {
        kind: 'parallel',
        commandId: `${prefix}-sampler`,
        maxConcurrency: 7,
        groups: Array.from({ length: 7 }, (_, index) => {
            const slot = index + 1;
            const statsId = `${prefix}-sample-${slot}-stats`;
            const statsResultId = `${prefix}-traffic:g2:sampling:c1:${prefix}-sampler:g${slot}:sample-${slot}:c${
                slot === 1 ? 1 : 2
            }:${statsId}`;
            return {
                groupId: `sample-${slot}`,
                commands: [
                    ...(slot === 1 ? [] : [{
                        kind: 'wait' as const,
                        commandId: `${prefix}-sample-${slot}-offset`,
                        match: { kind: 'diagnostic' as const, topic: 'rallar.black-box.alm.scale.sample-offset' },
                        absent: true as const,
                        timeoutMs: index * 5_000
                    }]),
                    { kind: 'stats' as const, commandId: statsId },
                    ...BUDGET_FACTS.map((fact, budgetIndex): RallarBlackBoxTestCommand => ({
                        kind: 'assert',
                        commandId: `${prefix}-sample-${slot}-budget-${budgetIndex + 1}`,
                        source: `resultCache.${statsResultId}.value.${fact.path}`,
                        operator: fact.operator,
                        expected: fact.expected
                    }))
                ]
            };
        })
    };
}

export function createAlmScaleFinalCommands(prefix: string): readonly RallarBlackBoxTestCommand[] {
    return [
        { kind: 'stats', commandId: `${prefix}-final-stats` },
        ...BUDGET_FACTS.map((fact, index): RallarBlackBoxTestCommand => ({
            kind: 'assert',
            commandId: `${prefix}-final-budget-${index + 1}`,
            source: `resultCache.${prefix}-final-stats.value.${fact.path}`,
            operator: fact.operator,
            expected: fact.expected
        })),
        { kind: 'storage.counters', commandId: `${prefix}-storage`, reset: false },
        {
            kind: 'assert',
            commandId: `${prefix}-assert-admission-storage`,
            source: `resultCache.${prefix}-storage.value.byOwner.al-admission`,
            operator: 'equals',
            expected: 0
        },
        {
            kind: 'assert',
            commandId: `${prefix}-assert-work-storage`,
            source: `resultCache.${prefix}-storage.value.workNonProbeCount`,
            operator: 'equals',
            expected: 0
        }
    ];
}

export function createAlmScaleGroupAssertions(playerCount: number): readonly RallarBlackBoxDistributedGroupAssertion[] {
    return (['director', 'player'] as const).flatMap((role) => {
        const prefix = `alm-scale-${role}`;
        const sampler = [['groupCount', 7], ['maxConcurrency', 7], ['passed', 90], ['failed', 0], [
            'cancelled',
            false
        ]] as const;
        const assertions = sampler.map(([path, expected]) =>
            createGroupAssertion(role, `${prefix}-sampler`, { path, operator: 'equals', expected })
        );
        const sampledBudgets = Array.from(
            { length: 7 },
            (_, index) =>
                BUDGET_FACTS.map((fact) =>
                    createGroupAssertion(role, `${prefix}-sampler`, {
                        path: `groups.${index}.results.${index === 0 ? 0 : 1}.result.value.${fact.path}`,
                        operator: fact.operator,
                        expected: fact.expected
                    })
                )
        ).flat();
        return [
            ...assertions,
            ...sampledBudgets,
            ...createWorkloadGroupAssertions(role, playerCount),
            ...BUDGET_FACTS.map((fact) => createGroupAssertion(role, `${prefix}-final-stats`, fact)),
            createGroupAssertion(role, `${prefix}-storage`, {
                path: 'byOwner.al-admission',
                operator: 'equals',
                expected: 0
            }),
            createGroupAssertion(role, `${prefix}-storage`, {
                path: 'workNonProbeCount',
                operator: 'equals',
                expected: 0
            }),
            createGroupAssertion(role, `${prefix}-received`, {
                path: 'observed',
                operator: 'equals',
                expected: role === 'director' ? playerCount * 6 : 2
            }),
            ...(role === 'director'
                ? createDirectorLifecycleGroupAssertions(playerCount)
                : ([['iterations', 6], ['pacing.completedIterations', 6], ['failed', 0], ['cancelled', false]] as const)
                    .map(([path, expected]) =>
                        createGroupAssertion(role, `${prefix}-shots`, { path, operator: 'equals', expected })
                    ))
        ];
    });
}

function createDirectorLifecycleGroupAssertions(
    playerCount: number
): readonly RallarBlackBoxDistributedGroupAssertion[] {
    const prefix = 'alm-scale-director';
    return [
        ...['start', 'end'].flatMap((event) => createReceiptGroupAssertions(`${prefix}-${event}-receipt`, playerCount)),
        ...(['start', 'end'] as const).flatMap((event) =>
            (['expectedRecipientPeerIds', 'confirmedRecipientPeerIds'] as const).map((field) => ({
                groupAssertionId: `${prefix}-${event}-receipt-${field}-frozen-player-sessions`,
                aggregate: 'sameUniqueStringSetAsRole' as const,
                scope: { role: 'sender' },
                source: {
                    recipeId: 'alm-scale-director',
                    commandId: `${prefix}-${event}-receipt`,
                    path: field
                },
                comparison: {
                    role: 'receiver',
                    source: {
                        recipeId: 'alm-scale-player',
                        commandId: 'alm-scale-player-connect',
                        path: 'sessionId'
                    }
                }
            }))
        )
    ];
}

function createWorkloadGroupAssertions(
    role: 'director' | 'player',
    playerCount: number
): readonly RallarBlackBoxDistributedGroupAssertion[] {
    const prefix = `alm-scale-${role}`;
    const window = [
        ['groupCount', 1],
        ['groups.0.commandCount', role === 'director' ? 23 : 8],
        ['passed', role === 'director' ? 23 : 8],
        ['failed', 0],
        ['cancelled', false]
    ] as const;
    return [
        ...window.map(([path, expected]) =>
            createGroupAssertion(role, `${prefix}-window`, { path, operator: 'equals', expected })
        ),
        createGroupAssertion(role, `${prefix}-window`, {
            path: 'groups.0.durationMs',
            operator: 'lt',
            expected: 30_000
        }),
        ...(role === 'director'
            ? ([['iterations', 6], ['pacing.completedIterations', 6], ['passed', playerCount * 6 * 3], ['failed', 0], [
                'cancelled',
                false
            ]] as const)
                .map(([path, expected]) =>
                    createGroupAssertion(role, `${prefix}-shot-arrivals`, { path, operator: 'equals', expected })
                )
            : ['started', 'ended'].flatMap((kind) => [
                createGroupAssertion(role, `${prefix}-${kind}-arrival`, {
                    path: 'matched',
                    operator: 'equals',
                    expected: true
                }),
                createGroupAssertion(role, `${prefix}-${kind}-arrival`, {
                    path: 'event.payload.data.typeId',
                    operator: 'equals',
                    expected: 'room.ar-eye-hunter.director.event.v1'
                })
            ]))
    ];
}

export function createAlmScaleAcceptanceMetadata(): RallarBlackBoxTestRecord {
    return {
        budgets: Object.fromEntries(BUDGET_FACTS.map((fact) => [fact.path, fact.expected])),
        samplingScope:
            'Seven page ledger and congestion reads initiated at nominal 0/5/10/15/20/25/30 seconds; completion may follow initiation, and observed bounds are not continuous peaks.',
        storageResetScope:
            'AL IndexedDB counters reset after group, membership, connection, audience and director setup; shared barrier precedes traffic.',
        storageBudgets: { 'byOwner.al-admission': 0, workNonProbeCount: 0 },
        excludedStorage: { metric: 'workProbeCount', kinds: ['work-page', 'work-probe'], recorded: true },
        receiptPolicy: {
            reliability: 'at-least-once',
            durability: 'volatile',
            carrier: 'rtc-with-ws-fallback',
            ttlMs: 30_000,
            shotAck: 'group-leader',
            matchAck: 'all-logical-recipients',
            purposeScope: 'Effective explicit policy; harness purpose defaults are not asserted.'
        }
    };
}

function createGroupAssertion(
    role: 'director' | 'player',
    commandId: string,
    fact: AlmScaleAcceptanceFact
): RallarBlackBoxDistributedGroupAssertion {
    return {
        groupAssertionId: `${commandId}-${fact.path.replaceAll('.', '-')}`,
        aggregate: 'allMatch',
        scope: { role: role === 'director' ? 'sender' : 'receiver' },
        source: { recipeId: `alm-scale-${role}`, commandId, path: fact.path },
        predicate: { operator: fact.operator, expected: fact.expected }
    };
}

function createReceiptGroupAssertions(
    commandId: string,
    playerCount: number
): readonly RallarBlackBoxDistributedGroupAssertion[] {
    const facts = [
        ['state', 'acknowledged'],
        ['receiptMode', 'receiver'],
        ['expectedRecipientPeerIds.length', playerCount],
        ['confirmedRecipientPeerIds.length', playerCount],
        ['unconfirmedRecipientPeerIds.length', 0]
    ] as const;
    return facts.map(([path, expected]) => ({
        groupAssertionId: `${commandId}-${path.replaceAll('.', '-')}`,
        aggregate: 'allMatch',
        scope: { role: 'sender' },
        source: { recipeId: 'alm-scale-director', commandId, path },
        predicate: { operator: 'equals', expected }
    }));
}
