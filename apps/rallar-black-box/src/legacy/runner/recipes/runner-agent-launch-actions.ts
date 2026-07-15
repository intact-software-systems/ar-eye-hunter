import type { AuthSession } from '@shared/api/api-config.ts';
import { createBrowserAgentLaunchService } from '../../../browser-agent-launch-service.ts';
import {
    navigateReservedBrowserAgentPopups,
    releaseReservedBrowserAgentPopups,
    reserveBrowserAgentPopups,
} from '../../../browser-agent-popup.ts';
import {
    runnerNewAgentLaunchSuffix,
} from '../../../runner-agent-launch.ts';
import { runnerFriendlyErrorMessage } from '../../../runner-readiness.ts';
import type { RallarBlackBoxBootstrapConfig } from '../../../runtime-store.ts';
import { runnerBrowserOrigin } from './runner-endpoints.ts';

type RunnerAgentLaunchActionsInput = Readonly<{
    agentRestoreSession: boolean;
    providerMode: RallarBlackBoxBootstrapConfig['providerMode'];
    authSession?: AuthSession;
    apiBaseUrl: string;
    agentIds: readonly string[];
    agentControlWsUrl: string;
    agentRunId: string;
    groupId: string;
    applicationId: string;
    workspaceId: string;
    controlToken: string;
    copyText(text: string, message: string): Promise<void>;
    setBusyAction(value: string | undefined): void;
    setAgentLaunchMessage(value: string | undefined): void;
    setAgentLaunchSuffix(value: string): void;
    setControlRunId(value: string): void;
}>;

export function createRunnerAgentLaunchActions({
    agentRestoreSession,
    providerMode,
    authSession,
    apiBaseUrl,
    agentIds,
    agentControlWsUrl,
    agentRunId,
    groupId,
    applicationId,
    workspaceId,
    controlToken,
    copyText,
    setBusyAction,
    setAgentLaunchMessage,
    setAgentLaunchSuffix,
    setControlRunId,
}: RunnerAgentLaunchActionsInput) {
    const launchService = createBrowserAgentLaunchService({
        origin: runnerBrowserOrigin(),
        providerMode,
        controlWsUrl: agentControlWsUrl,
        apiBaseUrl,
        group: { applicationId, workspaceId, groupId },
        authSession,
        issueAgentSessions: agentRestoreSession,
        allowAnonymousControlToken: true,
        issueRunToken: async ({ runId, agentId }) => {
            const issuedAtEpochMs = Date.now();
            return {
                runId,
                agentId,
                token: controlToken,
                issuedAtEpochMs,
                expiresAtEpochMs: issuedAtEpochMs + 60 * 60 * 1_000,
            };
        },
    });

    const prepare = (ids: readonly string[]) => launchService.prepare({
        runId: agentRunId,
        agentIds: ids,
    });

    const copyAgentLinks = async (): Promise<void> => {
        setBusyAction('agent-links');
        setAgentLaunchMessage('Minting fresh one-time agent links...');
        try {
            const prepared = await prepare(agentIds);
            setControlRunId(prepared.runId);
            await copyText(
                prepared.agents.map(agent => agent.launchUrl).join('\n'),
                `Copied ${prepared.agents.length} one-time agent link${prepared.agents.length === 1 ? '' : 's'}.`,
            );
            setAgentLaunchMessage(
                `Copied ${prepared.agents.length} one-time, short-lived agent link${prepared.agents.length === 1 ? '' : 's'}.`,
            );
            setAgentLaunchSuffix(runnerNewAgentLaunchSuffix());
        } catch (error) {
            setAgentLaunchMessage(runnerFriendlyErrorMessage(error));
        } finally {
            setBusyAction(undefined);
        }
    };

    const openAgentTabs = async (): Promise<void> => {
        const reservation = reserveBrowserAgentPopups(agentIds);
        if (reservation.reservedAgentIds.length === 0) {
            setAgentLaunchMessage(
                `Your browser blocked all ${agentIds.length} agent tabs. Copy the launch links instead.`,
            );
            return;
        }
        setBusyAction('agent-tabs');
        setAgentLaunchMessage(
            'Minting fresh one-time agent sessions...',
        );
        try {
            const prepared = await prepare(reservation.reservedAgentIds);
            setControlRunId(prepared.runId);
            navigateReservedBrowserAgentPopups(reservation, prepared.agents);
            const blocked = reservation.blockedAgentIds.length;
            setAgentLaunchMessage(
                blocked > 0
                    ? `Opened ${prepared.agents.length} agent tabs. ${blocked} ${blocked === 1 ? 'tab was' : 'tabs were'} blocked; copy fresh links for the remainder.`
                    : `Opened ${prepared.agents.length} agent tab${prepared.agents.length === 1 ? '' : 's'} with fresh one-time sessions.`,
            );
            setAgentLaunchSuffix(runnerNewAgentLaunchSuffix());
        } catch (error) {
            const message = runnerFriendlyErrorMessage(error);
            releaseReservedBrowserAgentPopups(reservation, message);
            setAgentLaunchMessage(message);
        } finally {
            setBusyAction(undefined);
        }
    };

    return { copyAgentLinks, openAgentTabs };
}
