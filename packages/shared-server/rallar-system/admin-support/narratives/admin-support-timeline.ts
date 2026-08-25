import type { AdminSupportTimelineItem } from '@shared/api/admin-support/admin-support-types.ts';

export interface AdminSupportTimelineInput {
    readonly atEpochMs: number | undefined;
    readonly source: string;
    readonly eventType: string;
    readonly summary: string;
}

export function toAdminSupportTimelineItem(
    input: AdminSupportTimelineInput
): AdminSupportTimelineItem | undefined {
    return input.atEpochMs === undefined
        ? undefined
        : {
            atEpochMs: input.atEpochMs,
            source: input.source,
            eventType: input.eventType,
            summary: input.summary
        };
}
