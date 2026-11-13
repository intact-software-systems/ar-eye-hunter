import type { RallarBlackBoxDistributedGroupRef } from '../../distributed-run.ts';
import type { RallarBlackBoxTestCommand } from '../../rallar-black-box-test-contracts.ts';

import type { AlmConformanceCarrier } from './alm-conformance-carriers.ts';
import type { AlmConformanceReceiptRoles } from './alm-conformance-receipt-commands.ts';
import type { AlmConformanceRole } from './alm-conformance-roles.ts';
import type { AlmReloadCheckpoint } from './alm-reload-pair.ts';

export interface CreateAlmConformanceRecipesInput {
    readonly group: RallarBlackBoxDistributedGroupRef;
    readonly carrier: AlmConformanceCarrier;
    readonly typeId: string;
    readonly senderConnection: string;
    /** Every recipient role's recipe uses it; each agent names its own connections, so recipients share the label. */
    readonly receiverConnection: string;
    readonly deadlineMs: number;
    /** The lane families whose scenarios the call creates; a caller that runs no family creates none of its cells. */
    readonly laneFamilies: readonly AlmConformanceLaneFamily[];
    /**
     * The principal each role signs in as, which a step names as `{principal:<role>}` and creation substitutes. The lane
     * passes its opened agents' client ids; a caller whose agents are not known when it creates passes `{}`, and creation
     * makes no scenario whose `principalRoles` it does not resolve.
     */
    readonly principalIdsByRole: Readonly<Partial<Record<AlmConformanceRole, string>>>;
    /**
     * Absent, no connect installs a recovery owner and no cell waits for one: the hosted combined recipe shares one
     * connect across its cells, so it names no channel's owner. `record` installs the harness's recording owner on each
     * recipient's connect and lets `ordering-resync` wait for its invocation.
     */
    readonly recoveryOwner?: 'record';
    /**
     * Absent, no cell's roles meet before its body: the hosted combined recipe orders its blocks with barriers of its
     * own, and a caller without a started distributed run has no participants to meet. `barriered` makes every role but
     * the successor meet at its cell's `connected` barrier between its prologue and its body.
     */
    readonly cellSettle?: 'barriered';
}

export type AlmConformanceScenarioId =
    | 'backpressure-deferred'
    | 'backpressure-hands-over'
    | 'backpressure-refused'
    | 'bounded-rejection'
    | 'buffered-track-drains'
    | 'capacity'
    | 'capacity-age'
    | 'capacity-tracks'
    | 'checkpoint-lag'
    | 'checkpoint-recovery'
    | 'churn-bounded-tracks'
    | 'claim-expires-reclaims'
    | 'claim-first-wins'
    | 'claim-refused-on-rtc'
    | 'cross-carrier-duplicate'
    | 'deadline-expiry'
    | 'delivery-baseline'
    | 'delivery-lifecycle'
    | 'delivery-reload'
    | 'durable-opt-in'
    | 'durable-takeover'
    | 'fallback-within-deadline'
    | 'fenced-catch-up'
    | 'fenced-delivery'
    | 'fenced-rejection'
    | 'fixed-list-delivery'
    | 'flush-on-hide'
    | 'granted-rtc-delivered'
    | 'granted-rtc-forged-sender'
    | 'granted-rtc-list-delivered'
    | 'granted-rtc-list-lane-roles'
    | 'granted-rtc-list-non-holder'
    | 'granted-rtc-missing-proof'
    | 'granted-rtc-not-subscribed'
    | 'granted-rtc-ordered-relay'
    | 'granted-rtc-principal-delivered'
    | 'granted-rtc-publish-refused'
    | 'granted-rtc-receipted-delivered'
    | 'granted-rtc-relay-only'
    | 'granted-rtc-revoked-publisher'
    | 'granted-rtc-unicast-delivered'
    | 'leader-confirms'
    | 'leader-outside-list'
    | 'no-fallback-after-deadline'
    | 'no-leader-refused'
    | 'not-yet-in-sync'
    | 'ordering-gap-repair'
    | 'ordering-resync'
    | 'own-share-under-inbound'
    | 'paced-cancel'
    | 'paced-capacity'
    | 'paced-expiry'
    | 'paced-fairness'
    | 'paced-isolation-lists'
    | 'paced-isolation-resources'
    | 'paced-latest'
    | 'paced-newest-n'
    | 'principal-delivery'
    | 'receipt-exhausted-fallback'
    | 'repair-exhausted'
    | 'receipted-audience'
    | 'receipted-relay-path'
    | 'reply-correlated'
    | 'reply-first-wins'
    | 'reply-timeout-late'
    | 'reply-undelivered'
    | 'server-command'
    | 'server-ordered-entry'
    | 'server-originated'
    | 'storage-unavailable'
    | 'subscription-delivery'
    | 'subscription-ordered-entry'
    | 'subscription-ordered-omission'
    | 'subscription-ordered-reconnect'
    | 'subscription-revoke-disconnected'
    | 'subscription-successor'
    | 'subscription-token-count'
    | 'unicast-fallback'
    | 'volatile-default'
    | 'world-routing'
    | 'ws-unicast-receipt';

export type AlmConformanceTag = 'smoke' | 'full';

/**
 * A connect's `RallarMessageSelector`, which this browser-loaded catalog cannot import: the topic its lanes subscribe.
 * `granted` names the room channel the page opens on that topic, which `messages.subscribe` elects; absent, members.
 */
export interface AlmConformanceMessageSelector {
    readonly topicId: string;
    readonly access?: 'granted';
}

/** How a scenario's waiting connect judges readiness: the count of its ready RTC peers that settles the connect. */
export interface AlmConformanceConnect {
    readonly minReadyPeers: number;
}

/**
 * A step of `role`'s recipe, named as a step names its commands, after which the lane starts a recipe it holds back.
 */
export interface AlmConformanceRecipeGate {
    readonly role: AlmConformanceRole;
    readonly commandName: string;
}

/**
 * A further recipe of `role`, which the lane starts on that role's agent, on its open connection, once the role's
 * first recipe ended and the gate passed: how a page that hears no cue, such as one whose socket is closed, waits for
 * another role's step.
 */
export interface AlmConformanceContinuationDefinition {
    readonly role: AlmConformanceRole;
    readonly gate: AlmConformanceRecipeGate;
    readonly toCommands: (step: AlmConformanceStepInput) => readonly RallarBlackBoxTestCommand[];
}

export interface AlmConformanceStepInput {
    readonly input: CreateAlmConformanceRecipesInput;
    readonly scenarioId: AlmConformanceScenarioId;
    readonly scenarioKey: string;
    readonly role: AlmConformanceRole;
    /** Every role the scenario declares, which decides how many ready peers each connect waits for. */
    readonly roles: readonly AlmConformanceRole[];
    /** The definition's selector, which every connect of the scenario carries; undefined subscribes its own channel. */
    readonly messageSelector: AlmConformanceMessageSelector | undefined;
    /** The definition's connect readiness; undefined waits for every other peer. */
    readonly connect: AlmConformanceConnect | undefined;
}

export interface AlmConformanceMessageStepInput extends AlmConformanceStepInput {
    readonly index: number;
}

/**
 * The addressed sends run on their own two agents, so the baseline cell keeps its wall time. A `same-context`
 * scenario runs its sender and its successor as two pages of one browser context, which only the Playwright lane has.
 * A `same-principal` scenario signs the sender's user in a second time on an agent of its own. A `four-role` scenario
 * adds a second producer of a third principal to those three.
 */
export const ALM_CONFORMANCE_LANE_FAMILIES = [
    'two-agent',
    'addressed',
    'three-agent',
    'same-context',
    'same-principal',
    'four-role'
] as const;

export type AlmConformanceLaneFamily = typeof ALM_CONFORMANCE_LANE_FAMILIES[number];

export interface AlmConformanceScenarioDefinition {
    readonly scenarioId: AlmConformanceScenarioId;
    readonly scenarioKey: string;
    readonly tags: readonly AlmConformanceTag[];
    readonly carriers: readonly AlmConformanceCarrier[];
    /**
     * Every scenario declares the sender and the receiver; a three-agent scenario adds `recipient-b`, a same-context
     * scenario adds `successor`, a same-principal scenario adds `sibling`, a four-role scenario adds `publisher-b` and
     * `sibling`.
     */
    readonly roles: readonly AlmConformanceRole[];
    /**
     * The lane test that runs it: `three-agent` exactly when `roles` declares `recipient-b`, `same-context` exactly
     * when it declares `successor`, `four-role` exactly when it declares `publisher-b`, and `same-principal` exactly
     * when it declares `sibling` without `publisher-b`.
     */
    readonly laneFamily: AlmConformanceLaneFamily;
    /**
     * Absent, each connect subscribes the scenario's own typed channel. Otherwise every connect subscribes its lanes to
     * this selector instead, so its pages hear the server's own publications on that topic.
     */
    readonly messageSelector?: AlmConformanceMessageSelector;
    /**
     * Absent, a connect that waits for ready peers waits for every other peer of the scenario. A scenario whose overlay
     * gives a connect fewer next hops, such as a path whose leaf has one, names the count instead.
     */
    readonly connect?: AlmConformanceConnect;
    /**
     * Absent when no step names a principal. Otherwise every role a step names as `{principal:<role>}`: creation makes
     * the scenario only when `principalIdsByRole` resolves each of them.
     */
    readonly principalRoles?: readonly AlmConformanceRole[];
    /** Called once per producer page: the sender, the successor and `publisher-b` a scenario declares. */
    readonly toSenderCommands: (sender: AlmConformanceStepInput) => readonly RallarBlackBoxTestCommand[];
    /** Called once per recipient role the scenario declares; the step's role tells the recipients apart. */
    readonly toRecipientCommands: (recipient: AlmConformanceStepInput) => readonly RallarBlackBoxTestCommand[];
    /**
     * Absent when the sender pins no receipt identity. Otherwise the recipient roles the receipt of its first send
     * confirms and leaves unconfirmed, which the identity assessment joins to their sessions after the run.
     */
    readonly toReceiptRoles?: (carrier: AlmConformanceCarrier) => AlmConformanceReceiptRoles;
    /**
     * Absent when the cell needs no relayed send. Otherwise the roles whose first sends the identity assessment reads
     * after the run: at least one of them must have reached both of its recipients through one hop.
     */
    readonly relayedReceiptOrigins?: readonly AlmConformanceRole[];
    /** Absent when the sender keeps its page. Otherwise the sync points both roles carry around its one reload. */
    readonly toReloadCheckpoint?: (step: AlmConformanceStepInput) => AlmReloadCheckpoint;
    /** Absent when the successor starts once the owner page ended; otherwise the owner's step it starts after. */
    readonly successorGate?: AlmConformanceRecipeGate;
    /** Absent when every role runs one recipe; otherwise one role's later steps, which wait for another role. */
    readonly continuation?: AlmConformanceContinuationDefinition;
}

export const SMOKE_TAGS: readonly AlmConformanceTag[] = ['smoke', 'full'];
export const FULL_TAGS: readonly AlmConformanceTag[] = ['full'];
