import type { ControlCommandEnvelope } from '@shared-test/rallar-bb-test/control-protocol.ts';
export function toControlCommandFingerprint(envelope: ControlCommandEnvelope): string {
    return JSON.stringify({
        command: envelope.command,
        deadlineEpochMs: envelope.deadlineEpochMs
    });
}
