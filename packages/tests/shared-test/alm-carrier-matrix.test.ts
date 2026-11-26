import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ALM_CONFORMANCE_CARRIERS, type AlmConformanceCarrier } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-carriers.ts';
import {
    ALM_CARRIER_MATRIX,
    type AlmCarrierMatrix,
    type AlmCarrierMatrixCell,
    type AlmCarrierProof
} from '@shared-test/rallar-bb-test/conformance/alm/carrier-matrix/alm-carrier-matrix.ts';
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
function readCatalogueCells(): readonly AlmCarrierMatrixCatalogueCell[] {
    return ALM_CONFORMANCE_CARRIERS.flatMap((carrier) =>
        createAlmConformanceRecipes(toConformanceInput(carrier)).map(({ scenarioKey, tags }) => ({
            carrier,
            scenarioKey,
            tags
        }))
    );
}

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
        expect(validateAlmCarrierMatrix({ matrix: ALM_CARRIER_MATRIX, cells: readCatalogueCells() })).toEqual([]);
    });
});

const NOT_APPLICABLE = { kind: 'not-applicable' } as const;
const DELIVERED = { kind: 'stated', outcome: { kind: 'delivered' } } as const;
const REFUSED_BY_THE_RECEIVER = { kind: 'stated', outcome: { kind: 'refused', by: 'receiver' } } as const;
const HANDED_TO_WS_AT_ROUTING = { kind: 'stated', outcome: { kind: 'handed-to-ws', at: 'routing' } } as const;
const HANDED_TO_WS_NOT_READY = {
    kind: 'stated',
    outcome: { kind: 'handed-to-ws', at: 'after-admission', reason: 'not-ready' }
} as const;

function refusedBy(by: 'origin' | 'trusted-server' | 'peer', reason: string) {
    return { kind: 'stated', outcome: { kind: 'refused', by, reason } } as const;
}

function refusedAtTheCall(issuePath: string, code: string) {
    return { kind: 'stated', outcome: { kind: 'refused', by: 'call', path: issuePath, code } } as const;
}

/**
 * Transcribed by hand from the by-design table of the carrier-parity section and the single-carrier cells of item G7
 * of the ALM 1.0 readiness plan, each cell read against the scenario or unit test that asserts it. Where the tree and
 * the plan disagree the tree is stated: a send to the server peer and an `all` broadcast are refused at the call, and
 * a granted audience over the room limit is handed to WS under the fallback strategy.
 */
const EXPECTED_OUTCOMES = {
    'exclusive-claim': {
        ws: DELIVERED,
        rtc: refusedBy('origin', 'unsupported'),
        'rtc-with-ws-fallback': HANDED_TO_WS_AT_ROUTING
    },
    'world-broadcast': {
        ws: DELIVERED,
        rtc: refusedBy('origin', 'unsupported'),
        'rtc-with-ws-fallback': HANDED_TO_WS_AT_ROUTING
    },
    'all-broadcast': {
        ws: refusedAtTheCall('$.scope', 'invalid-scope'),
        rtc: refusedAtTheCall('$.scope', 'invalid-scope'),
        'rtc-with-ws-fallback': refusedAtTheCall('$.scope', 'invalid-scope')
    },
    'server-peer-unicast': {
        ws: DELIVERED,
        rtc: refusedAtTheCall('$.peerId', 'unsupported'),
        'rtc-with-ws-fallback': refusedAtTheCall('$.peerId', 'unsupported')
    },
    'peer-unicast': { ws: DELIVERED, rtc: DELIVERED, 'rtc-with-ws-fallback': DELIVERED },
    'peer-unicast-without-direct-route': {
        ws: NOT_APPLICABLE,
        rtc: { kind: 'stated', outcome: { kind: 'undelivered', failure: { kind: 'expired' } } },
        'rtc-with-ws-fallback': HANDED_TO_WS_NOT_READY
    },
    'ordered-gap-repair': { ws: DELIVERED, rtc: DELIVERED, 'rtc-with-ws-fallback': DELIVERED },
    'repair-budget-exhausted': {
        ws: NOT_APPLICABLE,
        rtc: { kind: 'stated', outcome: { kind: 'undelivered', failure: { kind: 'skipped', reason: 'repair-exhausted' } } },
        'rtc-with-ws-fallback': HANDED_TO_WS_NOT_READY
    },
    'granted-audience-over-room-limit': {
        ws: DELIVERED,
        rtc: refusedBy('origin', 'unsupported'),
        'rtc-with-ws-fallback': {
            kind: 'stated',
            outcome: { kind: 'handed-to-ws', at: 'admission', reason: 'unsupported' }
        }
    },
    'relay-payload-confidentiality': { ws: NOT_APPLICABLE, rtc: DELIVERED, 'rtc-with-ws-fallback': DELIVERED },
    'publish-revocation': {
        ws: refusedBy('trusted-server', 'no-publish-grant'),
        rtc: refusedBy('origin', 'no-publish-grant'),
        'rtc-with-ws-fallback': refusedBy('origin', 'no-publish-grant')
    },
    'sender-authentication': {
        ws: NOT_APPLICABLE,
        rtc: REFUSED_BY_THE_RECEIVER,
        'rtc-with-ws-fallback': REFUSED_BY_THE_RECEIVER
    },
    reply: { ws: DELIVERED, rtc: DELIVERED, 'rtc-with-ws-fallback': DELIVERED },
    'left-sender-send': {
        ws: refusedBy('trusted-server', 'membership-fenced'),
        rtc: refusedBy('origin', 'unauthorized'),
        'rtc-with-ws-fallback': refusedBy('origin', 'unauthorized')
    },
    'resync-recovery-owner': {
        ws: refusedBy('trusted-server', 'resync-required'),
        rtc: refusedBy('peer', 'resync-required'),
        'rtc-with-ws-fallback': refusedBy('peer', 'resync-required')
    },
    'snapshot-floor-catch-up': { ws: DELIVERED, rtc: DELIVERED, 'rtc-with-ws-fallback': DELIVERED }
} as const;

/** Every cell some part of whose outcome nothing proves yet, and what will prove it. */
const UNPROVEN_CELLS = [
    ['peer-unicast-without-direct-route', 'rtc', 'a unit pin of the kept unicast\'s handle at its deadline'],
    [
        'ordered-gap-repair',
        'rtc-with-ws-fallback',
        'one ordering track across the hand-over to WS, then `ordering-gap-repair` over this carrier'
    ],
    [
        'repair-budget-exhausted',
        'rtc-with-ws-fallback',
        'one lifecycle across the hand-over to WS, then a held-gap cell over this carrier'
    ],
    [
        'granted-audience-over-room-limit',
        'ws',
        'a server test that delivers a granted publication to more than 256 subscribed sessions'
    ],
    ['reply', 'rtc', '`reply-correlated` over this carrier'],
    ['left-sender-send', 'rtc', 'a left-sender cell over this carrier, beside `fenced-rejection`'],
    ['left-sender-send', 'rtc-with-ws-fallback', 'a left-sender cell over this carrier'],
    ['resync-recovery-owner', 'ws', 'an absent `recovery-owner-invoked` wait in `ordering-resync` over this carrier'],
    [
        'snapshot-floor-catch-up',
        'rtc-with-ws-fallback',
        'one lifecycle across the hand-over to WS, then `fenced-catch-up` over this carrier'
    ]
] as const;

interface CarrierProof {
    readonly capabilityId: string;
    readonly carrier: AlmConformanceCarrier;
    readonly proof: AlmCarrierProof;
}

function readProofs(matrix: AlmCarrierMatrix): readonly CarrierProof[] {
    return Object.entries(matrix).flatMap(([capabilityId, capability]) =>
        ALM_CONFORMANCE_CARRIERS.flatMap((carrier) => readCellProofs(capabilityId, carrier, capability.cells[carrier]))
    );
}

function readCellProofs(
    capabilityId: string,
    carrier: AlmConformanceCarrier,
    cell: AlmCarrierMatrixCell
): readonly CarrierProof[] {
    return cell.kind === 'stated' ? cell.proofs.map((proof) => ({ capabilityId, carrier, proof })) : [];
}

describe('ALM_CARRIER_MATRIX', () => {
    it('states the outcome section 5.7 and G7 give for every capability on every carrier', () => {
        expect(Object.keys(ALM_CARRIER_MATRIX).sort()).toEqual(Object.keys(EXPECTED_OUTCOMES).sort());
        expect(ALM_CARRIER_MATRIX).toMatchObject(
            Object.fromEntries(Object.entries(EXPECTED_OUTCOMES).map(([capabilityId, cells]) => [capabilityId, { cells }]))
        );
    });

    it('names every cell nothing proves yet and what will prove it', () => {
        const unproven = readProofs(ALM_CARRIER_MATRIX).flatMap(({ capabilityId, carrier, proof }) =>
            proof.kind === 'unproven' ? [[capabilityId, carrier, proof.closedBy]] : []
        );

        expect(unproven).toHaveLength(UNPROVEN_CELLS.length);
        expect(unproven).toEqual(expect.arrayContaining([...UNPROVEN_CELLS]));
    });

    it('points every unit proof at a test file that exists', () => {
        const testFiles = readProofs(ALM_CARRIER_MATRIX).flatMap(({ proof }) => proof.kind === 'unit-test' ? [proof.testFile] : []);

        expect(testFiles.length).toBeGreaterThan(0);
        expect(testFiles.filter((testFile) => !/\.test\.ts$/.test(testFile) || !existsSync(path.join(repoRoot, testFile))))
            .toEqual([]);
    });
});
