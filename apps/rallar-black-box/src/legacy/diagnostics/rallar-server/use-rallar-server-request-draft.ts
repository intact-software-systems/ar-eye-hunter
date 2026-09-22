import type * as React from 'react';
import { useEffect, useState } from 'react';
import {
    readStoredRallarServerWorkbenchDraft,
    writeStoredRallarServerWorkbenchDraft,
    type RallarServerWorkbenchDraft
} from '../../../ui-cache/rallar-server-drafts.ts';
import { uiSecretValues } from '../../shared/redaction-presentation.ts';
import { browserUiStorage } from '../../shell/browser-ui-storage.ts';
import type { RallarServerRequestDraftModel, UseRallarServerControllerInput } from './rallar-server-contracts.ts';
import type { RallarServerDefaults } from './use-rallar-server-defaults.ts';

export interface RallarServerRequestDraft {
    readonly draft: RallarServerWorkbenchDraft;
    readonly setDraft: React.Dispatch<React.SetStateAction<RallarServerWorkbenchDraft>>;
    readonly setters: Omit<RallarServerRequestDraftModel, keyof RallarServerWorkbenchDraft>;
}

export function useRallarServerRequestDraft(
    input: UseRallarServerControllerInput,
    defaults: RallarServerDefaults
): RallarServerRequestDraft {
    const [initial] = useState(() => {
        const stored = readStoredRallarServerWorkbenchDraft(browserUiStorage());
        return { draft: stored ?? defaults.defaultDraft, restored: Boolean(stored) };
    });
    const [draft, setDraft] = useState(initial.draft);
    const [serverDraftEdited, setServerDraftEdited] = useState(initial.restored);
    useEffect(() => {
        if (!serverDraftEdited) {
            const apiBaseUrl = defaults.defaultDraft.apiBaseUrl;
            setDraft((current) => current.apiBaseUrl === apiBaseUrl ? current : { ...current, apiBaseUrl });
        }
    }, [defaults.defaultDraft.apiBaseUrl, serverDraftEdited]);
    useEffect(() => {
        writeStoredRallarServerWorkbenchDraft(browserUiStorage(), draft, uiSecretValues(undefined, input.authSession));
    }, [draft, input.authSession?.accessToken]);
    return { draft, setDraft, setters: toRallarServerDraftSetters(setDraft, setServerDraftEdited) };
}

function toRallarServerDraftSetters(
    setDraft: React.Dispatch<React.SetStateAction<RallarServerWorkbenchDraft>>,
    setServerDraftEdited: React.Dispatch<React.SetStateAction<boolean>>
): RallarServerRequestDraft['setters'] {
    const update = <K extends keyof RallarServerWorkbenchDraft>(key: K) => (value: RallarServerWorkbenchDraft[K]) =>
        setDraft((current) => current[key] === value ? current : { ...current, [key]: value });
    return {
        setServerDraftEdited,
        setApiBaseUrl: update('apiBaseUrl'),
        setMethod: update('method'),
        setPath: update('path'),
        setHeadersText: update('headersText'),
        setQueryText: update('queryText'),
        setBodyText: update('bodyText'),
        setResponseBodyMode: update('responseBodyMode'),
        setAttachAuth: update('attachAuth'),
        setTimeoutMs: update('timeoutMs')
    };
}
