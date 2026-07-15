import { useMemo, useState } from 'react';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { RallarBlackBoxControlSnapshot } from '../../../control-client.ts';
import {
    runnerAgentId,
    runnerNewAgentLaunchSuffix,
} from '../../../runner-agent-launch.ts';
import type { RallarBlackBoxBootstrapConfig } from '../../../runtime-store.ts';
import { safeIdSegment } from '../../shared/safe-id-segment.ts';
import {
    runnerControlWsUrlFromHttpBaseUrl,
} from './runner-endpoints.ts';

export function useRunnerAgentLaunchState({
    control,
    bootstrap,
    authSession,
    controlBaseUrl,
}: Readonly<{
    control: RallarBlackBoxControlSnapshot;
    bootstrap: RallarBlackBoxBootstrapConfig;
    authSession?: AuthSession;
    controlBaseUrl: string;
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
    };
}

export type RunnerAgentLaunchStateModel = ReturnType<
    typeof useRunnerAgentLaunchState
>;
