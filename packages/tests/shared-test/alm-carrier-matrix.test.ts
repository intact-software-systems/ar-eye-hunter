import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ALM_CONFORMANCE_CARRIERS } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-carriers.ts';
import {
    ALM_CARRIER_MATRIX,
    type AlmCarrierMatrix,
    type AlmCarrierOutcome
} from '@shared-test/rallar-bb-test/conformance/alm/carrier-matrix/alm-carrier-matrix.ts';
import { toAlmCarrierMatrixCellProofs } from '@shared-test/rallar-bb-test/conformance/alm/carrier-matrix/to-alm-carrier-matrix-cell-proofs.ts';
import {
    validateAlmCarrierMatrix,
    type AlmCarrierMatrixCatalogueCell
} from '@shared-test/rallar-bb-test/conformance/alm/carrier-matrix/validate-alm-carrier-matrix.ts';
import { createAlmConformanceRecipes } from '@shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';

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

describe('toAlmCarrierMatrixCellProofs', () => {
    it('yields each proof of each stated cell under its capability and carrier, in the order written, and nothing for a cell that is not applicable', () => {
        const matrix: AlmCarrierMatrix = {
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

        expect(toAlmCarrierMatrixCellProofs(matrix)).toEqual([
            { capabilityId: 'first', carrier: 'ws', proof: { kind: 'lane-cell', scenarioKey: 'first-on-ws' } },
            { capabilityId: 'first', carrier: 'ws', proof: { kind: 'unproven', closedBy: 'a second cell' } },
            { capabilityId: 'first', carrier: 'rtc-with-ws-fallback', proof: { kind: 'lane-cell', scenarioKey: 'first-on-fallback' } },
            { capabilityId: 'probe', carrier: 'rtc', proof: { kind: 'lane-cell', scenarioKey: 'probe-cell' } }
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
    ['all-broadcast', 'ws', 'a unit pin of the `$.scope` path of the issue that a WS send naming `all` throws'],
    ['peer-unicast-off-overlay-next-hop', 'rtc', 'a unit pin of the kept unicast\'s handle at its deadline'],
    [
        'ordered-gap-repair',
        'rtc-with-ws-fallback',
        'a gap cell over this carrier whose track stays on RTC; a frame its sender holds is handed to WS, whose relay gates it as its own gap, until one ordering track spans the hand-over (product work)'
    ],
    [
        'repair-budget-exhausted',
        'ws',
        '`repair-exhausted` over this carrier, where the server is the one requester and renews its own gap'
    ],
    [
        'repair-budget-exhausted',
        'rtc-with-ws-fallback',
        'one lifecycle across the hand-over to WS, then a held-gap cell over this carrier'
    ],
    [
        'room-audience-over-frame-limit',
        'ws',
        'a server test that delivers a granted publication to more than 256 subscribed sessions'
    ],
    ['relay-payload-confidentiality', 'rtc-with-ws-fallback', '`granted-rtc-relay-only` over this carrier'],
    [
        'frame-with-forged-sender',
        'rtc-with-ws-fallback',
        '`granted-rtc-forged-sender` over this carrier; no unit test forges a sender together with its registered key id at a receiving hop'
    ],
    ['reply', 'rtc', '`reply-correlated` over this carrier'],
    ['left-sender-send', 'rtc', LEFT_SENDER_CELL],
    ['left-sender-send', 'rtc-with-ws-fallback', LEFT_SENDER_CELL],
    ['resync-recovery-owner', 'ws', 'an absent `recovery-owner-invoked` wait in `ordering-resync` over this carrier'],
    [
        'snapshot-floor-catch-up',
        'rtc-with-ws-fallback',
        'one lifecycle across the hand-over to WS, then `fenced-catch-up` over this carrier'
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
