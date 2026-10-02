import type { RallarBlackBoxDistributedGroupRef } from '../../distributed-run.ts';
import type { RallarBlackBoxTestCommand } from '../../rallar-black-box-test-contracts.ts';

import type { AlmConformanceCarrier } from './alm-conformance-carriers.ts';
import type { AlmConformanceReceiptRoles } from './alm-conformance-receipt-commands.ts';
import type { AlmConformanceRole } from './alm-conformance-roles.ts';

export interface CreateAlmConformanceRecipesInput {
    readonly group: RallarBlackBoxDistributedGroupRef;
    readonly carrier: AlmConformanceCarrier;
    readonly typeId: string;
    readonly senderConnection: string;
    /** Every recipient role's recipe uses it; each agent names its own connections, so recipients share the label. */
    readonly receiverConnection: string;
    readonly deadlineMs: number;
}

export type AlmConformanceScenarioId =
    | 'bounded-rejection'
    | 'capacity'
    | 'cross-carrier-duplicate'
    | 'deadline-expiry'
    | 'delivery-baseline'
    | 'delivery-lifecycle'
    | 'delivery-reload'
    | 'durable-opt-in'
    | 'fallback-within-deadline'
    | 'no-fallback-after-deadline'
    | 'not-yet-in-sync'
    | 'ordering-resync'
    | 'receipt-exhausted-fallback'
    | 'receipted-audience'
    | 'server-command'
    | 'storage-unavailable'
    | 'unicast-fallback'
    | 'volatile-default'
    | 'ws-unicast-receipt';

export type AlmConformanceTag = 'smoke' | 'full';

export interface AlmConformanceStepInput {
    readonly input: CreateAlmConformanceRecipesInput;
    readonly scenarioId: AlmConformanceScenarioId;
    readonly scenarioKey: string;
    readonly role: AlmConformanceRole;
    /** Every role the scenario declares, which decides how many ready peers each connect waits for. */
    readonly roles: readonly AlmConformanceRole[];
}

export interface AlmConformanceMessageStepInput extends AlmConformanceStepInput {
    readonly index: number;
}

/**
 * The addressed sends run on their own two agents, so the baseline cell keeps its wall time. A `same-context`
 * scenario runs its sender and its successor as two pages of one browser context, which only the Playwright lane has.
 */
export type AlmConformanceLaneFamily = 'two-agent' | 'addressed' | 'three-agent' | 'same-context';

export interface AlmConformanceScenarioDefinition {
    readonly scenarioId: AlmConformanceScenarioId;
    readonly scenarioKey: string;
    readonly tags: readonly AlmConformanceTag[];
    readonly carriers: readonly AlmConformanceCarrier[];
    /**
     * Every scenario declares the sender and the receiver; a three-agent scenario adds `recipient-b`, a same-context
     * scenario adds `successor`.
     */
    readonly roles: readonly AlmConformanceRole[];
    /**
     * The lane test that runs it: `three-agent` exactly when `roles` declares `recipient-b`, `same-context` exactly
     * when it declares `successor`.
     */
    readonly laneFamily: AlmConformanceLaneFamily;
    /** Called once per page of the sender's session: the sender, and the successor a scenario declares. */
    readonly toSenderCommands: (sender: AlmConformanceStepInput) => readonly RallarBlackBoxTestCommand[];
    /** Called once per recipient role the scenario declares; the step's role tells the recipients apart. */
    readonly toRecipientCommands: (recipient: AlmConformanceStepInput) => readonly RallarBlackBoxTestCommand[];
    /**
     * Absent when the sender pins no receipt identity. Otherwise the recipient roles the receipt of its first send
     * confirms and leaves unconfirmed, which the identity assessment joins to their sessions after the run.
     */
    readonly toReceiptRoles?: (carrier: AlmConformanceCarrier) => AlmConformanceReceiptRoles;
}

export const SMOKE_TAGS: readonly AlmConformanceTag[] = ['smoke', 'full'];
export const FULL_TAGS: readonly AlmConformanceTag[] = ['full'];
