import {
    selectRallarBlackBoxActiveCommand,
    selectRallarBlackBoxCommandHistory
} from '@shared-test/rallar-bb-test/selectors.ts';
import type { RallarBlackBoxTestResult, RallarBlackBoxTestState } from '@shared-test/rallar-bb-test/types.ts';
import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { readStoredSelectedCommandId, writeStoredSelectedCommandId } from '../../../ui-persistence.ts';
import type { LegacyDiagnosticContext } from '../../diagnostics/context/legacy-diagnostic-context.ts';
import { useNow } from '../../shared/use-now.ts';
import { browserUiStorage } from '../../shell/browser-ui-storage.ts';
import type { RunnerDistributedRunSelection } from '../runner-contracts.ts';
import { deriveQueue, findSelectedResult } from './runner-shell-model.ts';

export function useRunnerShellState(
    state: RallarBlackBoxTestState,
    diagnosticContext?: LegacyDiagnosticContext
) {
    const queueRows = useMemo(() => deriveQueue(state), [state]);
    const history = selectRallarBlackBoxCommandHistory(state);
    const activeCommand = selectRallarBlackBoxActiveCommand(state);
    const now = useNow(250);
    const [selectedCommandId, setSelectedCommandId] = useState<string | undefined>(() =>
        initialRunnerCommandId(
            diagnosticContext,
            readStoredSelectedCommandId(browserUiStorage())
        )
    );
    const [runnerDistributedSelection, setRunnerDistributedSelection] = useState<
        RunnerDistributedRunSelection | undefined
    >();
    const selectedResult = selectedRunnerResult(
        history,
        selectedCommandId,
        diagnosticContext
    );
    const diagnosticCommandId = diagnosticContext?.commandId;
    const lastDiagnosticCommandId = useRef(diagnosticCommandId);

    useEffect(() => {
        if (diagnosticCommandId === lastDiagnosticCommandId.current) {
            return;
        }
        lastDiagnosticCommandId.current = diagnosticCommandId;
        setSelectedCommandId(
            initialRunnerCommandId(
                diagnosticContext,
                readStoredSelectedCommandId(browserUiStorage())
            )
        );
    }, [diagnosticCommandId]);

    return {
        queueRows,
        history,
        activeCommand,
        now,
        selectedCommandId,
        setSelectedCommandId,
        runnerDistributedSelection,
        setRunnerDistributedSelection,
        selectedResult,
        diagnosticCommandId
    };
}

export function useRunnerShellSelectionSync({
    activeCommand,
    history,
    selectedCommandId,
    setSelectedCommandId,
    diagnosticCommandId
}: Readonly<{
    activeCommand: RallarBlackBoxTestState['activeCommand'];
    history: readonly RallarBlackBoxTestResult[];
    selectedCommandId: string | undefined;
    setSelectedCommandId: Dispatch<SetStateAction<string | undefined>>;
    diagnosticCommandId?: string;
}>): void {
    const activeCommandId = activeCommand?.commandId;
    const didInitializeSync = useRef(false);
    const lastActiveCommandId = useRef<string | undefined>(undefined);
    const lastDiagnosticCommandId = useRef(diagnosticCommandId);

    useEffect(() => {
        const initialSync = !didInitializeSync.current;
        const diagnosticContextChanged = diagnosticCommandId !== lastDiagnosticCommandId.current;
        const activeCommandChanged = activeCommandId !== lastActiveCommandId.current;

        didInitializeSync.current = true;
        lastDiagnosticCommandId.current = diagnosticCommandId;
        lastActiveCommandId.current = activeCommandId;

        if ((initialSync && diagnosticCommandId) || diagnosticContextChanged) {
            return;
        }

        if (activeCommandId && (initialSync || activeCommandChanged)) {
            setSelectedCommandId(activeCommandId);
            return;
        }

        if (!selectedCommandId && history.length > 0) {
            setSelectedCommandId(history.at(-1)?.commandId);
        }
    }, [activeCommandId, diagnosticCommandId, history, selectedCommandId]);

    useEffect(() => {
        if (!diagnosticCommandId) {
            writeStoredSelectedCommandId(browserUiStorage(), selectedCommandId);
        }
    }, [diagnosticCommandId, selectedCommandId]);
}

export function initialRunnerCommandId(
    diagnosticContext: LegacyDiagnosticContext | undefined,
    storedCommandId: string | undefined
): string | undefined {
    return diagnosticContext?.commandId ?? storedCommandId;
}

export function selectedRunnerResult(
    history: readonly RallarBlackBoxTestResult[],
    selectedCommandId: string | undefined,
    diagnosticContext: LegacyDiagnosticContext | undefined
): RallarBlackBoxTestResult | undefined {
    if (
        diagnosticContext?.commandId &&
        selectedCommandId === diagnosticContext.commandId
    ) {
        return history.find(
            (result) => result.commandId === diagnosticContext.commandId
        );
    }
    return findSelectedResult(history, selectedCommandId);
}
