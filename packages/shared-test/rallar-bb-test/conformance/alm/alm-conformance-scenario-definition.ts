import type { RallarBlackBoxDistributedGroupRef } from '../../distributed-run.ts';
import type { RallarBlackBoxTestCommand } from '../../rallar-black-box-test-contracts.ts';

import type { AlmConformanceCarrier } from './alm-conformance-carriers.ts';

export interface CreateAlmConformanceRecipesInput {
    readonly group: RallarBlackBoxDistributedGroupRef;
    readonly carrier: AlmConformanceCarrier;
    readonly typeId: string;
    readonly senderConnection: string;
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

export type AlmConformanceRole = 'sender' | 'receiver';

export type AlmConformanceTag = 'smoke' | 'full';

export interface AlmConformanceStepInput {
    readonly input: CreateAlmConformanceRecipesInput;
    readonly scenarioId: AlmConformanceScenarioId;
    readonly scenarioKey: string;
    readonly role: AlmConformanceRole;
}

export interface AlmConformanceMessageStepInput extends AlmConformanceStepInput {
    readonly index: number;
}

export interface AlmConformanceScenarioDefinition {
    readonly scenarioId: AlmConformanceScenarioId;
    readonly scenarioKey: string;
    readonly tags: readonly AlmConformanceTag[];
    readonly carriers: readonly AlmConformanceCarrier[];
    readonly toSenderCommands: (sender: AlmConformanceStepInput) => readonly RallarBlackBoxTestCommand[];
    readonly toReceiverCommands: (receiver: AlmConformanceStepInput) => readonly RallarBlackBoxTestCommand[];
}

export const SMOKE_TAGS: readonly AlmConformanceTag[] = ['smoke', 'full'];
export const FULL_TAGS: readonly AlmConformanceTag[] = ['full'];
