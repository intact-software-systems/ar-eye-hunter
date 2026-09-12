import type { RallarBlackBoxTestState } from '@shared-test/rallar-bb-test/types.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type * as React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
    type DirectRallarOperationResult
} from '../../../direct-rallar-operations.ts';
import { type RallarBlackBoxBootstrapConfig } from '../../../runtime-store.ts';
import type { CommandCenterGlobalValues } from '../../shell/global-context-model.ts';
import type { RallarBrowserStatusSummary } from '../../shell/rallar-browser-status.ts';
import type {
    QuickRallarReceivedMessageRow,
    QuickRallarSubscriptionState,
    QuickRallarTestViewModel,
    QuickRallarValues,
    QuickRallarWorkflowStep
} from './quick-rallar-contracts.ts';
import { QUICK_RALLAR_DEFAULT_VALUES } from './quick-rallar-defaults.ts';
import { QuickRallarTestActions } from './quick-rallar-test-actions.ts';
export interface UseQuickRallarTestControllerInput {
    state: RallarBlackBoxTestState;
    bootstrap: RallarBlackBoxBootstrapConfig;
    authSession?: AuthSession;
    globalValues: CommandCenterGlobalValues;
    browserStatus: RallarBrowserStatusSummary;
    onGlobalValueChange<K extends keyof CommandCenterGlobalValues>(
        key: K,
        value: CommandCenterGlobalValues[K]
    ): void;
}
interface QuickRallarTestControls {
    readonly values: QuickRallarValues;
    readonly setValues: React.Dispatch<React.SetStateAction<QuickRallarValues>>;
    readonly busyAction: string | undefined;
    readonly setBusyAction: React.Dispatch<React.SetStateAction<string | undefined>>;
    readonly localError: string | undefined;
    readonly setLocalError: React.Dispatch<React.SetStateAction<string | undefined>>;
    readonly lastResult: DirectRallarOperationResult | undefined;
    readonly setLastResult: React.Dispatch<React.SetStateAction<DirectRallarOperationResult | undefined>>;
    readonly subscription: QuickRallarSubscriptionState | undefined;
    readonly setSubscription: React.Dispatch<React.SetStateAction<QuickRallarSubscriptionState | undefined>>;
    readonly receivedMessages: readonly QuickRallarReceivedMessageRow[];
    readonly setReceivedMessages: React.Dispatch<React.SetStateAction<readonly QuickRallarReceivedMessageRow[]>>;
    readonly waitStatus: string;
    readonly setWaitStatus: React.Dispatch<React.SetStateAction<string>>;
}
function useQuickRallarTestControls(globalValues: CommandCenterGlobalValues): QuickRallarTestControls {
    const [values, setValues] = useState<QuickRallarValues>(() => createQuickRallarTestValues(globalValues));
    const [busyAction, setBusyAction] = useState<string | undefined>();
    const [localError, setLocalError] = useState<string | undefined>();
    const [lastResult, setLastResult] = useState<DirectRallarOperationResult | undefined>();
    const [subscription, setSubscription] = useState<QuickRallarSubscriptionState | undefined>();
    const [receivedMessages, setReceivedMessages] = useState<readonly QuickRallarReceivedMessageRow[]>([]);
    const [waitStatus, setWaitStatus] = useState('idle');
    return {
        values,
        setValues,
        busyAction,
        setBusyAction,
        localError,
        setLocalError,
        lastResult,
        setLastResult,
        subscription,
        setSubscription,
        receivedMessages,
        setReceivedMessages,
        waitStatus,
        setWaitStatus
    };
}
function createQuickRallarTestValues(globalValues: CommandCenterGlobalValues): QuickRallarValues {
    return {
        ...QUICK_RALLAR_DEFAULT_VALUES,
        contextId: globalValues.roomId || 'room'
    };
}
export function useQuickRallarTestController(input: UseQuickRallarTestControllerInput): QuickRallarTestViewModel {
    const providerMode = input.bootstrap.providerMode;
    const controls = useQuickRallarTestControls(input.globalValues);
    const lifecycle = useQuickRallarTestLifecycle(input, controls);
    const projection = useQuickRallarTestPresentation(input, controls, providerMode);
    const actions = new QuickRallarTestActions({ ...input, ...controls, ...lifecycle, ...projection });
    return toQuickRallarTestViewModel(controls, projection, actions);
}
interface QuickRallarTestLifecycle {
    readonly subscriptionRef: React.RefObject<QuickRallarSubscriptionState | undefined>;
    readonly receivedCountRef: React.RefObject<number>;
    readonly previousGlobalGroupRef: React.RefObject<string>;
}
function useQuickRallarTestLifecycle(
    input: UseQuickRallarTestControllerInput,
    controls: QuickRallarTestControls
): QuickRallarTestLifecycle {
    const { globalValues } = input;
    const { subscription, receivedMessages, setValues } = controls;

    const subscriptionRef = useRef<QuickRallarSubscriptionState | undefined>(
        undefined
    );
    const receivedCountRef = useRef(0);
    const previousGlobalGroupRef = useRef(globalValues.roomId);
    useEffect(() => {
        subscriptionRef.current = subscription;
    }, [subscription]);
    useEffect(() => {
        receivedCountRef.current = receivedMessages.length;
    }, [receivedMessages.length]);
    useEffect(
        () => () => {
            subscriptionRef.current?.unsubscribe();
        },
        []
    );
    useEffect(() => {
        const previousGroup = previousGlobalGroupRef.current;
        previousGlobalGroupRef.current = globalValues.roomId;
        setValues((current) => {
            if (current.contextId && current.contextId !== previousGroup) {
                return current;
            }

            return {
                ...current,
                contextId: globalValues.roomId || 'room'
            };
        });
    }, [globalValues.roomId]);
    return { subscriptionRef, receivedCountRef, previousGlobalGroupRef };
}

interface QuickRallarTestPresentation {
    readonly providerMode: 'browser-rallar' | 'simulated';
    readonly realBackendReady: boolean;
    readonly canUseDirectRallar: boolean;
    readonly activeGroupId: string;
    readonly activeTypeId: string;
    readonly activeTopicId: string;
    readonly activeContextId: string;
    readonly selectorLabel: string;
    readonly payloadResult: QuickRallarTestActions.Input['payloadResult'];
    readonly setupComplete: boolean;
    readonly subscribed: boolean;
    readonly workflowSteps: readonly QuickRallarWorkflowStep[];
}
function useQuickRallarTestPresentation(
    input: UseQuickRallarTestControllerInput,
    controls: QuickRallarTestControls,
    providerMode: 'browser-rallar' | 'simulated'
): QuickRallarTestPresentation {
    const { authSession, globalValues } = input;
    const { values, busyAction, localError, lastResult, subscription, receivedMessages, waitStatus } = controls;
    const realBackendReady = providerMode === 'browser-rallar';
    const canUseDirectRallar = realBackendReady && Boolean(authSession) && !busyAction;
    const activeGroupId = globalValues.roomId.trim();
    const activeTypeId = values.typeId.trim();
    const activeTopicId = values.topicId.trim() || activeTypeId;
    const activeContextId = values.contextId.trim() || activeGroupId || 'room';
    const selectorLabel = `${activeTopicId || '*'} / ${activeTypeId || '-'}`;
    const payloadResult = useMemo(() => toQuickRallarTestPayload(values.payloadText), [values.payloadText]);
    const setupComplete = realBackendReady && Boolean(authSession) && Boolean(activeGroupId);
    const subscribed = Boolean(subscription);
    const sendComplete = lastResult?.kind === 'ws.send' && lastResult.status === 'completed';
    const verifyComplete = receivedMessages.length > 0 || waitStatus === 'message observed';
    const workflowSteps: readonly QuickRallarWorkflowStep[] = computeQuickRallarWorkflowSteps({
        realBackendReady,
        authSession,
        activeGroupId,
        setupComplete,
        subscription,
        activeTypeId,
        subscribed,
        payloadResult,
        activeTopicId,
        sendComplete,
        verifyComplete,
        receivedMessages,
        waitStatus
    });
    return {
        providerMode,
        realBackendReady,
        canUseDirectRallar,
        activeGroupId,
        activeTypeId,
        activeTopicId,
        activeContextId,
        selectorLabel,
        payloadResult,
        setupComplete,
        subscribed,
        workflowSteps
    };
}
function toQuickRallarTestViewModel(
    controls: QuickRallarTestControls,
    projection: QuickRallarTestPresentation,
    actions: QuickRallarTestActions
): QuickRallarTestViewModel {
    return {
        values: controls.values,
        busyAction: controls.busyAction,
        localError: controls.localError,
        lastResult: controls.lastResult,
        subscription: controls.subscription,
        receivedMessages: controls.receivedMessages,
        waitStatus: controls.waitStatus,
        providerMode: projection.providerMode,
        realBackendReady: projection.realBackendReady,
        canUseDirectRallar: projection.canUseDirectRallar,
        activeGroupId: projection.activeGroupId,
        activeTypeId: projection.activeTypeId,
        activeContextId: projection.activeContextId,
        selectorLabel: projection.selectorLabel,
        payloadResult: projection.payloadResult,
        updateValue: actions.updateValue,
        updateGroupId: actions.updateGroupId,
        createGroup: actions.createGroup,
        joinGroup: actions.joinGroup,
        subscribeWs: actions.subscribeWs,
        unsubscribeWs: actions.unsubscribeWs,
        sendWs: actions.sendWs,
        waitForReceive: actions.waitForReceive,
        copyDiagnostics: actions.copyDiagnostics,
        copyRunnerRecipe: actions.copyRunnerRecipe,
        setupComplete: projection.setupComplete,
        subscribed: projection.subscribed,
        workflowSteps: projection.workflowSteps
    };
}

function toQuickRallarTestPayload(payloadText: string): QuickRallarTestActions.Input['payloadResult'] {
    try {
        return {
            ok: true as const,
            value: JSON.parse(
                payloadText
            ) as import('@shared-web/browser/messages/rallar-message-contracts.ts').RallarMessagePayload
        };
    }
    catch (error) {
        return {
            ok: false as const,
            error: error instanceof Error ? error.message : String(error)
        };
    }
}

interface QuickRallarWorkflowInput {
    readonly realBackendReady: boolean;
    readonly authSession: AuthSession | undefined;
    readonly activeGroupId: string;
    readonly setupComplete: boolean;
    readonly subscription: QuickRallarSubscriptionState | undefined;
    readonly activeTypeId: string;
    readonly subscribed: boolean;
    readonly payloadResult: QuickRallarTestActions.Input['payloadResult'];
    readonly activeTopicId: string;
    readonly sendComplete: boolean;
    readonly verifyComplete: boolean;
    readonly receivedMessages: readonly QuickRallarReceivedMessageRow[];
    readonly waitStatus: string;
}

function computeQuickRallarWorkflowSteps(input: QuickRallarWorkflowInput): readonly QuickRallarWorkflowStep[] {
    return [
        {
            id: 'setup',
            label: 'Setup',
            detail: !input.realBackendReady
                ? 'real backend required'
                : !input.authSession
                ? 'login required'
                : input.activeGroupId
                ? input.activeGroupId
                : 'group required',
            state: input.setupComplete ? 'done' : 'current'
        },
        {
            id: 'subscribe',
            label: 'Subscribe',
            detail: input.subscription ? input.subscription.label : input.activeTypeId || 'type required',
            state: input.subscribed
                ? 'done'
                : input.setupComplete && input.activeTypeId
                ? 'current'
                : 'blocked'
        },
        {
            id: 'send',
            label: 'Send',
            detail: input.payloadResult.ok ? input.activeTopicId || input.activeTypeId || '-' : 'payload invalid',
            state: input.sendComplete
                ? 'done'
                : input.setupComplete && input.payloadResult.ok
                ? 'current'
                : input.setupComplete
                ? 'blocked'
                : 'pending'
        },
        {
            id: 'verify',
            label: 'Verify',
            detail: input.verifyComplete
                ? `${input.receivedMessages.length} received`
                : input.waitStatus,
            state: input.verifyComplete
                ? 'done'
                : input.sendComplete || input.subscribed
                ? 'current'
                : 'pending'
        }
    ];
}
