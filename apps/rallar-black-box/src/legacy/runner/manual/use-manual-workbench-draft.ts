import type * as React from 'react';
import { useEffect, useMemo, useState } from 'react';
import {
    MANUAL_PAYLOAD_PRESETS,
    type ManualWorkbenchValues
} from '../../../manual-workbench.ts';
import {
    readStoredManualWorkbenchDraft,
    writeStoredManualWorkbenchDraft,
    type ManualWorkbenchDraft
} from '../../../stored-manual-workbench-draft.ts';
import { uiSecretValues } from '../../shared/redaction-presentation.ts';
import { browserUiStorage } from '../../shell/browser-ui-storage.ts';
import { toManualWorkbenchValues } from './to-manual-workbench-values.ts';

import type { ManualRallarWorkbenchOptions } from './manual-rallar-workbench-options.ts';
export function useManualWorkbenchDraft(options: ManualRallarWorkbenchOptions) {
    const { state, authSession } = options;
    const defaultDraft = useManualDefaultDraft(options);
    const draft = useRestoredManualDraft(defaultDraft);
    const { values, setValues, valuesEdited, setValuesEdited, payloadPresetId, payloadText } = draft;
    useEffect(() => {
        if (!valuesEdited) {
            setValues(defaultDraft.values);
        }
    }, [defaultDraft.values, valuesEdited]);
    useManualAuthenticatedValues({ ...options, setValues });
    useManualGlobalValues({ ...options, setValues });
    useManualDraftPersistence({ state, authSession, values, payloadPresetId, payloadText });
    const updateValue = <K extends keyof ManualWorkbenchValues>(
        key: K,
        value: ManualWorkbenchValues[K]
    ): void => {
        setValuesEdited(true);
        setValues((current) => ({
            ...current,
            [key]: value
        }));
    };

    const selectPreset = (presetId: string): void => {
        draft.setPayloadPresetId(presetId);
        const preset = MANUAL_PAYLOAD_PRESETS.find(
            (entry) => entry.presetId === presetId
        );
        if (preset) {
            draft.setPayloadText(JSON.stringify(preset.payload, null, 2));
        }
    };

    return {
        values,
        payloadPresetId,
        payloadText,
        setPayloadPresetId: draft.setPayloadPresetId,
        setPayloadText: draft.setPayloadText,
        updateValue,
        selectPreset
    };
}
interface RestoredManualDraft extends ManualWorkbenchDraft {
    readonly setValues: React.Dispatch<React.SetStateAction<ManualWorkbenchValues>>;
    readonly valuesEdited: boolean;
    readonly setValuesEdited: React.Dispatch<React.SetStateAction<boolean>>;
    readonly setPayloadPresetId: React.Dispatch<React.SetStateAction<string>>;
    readonly setPayloadText: React.Dispatch<React.SetStateAction<string>>;
}
function useRestoredManualDraft(defaultDraft: ManualWorkbenchDraft): RestoredManualDraft {
    const [initialDraft] = useState(() => {
        const stored = readStoredManualWorkbenchDraft(browserUiStorage(), {
            providerMode: defaultDraft.values.providerMode,
            rallarPassword: defaultDraft.values.rallarPassword
        });
        return {
            draft: stored ?? defaultDraft,
            restored: Boolean(stored)
        };
    });
    const [values, setValues] = useState<ManualWorkbenchValues>(() => initialDraft.draft.values);
    const [valuesEdited, setValuesEdited] = useState(initialDraft.restored);
    const [payloadPresetId, setPayloadPresetId] = useState(initialDraft.draft.payloadPresetId);
    const [payloadText, setPayloadText] = useState(() => initialDraft.draft.payloadText);
    return {
        values,
        setValues,
        valuesEdited,
        setValuesEdited,
        payloadPresetId,
        setPayloadPresetId,
        payloadText,
        setPayloadText
    };
}
function useManualDefaultDraft({ state, bootstrap, authSession, globalValues }: ManualRallarWorkbenchOptions) {
    const defaultValues = useMemo(
        () => toManualWorkbenchValues({ state, bootstrap, authSession, globalValues }),
        [
            authSession,
            bootstrap,
            globalValues.apiBaseUrl,
            globalValues.applicationId,
            globalValues.clientId,
            globalValues.roomId,
            globalValues.sessionId,
            globalValues.workspaceId,
            state.currentConfig
        ]
    );
    const defaultDraft = useMemo<ManualWorkbenchDraft>(
        () => ({
            values: defaultValues,
            payloadPresetId: MANUAL_PAYLOAD_PRESETS[0].presetId,
            payloadText: JSON.stringify(
                MANUAL_PAYLOAD_PRESETS[0].payload,
                null,
                2
            )
        }),
        [defaultValues]
    );
    return defaultDraft;
}
interface ManualValueSynchronization extends ManualRallarWorkbenchOptions {
    readonly setValues: React.Dispatch<React.SetStateAction<ManualWorkbenchValues>>;
}
function useManualAuthenticatedValues({ authSession, globalValues, setValues }: ManualValueSynchronization): void {
    useEffect(() => {
        if (!authSession) {
            return;
        }

        setValues((current) => {
            const clientId = globalValues.clientId ||
                authSession.clientId ||
                authSession.username;
            const sessionId = globalValues.sessionId || authSession.sessionId;
            const nextValues = {
                ...current,
                actor: clientId,
                sessionId,
                rallarUsername: authSession.username,
                rallarRestoreSession: true
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
        globalValues.clientId,
        globalValues.sessionId
    ]);
}
function useManualGlobalValues({ globalValues, globalValuesEdited, setValues }: ManualValueSynchronization): void {
    useEffect(() => {
        if (!globalValuesEdited) {
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
                groupId: globalValues.roomId
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
        globalValues.apiBaseUrl,
        globalValues.applicationId,
        globalValues.clientId,
        globalValues.roomId,
        globalValues.sessionId,
        globalValues.workspaceId,
        globalValuesEdited
    ]);
}

interface ManualDraftPersistence extends ManualWorkbenchDraft {
    readonly state: ManualRallarWorkbenchOptions['state'];
    readonly authSession: ManualRallarWorkbenchOptions['authSession'];
}
function useManualDraftPersistence(
    { state, authSession, values, payloadPresetId, payloadText }: ManualDraftPersistence
): void {
    useEffect(() => {
        writeStoredManualWorkbenchDraft(
            browserUiStorage(),
            {
                values,
                payloadPresetId,
                payloadText
            },
            uiSecretValues(state, authSession, [values.rallarPassword])
        );
    }, [
        authSession?.accessToken,
        payloadPresetId,
        payloadText,
        state.currentConfig?.redaction,
        values
    ]);
}
