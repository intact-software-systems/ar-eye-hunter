export type EvidenceIdPart = string | number | undefined;

/** The identity a recorded event or runtime diagnostic keeps across the monitor and the raw control run. */
export interface EvidenceEventIdentity {
    readonly eventId: string;
    readonly agentId: string;
    /** Absent when the event belongs to no command. */
    readonly commandId?: string;
}

/** Absent and empty parts drop out, so the same evidence gets the same id whichever optional facts it records. */
export function toStableEvidenceId(parts: readonly EvidenceIdPart[]): string {
    return parts
        .filter((part) => part !== undefined && part !== '')
        .map((part) => encodeURIComponent(String(part)))
        .join(':');
}

export function toEventEvidenceKey(event: EvidenceEventIdentity): string {
    return toStableEvidenceId([event.eventId, event.agentId, event.commandId]);
}
