import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
    ALM_CONFORMANCE_CARRIERS,
    type AlmConformanceCarrier
} from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-carriers.ts';
import {
    ALM_CONFORMANCE_LANE_FAMILIES,
    type AlmConformanceTag
} from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-scenario-definition.ts';
import {
    ALM_CARRIER_MATRIX,
    type AlmCarrierMatrix,
    type AlmCarrierOutcome
} from '@shared-test/rallar-bb-test/conformance/alm/carrier-matrix/alm-carrier-matrix.ts';
import {
    resolveAlmCarrierMatrixCellCarriers,
    type AlmCarrierMatrixScenarioKey
} from '@shared-test/rallar-bb-test/conformance/alm/carrier-matrix/resolve-alm-carrier-matrix-cell-carriers.ts';
import { resolveAlmWorldSendCarriers } from '@shared-test/rallar-bb-test/conformance/alm/carrier-matrix/resolve-alm-world-send-carriers.ts';
import {
    toAlmCarrierMatrixCellProofs,
    toAlmCarrierMatrixLaneProofs
} from '@shared-test/rallar-bb-test/conformance/alm/carrier-matrix/to-alm-carrier-matrix-cell-proofs.ts';
import {
    toAlmCarrierOutcomeFacts,
    toOriginRefusalFacts,
    type AlmCarrierHandleOutcome
} from '@shared-test/rallar-bb-test/conformance/alm/carrier-matrix/to-alm-carrier-outcome-facts.ts';
import { validateAlmCarrierMatrixPlan } from '@shared-test/rallar-bb-test/conformance/alm/carrier-matrix/validate-alm-carrier-matrix-plan.ts';
import {
    validateAlmCarrierMatrix,
    type AlmCarrierMatrixCatalogueCell
} from '@shared-test/rallar-bb-test/conformance/alm/carrier-matrix/validate-alm-carrier-matrix.ts';
import { createAlmConformanceRecipes } from '@shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';
import { resolveAlmLanePlan } from '@shared-test/rallar-bb-test/conformance/alm/lane/resolve-alm-lane-plan.ts';
import type { ValidateAlmLanePlanCoverageInput } from '@shared-test/rallar-bb-test/conformance/alm/lane/validate-alm-lane-plan-coverage.ts';

import { toConformanceInput } from './alm-conformance-test-input.ts';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

const OUTSIDE_THE_PROBE = { kind: 'not-applicable', because: 'The probe states one carrier.' } as const;

/** One capability, delivered over `rtc`, whose only proof is the lane cell `scenarioKey`. */
function toProbeMatrix(scenarioKey: string): AlmCarrierMatrix {
    return {
        probe: {
            statement: 'A probe send.',
            cells: {
                ws: OUTSIDE_THE_PROBE,
                rtc: { kind: 'stated', outcome: { kind: 'delivered' }, proofs: [{ kind: 'lane-cell', scenarioKey }] },
                'rtc-with-ws-fallback': OUTSIDE_THE_PROBE
            }
        }
    };
}

/** Every scenario the lane catalogue creates, over each carrier, with every lane family and principal resolved. */
function toCatalogueCells(): readonly AlmCarrierMatrixCatalogueCell[] {
    return ALM_CONFORMANCE_CARRIERS.flatMap((carrier) =>
        createAlmConformanceRecipes(toConformanceInput(carrier)).map(({ scenarioKey, tags }) => ({
            carrier,
            scenarioKey,
            tags
        }))
    );
}

/** Two capabilities whose stated cells name three lane cells and one proof of another kind; no other cell applies. */
const TWO_CAPABILITY_MATRIX: AlmCarrierMatrix = {
    first: {
        statement: 'A first probe send.',
        cells: {
            ws: {
                kind: 'stated',
                outcome: { kind: 'delivered' },
                proofs: [{ kind: 'lane-cell', scenarioKey: 'first-on-ws' }, { kind: 'unproven', closedBy: 'a second cell' }]
            },
            rtc: OUTSIDE_THE_PROBE,
            'rtc-with-ws-fallback': {
                kind: 'stated',
                outcome: { kind: 'delivered' },
                proofs: [{ kind: 'lane-cell', scenarioKey: 'first-on-fallback' }]
            }
        }
    },
    ...toProbeMatrix('probe-cell')
};

describe('toAlmCarrierMatrixCellProofs', () => {
    it('yields each proof of each stated cell under its capability and carrier, in the order written, and nothing for a cell that is not applicable', () => {
        expect(toAlmCarrierMatrixCellProofs(TWO_CAPABILITY_MATRIX)).toEqual([
            { capabilityId: 'first', carrier: 'ws', proof: { kind: 'lane-cell', scenarioKey: 'first-on-ws' } },
            { capabilityId: 'first', carrier: 'ws', proof: { kind: 'unproven', closedBy: 'a second cell' } },
            { capabilityId: 'first', carrier: 'rtc-with-ws-fallback', proof: { kind: 'lane-cell', scenarioKey: 'first-on-fallback' } },
            { capabilityId: 'probe', carrier: 'rtc', proof: { kind: 'lane-cell', scenarioKey: 'probe-cell' } }
        ]);
    });
});

describe('toAlmCarrierMatrixLaneProofs', () => {
    it('yields each lane cell a capability names on a carrier, in the same order, and no proof of another kind', () => {
        expect(toAlmCarrierMatrixLaneProofs(TWO_CAPABILITY_MATRIX)).toEqual([
            { capabilityId: 'first', carrier: 'ws', scenarioKey: 'first-on-ws' },
            { capabilityId: 'first', carrier: 'rtc-with-ws-fallback', scenarioKey: 'first-on-fallback' },
            { capabilityId: 'probe', carrier: 'rtc', scenarioKey: 'probe-cell' }
        ]);
    });
});

describe('validateAlmCarrierMatrix', () => {
    it('reports a lane cell the catalogue does not run on the carrier the matrix names, and a carrier the catalogue runs it on that the matrix does not name', () => {
        const issues = validateAlmCarrierMatrix({
            matrix: toProbeMatrix('probe-cell'),
            cells: [{ carrier: 'ws', scenarioKey: 'probe-cell', tags: ['full'] }]
        });

        expect(issues).toEqual([
            'probe names the lane cell probe-cell over rtc, where the catalogue does not run it',
            'the catalogue runs probe-cell over ws, where no capability names it'
        ]);
    });

    it('reports a lane cell outside the full scope', () => {
        const issues = validateAlmCarrierMatrix({
            matrix: toProbeMatrix('probe-cell'),
            cells: [{ carrier: 'rtc', scenarioKey: 'probe-cell', tags: ['smoke'] }]
        });

        expect(issues).toEqual(['probe names the lane cell probe-cell over rtc, which is outside the full scope']);
    });

    it('accepts the lane catalogue against the matrix beside it', () => {
        expect(validateAlmCarrierMatrix({ matrix: ALM_CARRIER_MATRIX, cells: toCatalogueCells() })).toEqual([]);
    });
});

/**
 * The plan the lane records over one carrier: each family's cells as the lane resolves them from that family's
 * catalogue, in the declared order, with nothing narrowed.
 */
function toLanePlan(carrier: AlmConformanceCarrier, scope: AlmConformanceTag): ValidateAlmLanePlanCoverageInput {
    const parameters = {
        scope,
        carriers: [carrier],
        families: ALM_CONFORMANCE_LANE_FAMILIES,
        order: 'declared',
        seed: null,
        rooms: 'family',
        only: [],
        skip: []
    } as const;
    return {
        carrier,
        scope,
        only: parameters.only,
        skip: parameters.skip,
        families: ALM_CONFORMANCE_LANE_FAMILIES.map((family) => ({
            family,
            scenarioKeys: resolveAlmLanePlan({
                family,
                carrier,
                scenarios: createAlmConformanceRecipes({ ...toConformanceInput(carrier), laneFamilies: [family] }),
                scope,
                parameters,
                mintSeed: () => 0
            }).cellOrder.scenarioKeys
        }))
    };
}

describe('validateAlmCarrierMatrixPlan', () => {
    it('reports each lane cell the matrix names over the carrier of a full plan that leaves it out, and no cell it names over another carrier', () => {
        const plan = {
            carrier: 'ws',
            scope: 'full',
            families: [{ family: 'two-agent', scenarioKeys: ['another-cell'] }],
            only: [],
            skip: []
        } as const;

        expect(validateAlmCarrierMatrixPlan({ matrix: TWO_CAPABILITY_MATRIX, plan })).toEqual([
            'first names the lane cell first-on-ws over ws, which the full plan leaves out'
        ]);
    });

    it.each(ALM_CONFORMANCE_CARRIERS)('accepts the full plan the lane resolves over %s from the catalogue', (carrier) => {
        expect(validateAlmCarrierMatrixPlan({ matrix: ALM_CARRIER_MATRIX, plan: toLanePlan(carrier, 'full') })).toEqual([]);
    });

    it('reports exactly the cell taken out of the full plan the lane resolves', () => {
        const full = toLanePlan('rtc', 'full');
        const families = full.families.map(({ family, scenarioKeys }) => ({
            family,
            scenarioKeys: scenarioKeys.filter((scenarioKey) => scenarioKey !== 'claim-refused-on-rtc')
        }));

        expect(full.families.flatMap(({ scenarioKeys }) => scenarioKeys)).toContain('claim-refused-on-rtc');
        expect(validateAlmCarrierMatrixPlan({ matrix: ALM_CARRIER_MATRIX, plan: { ...full, families } })).toEqual([
            'exclusive-claim names the lane cell claim-refused-on-rtc over rtc, which the full plan leaves out'
        ]);
    });

    it.each([
        { only: ['another-cell'], skip: [] },
        { only: [], skip: ['first-on-ws'] }
    ])('does not judge a full plan its run narrowed, whatever it leaves out: %j', ({ only, skip }) => {
        const plan = { carrier: 'ws', scope: 'full', families: [], only, skip } as const;

        expect(validateAlmCarrierMatrixPlan({ matrix: TWO_CAPABILITY_MATRIX, plan })).toEqual([]);
    });

    it('does not judge a smoke plan, whatever it leaves out', () => {
        const plan = { carrier: 'ws', scope: 'smoke', families: [], only: [], skip: [] } as const;

        expect(validateAlmCarrierMatrixPlan({ matrix: TWO_CAPABILITY_MATRIX, plan })).toEqual([]);
    });
});

const NOT_APPLICABLE = { kind: 'not-applicable' } as const;
const DELIVERED = { kind: 'stated', outcome: { kind: 'delivered' } } as const;
const HANDED_TO_WS_AT_ROUTING = { kind: 'stated', outcome: { kind: 'handed-to-ws', at: 'routing' } } as const;
const HANDED_TO_WS_NOT_READY = {
    kind: 'stated',
    outcome: { kind: 'handed-to-ws', at: 'after-admission', reason: 'not-ready' }
} as const;

function toRefusedBy(by: 'origin' | 'trusted-server' | 'peer', reason: string) {
    return { kind: 'stated', outcome: { kind: 'refused', by, reason } } as const;
}

function toRefusedAtTheCall(issuePath: string, code: string) {
    return { kind: 'stated', outcome: { kind: 'refused', by: 'call', path: issuePath, code } } as const;
}

function toRefusedByTheReceiver(of: 'frame' | 'receipt', code: string) {
    return { kind: 'stated', outcome: { kind: 'refused', by: 'receiver', of, code } } as const;
}

function toHandedToWsAtAdmission(reason: string) {
    return { kind: 'stated', outcome: { kind: 'handed-to-ws', at: 'admission', reason } } as const;
}

const UNDELIVERED_EXPIRED = { kind: 'stated', outcome: { kind: 'undelivered', failure: { kind: 'expired' } } } as const;

function toUndelivered(kind: 'skipped' | 'unroutable', reason: string) {
    return { kind: 'stated', outcome: { kind: 'undelivered', failure: { kind, reason } } } as const;
}

/**
 * Written by hand, cell by cell, from the production code and the test that each cell of the matrix cites, and never
 * from the matrix: a cell that changes here without its code changing is a wrong cell.
 */
const EXPECTED_OUTCOMES = {
    'exclusive-claim': {
        ws: DELIVERED,
        rtc: toRefusedBy('origin', 'unsupported'),
        'rtc-with-ws-fallback': HANDED_TO_WS_AT_ROUTING
    },
    'world-broadcast': {
        ws: DELIVERED,
        rtc: toRefusedBy('origin', 'unsupported'),
        'rtc-with-ws-fallback': HANDED_TO_WS_AT_ROUTING
    },
    'all-broadcast': {
        ws: toRefusedAtTheCall('$.scope', 'invalid-scope'),
        rtc: toRefusedAtTheCall('$.scope', 'invalid-scope'),
        'rtc-with-ws-fallback': toRefusedAtTheCall('$.scope', 'invalid-scope')
    },
    'room-send-naming-another-room': {
        ws: toRefusedAtTheCall('$.contextId', 'context-room-mismatch'),
        rtc: toRefusedAtTheCall('$.contextId', 'context-room-mismatch'),
        'rtc-with-ws-fallback': toRefusedAtTheCall('$.contextId', 'context-room-mismatch')
    },
    'server-peer-unicast': {
        ws: DELIVERED,
        rtc: toRefusedAtTheCall('$.peerId', 'unsupported'),
        'rtc-with-ws-fallback': toRefusedAtTheCall('$.peerId', 'unsupported')
    },
    'peer-unicast': { ws: DELIVERED, rtc: DELIVERED, 'rtc-with-ws-fallback': DELIVERED },
    'peer-unicast-to-unready-addressee': {
        ws: NOT_APPLICABLE,
        rtc: toUndelivered('unroutable', 'no-route'),
        'rtc-with-ws-fallback': toHandedToWsAtAdmission('no-route')
    },
    'peer-unicast-off-overlay-next-hop': {
        ws: NOT_APPLICABLE,
        rtc: UNDELIVERED_EXPIRED,
        'rtc-with-ws-fallback': HANDED_TO_WS_NOT_READY
    },
    'ordered-gap-repair': { ws: DELIVERED, rtc: DELIVERED, 'rtc-with-ws-fallback': DELIVERED },
    'repair-budget-exhausted': {
        ws: toUndelivered('skipped', 'repair-exhausted'),
        rtc: toUndelivered('skipped', 'repair-exhausted'),
        'rtc-with-ws-fallback': HANDED_TO_WS_NOT_READY
    },
    'room-audience-over-frame-limit': {
        ws: DELIVERED,
        rtc: toRefusedBy('origin', 'unsupported'),
        'rtc-with-ws-fallback': toHandedToWsAtAdmission('unsupported')
    },
    'relay-payload-confidentiality': { ws: NOT_APPLICABLE, rtc: DELIVERED, 'rtc-with-ws-fallback': DELIVERED },
    'revoked-publish-known-to-sender': {
        ws: toRefusedBy('origin', 'no-publish-grant'),
        rtc: toRefusedBy('origin', 'no-publish-grant'),
        'rtc-with-ws-fallback': toRefusedBy('origin', 'no-publish-grant')
    },
    'revoked-publish-unknown-to-sender': {
        ws: toRefusedBy('trusted-server', 'no-publish-grant'),
        rtc: toRefusedByTheReceiver('frame', 'no-publish-grant'),
        'rtc-with-ws-fallback': toRefusedByTheReceiver('frame', 'no-publish-grant')
    },
    'frame-without-proof': {
        ws: NOT_APPLICABLE,
        rtc: toRefusedByTheReceiver('frame', 'missing-proof'),
        'rtc-with-ws-fallback': toRefusedByTheReceiver('frame', 'missing-proof')
    },
    'frame-with-forged-sender': {
        ws: NOT_APPLICABLE,
        rtc: toRefusedByTheReceiver('frame', 'invalid-signature'),
        'rtc-with-ws-fallback': toRefusedByTheReceiver('frame', 'invalid-signature')
    },
    'receipt-without-proof': {
        ws: NOT_APPLICABLE,
        rtc: toRefusedByTheReceiver('receipt', 'missing-proof'),
        'rtc-with-ws-fallback': toRefusedByTheReceiver('receipt', 'missing-proof')
    },
    reply: { ws: DELIVERED, rtc: DELIVERED, 'rtc-with-ws-fallback': DELIVERED },
    'reply-wait-on-topic-ws-cannot-carry': {
        ws: NOT_APPLICABLE,
        rtc: toRefusedAtTheCall('$.topicId', 'invalid-ws-user-topic'),
        'rtc-with-ws-fallback': NOT_APPLICABLE
    },
    'left-sender-send': {
        ws: toRefusedBy('trusted-server', 'membership-fenced'),
        rtc: toRefusedBy('peer', 'membership-fenced'),
        'rtc-with-ws-fallback': toRefusedBy('peer', 'membership-fenced')
    },
    'resync-recovery-owner': {
        ws: toRefusedBy('trusted-server', 'resync-required'),
        rtc: toRefusedBy('peer', 'resync-required'),
        'rtc-with-ws-fallback': toRefusedBy('peer', 'resync-required')
    },
    'snapshot-floor-catch-up': { ws: DELIVERED, rtc: DELIVERED, 'rtc-with-ws-fallback': DELIVERED }
} as const;

const LEFT_SENDER_CELL =
    'a left-sender cell over this carrier; a page that has read its own leave holds the send `pending-authority`, and nothing pins how that ends';

/** Every cell some part of whose outcome nothing proves yet, and what will prove it. */
const UNPROVEN_CELLS = [
    [
        'ordered-gap-repair',
        'rtc-with-ws-fallback',
        'a gap cell over this carrier whose track stays on RTC; a frame its sender holds is handed to WS, whose relay gates it as its own gap, until one ordering track spans the hand-over (product work)'
    ],
    [
        'repair-budget-exhausted',
        'rtc-with-ws-fallback',
        'one lifecycle across the hand-over to WS, then a held-gap cell over this carrier'
    ],
    [
        'room-audience-over-frame-limit',
        'ws',
        'a server test that delivers a granted publication to more than 256 subscribed sessions; it waits for the merge of pull request 885, which changes the test file that holds the harness'
    ],
    [
        'revoked-publish-unknown-to-sender',
        'rtc-with-ws-fallback',
        'a receipted publication over this carrier: no hop answers the frame it drops, so the receipt runs out and the send is handed to WS, where the server refuses it `no-publish-grant`; nothing pins that chain'
    ],
    ['left-sender-send', 'rtc', LEFT_SENDER_CELL],
    ['left-sender-send', 'rtc-with-ws-fallback', LEFT_SENDER_CELL],
    [
        'left-sender-send',
        'rtc-with-ws-fallback',
        'a receipted room send over this carrier: the receipt a fencing receiver ends is handed to WS as `receipt-exhausted`, where the server fences the send; nothing pins that end'
    ],
    [
        'snapshot-floor-catch-up',
        'rtc-with-ws-fallback',
        'one lifecycle across the hand-over to WS, then `fenced-catch-up` over this carrier'
    ]
] as const;

/** Every lane cell that shows only a part of its cell's outcome, and the part it shows. */
const PARTIAL_LANE_CELLS = [
    [
        'relay-payload-confidentiality',
        'rtc',
        'granted-rtc-relay-only',
        'The subscriber receives the publication over RTC, and the session that holds `publish` alone delivers nothing to its application. The run does not force the frame through that session, so it does not show it forwarding.'
    ]
] as const;

/** What one cell states, without its proofs or its reason. */
type StatedOutcome = Readonly<{ kind: 'stated'; outcome: AlmCarrierOutcome; }> | Readonly<{ kind: 'not-applicable'; }>;

function toStatedOutcomes(matrix: AlmCarrierMatrix): Readonly<Record<string, Readonly<Record<string, StatedOutcome>>>> {
    return Object.fromEntries(
        Object.entries(matrix).map(([capabilityId, capability]) => [
            capabilityId,
            Object.fromEntries(ALM_CONFORMANCE_CARRIERS.map((carrier) => {
                const cell = capability.cells[carrier];
                const stated: StatedOutcome = cell.kind === 'stated' ? { kind: cell.kind, outcome: cell.outcome } : { kind: cell.kind };
                return [carrier, stated];
            }))
        ])
    );
}

/** The file's text with its whitespace runs collapsed, or nothing when the repository holds no such file. */
function readRepositoryText(relativePath: string): string | undefined {
    const absolutePath = path.join(repoRoot, relativePath);
    return existsSync(absolutePath) ? readFileSync(absolutePath, 'utf8').replace(/\s+/g, ' ') : undefined;
}

describe('ALM_CARRIER_MATRIX', () => {
    it('states what a send comes to for every capability on every carrier', () => {
        expect(toStatedOutcomes(ALM_CARRIER_MATRIX)).toEqual(EXPECTED_OUTCOMES);
    });

    it('names every cell nothing proves yet and what will prove it', () => {
        const unproven = toAlmCarrierMatrixCellProofs(ALM_CARRIER_MATRIX).flatMap(({ capabilityId, carrier, proof }) =>
            proof.kind === 'unproven' ? [[capabilityId, carrier, proof.closedBy]] : []
        );

        expect(unproven).toHaveLength(UNPROVEN_CELLS.length);
        expect(unproven).toEqual(expect.arrayContaining([...UNPROVEN_CELLS]));
    });

    it('names every lane cell that shows only a part of its outcome and the part it shows', () => {
        const partial = toAlmCarrierMatrixCellProofs(ALM_CARRIER_MATRIX).flatMap(({ capabilityId, carrier, proof }) =>
            proof.kind === 'lane-cell' && proof.because !== undefined
                ? [[capabilityId, carrier, proof.scenarioKey, proof.because]]
                : []
        );

        expect(partial).toEqual(PARTIAL_LANE_CELLS);
    });

    it('names for every unit proof a test title that its test file holds', () => {
        const unitProofs = toAlmCarrierMatrixCellProofs(ALM_CARRIER_MATRIX).flatMap(({ proof }) => proof.kind === 'unit-test' ? [proof] : []);
        // A title written with an escaped apostrophe is named as it reads.
        const unpinned = unitProofs.filter(({ testFile, testName }) =>
            !/\.test\.ts$/.test(testFile) || testName.trim() === '' ||
            !readRepositoryText(testFile)?.replaceAll('\\\'', '\'').includes(testName)
        );

        expect(unitProofs.length).toBeGreaterThan(0);
        expect(unpinned.map(({ testFile, testName }) => [testFile, testName])).toEqual([]);
    });

    it('quotes for every documented limit a phrase that its document holds', () => {
        const limits = toAlmCarrierMatrixCellProofs(ALM_CARRIER_MATRIX).flatMap(({ proof }) => proof.kind === 'documented-limit' ? [proof] : []);
        const unquoted = limits.filter(({ document, limit }) => limit.trim() === '' || !readRepositoryText(document)?.includes(limit));

        expect(limits.length).toBeGreaterThan(0);
        expect(unquoted.map(({ document, limit }) => [document, limit])).toEqual([]);
    });
});

/**
 * Written by hand, scenario by scenario, from the carriers each cell is proven on, and never from the matrix: a carrier
 * that changes here without its scenario's cell changing is a wrong resolution.
 */
const EXPECTED_CELL_CARRIERS: readonly (readonly [AlmCarrierMatrixScenarioKey, readonly AlmConformanceCarrier[]])[] = [
    ['claim-first-wins', ['ws', 'rtc-with-ws-fallback']],
    ['claim-expires-reclaims', ['ws']],
    ['claim-refused-on-rtc', ['rtc']],
    ['world-routing', ['ws', 'rtc', 'rtc-with-ws-fallback']],
    ['server-command', ['ws']],
    ['ws-unicast-receipt', ['ws', 'rtc', 'rtc-with-ws-fallback']],
    ['unicast-fallback', ['rtc-with-ws-fallback']],
    ['ordering-gap-repair', ['ws', 'rtc']],
    ['seeded-loss-unreceipted-stream', ['ws']],
    ['repair-exhausted', ['ws', 'rtc']],
    ['granted-rtc-relay-only', ['rtc']],
    ['granted-rtc-revoked-publisher', ['rtc', 'rtc-with-ws-fallback']],
    ['granted-rtc-missing-proof', ['rtc']],
    ['granted-rtc-forged-sender', ['rtc']],
    ['unsigned-ack-refused', ['rtc', 'rtc-with-ws-fallback']],
    ['forged-recipient-ack', ['rtc']],
    ['reply-correlated', ['ws', 'rtc', 'rtc-with-ws-fallback']],
    ['reply-timeout-late', ['ws']],
    ['reply-first-wins', ['ws']],
    ['fenced-rejection', ['ws']],
    ['ordering-resync', ['ws', 'rtc', 'rtc-with-ws-fallback']],
    ['fenced-catch-up', ['ws', 'rtc']]
];

describe('resolveAlmCarrierMatrixCellCarriers', () => {
    it.each(EXPECTED_CELL_CARRIERS)('resolves the carriers the matrix names %s on', (scenarioKey, carriers) => {
        expect(resolveAlmCarrierMatrixCellCarriers(scenarioKey)).toEqual(carriers);
    });

    it('takes exactly the scenarios the matrix names as a lane cell', () => {
        const named = new Set(toAlmCarrierMatrixLaneProofs(ALM_CARRIER_MATRIX).map(({ scenarioKey }) => scenarioKey));
        // @ts-expect-error No cell names `reply-undelivered` as its proof, so the matrix has no carriers to resolve for it.
        const unnamed: AlmCarrierMatrixScenarioKey = 'reply-undelivered';

        expect(new Set(EXPECTED_CELL_CARRIERS.map(([scenarioKey]) => scenarioKey))).toEqual(named);
        expect(named).not.toContain(unnamed);
    });
});

describe('resolveAlmWorldSendCarriers', () => {
    it('selects the carriers on which a world broadcast leaves its sender\'s page: every one that does not refuse it', () => {
        expect(resolveAlmWorldSendCarriers()).toEqual(['ws', 'rtc-with-ws-fallback']);
    });
});

describe('toAlmCarrierOutcomeFacts', () => {
    it('translates each outcome into the facts its observation must hold', () => {
        expect(toAlmCarrierOutcomeFacts({ kind: 'refused', by: 'origin', reason: 'unsupported' })).toEqual([
            ['refused', 'failure.kind', 'equals', 'refused'],
            ['unsupported', 'failure.reason', 'equals', 'unsupported'],
            ['no-attempt', 'attempts', 'equals', 0]
        ]);
        expect(toAlmCarrierOutcomeFacts({ kind: 'handed-to-ws', at: 'routing' })).toEqual([
            ['one-attempt', 'attempts', 'equals', 1],
            ['ws-attempt', 'attemptCarriers.0', 'equals', 'ws'],
            ['no-fallback', 'carrierFallback', 'exists', false]
        ]);
        expect(toAlmCarrierOutcomeFacts({ kind: 'handed-to-ws', at: 'after-admission', reason: 'not-ready' })).toEqual([
            ['fallback-from', 'carrierFallback.from', 'equals', 'rtc'],
            ['fallback-to', 'carrierFallback.to', 'equals', 'ws'],
            ['fallback-reason', 'carrierFallback.reason', 'equals', 'not-ready']
        ]);
    });

    it('states the same three facts for an origin refusal a cell knows by its reason alone', () => {
        expect(toOriginRefusalFacts('no-publish-grant')).toEqual([
            ['refused', 'failure.kind', 'equals', 'refused'],
            ['no-publish-grant', 'failure.reason', 'equals', 'no-publish-grant'],
            ['no-attempt', 'attempts', 'equals', 0]
        ]);
    });

    it('takes no outcome whose evidence is not on the sender\'s handle', () => {
        // @ts-expect-error A delivered send leaves no fact of its own on the handle: each cell asserts its own evidence.
        const delivered: AlmCarrierHandleOutcome = { kind: 'delivered' };
        // @ts-expect-error A hand-over at admission is evidenced by the RTC leg's attempt row, which no cell asserts yet.
        const atAdmission: AlmCarrierHandleOutcome = { kind: 'handed-to-ws', at: 'admission', reason: 'no-route' };
        // @ts-expect-error A frame its receiver refuses is evidenced on the receiving page, never on the sender's handle.
        const byTheReceiver: AlmCarrierHandleOutcome = { kind: 'refused', by: 'receiver', of: 'frame', code: 'missing-proof' };

        expect([delivered.kind, atAdmission.kind, byTheReceiver.kind]).toEqual(['delivered', 'handed-to-ws', 'refused']);
    });
});
