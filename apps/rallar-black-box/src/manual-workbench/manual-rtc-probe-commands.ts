import type { RallarBlackBoxTestCommand } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import type { RallarMessagePayload } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { ManualWorkbenchTransport, ManualWorkbenchValues } from '../manual-workbench.ts';
import {
    toManualConfigureCommand,
    toManualConnectCommand,
    toManualCreateGroupCommand,
    toManualRtcSendCommand,
    toManualSendCommand,
    toManualSimpleCommand
} from './manual-workbench-commands.ts';

export interface ManualRtcDeliveryMatrixInput {
    readonly values: ManualWorkbenchValues;
    readonly payload: RallarMessagePayload;
    readonly sequence: number;
    readonly transport: Extract<ManualWorkbenchTransport, 'realtime' | 'messages.rtc'>;
    readonly requestId: string;
}

const NEGATIVE_RTC_SEND_CASES = {
    missingPeer: {
        sequence: 3,
        targetClient: 'missing-peer',
        commandId: 'manual-rtc-negative-missing-peer',
        label: 'RTC missing peer negative',
        metadata: { negativeCase: 'missing-peer', expectedOutcome: 'delivery-failure' }
    },
    staleAgent: {
        sequence: 4,
        targetClient: 'stale-agent',
        commandId: 'manual-rtc-negative-stale-agent',
        label: 'RTC stale agent negative',
        metadata: { negativeCase: 'stale-agent', expectedOutcome: 'delivery-failure' }
    },
    permissionDenied: {
        sequence: 6,
        commandId: 'manual-rtc-negative-permission-denied',
        label: 'RTC permission denied negative',
        metadata: { negativeCase: 'permission-denied', expectedOutcome: 'permission-failure' }
    },
    closedTransport: {
        sequence: 8,
        commandId: 'manual-rtc-negative-closed-transport',
        label: 'RTC closed transport negative',
        metadata: { negativeCase: 'closed-transport', expectedOutcome: 'transport-failure' }
    }
} as const;

export function toManualRtcDeliveryMatrixCommands(
    { values, payload, sequence, transport, requestId }: ManualRtcDeliveryMatrixInput
): readonly RallarBlackBoxTestCommand[] {
    const baseValues: ManualWorkbenchValues = {
        ...values,
        transport,
        deliveryMode: 'direct'
    };
    const commands: RallarBlackBoxTestCommand[] = [toManualConfigureCommand(baseValues, sequence)];
    let nextSequence = sequence + 1;

    if (baseValues.providerMode === 'browser-rallar') {
        commands.push(toManualCreateGroupCommand(baseValues, nextSequence, requestId));
        nextSequence += 1;
    }

    commands.push(toManualConnectCommand(baseValues, nextSequence));
    nextSequence += 1;

    for (const deliveryMode of ['direct', 'multicast', 'broadcast'] as const) {
        commands.push(toManualSendCommand(
            {
                ...baseValues,
                deliveryMode
            },
            payload,
            nextSequence
        ));
        nextSequence += 1;
    }

    return commands;
}

export function toManualRtcNackProbeCommands(
    values: ManualWorkbenchValues,
    payload: RallarMessagePayload,
    sequence: number
): readonly RallarBlackBoxTestCommand[] {
    const transport = values.transport === 'messages.rtc' ? 'messages.rtc' : 'realtime';
    const scopedValues: ManualWorkbenchValues = {
        ...values,
        transport,
        deliveryMode: 'direct',
        minSnapshotVersion: Math.max(values.minSnapshotVersion, 9_999_999)
    };
    const send = toManualRtcSendCommand(scopedValues, payload, sequence);
    return [{
        ...send,
        commandId: `manual-rtc-nack-not-yet-in-sync-${sequence}`,
        label: 'RTC not-yet-in-sync probe',
        metadata: {
            ...send.metadata,
            negativeCase: 'not-yet-in-sync',
            expectedOutcome: 'nack'
        }
    }];
}

export function toManualRtcNegativeRecipeText(
    values: ManualWorkbenchValues,
    payload: RallarMessagePayload
): string {
    const commands = toNegativeRtcCommands(values, payload);
    return JSON.stringify(
        {
            schemaVersion: 1,
            recipeId: 'manual-rtc-negative-recipe',
            name: 'Manual RTC negative recipe',
            description:
                'Missing peer, stale agent, duplicate session, permission denied, closed transport, and not-yet-in-sync/NACK probes.',
            continueOnFailure: true,
            commands
        },
        null,
        2
    );
}

function toNegativeRtcSend(
    values: ManualWorkbenchValues,
    payload: RallarMessagePayload,
    caseId: keyof typeof NEGATIVE_RTC_SEND_CASES
): RallarBlackBoxTestCommand {
    const probe = NEGATIVE_RTC_SEND_CASES[caseId];
    const targetClient = 'targetClient' in probe ? probe.targetClient : values.targetClient;
    return {
        ...toManualRtcSendCommand({ ...values, targetClient }, payload, probe.sequence),
        commandId: probe.commandId,
        label: probe.label,
        metadata: probe.metadata
    };
}

function toNegativeRtcCommands(
    values: ManualWorkbenchValues,
    payload: RallarMessagePayload
): readonly RallarBlackBoxTestCommand[] {
    const baseValues: ManualWorkbenchValues = {
        ...values,
        transport: values.transport === 'messages.rtc' ? 'messages.rtc' : 'realtime',
        deliveryMode: 'direct'
    };
    return [
        toManualConfigureCommand(baseValues, 1),
        toManualConnectCommand(baseValues, 2),
        toNegativeRtcSend(baseValues, payload, 'missingPeer'),
        toNegativeRtcSend(baseValues, payload, 'staleAgent'),
        {
            ...toManualConnectCommand(baseValues, 5),
            commandId: 'manual-rtc-negative-duplicate-session',
            label: 'RTC duplicate session negative',
            metadata: { negativeCase: 'duplicate-session', expectedOutcome: 'permission-failure' }
        },
        toNegativeRtcSend(baseValues, payload, 'permissionDenied'),
        toManualSimpleCommand('close', 7),
        toNegativeRtcSend(baseValues, payload, 'closedTransport'),
        ...toManualRtcNackProbeCommands(baseValues, payload, 9)
    ];
}
