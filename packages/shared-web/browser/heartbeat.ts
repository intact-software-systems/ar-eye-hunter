import { type AuthSession, ClientInfo } from '@shared/api/api-config.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import {
    DEFAULT_STATE_WORKSPACE_ID,
    type StateScope,
} from '@shared/api/state-types.ts';
import type { CommandsOrchestratorPolicies } from '@shared/cache/CommandsOrchestrator.ts';
import * as clientStateSnapshotsRepository from '@shared/repository/client-state-snapshots-repository.ts';
import * as groupStateSnapshotsRepository from '@shared/repository/group-state-snapshots-repository.ts';
import {
    refreshStateHeartbeat,
    type StateHeartbeatWorkflowValue,
} from '@shared-web/browser/api-workflows.ts';
import { ApiHttpError } from '@shared-web/browser/api/http-error.ts';
import { emitBrowserStateReadDiagnostic } from '@shared-web/browser/state-read/diagnostics.ts';

const intervalMsecs = 20000;
const retryIntervalMsecs = 5000;

export type HeartbeatHandle = Readonly<{
    sessionId: string;
    generationId: string;
    stop(): void;
}>;

export type InitHeartbeatOptions = Readonly<{
    authSession?: AuthSession;
    scope?: StateScope;
    policies?: CommandsOrchestratorPolicies<StateHeartbeatWorkflowValue>;
    onAuthInvalid?: (error: unknown) => void | Promise<void>;
}>;

let activeHeartbeat: HeartbeatHandle | undefined;

export async function initHeartbeat(
    clientData: ClientInfo,
    options: InitHeartbeatOptions = {},
): Promise<HeartbeatHandle> {
    activeHeartbeat?.stop();

    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const generationId = crypto.randomUUID();

    const handle: HeartbeatHandle = {
        sessionId: clientData.sessionId,
        generationId,
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
            await refreshHeartbeat(clientData, generationId, options);
            schedule(intervalMsecs);
        } catch (error) {
            if (isUnauthorizedApiError(error)) {
                handle.stop();
                await options.onAuthInvalid?.(error);
                return;
            }

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
    generationId: string,
    options: InitHeartbeatOptions,
): Promise<void> {
    const joinedGroups = groupStateSnapshotsRepository
        .getAllGroupStateSnapshots()
        .filter((snapshot) => isGroupSnapshotInScope(snapshot, options.scope))
        .filter((snapshot) =>
            snapshot.activeSessions.some((session) =>
                session.sessionId === clientData.sessionId
            )
        );

    const refreshed = await refreshStateHeartbeat(clientData, joinedGroups, {
        generationId,
        authSession: options.authSession,
        scope: options.scope,
        policies: options.policies,
    });

    clientStateSnapshotsRepository.setClientStateSnapshotByPrincipalId(
        refreshed.client.principal.principalId,
        refreshed.client,
    );

    groupStateSnapshotsRepository.setGroupStateSnapshots(refreshed.groups);
    for (const missingGroup of refreshed.missingGroups) {
        const removed = groupStateSnapshotsRepository.removeGroupStateSnapshotIfUnchanged(
            missingGroup.group,
            missingGroup,
        );
        emitBrowserStateReadDiagnostic({
            name: 'rallar.browser.state-read',
            feature: 'group',
            operation: 'heartbeat',
            result: removed ? 'removed' : 'preserved',
            durationMs: 0,
        });
    }

    await Promise.all([
        clientStateSnapshotsRepository.waitForClientStateSnapshotChangesIdle(),
        groupStateSnapshotsRepository.waitForGroupStateSnapshotChangesIdle(),
    ]);

    console.log(
        `State heartbeat refreshed for client ${clientData.clientId} and ${joinedGroups.length} groups`,
    );
}

function isGroupSnapshotInScope(
    snapshot: GroupSnapshot,
    scope: StateScope | undefined,
): boolean {
    if (!scope) {
        return true;
    }

    return snapshot.group.applicationId === scope.applicationId &&
        (snapshot.group.workspaceId ?? DEFAULT_STATE_WORKSPACE_ID) === scope.workspaceId;
}

function isUnauthorizedApiError(error: unknown): boolean {
    return error instanceof ApiHttpError && error.status === 401;
}
