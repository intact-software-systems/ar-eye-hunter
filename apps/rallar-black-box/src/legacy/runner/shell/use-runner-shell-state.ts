import {
    type Dispatch,
    type SetStateAction,
    useEffect,
    useMemo,
    useState,
} from 'react';
import {
    selectRallarBlackBoxActiveCommand,
    selectRallarBlackBoxCommandHistory,
} from '@shared-test/rallar-bb-test/selectors.ts';
import type {
    RallarBlackBoxTestResult,
    RallarBlackBoxTestState,
} from '@shared-test/rallar-bb-test/types.ts';
import {
    readStoredSelectedCommandId,
    writeStoredSelectedCommandId,
} from '../../../ui-persistence.ts';
import { useNow } from '../../shared/use-now.ts';
import { browserUiStorage } from '../../shell/browser-ui-storage.ts';
import type { RunnerDistributedRunSelection } from '../runner-contracts.ts';
import { deriveQueue, findSelectedResult } from './runner-shell-model.ts';

export function useRunnerShellState(state: RallarBlackBoxTestState) {
    const queueRows = useMemo(() => deriveQueue(state), [state]);
    const history = selectRallarBlackBoxCommandHistory(state);
    const activeCommand = selectRallarBlackBoxActiveCommand(state);
    const now = useNow(250);
    const [selectedCommandId, setSelectedCommandId] = useState<
        string | undefined
    >(() => readStoredSelectedCommandId(browserUiStorage()));
    const [runnerDistributedSelection, setRunnerDistributedSelection] =
        useState<RunnerDistributedRunSelection | undefined>();
    const selectedResult = findSelectedResult(history, selectedCommandId);

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
    };
}

export function useRunnerShellSelectionSync({
    activeCommand,
    history,
    selectedCommandId,
    setSelectedCommandId,
}: Readonly<{
    activeCommand: RallarBlackBoxTestState['activeCommand'];
    history: readonly RallarBlackBoxTestResult[];
    selectedCommandId: string | undefined;
    setSelectedCommandId: Dispatch<SetStateAction<string | undefined>>;
}>): void {
    useEffect(() => {
        if (activeCommand) {
            setSelectedCommandId(activeCommand.commandId);
            return;
        }

        if (!selectedCommandId && history.length > 0) {
            setSelectedCommandId(history.at(-1)?.commandId);
        }
    }, [activeCommand, history, selectedCommandId]);

    useEffect(() => {
        writeStoredSelectedCommandId(browserUiStorage(), selectedCommandId);
    }, [selectedCommandId]);
}
