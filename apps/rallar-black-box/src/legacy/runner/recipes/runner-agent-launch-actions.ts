import type { AuthSession } from '@shared/api/api-config.ts';
import { configureApiClient } from '@shared-web/browser/api-client-config.ts';
import { issueAgentSessionTickets } from '@shared-web/browser/api-integration.ts';
import {
    createRunnerAgentLaunchUrl,
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
    const createBrokeredAgentLaunchUrls = async (): Promise<
        readonly string[]
    > => {
        if (
            agentRestoreSession &&
            providerMode === 'browser-rallar'
        ) {
            if (!authSession) {
                throw new Error(
                    'Open agent tabs requires a logged-in browser session.',
                );
            }

            configureApiClient({ apiBaseUrl: apiBaseUrl });
            const response = await issueAgentSessionTickets(
                { agentIds },
                { authSession },
            );
            const ticketsByAgent = new Map(
                response.tickets.map((ticket) => [ticket.agentId, ticket]),
            );

            return agentIds.map((agentId) => {
                const ticket = ticketsByAgent.get(agentId);
                if (!ticket) {
                    throw new Error(
                        `Missing agent session ticket for ${agentId}.`,
                    );
                }

                return createRunnerAgentLaunchUrl({
                    origin: runnerBrowserOrigin(),
                    providerMode: providerMode,
                    controlWsUrl: agentControlWsUrl,
                    runId: agentRunId,
                    agentId,
                    groupId: groupId,
                    apiBaseUrl: apiBaseUrl,
                    applicationId: applicationId,
                    workspaceId: workspaceId,
                    restoreSession: true,
                    authStorage: 'session',
                    actor: authSession.username,
                    sessionId: ticket.sessionId,
                    controlToken,
                    agentSessionTicket: ticket.ticket,
                });
            });
        }

        return agentIds.map((agentId) =>
            createRunnerAgentLaunchUrl({
                origin: runnerBrowserOrigin(),
                providerMode: providerMode,
                controlWsUrl: agentControlWsUrl,
                runId: agentRunId,
                agentId,
                groupId: groupId,
                apiBaseUrl: apiBaseUrl,
                applicationId: applicationId,
                workspaceId: workspaceId,
                restoreSession: agentRestoreSession,
                authStorage: agentRestoreSession ? 'session' : undefined,
                actor: authSession?.username,
                sessionId: authSession?.sessionId,
                controlToken,
            }),
        );
    };

    const copyAgentLinks = async (): Promise<void> => {
        setBusyAction('agent-links');
        setAgentLaunchMessage('Minting fresh one-time agent links...');
        try {
            const launchUrls = await createBrokeredAgentLaunchUrls();
            await copyText(
                launchUrls.join('\n'),
                `Copied ${launchUrls.length} one-time agent link${launchUrls.length === 1 ? '' : 's'}.`,
            );
            setAgentLaunchMessage(
                `Copied ${launchUrls.length} one-time, short-lived agent link${launchUrls.length === 1 ? '' : 's'}.`,
            );
            setAgentLaunchSuffix(runnerNewAgentLaunchSuffix());
        } catch (error) {
            setAgentLaunchMessage(runnerFriendlyErrorMessage(error));
        } finally {
            setBusyAction(undefined);
        }
    };

    const openAgentTabs = async (): Promise<void> => {
        const pendingAgentWindows = agentIds.map(() => {
            const popup = globalThis.open?.('about:blank', '_blank');
            try {
                if (popup) {
                    popup.opener = null;
                    popup.document.title = 'Rallar Agent';
                    popup.document.body.textContent =
                        'Preparing fresh Rallar agent session...';
                }
            } catch {
                // Popup access can be unavailable in browser security modes.
            }
            return popup;
        });
        setBusyAction('agent-tabs');
        setAgentLaunchMessage(
            'Minting fresh one-time agent sessions...',
        );
        try {
            const launchUrls = await createBrokeredAgentLaunchUrls();
            setControlRunId(agentRunId);
            launchUrls.forEach((url, index) => {
                const pendingWindow = pendingAgentWindows[index];
                if (pendingWindow && !pendingWindow.closed) {
                    pendingWindow.location.href = url;
                    return;
                }
                globalThis.open?.(url, '_blank', 'noopener,noreferrer');
            });
            setAgentLaunchMessage(
                `Requested ${launchUrls.length} agent tab${launchUrls.length === 1 ? '' : 's'} with fresh one-time sessions. Copy links if your browser blocked popups.`,
            );
            setAgentLaunchSuffix(runnerNewAgentLaunchSuffix());
        } catch (error) {
            const message = runnerFriendlyErrorMessage(error);
            pendingAgentWindows.forEach((pendingWindow) => {
                try {
                    if (pendingWindow && !pendingWindow.closed) {
                        pendingWindow.document.body.textContent = message;
                    }
                } catch {
                    // Ignore inaccessible popup documents.
                }
            });
            setAgentLaunchMessage(message);
        } finally {
            setBusyAction(undefined);
        }
    };

    return { copyAgentLinks, openAgentTabs };
}
