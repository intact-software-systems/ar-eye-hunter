import type { ALReceiptProofRefusal } from '@shared/al-contracts/receipt-proof/al-receipt-proof.ts';
import type { ALDeliveryFailure } from '@shared/alm/delivery/al-delivery-failure.ts';
import type {
    ALDeliveryFallbackReason,
    ALDeliveryRefusalReason,
    ALDeliveryRelayRejection,
    ALDeliveryUnroutableReason
} from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type { RtcPublicationRefusalCode } from '@shared/multicast/publication/compute-rtc-publication-admission.ts';

import type { AlmConformanceCarrier } from '../alm-conformance-carriers.ts';

/**
 * What the send a capability names comes to on one carrier.
 *
 * `refused` names who refuses. The `call` throws a validation issue and returns no handle; a reply wait's refusal is
 * its call's resolved value instead, with that issue. The `origin` ends the handle `rejected` before any carrier
 * attempt. The `trusted-server` and a `peer` hop refuse the send at their own
 * admission and answer the hop that sent it with a NACK. The origin admits a peer's NACK only from a peer the send
 * owes: a unicast's addressee, a peer its receipt expects, a session a server admitted the send to, or a hop its
 * carrier sends every frame through. It states an admitted NACK as a rejection by that relay, except that a
 * `membership-fenced` NACK, and the trusted server's `unauthorized` or `no-leader`, is a rejection only while the send
 * has no receipt row: with one, an admitted `membership-fenced` or `unauthorized` NACK ends the send's receipt
 * `receipt-exhausted`, cause `hop-refused`. The `receiver` refuses the proof `of` a frame or of a receipt at its own
 * inbound admission with `code`, delivers and counts nothing, and answers nothing; a frame the page's room admission
 * refuses keeps the room's refusal instead.
 *
 * `handed-to-ws` names where the fallback strategy leaves RTC: at `routing` the browser sends over WS at once, one WS
 * attempt and no hand-over evidence; at `admission` the RTC leg's verdict, refused or unroutable, is the evidence row
 * of the leg that WS follows; after admission the D56 hand-over moves a message RTC had admitted.
 *
 * `undelivered` ends the handle with that failure and no recipient: `failed` for `skipped` and `unroutable`, `expired`
 * for `expired`.
 */
export type AlmCarrierOutcome =
    | Readonly<{ kind: 'delivered'; }>
    | Readonly<{ kind: 'refused'; by: 'call'; path: string; code: string; }>
    | Readonly<{ kind: 'refused'; by: 'origin'; reason: ALDeliveryRefusalReason; }>
    | Readonly<{ kind: 'refused'; by: 'trusted-server'; reason: AlmTrustedServerRejectionReason; }>
    | Readonly<{ kind: 'refused'; by: 'peer'; reason: AlmPeerRejectionReason; }>
    | Readonly<{ kind: 'refused'; by: 'receiver'; of: 'frame'; code: RtcPublicationRefusalCode; }>
    | Readonly<{ kind: 'refused'; by: 'receiver'; of: 'receipt'; code: ALReceiptProofRefusal['kind']; }>
    | Readonly<{ kind: 'handed-to-ws'; at: 'routing'; }>
    | Readonly<{ kind: 'handed-to-ws'; at: 'admission'; reason: ALDeliveryRefusalReason | ALDeliveryUnroutableReason; }>
    | Readonly<{ kind: 'handed-to-ws'; at: 'after-admission'; reason: ALDeliveryFallbackReason; }>
    | Readonly<{
        kind: 'undelivered';
        failure: Extract<ALDeliveryFailure, Readonly<{ kind: 'skipped' | 'expired' | 'unroutable'; }>>;
    }>;

type AlmTrustedServerRejectionReason = Extract<
    ALDeliveryRelayRejection,
    Readonly<{ relay: 'trusted-server'; }>
>['reason'];

type AlmPeerRejectionReason = Extract<ALDeliveryRelayRejection, Readonly<{ relay: 'peer'; }>>['reason'];

/**
 * What shows a cell's outcome. A `lane-cell` is a scenario of the conformance catalogue, by its `scenarioKey`, which
 * runs over the cell's carrier in the `full` scope; absent a `because` it shows the cell's whole outcome, and with one
 * it shows only the part the `because` names. A `unit-test` names a test file from the repository root, one test in it
 * by a part of its title, and what that test pins. A `documented-limit` names a document from the repository root and
 * the phrase of it that states the limit. An `unproven` proof names what will prove the part of the outcome nothing
 * proves yet.
 */
export type AlmCarrierProof =
    | Readonly<{ kind: 'lane-cell'; scenarioKey: string; because?: string; }>
    | Readonly<{ kind: 'unit-test'; testFile: string; testName: string; because: string; }>
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
    limit: 'payload is not confidential from relays'
} as const satisfies AlmCarrierProof;

/** D515: a peer judges a granted frame against its cached room snapshot, which a heartbeat or a delta renews. */
const CACHED_AUTHORITY_REVOCATION_BOUND = {
    kind: 'documented-limit',
    document: 'playground/alm/alm-improvement-plan.md',
    limit: 'at worst 60 s after the snapshot\'s last renewal'
} as const satisfies AlmCarrierProof;

const RTC_RELAY_PUBLICATION_PROOF_TEST = 'packages/tests/shared/multicast/rtc-relay-publication-proof.test.ts';

/**
 * What a hop that holds no `subscribe` does with a granted frame. No lane run forces a frame through such a hop, so
 * this is what either RTC strategy shows of the forwarding half.
 */
const RELAY_WITHOUT_SUBSCRIBE_FORWARDS = {
    kind: 'unit-test',
    testFile: RTC_RELAY_PUBLICATION_PROOF_TEST,
    testName: 'forwards at a relay without subscribe, delivering nothing there, and the copy verifies at the next hop',
    because:
        'A hop that holds no `subscribe` forwards a granted frame to its next hop, where the copy verifies and is delivered, and delivers nothing to its own application; its admission is given the frame and its channel peer, not the strategy that sent it.'
} as const satisfies AlmCarrierProof;

/**
 * A frozen recipient whose `subscribe` was revoked after the freeze: the frozen audience lets it deliver, so its own
 * grant check is the only gate.
 */
const RELAY_REVOKED_AFTER_FREEZE_FORWARDS = {
    kind: 'unit-test',
    testFile: RTC_RELAY_PUBLICATION_PROOF_TEST,
    testName: 'forwards at a frozen recipient whose subscribe was revoked after the freeze, delivering nothing there',
    because:
        'The grant check alone keeps a session whose `subscribe` was revoked after the origin froze it into the audience from delivering: it forwards the granted frame to its next hop, where the copy verifies and is delivered, and delivers nothing to its own application.'
} as const satisfies AlmCarrierProof;

/** The RTC cell of a publication whose sender has not read its revoke: what either RTC strategy shows of it. */
const REVOKED_PUBLICATION_DROPPED_BY_A_HOP = {
    kind: 'stated',
    outcome: { kind: 'refused', by: 'receiver', of: 'frame', code: 'no-publish-grant' },
    proofs: [
        {
            kind: 'unit-test',
            testFile: RTC_RELAY_PUBLICATION_PROOF_TEST,
            testName: 'drops a frame its publisher signed before a revoke the relay has since observed',
            because:
                'A hop that has observed the revoke drops the frame `unauthorized: no-publish-grant` and forwards nothing.'
        },
        CACHED_AUTHORITY_REVOCATION_BOUND
    ]
} as const satisfies AlmCarrierMatrixCell;

const RTC_ROOM_SNAPSHOT_ADMISSION_TEST =
    'packages/tests/shared/multicast/room-authority/rtc-room-snapshot-admission.test.ts';
const AL_OUTBOUND_CONTROL_ADMISSION_TEST = 'packages/tests/shared/alm/al-outbound-control-admission.test.ts';

/** The RTC cell of a room send from a member that left: what either RTC strategy shows of it. */
const LEFT_SENDER_FENCED_BY_A_RECEIVER = {
    kind: 'stated',
    outcome: { kind: 'refused', by: 'peer', reason: 'membership-fenced' },
    proofs: [
        {
            kind: 'unit-test',
            testFile: RTC_ROOM_SNAPSHOT_ADMISSION_TEST,
            testName: 'fences a sender with no live session in a roster beyond its stamp',
            because: 'A receiver whose roster is beyond the copy\'s stamp fences a sender with no live session in it.'
        },
        {
            kind: 'unit-test',
            testFile: RTC_ROOM_SNAPSHOT_ADMISSION_TEST,
            testName: 'plans a fenced refusal as membership-fenced with a NACK to the immediate hop',
            because: 'The receiver drops a fenced copy and NACKs its hop `membership-fenced`.'
        },
        {
            kind: 'unit-test',
            testFile: AL_OUTBOUND_CONTROL_ADMISSION_TEST,
            testName: 'states a peer membership-fenced NACK before any receipt row as rejected by that peer',
            because:
                'The origin of a unicast that holds no receipt row reads its addressee\'s `membership-fenced` NACK as a rejection by that peer.'
        },
        {
            kind: 'unit-test',
            testFile: AL_OUTBOUND_CONTROL_ADMISSION_TEST,
            testName: 'ends a receipt a hop refused for good',
            because:
                'Once a receipt row exists, the origin reads the same NACK as the end of the send\'s receipt, `receipt-exhausted` with cause `hop-refused`, and not as a rejection.'
        },
        {
            kind: 'unit-test',
            testFile: AL_OUTBOUND_CONTROL_ADMISSION_TEST,
            testName: 'still refuses a membership-fenced NACK from a peer the send owes nothing',
            because:
                'A room send that asked no receipt owes no peer an answer: its origin refuses the NACK and states nothing.'
        },
        {
            kind: 'unit-test',
            testFile: AL_OUTBOUND_CONTROL_ADMISSION_TEST,
            testName:
                'still refuses a frozen recipient\'s membership-fenced NACK for a receiptless room send frozen to an audience',
            because:
                'The origin of a receiptless room send frozen to an audience refuses a frozen recipient\'s `membership-fenced` NACK and states nothing.'
        },
        {
            kind: 'unproven',
            closedBy:
                'a left-sender cell over this carrier; a page that has read its own leave holds the send `pending-authority`, and nothing pins how that ends'
        }
    ]
} as const satisfies AlmCarrierMatrixCell;

const BROWSER_MESSAGE_AUDIENCES_TEST = 'packages/tests/shared-web/messages/browser-message-audiences.test.ts';
const BROWSER_RTC_PEER_SEND_TEST = 'packages/tests/shared-web/messages/browser-rtc-peer-send.test.ts';
const RTC_ROOM_UNICAST_DISPATCH_TEST = 'packages/tests/shared/multicast/rtc-room-unicast-dispatch.test.ts';
const WEB_RTC_OVERLAY_FROZEN_AUDIENCE_TEST = 'packages/tests/shared/multicast/web-rtc-overlay-frozen-audience.test.ts';
const RTC_PUBLICATION_SIGNING_TEST = 'packages/tests/shared/multicast/rtc-publication-signing.test.ts';
const BROWSER_MESSAGE_FALLBACK_IDENTITY_TEST =
    'packages/tests/shared-web/messages/browser-message-fallback-identity.test.ts';
const WS_CLIENT_RELAY_REJECTION_TEST = 'packages/tests/shared/services/ws-queue-box-client-relay-rejection.test.ts';

/** Why a row about a frame's proof of origin does not apply to `ws`. */
const WS_SEND_CARRIES_NO_PROOF =
    'A WS send carries no proof: the authenticated socket names its sender, and the server verifies only the proof a handed-over copy carries.';

/** The browser's refusal of a room send routed in another room, which every strategy throws before any carrier. */
const ROOM_SEND_NAMING_ANOTHER_ROOM_REFUSED_AT_THE_CALL = {
    kind: 'unit-test',
    testFile: BROWSER_MESSAGE_AUDIENCES_TEST,
    testName:
        'refuses a room send whose contextId names another room at the call on %s, before the connect and before either carrier',
    because:
        'A room send whose `contextId` is not its room id throws `context-room-mismatch` at `$.contextId`, connects nothing and admits on neither carrier.'
} as const satisfies AlmCarrierProof;

/** D82: no RTC receiver checks a frame's context against its room, so only the browser's own refusal stands there. */
const RTC_RECEIVER_CHECKS_NO_ROOM_CONTEXT = {
    kind: 'documented-limit',
    document: 'docs/rallar-api-reference.md',
    limit: 'a frame that did not pass this refusal is still delivered over RTC'
} as const satisfies AlmCarrierProof;

/**
 * Each capability whose outcome differs by carrier on purpose, or that a single carrier proves, and what proves each
 * cell. A scenario a cell names runs over exactly the carriers that name it: it takes them from here
 * (`resolveAlmCarrierMatrixCellCarriers`).
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
                proofs: [{ kind: 'lane-cell', scenarioKey: 'world-routing' }]
            },
            rtc: {
                kind: 'stated',
                outcome: { kind: 'refused', by: 'origin', reason: 'unsupported' },
                proofs: [{ kind: 'lane-cell', scenarioKey: 'world-routing' }]
            },
            'rtc-with-ws-fallback': {
                kind: 'stated',
                outcome: { kind: 'handed-to-ws', at: 'routing' },
                proofs: [{ kind: 'lane-cell', scenarioKey: 'world-routing' }]
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
                        testFile: BROWSER_MESSAGE_AUDIENCES_TEST,
                        testName: 'names the three scopes a browser WS send may take',
                        because:
                            'A browser WS send names room, world or principal; `all` throws `invalid-scope` at `$.scope` and enqueues nothing.'
                    },
                    {
                        kind: 'unit-test',
                        testFile: 'packages/tests/shared/services/ws-queue-box-server-ingress.test.ts',
                        testName: 'refuses %s from a client as %s and admits nothing',
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
                        testFile: BROWSER_MESSAGE_AUDIENCES_TEST,
                        testName: 'an rtc-strategy send with an invalid scope produces no RTC admission',
                        because: 'An rtc-strategy send that names `all` throws and produces no RTC admission.'
                    },
                    {
                        kind: 'unit-test',
                        testFile: WEB_RTC_OVERLAY_FROZEN_AUDIENCE_TEST,
                        testName: 'refuses a %s broadcast that names no room as unsupported, sending nothing',
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
                    testFile: BROWSER_MESSAGE_AUDIENCES_TEST,
                    testName: 'a %s send with an invalid scope produces no admission on either carrier',
                    because: 'A fallback-strategy send that names `all` throws and admits on neither carrier.'
                }]
            }
        }
    },
    'room-send-naming-another-room': {
        statement:
            'A room send whose `contextId` is not its room id is refused at the call on every strategy; a modified client\'s frame is refused `unauthorized` by the WS server and is not checked by an RTC receiver.',
        cells: {
            ws: {
                kind: 'stated',
                outcome: { kind: 'refused', by: 'call', path: '$.contextId', code: 'context-room-mismatch' },
                proofs: [
                    ROOM_SEND_NAMING_ANOTHER_ROOM_REFUSED_AT_THE_CALL,
                    {
                        kind: 'unit-test',
                        testFile:
                            'packages/tests/shared-server/rallar-system/websocket/router/rallar-server-ws-room-route-context.test.ts',
                        testName: 'refuses a %s whose route names another room than its groupRef as unauthorized',
                        because:
                            'The WS server refuses a client frame whose `route.contextId` names another room than its `groupRef` as `unauthorized`, whatever its audience.'
                    }
                ]
            },
            rtc: {
                kind: 'stated',
                outcome: { kind: 'refused', by: 'call', path: '$.contextId', code: 'context-room-mismatch' },
                proofs: [ROOM_SEND_NAMING_ANOTHER_ROOM_REFUSED_AT_THE_CALL, RTC_RECEIVER_CHECKS_NO_ROOM_CONTEXT]
            },
            'rtc-with-ws-fallback': {
                kind: 'stated',
                outcome: { kind: 'refused', by: 'call', path: '$.contextId', code: 'context-room-mismatch' },
                proofs: [ROOM_SEND_NAMING_ANOTHER_ROOM_REFUSED_AT_THE_CALL, RTC_RECEIVER_CHECKS_NO_ROOM_CONTEXT]
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
                    testFile: BROWSER_RTC_PEER_SEND_TEST,
                    testName: 'refuses a send to the server on %s',
                    because: 'The lane cannot witness a thrown call: the send throws before either carrier admits it.'
                }]
            },
            'rtc-with-ws-fallback': {
                kind: 'stated',
                outcome: { kind: 'refused', by: 'call', path: '$.peerId', code: 'unsupported' },
                proofs: [{
                    kind: 'unit-test',
                    testFile: BROWSER_RTC_PEER_SEND_TEST,
                    testName: 'refuses a send to the server on %s',
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
    'peer-unicast-to-unready-addressee': {
        statement:
            'A members-channel unicast whose addressee is missing from the origin\'s non-empty set of ready RTC peers has no RTC route and is never relayed.',
        cells: {
            ws: {
                kind: 'not-applicable',
                because: 'The WS server routes every unicast: the origin holds no ready set to miss the addressee from.'
            },
            rtc: {
                kind: 'stated',
                outcome: { kind: 'undelivered', failure: { kind: 'unroutable', reason: 'no-route' } },
                proofs: [
                    {
                        kind: 'unit-test',
                        testFile: RTC_ROOM_UNICAST_DISPATCH_TEST,
                        testName: 'refuses it at admission as unroutable no-route when the addressee is missing',
                        because:
                            'The origin refuses it at admission as `unroutable`/`no-route` and sends the addressee nothing.'
                    },
                    {
                        kind: 'unit-test',
                        testFile: BROWSER_RTC_PEER_SEND_TEST,
                        testName: 'ends failed when the addressee has no route',
                        because: 'On rtc alone the handle ends `failed` with `unroutable`/`no-route` and no WS leg.'
                    }
                ]
            },
            'rtc-with-ws-fallback': {
                kind: 'stated',
                outcome: { kind: 'handed-to-ws', at: 'admission', reason: 'no-route' },
                proofs: [
                    {
                        kind: 'unit-test',
                        testFile: RTC_ROOM_UNICAST_DISPATCH_TEST,
                        testName: 'refuses it at admission as unroutable no-route when the addressee is missing',
                        because: 'The RTC origin answers the admission `unroutable`/`no-route`.'
                    },
                    {
                        kind: 'unit-test',
                        testFile: BROWSER_RTC_PEER_SEND_TEST,
                        testName: 'falls back at admission when the addressee is missing from a non-empty ready set',
                        because:
                            'The `no-route` verdict moves the same envelope to WS at admission, with no hand-over, and it ends on the WS receipt.'
                    }
                ]
            }
        }
    },
    'peer-unicast-off-overlay-next-hop': {
        statement:
            'A members-channel unicast whose addressee is ready but is not the origin\'s overlay next hop is never relayed over RTC: every attempt settles `not-ready`.',
        cells: {
            ws: {
                kind: 'not-applicable',
                because: 'The WS server routes every unicast: no overlay edge decides it.'
            },
            rtc: {
                kind: 'stated',
                outcome: { kind: 'undelivered', failure: { kind: 'expired' } },
                proofs: [
                    {
                        kind: 'unit-test',
                        testFile: RTC_ROOM_UNICAST_DISPATCH_TEST,
                        testName:
                            'settles every attempt not-ready when the addressee is directly ready but not the overlay next hop',
                        because: 'Every attempt settles `not-ready` and nothing is sent to the addressee.'
                    },
                    {
                        kind: 'unit-test',
                        testFile: BROWSER_RTC_PEER_SEND_TEST,
                        testName: 'keeps the message on RTC through any run of not-ready attempts',
                        because: 'On rtc alone a run of `not-ready` attempts hands nothing over and fails no handle.'
                    },
                    {
                        kind: 'unit-test',
                        testFile: BROWSER_RTC_PEER_SEND_TEST,
                        testName: 'ends expired at its deadline when every attempt settled not-ready',
                        because: 'On rtc alone the kept unicast reads `expired` at its deadline, and no WS leg starts.'
                    }
                ]
            },
            'rtc-with-ws-fallback': {
                kind: 'stated',
                outcome: { kind: 'handed-to-ws', at: 'after-admission', reason: 'not-ready' },
                proofs: [
                    { kind: 'lane-cell', scenarioKey: 'unicast-fallback' },
                    {
                        kind: 'unit-test',
                        testFile: RTC_ROOM_UNICAST_DISPATCH_TEST,
                        testName:
                            'settles every attempt not-ready when the addressee is directly ready but not the overlay next hop',
                        because:
                            'An addressee that is ready but not the overlay next hop settles every attempt `not-ready`.'
                    },
                    {
                        kind: 'unit-test',
                        testFile: BROWSER_RTC_PEER_SEND_TEST,
                        testName: 'hands the leg to WS after the not-ready bound',
                        because:
                            'The third `not-ready` attempt hands the same envelope to WS, and it ends on the WS receipt.'
                    }
                ]
            }
        }
    },
    'granted-receiver-unicast-to-non-subscriber': {
        statement:
            'A granted `receiver` unicast to a session that holds no `subscribe` on its topic, or to its own sender, is refused `unauthorized`: by the WS server from its live audience, and over RTC by the origin from its cached snapshot, unless a fallback carrier takes it and the WS server decides.',
        cells: {
            ws: {
                kind: 'stated',
                outcome: { kind: 'refused', by: 'trusted-server', reason: 'unauthorized' },
                proofs: [
                    {
                        kind: 'unit-test',
                        testFile: 'packages/tests/shared/services/ws-queue-box-server-addressed-receipts.test.ts',
                        testName:
                            'refuses a room unicast to a session outside the admitted audience before admission, with a NACK',
                        because:
                            'The WS server refuses a room unicast to a session outside the audience its room admitted `unauthorized` before admission, with a NACK.'
                    },
                    {
                        kind: 'unit-test',
                        testFile: 'packages/tests/shared/services/ws-queue-box-server-addressed-receipts.test.ts',
                        testName: 'refuses a room unicast to its own sender before admission, with a NACK',
                        because:
                            'It refuses a room unicast to its own sender the same way, though that audience holds it.'
                    },
                    {
                        kind: 'unit-test',
                        testFile: WS_CLIENT_RELAY_REJECTION_TEST,
                        testName:
                            'states the server refusing a room unicast to a non-member before admission; the receipted handle reads rejected (C3)',
                        because:
                            'The origin states that NACK as the trusted server\'s rejection: the receipted handle reads `rejected`.'
                    },
                    {
                        kind: 'unit-test',
                        testFile:
                            'packages/tests/shared-server/rallar-system/websocket/room-publication/compute-room-publication-admission.test.ts',
                        testName: 'the audience holds only subscribe-granted principals',
                        because:
                            'On a granted topic the audience the room admits holds only the live sessions of principals granted `subscribe`.'
                    }
                ]
            },
            rtc: {
                kind: 'stated',
                outcome: { kind: 'refused', by: 'origin', reason: 'unauthorized' },
                proofs: [
                    {
                        kind: 'unit-test',
                        testFile: RTC_PUBLICATION_SIGNING_TEST,
                        testName:
                            'as unauthorized on a leg with no fallback carrier: nothing sent, nothing stored, no receipt',
                        because:
                            'With no fallback carrier the origin refuses it `unauthorized` from its cached snapshot, a non-holder and its own session holding `subscribe` alike, and sends, stores and receipts nothing.'
                    },
                    {
                        kind: 'unit-test',
                        testFile: 'packages/tests/shared-web/messages/browser-granted-channel.test.ts',
                        testName: 'under rtc settles rejected refused/unauthorized, with no WS leg',
                        because:
                            'On rtc alone the handle ends `rejected` `unauthorized`, with no attempt and no WS leg.'
                    }
                ]
            },
            'rtc-with-ws-fallback': {
                kind: 'stated',
                outcome: { kind: 'handed-to-ws', at: 'admission', reason: 'no-route' },
                proofs: [
                    {
                        kind: 'unit-test',
                        testFile: RTC_PUBLICATION_SIGNING_TEST,
                        testName:
                            'unroutable no-route on a leg with a fallback carrier, naming the unicast its sender gave',
                        because:
                            'With a fallback carrier the origin answers `unroutable`/`no-route` with the unicast its sender gave, and sends, stores and receipts nothing.'
                    },
                    {
                        kind: 'unit-test',
                        testFile: 'packages/tests/shared-web/messages/browser-granted-channel.test.ts',
                        testName:
                            'under rtc-with-ws-fallback moves the unicast to WS at admission and ends on the server',
                        because:
                            'The `no-route` verdict moves the unicast to WS at admission, with no hand-over, and it ends `rejected` on the WS server\'s `unauthorized`; the test injects that NACK, which the `ws` cell shows the server answers.'
                    },
                    {
                        kind: 'unit-test',
                        testFile: 'packages/tests/shared-web/messages/browser-granted-channel.test.ts',
                        testName: 'ends acknowledged on WS when the server delivers it',
                        because:
                            'When the origin\'s cached snapshot was stale and the server\'s live audience holds the addressee, it ends on the WS receipt.'
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
                        'a gap cell over this carrier whose track stays on RTC; a frame its sender holds is handed to WS, whose relay gates it as its own gap, until one ordering track spans the hand-over (product work)'
                }]
            }
        }
    },
    'repair-budget-exhausted': {
        statement: 'A gap whose requester has spent its repair budget ends the message it asks for.',
        cells: {
            ws: {
                kind: 'stated',
                outcome: { kind: 'undelivered', failure: { kind: 'skipped', reason: 'repair-exhausted' } },
                proofs: [
                    {
                        kind: 'unit-test',
                        testFile: 'packages/tests/shared/alm/outbound-repair-lost-frame.test.ts',
                        testName: 'a written ack-none send carries no marker until its requester\'s budget runs out',
                        because:
                            'A WS sender settles `skipped`/`repair-exhausted` and ends the message at the server\'s request past its budget.'
                    },
                    { kind: 'lane-cell', scenarioKey: 'repair-exhausted' }
                ]
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
                        testName: 'it reads submitted until its deadline and expired after it',
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
    'room-audience-over-frame-limit': {
        statement:
            'A room send to more than 256 recipient sessions does not fit an RTC frame, which carries its frozen audience.',
        cells: {
            ws: {
                kind: 'stated',
                outcome: { kind: 'delivered' },
                proofs: [
                    {
                        kind: 'unit-test',
                        testFile: 'packages/tests/shared-server/rallar-system/rallar-server-ws-router.test.ts',
                        testName: 'room broadcast to a room larger than the wire collection limit',
                        because:
                            'The server delivers an outbox-fanned room broadcast to a room of 300 sessions, and no copy lists its audience.'
                    },
                    {
                        kind: 'unit-test',
                        testFile: 'apps/api-v1/test/services/ws-room-granted-delivery.test.ts',
                        testName:
                            'a granted publication reaches each of 257 subscribed sessions once, with no audience on the wire',
                        because:
                            'The server delivers a granted publication to each of 257 subscribed sessions once, and no copy lists its audience: each session\'s subscription generation is kept on the stored row beside the message, not in the frame.'
                    },
                    {
                        kind: 'documented-limit',
                        document: 'packages/shared/alm/receipt-record/README.md',
                        limit: 'A send to more than 256 recipients is admitted and gets no receipt'
                    }
                ]
            },
            rtc: {
                kind: 'stated',
                outcome: { kind: 'refused', by: 'origin', reason: 'unsupported' },
                proofs: [
                    {
                        kind: 'unit-test',
                        testFile: WEB_RTC_OVERLAY_FROZEN_AUDIENCE_TEST,
                        testName: 'send to a room of 300 sessions as unsupported, naming the bound and sending nothing',
                        because:
                            'The lane cannot stage a room this large: the origin refuses a room send to 299 recipients as `unsupported` and sends nothing.'
                    },
                    {
                        kind: 'unit-test',
                        testFile: RTC_PUBLICATION_SIGNING_TEST,
                        testName: 'whose narrowed audience passes the RTC room limit as unsupported before it signs',
                        because: 'The origin refuses a granted audience over the limit before it signs.'
                    },
                    {
                        kind: 'unit-test',
                        testFile: 'packages/tests/shared/multicast/publication/rtc-signed-publication-carrier.test.ts',
                        testName:
                            'refuses a granted leg whose frozen audience passes the RTC room limit as unsupported',
                        because: 'The carrier refuses a granted leg whose frozen audience passes the room limit.'
                    },
                    {
                        kind: 'unit-test',
                        testFile: BROWSER_MESSAGE_FALLBACK_IDENTITY_TEST,
                        testName: 'whose RTC room exceeds the wire audience bound',
                        because:
                            'On rtc alone the handle ends `rejected`, the refusal its reason, and no WS leg starts.'
                    }
                ]
            },
            'rtc-with-ws-fallback': {
                kind: 'stated',
                outcome: { kind: 'handed-to-ws', at: 'admission', reason: 'unsupported' },
                proofs: [
                    {
                        kind: 'unit-test',
                        testFile: BROWSER_MESSAGE_FALLBACK_IDENTITY_TEST,
                        testName: 'whose RTC room exceeds the wire audience bound',
                        because: 'A room send over the limit moves to WS, the refused RTC leg its evidence row.'
                    },
                    {
                        kind: 'unit-test',
                        testFile: RTC_PUBLICATION_SIGNING_TEST,
                        testName: 'whose narrowed audience passes the RTC room limit as unsupported before it signs',
                        because: 'The refusal is a verdict the strategy hands over, with the targets its sender gave.'
                    }
                ]
            }
        }
    },
    'relay-payload-confidentiality': {
        statement:
            'A relay that holds no `subscribe` forwards a granted publication over RTC and can read its payload, and it delivers nothing to its own application.',
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
                    {
                        kind: 'lane-cell',
                        scenarioKey: 'granted-rtc-relay-only',
                        because:
                            'The subscriber receives the publication over RTC, and the session that holds `publish` alone delivers nothing to its application. The run does not force the frame through that session, so it does not show it forwarding.'
                    },
                    RELAY_WITHOUT_SUBSCRIBE_FORWARDS,
                    RELAY_REVOKED_AFTER_FREEZE_FORWARDS
                ]
            },
            'rtc-with-ws-fallback': {
                kind: 'stated',
                outcome: { kind: 'delivered' },
                proofs: [
                    RELAY_READABLE_PAYLOAD,
                    {
                        kind: 'unit-test',
                        testFile: 'packages/tests/shared-web/messages/browser-granted-channel.test.ts',
                        testName: 'an ack: none room send under %s is admitted on RTC carrying its origin\'s proof',
                        because:
                            'Under the fallback strategy an `ack: none` granted room publication is admitted on RTC and carries its origin\'s proof, as under the `rtc` strategy.'
                    },
                    RELAY_WITHOUT_SUBSCRIBE_FORWARDS,
                    RELAY_REVOKED_AFTER_FREEZE_FORWARDS
                ]
            }
        }
    },
    'revoked-publish-known-to-sender': {
        statement:
            'A granted publication whose sender has read the revoke of its own `publish` grant is refused by the sender\'s page before any carrier takes it.',
        cells: {
            ws: {
                kind: 'stated',
                outcome: { kind: 'refused', by: 'origin', reason: 'no-publish-grant' },
                proofs: [{
                    kind: 'unit-test',
                    testFile: 'packages/tests/shared-web/messages/browser-granted-channel.test.ts',
                    testName:
                        'a send without a cached publish grant settles rejected with refused/no-publish-grant before any leg',
                    because:
                        'A send whose cached snapshot grants no `publish` ends `rejected` before any leg, `sendWs` included.'
                }]
            },
            rtc: {
                kind: 'stated',
                outcome: { kind: 'refused', by: 'origin', reason: 'no-publish-grant' },
                proofs: [{ kind: 'lane-cell', scenarioKey: 'granted-rtc-revoked-publisher' }]
            },
            'rtc-with-ws-fallback': {
                kind: 'stated',
                outcome: { kind: 'refused', by: 'origin', reason: 'no-publish-grant' },
                proofs: [{ kind: 'lane-cell', scenarioKey: 'granted-rtc-revoked-publisher' }]
            }
        }
    },
    'revoked-publish-unknown-to-sender': {
        statement:
            'A granted publication whose sender has not read the revoke of its `publish` grant is refused by the first authority that has: the WS server, or over RTC a page the frame reaches.',
        cells: {
            ws: {
                kind: 'stated',
                outcome: { kind: 'refused', by: 'trusted-server', reason: 'no-publish-grant' },
                proofs: [
                    {
                        kind: 'unit-test',
                        testFile: 'apps/api-v1/test/services/ws-room-granted-delivery.test.ts',
                        testName:
                            'each of socket admission, pending replay, inbox dispatch and route refuses a publication without a grant',
                        because:
                            'The server re-reads the grant at socket admission, pending replay, inbox dispatch and route, and answers the NACK at all but inbox dispatch.'
                    },
                    {
                        kind: 'unit-test',
                        testFile: WS_CLIENT_RELAY_REJECTION_TEST,
                        testName: 'a no-publish-grant NACK after the admitted receipt settles relay-rejected',
                        because:
                            'The origin reads the server\'s `no-publish-grant` NACK as a rejection by the trusted server.'
                    }
                ]
            },
            rtc: REVOKED_PUBLICATION_DROPPED_BY_A_HOP,
            'rtc-with-ws-fallback': {
                ...REVOKED_PUBLICATION_DROPPED_BY_A_HOP,
                proofs: [
                    ...REVOKED_PUBLICATION_DROPPED_BY_A_HOP.proofs,
                    {
                        kind: 'unproven',
                        closedBy:
                            'a receipted publication over this carrier: no hop answers the frame it drops, so the receipt runs out and the send is handed to WS, where the server refuses it `no-publish-grant`; nothing pins that chain'
                    }
                ]
            }
        }
    },
    'frame-without-proof': {
        statement: 'A granted frame that carries no proof of its origin is refused by the page it reaches.',
        cells: {
            ws: {
                kind: 'not-applicable',
                because: WS_SEND_CARRIES_NO_PROOF
            },
            rtc: {
                kind: 'stated',
                outcome: { kind: 'refused', by: 'receiver', of: 'frame', code: 'missing-proof' },
                proofs: [{ kind: 'lane-cell', scenarioKey: 'granted-rtc-missing-proof' }]
            },
            'rtc-with-ws-fallback': {
                kind: 'stated',
                outcome: { kind: 'refused', by: 'receiver', of: 'frame', code: 'missing-proof' },
                proofs: [{
                    kind: 'unit-test',
                    testFile: RTC_RELAY_PUBLICATION_PROOF_TEST,
                    testName: 'drops a frame without a proof at the first hop',
                    because:
                        'A hop drops a granted frame without a proof `unauthorized: missing-proof` and forwards nothing; its admission is given the frame and its channel peer, not the strategy that sent it.'
                }]
            }
        }
    },
    'frame-with-forged-sender': {
        statement:
            'A granted frame rewritten to name another member as its sender, under that member\'s registered key id, is refused by each page it reaches.',
        cells: {
            ws: {
                kind: 'not-applicable',
                because: WS_SEND_CARRIES_NO_PROOF
            },
            rtc: {
                kind: 'stated',
                outcome: { kind: 'refused', by: 'receiver', of: 'frame', code: 'invalid-signature' },
                proofs: [{ kind: 'lane-cell', scenarioKey: 'granted-rtc-forged-sender' }]
            },
            'rtc-with-ws-fallback': {
                kind: 'stated',
                outcome: { kind: 'refused', by: 'receiver', of: 'frame', code: 'invalid-signature' },
                proofs: [
                    {
                        kind: 'unit-test',
                        testFile: 'packages/tests/shared/al-contracts/publication-proof/al-publication-proof.test.ts',
                        testName: 'refuses a frame signed by another key as invalid-signature',
                        because:
                            'A frame verified under another key than the one that signed it fails as `invalid-signature`.'
                    },
                    {
                        kind: 'unit-test',
                        testFile:
                            'packages/tests/shared/multicast/publication/compute-rtc-publication-admission.test.ts',
                        testName: 'refuses %s as %s',
                        because:
                            'A page refuses a frame whose proof its verifier did not verify with the code `invalid-signature`.'
                    },
                    {
                        kind: 'unit-test',
                        testFile: RTC_RELAY_PUBLICATION_PROOF_TEST,
                        testName:
                            'drops a frame forged to another member under that member\'s registered key id as invalid-signature, never forwarding it',
                        because:
                            'A hop that finds the named member\'s key drops the frame `unauthorized: invalid-signature` and forwards nothing; its admission is given the frame and its channel peer, not the strategy that sent it.'
                    }
                ]
            }
        }
    },
    'receipt-without-proof': {
        statement:
            'A receipt that reaches its origin over RTC without its recipient\'s proof is refused there and confirms no recipient.',
        cells: {
            ws: {
                kind: 'not-applicable',
                because:
                    'On WS the trusted server relays each receipt and names its sender; only RTC receipts carry a signature.'
            },
            rtc: {
                kind: 'stated',
                outcome: { kind: 'refused', by: 'receiver', of: 'receipt', code: 'missing-proof' },
                proofs: [
                    { kind: 'lane-cell', scenarioKey: 'unsigned-ack-refused' },
                    { kind: 'lane-cell', scenarioKey: 'forged-recipient-ack' }
                ]
            },
            'rtc-with-ws-fallback': {
                kind: 'stated',
                outcome: { kind: 'refused', by: 'receiver', of: 'receipt', code: 'missing-proof' },
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
                        testName: 'subscribes the WS inbox once as message-replies at order 15',
                        because: 'The reply inbox subscribes the WS inbox alone, so only a reply over WS is matched.'
                    },
                    { kind: 'lane-cell', scenarioKey: 'reply-correlated' }
                ]
            },
            'rtc-with-ws-fallback': {
                kind: 'stated',
                outcome: { kind: 'delivered' },
                proofs: [{ kind: 'lane-cell', scenarioKey: 'reply-correlated' }]
            }
        }
    },
    'reply-wait-on-topic-ws-cannot-carry': {
        statement: 'A request on a topic WS cannot carry has no reply: its reply wait is refused at the call.',
        cells: {
            ws: {
                kind: 'not-applicable',
                because: 'The send itself is refused at the call, `$.topicId`: the strategy validates the WS topic.'
            },
            rtc: {
                kind: 'stated',
                outcome: { kind: 'refused', by: 'call', path: '$.topicId', code: 'invalid-ws-user-topic' },
                proofs: [{
                    kind: 'unit-test',
                    testFile: 'packages/tests/shared-web/messages/browser-rallar-delivery-registry.test.ts',
                    testName:
                        'refuses a reply wait on a request whose topic WS cannot carry, at the call, with the issue its reply would be refused with',
                    because:
                        'The wait resolves `unanswerable` with the issue the responder\'s `reply()` is refused with, and arms no timer.'
                }, {
                    kind: 'unit-test',
                    testFile: 'packages/tests/shared-web/messages/reply/validate-browser-reply-route.test.ts',
                    testName: 'names a topic the platform reserves on WS',
                    because:
                        'A topic the platform reserves on WS reads `reserved-ws-topic` at the same path, in place of `invalid-ws-user-topic`.'
                }]
            },
            'rtc-with-ws-fallback': {
                kind: 'not-applicable',
                because: 'The send itself is refused at the call, `$.topicId`: the strategy validates the WS topic.'
            }
        }
    },
    'left-sender-send': {
        statement:
            'A room send from a member that left is refused by the first authority that has read the leave, the WS server or over RTC a receiver, and what its origin states of that refusal depends on what the send is owed.',
        cells: {
            ws: {
                kind: 'stated',
                outcome: { kind: 'refused', by: 'trusted-server', reason: 'membership-fenced' },
                proofs: [{ kind: 'lane-cell', scenarioKey: 'fenced-rejection' }]
            },
            rtc: LEFT_SENDER_FENCED_BY_A_RECEIVER,
            'rtc-with-ws-fallback': {
                ...LEFT_SENDER_FENCED_BY_A_RECEIVER,
                proofs: [
                    ...LEFT_SENDER_FENCED_BY_A_RECEIVER.proofs,
                    {
                        kind: 'unproven',
                        closedBy:
                            'a receipted room send over this carrier: the receipt a fencing receiver ends is handed to WS as `receipt-exhausted`, where the server fences the send; nothing pins that end'
                    }
                ]
            }
        }
    },
    'resync-recovery-owner': {
        statement:
            'A gap past the repair window is refused where the track is ordered; a receiver that orders it tells its recovery owner, and one the WS server orders it for never sees the send, so its owner is told nothing.',
        cells: {
            ws: {
                kind: 'stated',
                outcome: { kind: 'refused', by: 'trusted-server', reason: 'resync-required' },
                proofs: [
                    { kind: 'lane-cell', scenarioKey: 'ordering-resync' },
                    {
                        kind: 'unit-test',
                        testFile: WS_CLIENT_RELAY_REJECTION_TEST,
                        testName: 'states the trusted server rejection of the gapped send with ack $ack',
                        because:
                            'The origin states the gapped send rejected by the trusted server, `resync-required`; without a receipt its handle stays `transport-accepted`.'
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
