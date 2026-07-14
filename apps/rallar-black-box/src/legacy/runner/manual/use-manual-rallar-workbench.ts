import { useEffect, useMemo, useState } from 'react';
import type { AuthSession } from '@shared/api/api-config.ts';
import { selectRallarBlackBoxEvents } from '@shared-test/rallar-bb-test/selectors.ts';
import type { RallarBlackBoxTestCommand, RallarBlackBoxTestState } from '@shared-test/rallar-bb-test/types.ts';
import { redactRallarBlackBoxValue } from '@shared-test/rallar-bb-test/redaction.ts';
import {
    MANUAL_PAYLOAD_PRESETS,
    buildManualWorkbenchCommands,
    manualRtcDeliveryMatrixCommands,
    manualRtcNackProbeCommands,
    manualRtcNegativeRecipeSnippet,
    manualRecipeSnippet,
    parseManualPayload,
    type ManualActionHistoryEntry,
    type ManualWorkbenchAction,
    type ManualWorkbenchTransport,
    type ManualWorkbenchValues,
} from '../../../manual-workbench.ts';
import { rallarBlackBoxRuntimeStore, type RallarBlackBoxBootstrapConfig } from '../../../runtime-store.ts';
import { validateSchemaAuthoringText, validateSchemaAuthoringValue } from '../../../schema-authoring.ts';
import {
    readManualWorkbenchDraft,
    writeManualWorkbenchDraft,
    type ManualWorkbenchDraft,
} from '../../../ui-persistence.ts';
import { browserUiStorage } from '../../shell/browser-ui-storage.ts';
import type { CommandCenterGlobalValues } from '../../shell/global-context-model.ts';
import { uiRedactionOptions, uiSecretValues } from '../../shared/redaction-presentation.ts';
import { actionLabel, manualValuesFromState } from './manual-workbench-defaults.ts';

type ManualRallarWorkbenchOptions = Readonly<{
    state: RallarBlackBoxTestState;
    bootstrap: RallarBlackBoxBootstrapConfig;
    authSession?: AuthSession;
    globalValues?: CommandCenterGlobalValues;
    globalValuesEdited?: boolean;
    onSelectCommand(commandId: string): void;
    onGlobalValueChange?<K extends keyof CommandCenterGlobalValues>(
        key: K,
        value: CommandCenterGlobalValues[K],
    ): void;
}>;

export function useManualRallarWorkbench({
    state,
    bootstrap,
    authSession,
    globalValues,
    globalValuesEdited,
    onSelectCommand,
    onGlobalValueChange,
}: ManualRallarWorkbenchOptions) {
    const defaultValues = useMemo(
        () =>
            manualValuesFromState(state, bootstrap, authSession, globalValues),
        [
            authSession,
            bootstrap,
            globalValues?.apiBaseUrl,
            globalValues?.applicationId,
            globalValues?.clientId,
            globalValues?.roomId,
            globalValues?.sessionId,
            globalValues?.workspaceId,
            state.currentConfig,
        ],
    );
    const defaultDraft = useMemo<ManualWorkbenchDraft>(
        () => ({
            values: defaultValues,
            payloadPresetId: MANUAL_PAYLOAD_PRESETS[0].presetId,
            payloadText: JSON.stringify(
                MANUAL_PAYLOAD_PRESETS[0].payload,
                null,
                2,
            ),
        }),
        [defaultValues],
    );
    const [initialDraft] = useState(() => {
        const stored = readManualWorkbenchDraft(
            browserUiStorage(),
            defaultDraft,
        );
        return {
            draft: stored ?? defaultDraft,
            restored: Boolean(stored),
        };
    });
    const [values, setValues] = useState<ManualWorkbenchValues>(
        () => initialDraft.draft.values,
    );
    const [valuesEdited, setValuesEdited] = useState(initialDraft.restored);
    const [payloadPresetId, setPayloadPresetId] = useState(
        initialDraft.draft.payloadPresetId,
    );
    const [payloadText, setPayloadText] = useState(
        () => initialDraft.draft.payloadText,
    );
    const [sequence, setSequence] = useState(1);
    const [history, setHistory] = useState<readonly ManualActionHistoryEntry[]>(
        [],
    );
    const [localError, setLocalError] = useState<string | undefined>();
    const [recipeVisible, setRecipeVisible] = useState(false);
    const events = selectRallarBlackBoxEvents(state);
    const payloadResult = useMemo(
        () => parseManualPayload(payloadText),
        [payloadText],
    );
    const previewCommands = useMemo(
        () =>
            payloadResult.ok
                ? buildManualWorkbenchCommands(
                      'send',
                      values,
                      payloadResult.value,
                      sequence,
                  )
                : [],
        [payloadResult, sequence, values],
    );
    const recipeText = useMemo(() => manualRecipeSnippet(history), [history]);
    const negativeRecipeText = useMemo(
        () =>
            payloadResult.ok
                ? manualRtcNegativeRecipeSnippet(values, payloadResult.value)
                : payloadResult.error,
        [payloadResult, values],
    );
    const previewRecipeValidation = useMemo(
        () =>
            payloadResult.ok
                ? validateSchemaAuthoringValue('recipe', {
                      recipeId: 'manual-rallar-command-preview',
                      commands: previewCommands,
                  })
                : undefined,
        [payloadResult.ok, previewCommands],
    );
    const manualRecipeValidation = useMemo(
        () =>
            recipeText.trim().length > 0
                ? validateSchemaAuthoringText('recipe', recipeText)
                : undefined,
        [recipeText],
    );
    const negativeRecipeValidation = useMemo(
        () =>
            payloadResult.ok
                ? validateSchemaAuthoringText('recipe', negativeRecipeText)
                : undefined,
        [negativeRecipeText, payloadResult.ok],
    );

    useEffect(() => {
        if (!valuesEdited) {
            setValues(defaultValues);
        }
    }, [defaultValues, valuesEdited]);

    useEffect(() => {
        if (!authSession) {
            return;
        }

        setValues((current) => {
            const clientId =
                globalValues?.clientId ||
                authSession.clientId ||
                authSession.username;
            const sessionId = globalValues?.sessionId || authSession.sessionId;
            const nextValues = {
                ...current,
                actor: clientId,
                sessionId,
                rallarUsername: authSession.username,
                rallarRestoreSession: true,
            };

            return current.actor === nextValues.actor &&
                current.sessionId === nextValues.sessionId &&
                current.rallarUsername === nextValues.rallarUsername &&
                current.rallarRestoreSession === nextValues.rallarRestoreSession
                ? current
                : nextValues;
        });
    }, [
        authSession?.clientId,
        authSession?.sessionId,
        authSession?.username,
        globalValues?.clientId,
        globalValues?.sessionId,
    ]);

    useEffect(() => {
        if (!globalValues || !globalValuesEdited) {
            return;
        }

        setValues((current) => {
            const nextValues = {
                ...current,
                apiBaseUrl: globalValues.apiBaseUrl,
                applicationId: globalValues.applicationId,
                workspaceId: globalValues.workspaceId,
                actor: globalValues.clientId,
                sessionId: globalValues.sessionId,
                groupId: globalValues.roomId,
            };

            return current.apiBaseUrl === nextValues.apiBaseUrl &&
                current.applicationId === nextValues.applicationId &&
                current.workspaceId === nextValues.workspaceId &&
                current.actor === nextValues.actor &&
                current.sessionId === nextValues.sessionId &&
                current.groupId === nextValues.groupId
                ? current
                : nextValues;
        });
    }, [
        globalValues?.apiBaseUrl,
        globalValues?.applicationId,
        globalValues?.clientId,
        globalValues?.roomId,
        globalValues?.sessionId,
        globalValues?.workspaceId,
        globalValuesEdited,
    ]);

    useEffect(() => {
        writeManualWorkbenchDraft(
            browserUiStorage(),
            {
                values,
                payloadPresetId,
                payloadText,
            },
            uiSecretValues(state, authSession, [values.rallarPassword]),
        );
    }, [
        authSession?.accessToken,
        payloadPresetId,
        payloadText,
        state.currentConfig?.redaction,
        values,
    ]);

    const updateValue = <K extends keyof ManualWorkbenchValues>(
        key: K,
        value: ManualWorkbenchValues[K],
    ): void => {
        setValuesEdited(true);
        setValues((current) => ({
            ...current,
            [key]: value,
        }));
    };

    const selectPreset = (presetId: string): void => {
        setPayloadPresetId(presetId);
        const preset = MANUAL_PAYLOAD_PRESETS.find(
            (entry) => entry.presetId === presetId,
        );
        if (preset) {
            setPayloadText(JSON.stringify(preset.payload, null, 2));
        }
    };

    const runManualCommandSet = async (
        label: string,
        commands: readonly RallarBlackBoxTestCommand[],
        startSequence: number,
    ): Promise<void> => {
        const entry: ManualActionHistoryEntry = {
            actionId: `manual-action-${startSequence}`,
            label,
            commandIds: commands.map(
                (command) => command.commandId ?? command.kind,
            ),
            commands: redactRallarBlackBoxValue(
                commands,
                uiRedactionOptions(state, authSession, [values.rallarPassword]),
            ),
            atEpochMs: Date.now(),
        };

        setSequence((current) => current + commands.length + 1);
        setHistory((current) => [...current, entry].slice(-12));
        onSelectCommand(entry.commandIds.at(-1) ?? entry.commandIds[0]);

        try {
            await rallarBlackBoxRuntimeStore.executeManualCommands(
                commands,
                label,
            );
        } catch (error) {
            setLocalError(
                error instanceof Error ? error.message : String(error),
            );
        }
    };

    const runManualAction = async (
        action: ManualWorkbenchAction,
    ): Promise<void> => {
        setLocalError(undefined);
        if (action === 'send' && !payloadResult.ok) {
            setLocalError(payloadResult.error);
            return;
        }
        const selectedGroupId = values.groupId.trim();
        if (
            selectedGroupId &&
            onGlobalValueChange &&
            ['configure', 'join', 'connect', 'send'].includes(action) &&
            globalValues?.roomId !== selectedGroupId
        ) {
            onGlobalValueChange('roomId', selectedGroupId);
        }

        const label = actionLabel(action);
        const startSequence = sequence;
        const commands = buildManualWorkbenchCommands(
            action,
            values,
            payloadResult.ok ? payloadResult.value : null,
            startSequence,
        );
        await runManualCommandSet(label, commands, startSequence);
    };

    const runRtcMatrix = async (
        transport: Extract<
            ManualWorkbenchTransport,
            'realtime' | 'messages.rtc'
        >,
    ): Promise<void> => {
        setLocalError(undefined);
        if (!payloadResult.ok) {
            setLocalError(payloadResult.error);
            return;
        }

        const label = `RTC ${transport} delivery matrix`;
        const startSequence = sequence;
        const commands = manualRtcDeliveryMatrixCommands(
            values,
            payloadResult.value,
            startSequence,
            transport,
        );
        await runManualCommandSet(label, commands, startSequence);
    };

    const runRtcNackProbe = async (): Promise<void> => {
        setLocalError(undefined);
        if (!payloadResult.ok) {
            setLocalError(payloadResult.error);
            return;
        }

        const startSequence = sequence;
        await runManualCommandSet(
            'RTC not-yet-in-sync probe',
            manualRtcNackProbeCommands(
                values,
                payloadResult.value,
                startSequence,
            ),
            startSequence,
        );
    };

    const copyRecipeSnippet = (): void => {
        if (navigator.clipboard) {
            void navigator.clipboard.writeText(recipeText);
        }
    };

    const copyRtcMatrixRecipe = (): void => {
        if (!payloadResult.ok || !navigator.clipboard) {
            return;
        }

        const realtime = manualRtcDeliveryMatrixCommands(
            values,
            payloadResult.value,
            1,
            'realtime',
        );
        const messages = manualRtcDeliveryMatrixCommands(
            values,
            payloadResult.value,
            realtime.length + 2,
            'messages.rtc',
        );
        void navigator.clipboard.writeText(
            JSON.stringify(
                {
                    recipeId: 'manual-rtc-delivery-matrix',
                    name: 'Manual RTC delivery matrix',
                    description:
                        'Direct, multicast, and broadcast delivery over realtime and messages.rtc.',
                    continueOnFailure: false,
                    commands: [...realtime, ...messages],
                },
                null,
                2,
            ),
        );
    };

    const copyNegativeRecipe = (): void => {
        if (navigator.clipboard) {
            void navigator.clipboard.writeText(negativeRecipeText);
        }
    };

    return {
        values,
        payloadPresetId,
        payloadText,
        history,
        recipeVisible,
        events,
        payloadResult,
        previewCommands,
        recipeText,
        negativeRecipeText,
        previewRecipeValidation,
        manualRecipeValidation,
        negativeRecipeValidation,
        localError,
        updateValue,
        selectPreset,
        setPayloadPresetId,
        setPayloadText,
        setRecipeVisible,
        runManualAction,
        runRtcMatrix,
        runRtcNackProbe,
        copyRecipeSnippet,
        copyRtcMatrixRecipe,
        copyNegativeRecipe,
    };
}

export type ManualRallarWorkbenchModel =
    ReturnType<typeof useManualRallarWorkbench>;
