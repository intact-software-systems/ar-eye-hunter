import { QuickRallarTestView } from './QuickRallarTestView.tsx';
import {
    useQuickRallarTestController,
    type UseQuickRallarTestControllerInput
} from './use-quick-rallar-test-controller.ts';

type QuickRallarTestPanelProps =
    & UseQuickRallarTestControllerInput
    & Readonly<{
        onOpenAuth(): void;
        onOpenRunnerMode(): void;
    }>;

export function QuickRallarTestPanel({
    state,
    bootstrap,
    authSession,
    globalValues,
    browserStatus,
    onGlobalValueChange,
    onOpenAuth,
    onOpenRunnerMode
}: QuickRallarTestPanelProps) {
    const {
        values,
        busyAction,
        localError,
        lastResult,
        subscription,
        receivedMessages,
        waitStatus,
        providerMode,
        realBackendReady,
        canUseDirectRallar,
        activeGroupId,
        activeTypeId,
        activeContextId,
        selectorLabel,
        payloadResult,
        updateValue,
        updateGroupId,
        createGroup,
        joinGroup,
        subscribeWs,
        unsubscribeWs,
        sendWs,
        waitForReceive,
        copyDiagnostics,
        copyRunnerRecipe,
        setupComplete,
        subscribed,
        workflowSteps
    } = useQuickRallarTestController({
        state,
        bootstrap,
        authSession,
        globalValues,
        browserStatus,
        onGlobalValueChange
    });

    return (
        <QuickRallarTestView
            state={state}
            authSession={authSession}
            globalValues={globalValues}
            browserStatus={browserStatus}
            model={{
                values,
                busyAction,
                localError,
                lastResult,
                subscription,
                receivedMessages,
                waitStatus,
                providerMode,
                realBackendReady,
                canUseDirectRallar,
                activeGroupId,
                activeTypeId,
                activeContextId,
                selectorLabel,
                payloadResult,
                updateValue,
                updateGroupId,
                createGroup,
                joinGroup,
                subscribeWs,
                unsubscribeWs,
                sendWs,
                waitForReceive,
                copyDiagnostics,
                copyRunnerRecipe,
                setupComplete,
                subscribed,
                workflowSteps
            }}
            onOpenAuth={onOpenAuth}
            onOpenRunnerMode={onOpenRunnerMode}
        />
    );
}
