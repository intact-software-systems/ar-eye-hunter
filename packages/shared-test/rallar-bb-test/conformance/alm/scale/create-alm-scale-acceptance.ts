import type { RallarBlackBoxDistributedGroupAssertion } from '../../../distributed/group-assertions.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestLoopCommand,
    RallarBlackBoxTestRecord
} from '../../../rallar-black-box-test-contracts.ts';

interface AlmScaleBudgetFact {
    readonly path: string;
    readonly operator: 'lte' | 'equals';
    readonly expected: number | boolean;
}

const BUDGET_FACTS: readonly AlmScaleBudgetFact[] = [
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

export function createAlmScaleSampler(prefix: string): RallarBlackBoxTestLoopCommand {
    return {
        kind: 'loop',
        commandId: `${prefix}-sampler`,
        count: 7,
        intervalMs: 5_000,
        commands: [
            { kind: 'stats', commandId: `${prefix}-sample-stats` },
            ...BUDGET_FACTS.map((fact, index): RallarBlackBoxTestCommand => ({
                kind: 'assert',
                commandId: `${prefix}-sample-budget-${index + 1}`,
                source: `stats.${fact.path}`,
                operator: fact.operator,
                expected: fact.expected
            }))
        ]
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
        const sampler = [['iterations', 7], ['pacing.completedIterations', 7], ['passed', 84], ['failed', 0], [
            'cancelled',
            false
        ]] as const;
        const assertions = sampler.map(([path, expected]) =>
            createGroupAssertion(role, `${prefix}-sampler`, { path, operator: 'equals', expected })
        );
        return [
            ...assertions,
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
                ? ['start', 'end'].flatMap((event) =>
                    createReceiptGroupAssertions(`${prefix}-${event}-receipt`, playerCount)
                )
                : ([['iterations', 6], ['pacing.completedIterations', 6], ['failed', 0], ['cancelled', false]] as const)
                    .map(([path, expected]) =>
                        createGroupAssertion(role, `${prefix}-shots`, { path, operator: 'equals', expected })
                    ))
        ];
    });
}

export function createAlmScaleAcceptanceMetadata(): RallarBlackBoxTestRecord {
    return {
        budgets: Object.fromEntries(BUDGET_FACTS.map((fact) => [fact.path, fact.expected])),
        samplingScope:
            'Seven page ledger and congestion readings at 0/5/10/15/20/25/30 seconds; observed bounds, not continuous peaks.',
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
    fact: AlmScaleBudgetFact
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
