import type { ALDeliveryFailure } from '@shared/alm/delivery/al-delivery-failure.ts';
import type {
    ALDeliveryFallbackReason,
    ALDeliveryRefusalReason,
    ALDeliveryRelayRejection,
    ALDeliveryUnroutableReason
} from '@shared/alm/delivery/al-delivery-lifecycle.ts';

import type { AlmConformanceCarrier } from '../alm-conformance-carriers.ts';

/**
 * What the send a capability names comes to on one carrier.
 *
 * `refused` names who refuses: the `call` throws a validation issue and returns no handle; the `origin` ends the handle
 * `rejected` before any carrier attempt; the `trusted-server` and a `peer` hop answer an admitted NACK, which a
 * receipt-tracked handle reads as `rejected`; the `receiver` refuses the proof of a frame or a receipt at its own
 * inbound admission, delivers and counts nothing, and answers nothing.
 *
 * `handed-to-ws` names where the fallback strategy leaves RTC: at `routing` the browser sends over WS at once, one WS
 * attempt and no hand-over evidence; at `admission` the RTC leg's verdict is the evidence row of a refused leg; after
 * admission the D56 hand-over moves a message RTC had admitted.
 *
 * `undelivered` ends the handle with that failure and no recipient: `failed` for `skipped`, `expired` for `expired`.
 */
export type AlmCarrierOutcome =
    | Readonly<{ kind: 'delivered'; }>
    | Readonly<{ kind: 'refused'; by: 'call'; path: string; code: string; }>
    | Readonly<{ kind: 'refused'; by: 'origin'; reason: ALDeliveryRefusalReason; }>
    | Readonly<{ kind: 'refused'; by: 'trusted-server'; reason: AlmTrustedServerRejectionReason; }>
    | Readonly<{ kind: 'refused'; by: 'peer'; reason: AlmPeerRejectionReason; }>
    | Readonly<{ kind: 'refused'; by: 'receiver'; }>
    | Readonly<{ kind: 'handed-to-ws'; at: 'routing'; }>
    | Readonly<{ kind: 'handed-to-ws'; at: 'admission'; reason: ALDeliveryRefusalReason | ALDeliveryUnroutableReason; }>
    | Readonly<{ kind: 'handed-to-ws'; at: 'after-admission'; reason: ALDeliveryFallbackReason; }>
    | Readonly<
        { kind: 'undelivered'; failure: Extract<ALDeliveryFailure, Readonly<{ kind: 'skipped' | 'expired'; }>>; }
    >;

type AlmTrustedServerRejectionReason = Extract<
    ALDeliveryRelayRejection,
    Readonly<{ relay: 'trusted-server'; }>
>['reason'];

type AlmPeerRejectionReason = Extract<ALDeliveryRelayRejection, Readonly<{ relay: 'peer'; }>>['reason'];

/**
 * What shows a cell's outcome. A `lane-cell` is a scenario of the conformance catalogue, by its `scenarioKey`, which
 * runs over the cell's carrier in the `full` scope. A `unit-test` names a test file from the repository root and what
 * it pins, for an outcome the lane cannot stage. A `documented-limit` names the document that states `limit`. An
 * `unproven` proof names what will prove the part of the outcome nothing proves yet.
 */
export type AlmCarrierProof =
    | Readonly<{ kind: 'lane-cell'; scenarioKey: string; }>
    | Readonly<{ kind: 'unit-test'; testFile: string; because: string; }>
    | Readonly<{ kind: 'documented-limit'; document: string; limit: string; }>
    | Readonly<{ kind: 'unproven'; closedBy: string; }>;

export type AlmCarrierMatrixCell =
    | Readonly<
        { kind: 'stated'; outcome: AlmCarrierOutcome; proofs: readonly [AlmCarrierProof, ...AlmCarrierProof[]]; }
    >
    | Readonly<{ kind: 'not-applicable'; because: string; }>;

export interface AlmCarrierCapability {
    readonly statement: string;
    readonly cells: Readonly<Record<AlmConformanceCarrier, AlmCarrierMatrixCell>>;
}

export type AlmCarrierMatrix = Readonly<Record<string, AlmCarrierCapability>>;

/** D520: relays decode the payload and keep a forwarded copy; a forward-only copy never reaches their application. */
const RELAY_READABLE_PAYLOAD = {
    kind: 'documented-limit',
    document: 'playground/alm/alm-complete-product-description.md',
    limit: 'The payload is not confidential from relays.'
} as const satisfies AlmCarrierProof;

/** D515: a peer judges a granted frame against its cached room snapshot, which a heartbeat or a delta renews. */
const CACHED_AUTHORITY_REVOCATION_BOUND = {
    kind: 'documented-limit',
    document: 'playground/alm/alm-improvement-plan.md',
    limit: 'A revocation reaches a peer within one 20 s heartbeat, at worst 60 s after its snapshot\'s last renewal.'
} as const satisfies AlmCarrierProof;

/**
 * Each capability whose outcome differs by carrier on purpose, or that a single carrier proves, and what proves each
 * cell. A scenario a cell names runs over exactly the carriers that name it (`validateAlmCarrierMatrix`).
 */
export const ALM_CARRIER_MATRIX = {
    'exclusive-claim': {
        statement: 'An exclusive send claims its resource, and one arbiter decides: the WS server\'s admission store.',
        cells: {
            ws: {
                kind: 'stated',
                outcome: { kind: 'delivered' },
                proofs: [
                    { kind: 'lane-cell', scenarioKey: 'claim-first-wins' },
                    { kind: 'lane-cell', scenarioKey: 'claim-expires-reclaims' }
                ]
            },
            rtc: {
                kind: 'stated',
                outcome: { kind: 'refused', by: 'origin', reason: 'unsupported' },
                proofs: [{ kind: 'lane-cell', scenarioKey: 'claim-refused-on-rtc' }]
            },
            'rtc-with-ws-fallback': {
                kind: 'stated',
                outcome: { kind: 'handed-to-ws', at: 'routing' },
                proofs: [{ kind: 'lane-cell', scenarioKey: 'claim-first-wins' }]
            }
        }
    },
    'world-broadcast': {
        statement: 'A broadcast to the sender\'s authenticated scope reaches beyond a room, and the mesh is per room.',
        cells: {
            ws: {
                kind: 'stated',
                outcome: { kind: 'delivered' },
                proofs: [
                    { kind: 'lane-cell', scenarioKey: 'world-routing' },
                    { kind: 'lane-cell', scenarioKey: 'capacity-tracks' }
                ]
            },
            rtc: {
                kind: 'stated',
                outcome: { kind: 'refused', by: 'origin', reason: 'unsupported' },
                proofs: [{ kind: 'lane-cell', scenarioKey: 'world-routing' }]
            },
            'rtc-with-ws-fallback': {
                kind: 'stated',
                outcome: { kind: 'handed-to-ws', at: 'routing' },
                proofs: [
                    { kind: 'lane-cell', scenarioKey: 'world-routing' },
                    { kind: 'lane-cell', scenarioKey: 'capacity-tracks' }
                ]
            }
        }
    },
    'all-broadcast': {
        statement: 'A broadcast to every scope is the server\'s alone: no browser send names it on any carrier.',
        cells: {
            ws: {
                kind: 'stated',
                outcome: { kind: 'refused', by: 'call', path: '$.scope', code: 'invalid-scope' },
                proofs: [
                    {
                        kind: 'unit-test',
                        testFile: 'packages/tests/shared-web/messages/browser-message-audiences.test.ts',
                        because: 'A browser WS send names room, world or principal; `all` throws and enqueues nothing.'
                    },
                    {
                        kind: 'unit-test',
                        testFile: 'packages/tests/shared/services/ws-queue-box-server-ingress.test.ts',
                        because:
                            'The server refuses a client frame that names `all` as `unauthorized` and admits nothing.'
                    }
                ]
            },
            rtc: {
                kind: 'stated',
                outcome: { kind: 'refused', by: 'call', path: '$.scope', code: 'invalid-scope' },
                proofs: [
                    {
                        kind: 'unit-test',
                        testFile: 'packages/tests/shared-web/messages/browser-message-audiences.test.ts',
                        because: 'An rtc-strategy send that names `all` throws and produces no RTC admission.'
                    },
                    {
                        kind: 'unit-test',
                        testFile: 'packages/tests/shared/multicast/web-rtc-overlay-frozen-audience.test.ts',
                        because:
                            'An `all` broadcast that reaches the RTC origin is refused `unsupported` and sends nothing.'
                    }
                ]
            },
            'rtc-with-ws-fallback': {
                kind: 'stated',
                outcome: { kind: 'refused', by: 'call', path: '$.scope', code: 'invalid-scope' },
                proofs: [{
                    kind: 'unit-test',
                    testFile: 'packages/tests/shared-web/messages/browser-message-audiences.test.ts',
                    because: 'A fallback-strategy send that names `all` throws and admits on neither carrier.'
                }]
            }
        }
    },
    'server-peer-unicast': {
        statement: 'A unicast to the server peer travels WS: the server is no RTC peer.',
        cells: {
            ws: {
                kind: 'stated',
                outcome: { kind: 'delivered' },
                proofs: [{ kind: 'lane-cell', scenarioKey: 'server-command' }]
            },
            rtc: {
                kind: 'stated',
                outcome: { kind: 'refused', by: 'call', path: '$.peerId', code: 'unsupported' },
                proofs: [{
                    kind: 'unit-test',
                    testFile: 'packages/tests/shared-web/messages/browser-rtc-peer-send.test.ts',
                    because: 'The lane cannot witness a thrown call: the send throws before either carrier admits it.'
                }]
            },
            'rtc-with-ws-fallback': {
                kind: 'stated',
                outcome: { kind: 'refused', by: 'call', path: '$.peerId', code: 'unsupported' },
                proofs: [{
                    kind: 'unit-test',
                    testFile: 'packages/tests/shared-web/messages/browser-rtc-peer-send.test.ts',
                    because:
                        'The lane cannot witness a thrown call: the strategy does not route the send to WS, it throws.'
                }]
            }
        }
    },
    'peer-unicast': {
        statement: 'A unicast to a room member the origin reaches ends on the addressee\'s own receipt.',
        cells: {
            ws: {
                kind: 'stated',
                outcome: { kind: 'delivered' },
                proofs: [{ kind: 'lane-cell', scenarioKey: 'ws-unicast-receipt' }]
            },
            rtc: {
                kind: 'stated',
                outcome: { kind: 'delivered' },
                proofs: [{ kind: 'lane-cell', scenarioKey: 'ws-unicast-receipt' }]
            },
            'rtc-with-ws-fallback': {
                kind: 'stated',
                outcome: { kind: 'delivered' },
                proofs: [{ kind: 'lane-cell', scenarioKey: 'ws-unicast-receipt' }]
            }
        }
    },
    'peer-unicast-without-direct-route': {
        statement:
            'A members-channel unicast whose addressee the origin cannot send to directly is never relayed over RTC.',
        cells: {
            ws: {
                kind: 'not-applicable',
                because: 'The WS server routes every unicast: there is no direct route to lack.'
            },
            rtc: {
                kind: 'stated',
                outcome: { kind: 'undelivered', failure: { kind: 'expired' } },
                proofs: [
                    {
                        kind: 'unit-test',
                        testFile: 'packages/tests/shared/multicast/rtc-room-unicast-dispatch.test.ts',
                        because: 'Every attempt settles `not-ready` and nothing is sent to the addressee.'
                    },
                    {
                        kind: 'unit-test',
                        testFile: 'packages/tests/shared-web/messages/browser-rtc-peer-send.test.ts',
                        because: 'On rtc alone a run of `not-ready` attempts hands nothing over and fails no handle.'
                    },
                    { kind: 'unproven', closedBy: 'a unit pin of the kept unicast\'s handle at its deadline' }
                ]
            },
            'rtc-with-ws-fallback': {
                kind: 'stated',
                outcome: { kind: 'handed-to-ws', at: 'after-admission', reason: 'not-ready' },
                proofs: [
                    { kind: 'lane-cell', scenarioKey: 'unicast-fallback' },
                    {
                        kind: 'unit-test',
                        testFile: 'packages/tests/shared-web/messages/browser-rtc-peer-send.test.ts',
                        because:
                            'The `not-ready` bound hands the leg to WS; a missing addressee leaves at admission instead.'
                    }
                ]
            }
        }
    },
    'ordered-gap-repair': {
        statement: 'A gap inside the repair window is repaired by the hop that orders the track.',
        cells: {
            ws: {
                kind: 'stated',
                outcome: { kind: 'delivered' },
                proofs: [
                    { kind: 'lane-cell', scenarioKey: 'ordering-gap-repair' },
                    { kind: 'lane-cell', scenarioKey: 'seeded-loss-unreceipted-stream' }
                ]
            },
            rtc: {
                kind: 'stated',
                outcome: { kind: 'delivered' },
                proofs: [{ kind: 'lane-cell', scenarioKey: 'ordering-gap-repair' }]
            },
            'rtc-with-ws-fallback': {
                kind: 'stated',
                outcome: { kind: 'delivered' },
                proofs: [{
                    kind: 'unproven',
                    closedBy:
                        'one ordering track across the hand-over to WS, then `ordering-gap-repair` over this carrier'
                }]
            }
        }
    },
    'repair-budget-exhausted': {
        statement: 'A held gap whose repair budget every requester has spent ends its message.',
        cells: {
            ws: {
                kind: 'not-applicable',
                because: 'The server is the one gap requester: its repeated reports of a gap are one attempt.'
            },
            rtc: {
                kind: 'stated',
                outcome: { kind: 'undelivered', failure: { kind: 'skipped', reason: 'repair-exhausted' } },
                proofs: [{ kind: 'lane-cell', scenarioKey: 'repair-exhausted' }]
            },
            'rtc-with-ws-fallback': {
                kind: 'stated',
                outcome: { kind: 'handed-to-ws', at: 'after-admission', reason: 'not-ready' },
                proofs: [
                    {
                        kind: 'unit-test',
                        testFile: 'packages/tests/shared-web/messages/handed-over-send-held-on-ws.test.ts',
                        because:
                            'The handed-over copy, held on WS too, reads `submitted` to its deadline, then `expired`.'
                    },
                    {
                        kind: 'unproven',
                        closedBy: 'one lifecycle across the hand-over to WS, then a held-gap cell over this carrier'
                    }
                ]
            }
        }
    },
    'granted-audience-over-room-limit': {
        statement: 'A granted audience of more than 256 sessions does not fit the envelope RTC signs.',
        cells: {
            ws: {
                kind: 'stated',
                outcome: { kind: 'delivered' },
                proofs: [{
                    kind: 'unproven',
                    closedBy: 'a server test that delivers a granted publication to more than 256 subscribed sessions'
                }]
            },
            rtc: {
                kind: 'stated',
                outcome: { kind: 'refused', by: 'origin', reason: 'unsupported' },
                proofs: [
                    {
                        kind: 'unit-test',
                        testFile: 'packages/tests/shared/multicast/rtc-publication-signing.test.ts',
                        because: 'The lane cannot stage 257 sessions: the origin refuses the audience before it signs.'
                    },
                    {
                        kind: 'unit-test',
                        testFile: 'packages/tests/shared/multicast/publication/rtc-signed-publication-carrier.test.ts',
                        because: 'The carrier refuses a granted leg whose frozen audience passes the room limit.'
                    }
                ]
            },
            'rtc-with-ws-fallback': {
                kind: 'stated',
                outcome: { kind: 'handed-to-ws', at: 'admission', reason: 'unsupported' },
                proofs: [
                    {
                        kind: 'unit-test',
                        testFile: 'packages/tests/shared/multicast/rtc-publication-signing.test.ts',
                        because: 'The refusal is a verdict the strategy hands over, with the targets its sender gave.'
                    },
                    {
                        kind: 'unit-test',
                        testFile: 'packages/tests/shared-web/messages/browser-message-fallback-identity.test.ts',
                        because: 'A send whose room passes the limit moves to WS, the refused RTC leg its evidence row.'
                    }
                ]
            }
        }
    },
    'relay-payload-confidentiality': {
        statement: 'A relay that forwards a granted publication over RTC can read its payload.',
        cells: {
            ws: {
                kind: 'not-applicable',
                because: 'The trusted server is the only hop: a topic that needs subscriber-only bytes stays on ws.'
            },
            rtc: {
                kind: 'stated',
                outcome: { kind: 'delivered' },
                proofs: [
                    RELAY_READABLE_PAYLOAD,
                    { kind: 'lane-cell', scenarioKey: 'granted-rtc-relay-only' }
                ]
            },
            'rtc-with-ws-fallback': {
                kind: 'stated',
                outcome: { kind: 'delivered' },
                proofs: [RELAY_READABLE_PAYLOAD]
            }
        }
    },
    'publish-revocation': {
        statement:
            'A publication is refused once the authority that judges it reads the revoke of its sender\'s grant.',
        cells: {
            ws: {
                kind: 'stated',
                outcome: { kind: 'refused', by: 'trusted-server', reason: 'no-publish-grant' },
                proofs: [{
                    kind: 'unit-test',
                    testFile: 'apps/api-v1/test/services/ws-room-granted-delivery.test.ts',
                    because:
                        'The server re-reads the grant at socket admission, pending replay, inbox dispatch and route.'
                }]
            },
            rtc: {
                kind: 'stated',
                outcome: { kind: 'refused', by: 'origin', reason: 'no-publish-grant' },
                proofs: [
                    { kind: 'lane-cell', scenarioKey: 'granted-rtc-revoked-publisher' },
                    CACHED_AUTHORITY_REVOCATION_BOUND
                ]
            },
            'rtc-with-ws-fallback': {
                kind: 'stated',
                outcome: { kind: 'refused', by: 'origin', reason: 'no-publish-grant' },
                proofs: [
                    { kind: 'lane-cell', scenarioKey: 'granted-rtc-revoked-publisher' },
                    CACHED_AUTHORITY_REVOCATION_BOUND
                ]
            }
        }
    },
    'sender-authentication': {
        statement: 'A frame or a receipt without a valid proof of its sender is refused by the page it reaches.',
        cells: {
            ws: {
                kind: 'not-applicable',
                because: 'WS trusts the server\'s channel: the authenticated socket names the sender.'
            },
            rtc: {
                kind: 'stated',
                outcome: { kind: 'refused', by: 'receiver' },
                proofs: [
                    { kind: 'lane-cell', scenarioKey: 'granted-rtc-missing-proof' },
                    { kind: 'lane-cell', scenarioKey: 'granted-rtc-forged-sender' },
                    { kind: 'lane-cell', scenarioKey: 'unsigned-ack-refused' },
                    { kind: 'lane-cell', scenarioKey: 'forged-recipient-ack' }
                ]
            },
            'rtc-with-ws-fallback': {
                kind: 'stated',
                outcome: { kind: 'refused', by: 'receiver' },
                proofs: [{ kind: 'lane-cell', scenarioKey: 'unsigned-ack-refused' }]
            }
        }
    },
    reply: {
        statement: 'A reply to a request travels WS, whichever carrier the request arrived on.',
        cells: {
            ws: {
                kind: 'stated',
                outcome: { kind: 'delivered' },
                proofs: [
                    { kind: 'lane-cell', scenarioKey: 'reply-correlated' },
                    { kind: 'lane-cell', scenarioKey: 'reply-timeout-late' },
                    { kind: 'lane-cell', scenarioKey: 'reply-undelivered' },
                    { kind: 'lane-cell', scenarioKey: 'reply-first-wins' }
                ]
            },
            rtc: {
                kind: 'stated',
                outcome: { kind: 'delivered' },
                proofs: [
                    {
                        kind: 'unit-test',
                        testFile: 'packages/tests/shared-web/messages/reply/browser-message-reply-inbox.test.ts',
                        because: 'The reply inbox subscribes the WS inbox alone, so only a reply over WS is matched.'
                    },
                    { kind: 'unproven', closedBy: '`reply-correlated` over this carrier' }
                ]
            },
            'rtc-with-ws-fallback': {
                kind: 'stated',
                outcome: { kind: 'delivered' },
                proofs: [{ kind: 'lane-cell', scenarioKey: 'reply-correlated' }]
            }
        }
    },
    'left-sender-send': {
        statement: 'A room send from a member that left is refused by whoever judges the roster first.',
        cells: {
            ws: {
                kind: 'stated',
                outcome: { kind: 'refused', by: 'trusted-server', reason: 'membership-fenced' },
                proofs: [{ kind: 'lane-cell', scenarioKey: 'fenced-rejection' }]
            },
            rtc: {
                kind: 'stated',
                outcome: { kind: 'refused', by: 'origin', reason: 'unauthorized' },
                proofs: [
                    {
                        kind: 'unit-test',
                        testFile: 'packages/tests/shared/multicast/room-authority/rtc-room-snapshot-admission.test.ts',
                        because: 'The origin\'s own room authority judges an inactive own member `unauthorized`.'
                    },
                    { kind: 'unproven', closedBy: 'a left-sender cell over this carrier, beside `fenced-rejection`' }
                ]
            },
            'rtc-with-ws-fallback': {
                kind: 'stated',
                outcome: { kind: 'refused', by: 'origin', reason: 'unauthorized' },
                proofs: [{ kind: 'unproven', closedBy: 'a left-sender cell over this carrier' }]
            }
        }
    },
    'resync-recovery-owner': {
        statement:
            'A gap past the repair window is refused where the track is ordered; a receiver that orders it tells its recovery owner.',
        cells: {
            ws: {
                kind: 'stated',
                outcome: { kind: 'refused', by: 'trusted-server', reason: 'resync-required' },
                proofs: [
                    { kind: 'lane-cell', scenarioKey: 'ordering-resync' },
                    {
                        kind: 'unproven',
                        closedBy: 'an absent `recovery-owner-invoked` wait in `ordering-resync` over this carrier'
                    }
                ]
            },
            rtc: {
                kind: 'stated',
                outcome: { kind: 'refused', by: 'peer', reason: 'resync-required' },
                proofs: [{ kind: 'lane-cell', scenarioKey: 'ordering-resync' }]
            },
            'rtc-with-ws-fallback': {
                kind: 'stated',
                outcome: { kind: 'refused', by: 'peer', reason: 'resync-required' },
                proofs: [{ kind: 'lane-cell', scenarioKey: 'ordering-resync' }]
            }
        }
    },
    'snapshot-floor-catch-up': {
        statement: 'A send floored one snapshot past its sender\'s is delivered once the roster moves.',
        cells: {
            ws: {
                kind: 'stated',
                outcome: { kind: 'delivered' },
                proofs: [{ kind: 'lane-cell', scenarioKey: 'fenced-catch-up' }]
            },
            rtc: {
                kind: 'stated',
                outcome: { kind: 'delivered' },
                proofs: [{ kind: 'lane-cell', scenarioKey: 'fenced-catch-up' }]
            },
            'rtc-with-ws-fallback': {
                kind: 'stated',
                outcome: { kind: 'delivered' },
                proofs: [{
                    kind: 'unproven',
                    closedBy: 'one lifecycle across the hand-over to WS, then `fenced-catch-up` over this carrier'
                }]
            }
        }
    }
} as const satisfies AlmCarrierMatrix;
