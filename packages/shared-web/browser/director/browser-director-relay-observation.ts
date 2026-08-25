import type {
    RallarDirectorRelayEnvelope,
    RallarDirectorRelayMessage,
    RallarDirectorStatus
} from '@shared-web/browser/rallar-director-facade.ts';
import type { RallarMessagePayload } from '@shared-web/browser/rallar-message-contracts.ts';
import { RALLAR_DIRECTOR_RELAY_PROTOCOL } from './browser-director-relay-transport.ts';
import type { BrowserDirectorStatusRuntime } from './browser-director-status-runtime.ts';

export function isCurrentDirectorEnvelope(
    status: RallarDirectorStatus,
    envelope: RallarDirectorRelayEnvelope
): boolean {
    return Boolean(
        status.appointment && status.roomId &&
            envelope.roomId === status.roomId &&
            envelope.epoch === status.appointment.epoch
    );
}

export function isDirectorRelayEnvelope(
    value: object | null,
    topicId: string
): value is RallarDirectorRelayEnvelope<RallarMessagePayload> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return false;
    }
    const envelope = value as Partial<RallarDirectorRelayEnvelope>;
    return envelope.protocol === RALLAR_DIRECTOR_RELAY_PROTOCOL &&
        envelope.topicId === topicId &&
        typeof envelope.typeId === 'string' &&
        typeof envelope.roomId === 'string' &&
        typeof envelope.epoch === 'number' &&
        typeof envelope.sentAtEpochMs === 'number' &&
        'payload' in envelope;
}

export function recordDirectorRelayHeartbeat<T>(
    statusRuntime: BrowserDirectorStatusRuntime,
    status: RallarDirectorStatus,
    message: RallarDirectorRelayMessage<T>
): void {
    if (message.senderId !== status.appointment?.sessionId) {
        return;
    }
    if (status.roomRef && status.appointment) {
        statusRuntime.recordHeartbeat(
            status.roomRef,
            status.appointment,
            message.receivedAtEpochMs
        );
        statusRuntime.emit();
    }
}
