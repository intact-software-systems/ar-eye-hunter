import { useMemo, useState } from 'react';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { RallarBlackBoxControlSnapshot } from '../../../control-client.ts';
import {
    createRunnerAgentLaunchUrl,
    runnerAgentId,
    runnerNewAgentLaunchSuffix,
} from '../../../runner-agent-launch.ts';
import type { RallarBlackBoxBootstrapConfig } from '../../../runtime-store.ts';
import { safeIdSegment } from '../../shared/safe-id-segment.ts';
import type { CommandCenterGlobalValues } from '../../shell/global-context-model.ts';
import {
    runnerBrowserOrigin,
    runnerControlWsUrlFromHttpBaseUrl,
} from './runner-endpoints.ts';

export function useRunnerAgentLaunchState({
    control,
    bootstrap,
    authSession,
    globalValues,
    controlBaseUrl,
    controlToken,
}: Readonly<{
    control: RallarBlackBoxControlSnapshot;
    bootstrap: RallarBlackBoxBootstrapConfig;
    authSession?: AuthSession;
    globalValues: CommandCenterGlobalValues;
    controlBaseUrl: string;
    controlToken: string;
}>) {
    const [agentRunId, setAgentRunId] = useState(
        control.runId ?? bootstrap.runId ?? 'manual-demo-run',
    );
    const [agentPrefix, setAgentPrefix] = useState(
        bootstrap.runnerAgentPrefix ??
        `${safeIdSegment(authSession?.username ?? bootstrap.actor ?? 'agent')}-agent`,
    );
    const [agentCount, setAgentCount] = useState(
        Math.min(6, Math.max(1, bootstrap.runnerAgentCount ?? 1)),
    );
    const [agentLaunchSuffix, setAgentLaunchSuffix] = useState(() =>
        runnerNewAgentLaunchSuffix(),
    );
    const [agentRestoreSession, setAgentRestoreSession] = useState(
        bootstrap.providerMode === 'browser-rallar',
    );
    const [agentLaunchMessage, setAgentLaunchMessage] =
        useState<string | undefined>();
    const agentControlWsUrl = runnerControlWsUrlFromHttpBaseUrl(controlBaseUrl);
    const agentIds = useMemo(
        () =>
            Array.from({ length: agentCount }, (_, index) =>
                runnerAgentId(
                    agentPrefix,
                    index,
                    agentCount,
                    agentLaunchSuffix,
                ),
            ),
        [agentCount, agentLaunchSuffix, agentPrefix],
    );
    const agentLaunchUrls = useMemo(
        () =>
            agentIds.map((agentId) =>
                createRunnerAgentLaunchUrl({
                    origin: runnerBrowserOrigin(),
                    providerMode: bootstrap.providerMode,
                    controlWsUrl: agentControlWsUrl,
                    runId: agentRunId,
                    agentId,
                    groupId: globalValues.roomId,
                    apiBaseUrl: globalValues.apiBaseUrl,
                    applicationId: globalValues.applicationId,
                    workspaceId: globalValues.workspaceId,
                    restoreSession: agentRestoreSession,
                    authStorage: agentRestoreSession ? 'session' : undefined,
                    actor: authSession?.username,
                    controlToken,
                }),
            ),
        [
            agentControlWsUrl,
            agentIds,
            agentRestoreSession,
            agentRunId,
            authSession?.username,
            bootstrap.providerMode,
            controlToken,
            globalValues.apiBaseUrl,
            globalValues.applicationId,
            globalValues.roomId,
            globalValues.workspaceId,
        ],
    );

    return {
        agentRunId,
        setAgentRunId,
        agentPrefix,
        setAgentPrefix,
        agentCount,
        setAgentCount,
        agentLaunchSuffix,
        setAgentLaunchSuffix,
        agentRestoreSession,
        setAgentRestoreSession,
        agentLaunchMessage,
        setAgentLaunchMessage,
        agentControlWsUrl,
        agentIds,
        agentLaunchUrls,
    };
}

export type RunnerAgentLaunchStateModel = ReturnType<
    typeof useRunnerAgentLaunchState
>;
