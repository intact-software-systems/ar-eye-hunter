import type { MyRealtimeSpaStatisticsResponse, SpaStatisticsWarning } from '@shared/api/spa-statistics-types.ts';
import { canReadGroupSnapshot } from '../../group-state/policy/group-snapshot-visibility-policy.ts';
import type { ReadWorkspaceSpaStatisticsInput, SpaStatisticsDependencies } from './spa-statistics-contracts.ts';
import { readBoundedGroupSnapshots } from './spa-statistics-group-reads.ts';
import {
    countActiveClientSessions,
    isSessionOpen,
    normalizePositiveInteger,
    spaStatisticsWarning,
    toSafeGroupSummary,
    toSpaStatisticsActor
} from './spa-statistics-projections.ts';

const DEFAULT_SNAPSHOT_SCAN_LIMIT = 100;

export class RealtimeStatusService {
    private readonly dependencies: SpaStatisticsDependencies;
    private readonly now: () => number;
    private readonly snapshotScanLimit: number;

    public constructor(dependencies: SpaStatisticsDependencies) {
        this.dependencies = dependencies;
        this.now = dependencies.now ?? Date.now;
        this.snapshotScanLimit = normalizePositiveInteger(
            dependencies.snapshotScanLimit,
            DEFAULT_SNAPSHOT_SCAN_LIMIT
        );
    }

    public async readMyRealtimeStatus(
        input: ReadWorkspaceSpaStatisticsInput
    ): Promise<MyRealtimeSpaStatisticsResponse> {
        const actor = toSpaStatisticsActor(input.authSession);
        const clientSnapshot = await this.dependencies.clientStateService.readSnapshot({
            ...input.scope,
            principalId: actor.principalId
        });
        const groupScan = await readBoundedGroupSnapshots(
            this.dependencies.groupStateService,
            input.scope,
            this.snapshotScanLimit
        );
        const readableGroups = groupScan.snapshots.filter((snapshot) =>
            canReadGroupSnapshot({ snapshot, actor }).allowed
        );
        const groupsWithCurrentSession = readableGroups.filter((snapshot) =>
            snapshot.activeSessions.some(
                (session) =>
                    session.principalId === actor.principalId &&
                    session.sessionId === actor.sessionId
            )
        );
        const currentSessionOpen = isSessionOpen(this.dependencies.wsStatus?.(), actor.sessionId);
        const currentSessionInClientState = Boolean(
            clientSnapshot?.activeSessions.some((session) => session.sessionId === actor.sessionId)
        );
        const warnings: SpaStatisticsWarning[] = [
            spaStatisticsWarning(
                'process-local-realtime',
                'WebSocket readiness is checked against this API process only.'
            )
        ];
        if (!currentSessionOpen) {
            warnings.push(spaStatisticsWarning(
                'websocket-session-missing',
                'The current auth session does not have an open WebSocket on this server.'
            ));
        }
        if (!currentSessionInClientState) {
            warnings.push(spaStatisticsWarning(
                'client-session-missing',
                'The current auth session is not present in client state.'
            ));
        }
        if (groupScan.hasMore) {
            warnings.push(spaStatisticsWarning(
                'bounded-snapshot-scan',
                `Realtime group presence is derived from at most ${this.snapshotScanLimit} group snapshots.`
            ));
        }
        if (groupsWithCurrentSession.length !== groupScan.snapshots.length) {
            warnings.push(spaStatisticsWarning(
                'group-presence-filtered',
                'Group presence lists only readable groups containing the current auth session.'
            ));
        }

        return {
            generatedAtEpochMs: this.now(),
            scope: input.scope,
            actor,
            warnings,
            realtime: { processLocal: true, currentSessionOpen },
            clientState: {
                activeClientSessionCount: countActiveClientSessions(clientSnapshot),
                currentSessionInClientState
            },
            groupPresence: {
                activeGroupPresenceCount: groupsWithCurrentSession.length,
                groups: groupsWithCurrentSession.map((snapshot) => {
                    const safe = toSafeGroupSummary(snapshot);
                    return {
                        groupRef: safe.groupRef,
                        displayName: safe.displayName,
                        kind: safe.kind,
                        status: safe.status,
                        joinMode: safe.joinMode,
                        actorSessionPresent: true
                    };
                })
            }
        };
    }
}
