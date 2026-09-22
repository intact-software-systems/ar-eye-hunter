import type { RallarGameHostAppointResult } from '@shared-web/game/director/rallar-game-director-appointment-contracts.ts';
import type { ALDeliveryLifecycle } from '@shared/alm/delivery/al-delivery-lifecycle.ts';

import type {
    CapabilityDelivery,
    DirectorAttemptSource,
    FinishedDirectorAttempt
} from '../arena-connection-contracts.ts';

interface DirectorAttemptCompletion {
    readonly source: DirectorAttemptSource;
    readonly startedAtEpochMs: number;
    readonly finishedAtEpochMs: number;
    readonly resultStatus: RallarGameHostAppointResult['status'];
    readonly reason: string | undefined;
    readonly capabilityDelivery: CapabilityDelivery | undefined;
}

export function toDirectorAttemptState(completion: DirectorAttemptCompletion): FinishedDirectorAttempt {
    return {
        ...completion,
        status: toDirectorAttemptStatus(completion.resultStatus),
        durationMs: completion.finishedAtEpochMs - completion.startedAtEpochMs
    };
}

export function toCapabilityDelivery(lifecycle: ALDeliveryLifecycle): CapabilityDelivery {
    const evidence = lifecycle.state;
    const reason = lifecycle.evidence.reason;
    switch (evidence) {
        case 'submitted':
        case 'pending-authority':
        case 'accepted':
        case 'queued':
            return { state: 'pending', evidence, reason };
        case 'transport-accepted':
        case 'acknowledged':
            return { state: 'confirmed', evidence, reason };
        case 'rejected':
        case 'failed':
            return { state: 'failed', evidence, reason };
        case 'expired':
        case 'superseded':
        case 'cancelled':
        case 'unobservable':
            return { state: evidence, evidence, reason };
    }
}

function toDirectorAttemptStatus(
    resultStatus: RallarGameHostAppointResult['status']
): FinishedDirectorAttempt['status'] {
    switch (resultStatus) {
        case 'appointed':
            return 'succeeded';
        case 'not-elected':
        case 'not-authorized':
            return 'not-elected';
        case 'not-ready':
            return 'not-ready';
        case 'failed':
        case 'no-local-peer':
            return 'failed';
    }
}
