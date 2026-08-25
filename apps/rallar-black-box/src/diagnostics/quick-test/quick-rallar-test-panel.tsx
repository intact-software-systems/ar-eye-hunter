import { QuickRallarTestView } from './quick-rallar-test-view.tsx';
import {
    useQuickRallarTestController,
    type UseQuickRallarTestControllerInput
} from './use-quick-rallar-test-controller.ts';

interface QuickRallarTestPanelProps extends UseQuickRallarTestControllerInput {
    onOpenAuth(): void;
    onOpenRunnerMode(): void;
}

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
    const model = useQuickRallarTestController({
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
            model={model}
            onOpenAuth={onOpenAuth}
            onOpenRunnerMode={onOpenRunnerMode}
        />
    );
}
