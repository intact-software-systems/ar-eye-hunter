import type { RallarBlackBoxDistributedGroupRef } from '../../distributed-run.ts';
import type { RallarBlackBoxTestCommand } from '../../rallar-black-box-test-contracts.ts';

import type { AlmConformanceCarrier } from './alm-conformance-carriers.ts';
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
    | 'cross-carrier-duplicate'
    | 'deadline-expiry'
    | 'delivery-baseline'
    | 'delivery-lifecycle'
    | 'delivery-reload'
    | 'not-yet-in-sync'
    | 'ordering-resync';

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

export interface AlmConformanceScenarioDefinition {
    readonly scenarioId: AlmConformanceScenarioId;
    readonly scenarioKey: string;
    readonly tags: readonly AlmConformanceTag[];
    readonly carriers: readonly AlmConformanceCarrier[];
    /** Every scenario declares the sender and the receiver; a three-agent scenario adds `recipient-b` (D45). */
    readonly roles: readonly AlmConformanceRole[];
    readonly toSenderCommands: (sender: AlmConformanceStepInput) => readonly RallarBlackBoxTestCommand[];
    /** Called once per recipient role the scenario declares; the step's role tells the recipients apart. */
    readonly toRecipientCommands: (recipient: AlmConformanceStepInput) => readonly RallarBlackBoxTestCommand[];
}

export const SMOKE_TAGS: readonly AlmConformanceTag[] = ['smoke', 'full'];
export const FULL_TAGS: readonly AlmConformanceTag[] = ['full'];
