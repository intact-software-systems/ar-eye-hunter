import type { AuthSession } from '@shared/api/api-config.ts';
import type {
    GroupSpaStatisticsResponse,
    MyRealtimeSpaStatisticsResponse,
    WorkspaceSpaStatisticsResponse
} from '@shared/api/spa-statistics-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import type { RallarServerWsStatus } from '../../../rallar-facade/ws-topic-router.ts';
import type { ClientStateService } from '../../client-state/client-state-service-contracts.ts';
import type { SpaStatisticsGroupStateReads } from './spa-statistics-group-reads.ts';

export interface SpaStatisticsDependencies {
    readonly clientStateService: Pick<ClientStateService, 'readSnapshot' | 'readPresenceSnapshot'>;
    readonly groupStateService: SpaStatisticsGroupStateReads;
    readonly wsStatus?: () => RallarServerWsStatus | undefined;
    readonly now?: () => number;
    readonly recentEventLimit?: number;
    readonly topGroupsLimit?: number;
    readonly snapshotScanLimit?: number;
}

export interface ReadWorkspaceSpaStatisticsInput {
    readonly scope: StateScope;
    readonly authSession: AuthSession;
}

export type ReadGroupSpaStatisticsInput =
    & ReadWorkspaceSpaStatisticsInput
    & Readonly<{
        groupId: string;
    }>;

export interface SpaStatisticsUseCases {
    readonly readWorkspaceSummary: (
        input: ReadWorkspaceSpaStatisticsInput
    ) => Promise<WorkspaceSpaStatisticsResponse>;
    readonly readGroupStats: (
        input: ReadGroupSpaStatisticsInput
    ) => Promise<GroupSpaStatisticsResponse>;
    readonly readMyRealtimeStatus: (
        input: ReadWorkspaceSpaStatisticsInput
    ) => Promise<MyRealtimeSpaStatisticsResponse>;
}
