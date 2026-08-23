import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import type { RuntimeStateEntryValue } from '../../../runtime-state/runtime-state-json-store.ts';
import type { RtcTopologyPublication } from '../publication/rtc-topology-publication.ts';

export type RtcTopologyStaleMutationComputed =
    | Readonly<{
        outcome: 'superseded';
        current: RallarOverlayTopologySnapshot;
    }>
    | Readonly<{
        outcome: 'publish-superseded';
        currentGuard: Readonly<{
            expectedRevision: number;
            current: RallarOverlayTopologySnapshot;
        }>;
        publication: RtcTopologyPublication;
        publicationExpireAtTimestamp: number;
        commandHash: string;
        attemptCount: number;
    }>;

export function computeStaleTopologyPublication(
    input: Readonly<{
        current: RuntimeStateEntryValue<RallarOverlayTopologySnapshot>;
        publication: RtcTopologyPublication | null;
        publicationExpireAtTimestamp: number | null;
        commandHash: string | null;
        attemptCount: number | null;
    }>
): RtcTopologyStaleMutationComputed {
    if (input.publication === null) {
        return { outcome: 'superseded', current: input.current.value };
    }
    const expiresAt = input.publicationExpireAtTimestamp;
    if (
        expiresAt === null || !Number.isSafeInteger(expiresAt) ||
        expiresAt <= input.publication.createdAtEpochMs ||
        typeof input.commandHash !== 'string' ||
        !/^sha256:[0-9a-f]{64}$/u.test(input.commandHash) ||
        !Number.isSafeInteger(input.attemptCount) || input.attemptCount! < 1
    ) {
        throw new TypeError('RTC topology publication expiry fact is invalid');
    }
    return {
        outcome: 'publish-superseded',
        currentGuard: {
            expectedRevision: input.current.entry.revision,
            current: input.current.value
        },
        publication: input.publication,
        publicationExpireAtTimestamp: expiresAt,
        commandHash: input.commandHash,
        attemptCount: input.attemptCount!
    };
}
