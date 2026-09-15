import type { RallarBlackBoxTestCommand } from '../rallar-black-box-test-contracts.ts';
import type {
    RallarBlackBoxParityCommandMetadata,
    RallarBlackBoxParityDeliveryMode,
    RallarBlackBoxParityOperation
} from './provider-parity-contracts.ts';

export const DEFAULT_PARITY_CONNECTION = 'aliceRtc';

export interface ParityMetadataOptions {
    readonly deliveryMode?: RallarBlackBoxParityDeliveryMode;
    readonly expectedConnections?: readonly string[];
    readonly targetPeerIds?: readonly string[];
    readonly runnerAction?: 'connect' | 'send' | 'wait' | 'close';
}

export function toParityMetadata(
    operation: RallarBlackBoxParityOperation,
    options: ParityMetadataOptions = {}
): RallarBlackBoxParityCommandMetadata {
    return {
        operation,
        ...(options.deliveryMode ? { deliveryMode: options.deliveryMode } : {}),
        ...(options.expectedConnections ? { expectedConnections: options.expectedConnections } : {}),
        ...(options.targetPeerIds ? { targetPeerIds: options.targetPeerIds } : {}),
        ...(options.runnerAction ? { runnerAction: options.runnerAction } : {}),
        providerSpecificFields: [
            'startedAtEpochMs',
            'endedAtEpochMs',
            'durationMs',
            'provider',
            'remote',
            'health',
            'result',
            'actual'
        ]
    };
}

export function toParityFromCommand(
    command: RallarBlackBoxTestCommand
): RallarBlackBoxParityCommandMetadata | undefined {
    const metadata = command.metadata?.parity;
    return metadata && typeof metadata === 'object' && !Array.isArray(metadata)
        ? metadata as RallarBlackBoxParityCommandMetadata
        : undefined;
}

export function toOperationFromCommand(
    command: Pick<RallarBlackBoxTestCommand, 'kind' | 'commandId'>
): RallarBlackBoxParityOperation {
    if (command.kind === 'configure') {
        return 'configure';
    }
    if (command.kind === 'rtc.connect') {
        return 'connect';
    }
    if (command.kind === 'rtc.send') {
        const id = command.commandId ?? '';
        if (id.includes('broadcast')) {
            return 'send.broadcast';
        }
        if (id.includes('multicast')) {
            return 'send.multicast';
        }
        return 'send.direct';
    }
    if (command.kind === 'health') {
        return 'health';
    }
    if (command.kind === 'close') {
        return 'close';
    }
    if (command.kind === 'reset') {
        return 'reset';
    }
    return 'configure';
}
