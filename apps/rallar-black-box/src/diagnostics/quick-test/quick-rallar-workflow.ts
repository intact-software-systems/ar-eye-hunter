import type { AuthSession } from '@shared/api/api-config.ts';
import type { DirectRallarOperationResult } from '../../direct-rallar-operations.ts';
import type {
    QuickRallarPayloadResult,
    QuickRallarSubscriptionState,
    QuickRallarWorkflowStep
} from './quick-rallar-contracts.ts';

export interface ComputeQuickRallarWorkflowStepsInput {
    readonly realBackendReady: boolean;
    readonly authSession?: AuthSession;
    readonly activeGroupId: string;
    readonly activeTypeId: string;
    readonly activeTopicId: string;
    readonly subscription?: QuickRallarSubscriptionState;
    readonly payloadResult: QuickRallarPayloadResult;
    readonly lastResult?: DirectRallarOperationResult;
    readonly receivedMessageCount: number;
    readonly waitStatus: string;
}

export function computeQuickRallarWorkflowSteps({
    realBackendReady,
    authSession,
    activeGroupId,
    activeTypeId,
    activeTopicId,
    subscription,
    payloadResult,
    lastResult,
    receivedMessageCount,
    waitStatus
}: ComputeQuickRallarWorkflowStepsInput): readonly QuickRallarWorkflowStep[] {
    const setupComplete = realBackendReady && Boolean(authSession) && Boolean(activeGroupId);
    const subscribed = Boolean(subscription);
    const sendComplete = lastResult?.kind === 'ws.send' && lastResult.status === 'completed';
    const verifyComplete = receivedMessageCount > 0 || waitStatus === 'message observed';
    return [
        toQuickRallarSetupStep({ realBackendReady, authSession, activeGroupId, setupComplete }),
        toQuickRallarSubscribeStep({ subscription, activeTypeId, setupComplete, subscribed }),
        toQuickRallarSendStep({ activeTopicId, activeTypeId, payloadResult, setupComplete, sendComplete }),
        toQuickRallarVerifyStep({ receivedMessageCount, waitStatus, verifyComplete, sendComplete, subscribed })
    ];
}

interface ToQuickRallarSetupStepInput {
    readonly realBackendReady: boolean;
    readonly authSession?: AuthSession;
    readonly activeGroupId: string;
    readonly setupComplete: boolean;
}

function toQuickRallarSetupStep({
    realBackendReady,
    authSession,
    activeGroupId,
    setupComplete
}: ToQuickRallarSetupStepInput): QuickRallarWorkflowStep {
    return {
        id: 'setup',
        label: 'Setup',
        detail: !realBackendReady
            ? 'real backend required'
            : !authSession
            ? 'login required'
            : activeGroupId || 'group required',
        state: setupComplete ? 'done' : 'current'
    };
}

interface ToQuickRallarSubscribeStepInput {
    readonly subscription?: QuickRallarSubscriptionState;
    readonly activeTypeId: string;
    readonly setupComplete: boolean;
    readonly subscribed: boolean;
}

function toQuickRallarSubscribeStep({
    subscription,
    activeTypeId,
    setupComplete,
    subscribed
}: ToQuickRallarSubscribeStepInput): QuickRallarWorkflowStep {
    return {
        id: 'subscribe',
        label: 'Subscribe',
        detail: subscription?.label ?? (activeTypeId || 'type required'),
        state: subscribed ? 'done' : setupComplete && activeTypeId ? 'current' : 'blocked'
    };
}

interface ToQuickRallarSendStepInput {
    readonly activeTopicId: string;
    readonly activeTypeId: string;
    readonly payloadResult: QuickRallarPayloadResult;
    readonly setupComplete: boolean;
    readonly sendComplete: boolean;
}

function toQuickRallarSendStep({
    activeTopicId,
    activeTypeId,
    payloadResult,
    setupComplete,
    sendComplete
}: ToQuickRallarSendStepInput): QuickRallarWorkflowStep {
    return {
        id: 'send',
        label: 'Send',
        detail: payloadResult.ok ? activeTopicId || activeTypeId || '-' : 'payload invalid',
        state: sendComplete
            ? 'done'
            : setupComplete && payloadResult.ok
            ? 'current'
            : setupComplete
            ? 'blocked'
            : 'pending'
    };
}

interface ToQuickRallarVerifyStepInput {
    readonly receivedMessageCount: number;
    readonly waitStatus: string;
    readonly verifyComplete: boolean;
    readonly sendComplete: boolean;
    readonly subscribed: boolean;
}

function toQuickRallarVerifyStep({
    receivedMessageCount,
    waitStatus,
    verifyComplete,
    sendComplete,
    subscribed
}: ToQuickRallarVerifyStepInput): QuickRallarWorkflowStep {
    return {
        id: 'verify',
        label: 'Verify',
        detail: verifyComplete ? `${receivedMessageCount} received` : waitStatus,
        state: verifyComplete ? 'done' : sendComplete || subscribed ? 'current' : 'pending'
    };
}
