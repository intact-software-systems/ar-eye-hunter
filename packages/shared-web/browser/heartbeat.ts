import { type AuthSession, ClientInfo } from '@shared/api/api-config.ts';
import * as clientStateSnapshotsRepository from '@shared/repository/client-state-snapshots-repository.ts';
import * as groupStateSnapshotsRepository from '@shared/repository/group-state-snapshots-repository.ts';
import { refreshStateHeartbeat } from '@shared-web/browser/api-workflows.ts';

const intervalMsecs = 20000;
const retryIntervalMsecs = 5000;

export type HeartbeatHandle = Readonly<{
    sessionId: string;
    stop(): void;
}>;

export type InitHeartbeatOptions = Readonly<{
    authSession?: AuthSession;
}>;

let activeHeartbeat: HeartbeatHandle | undefined;

export async function initHeartbeat(
    clientData: ClientInfo,
    options: InitHeartbeatOptions = {},
): Promise<HeartbeatHandle> {
    activeHeartbeat?.stop();

    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const handle: HeartbeatHandle = {
        sessionId: clientData.sessionId,
        stop() {
            stopped = true;
            if (timer !== undefined) {
                clearTimeout(timer);
                timer = undefined;
            }
            if (activeHeartbeat === handle) {
                activeHeartbeat = undefined;
            }
        },
    };

    activeHeartbeat = handle;

    const schedule = (delayMsecs: number): void => {
        if (stopped) {
            return;
        }
        timer = setTimeout(() => {
            void runHeartbeat();
        }, delayMsecs);
    };

    const runHeartbeat = async (): Promise<void> => {
        try {
            await refreshHeartbeat(clientData, options);
            schedule(intervalMsecs);
        } catch (error) {
            if (!stopped) {
                console.warn(
                    `State heartbeat failed for client ${clientData.clientId} session ${clientData.sessionId}:`,
                    error,
                );
                schedule(retryIntervalMsecs);
            }
        }
    };

    void runHeartbeat();
    return handle;
}

export function stopHeartbeat(handle: HeartbeatHandle | undefined = activeHeartbeat): void {
    handle?.stop();
}

async function refreshHeartbeat(
    clientData: ClientInfo,
    options: InitHeartbeatOptions,
): Promise<void> {
    const joinedGroups = groupStateSnapshotsRepository
        .getAllGroupStateSnapshots()
        .filter((snapshot) =>
            snapshot.activeSessions.some((session) =>
                session.sessionId === clientData.sessionId
            )
        );

    const refreshed = await refreshStateHeartbeat(clientData, joinedGroups, {
        authSession: options.authSession,
    });

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
}
