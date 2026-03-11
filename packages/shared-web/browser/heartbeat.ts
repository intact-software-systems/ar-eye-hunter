import { tryRunInIntervals } from '@shared/resilience/TryWith.ts';
import { ClientInfo } from '@shared/api/api-config.ts';
import * as clientStateSnapshotsRepository from '@shared/repository/client-state-snapshots-repository.ts';
import * as groupStateSnapshotsRepository from '@shared/repository/group-state-snapshots-repository.ts';
import { refreshStateHeartbeat } from '@shared-web/browser/api-workflows.ts';

const intervalMsecs = 20000;

export async function initHeartbeat(
    clientData: ClientInfo,
) {
    await tryRunInIntervals(
        async () => {
            const joinedGroups = groupStateSnapshotsRepository
                .getAllGroupStateSnapshots()
                .filter((snapshot) =>
                    snapshot.activeSessions.some((session) =>
                        session.sessionId === clientData.sessionId
                    )
                );

            const refreshed = await refreshStateHeartbeat(clientData, joinedGroups);

            clientStateSnapshotsRepository.setClientStateSnapshotByPrincipalId(
                refreshed.client.principal.principalId,
                refreshed.client,
            );

            groupStateSnapshotsRepository.setGroupStateSnapshots(refreshed.groups);

            await Promise.all([
                clientStateSnapshotsRepository.waitForClientStateSnapshotChangesIdle(),
                groupStateSnapshotsRepository.waitForGroupStateSnapshotChangesIdle(),
            ]);

            console.log(
                `State heartbeat refreshed for client ${clientData.clientId} and ${joinedGroups.length} groups`,
            );
        },
        intervalMsecs,
    );
}
