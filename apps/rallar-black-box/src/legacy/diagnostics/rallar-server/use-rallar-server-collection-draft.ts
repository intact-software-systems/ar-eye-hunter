import type { AuthSession } from '@shared/api/api-config.ts';
import type * as React from 'react';
import { useEffect, useState } from 'react';
import {
    readRallarServerRestCollectionDraft,
    writeRallarServerRestCollectionDraft,
    type RallarServerRestCollectionDraft
} from '../../../ui-persistence.ts';
import { json } from '../../shared/json-presentation.ts';
import { uiSecretValues } from '../../shared/redaction-presentation.ts';
import { browserUiStorage } from '../../shell/browser-ui-storage.ts';
import { decodeRallarServerCollectionDraftText } from './decode-rallar-server-collection-text.ts';

export interface RallarServerCollectionDraft {
    readonly selectedCollectionId: string;
    readonly setSelectedCollectionId: React.Dispatch<React.SetStateAction<string>>;
    readonly collectionText: string;
    readonly setCollectionText: React.Dispatch<React.SetStateAction<string>>;
    readonly collectionVariablesText: string;
    readonly setCollectionVariablesText: React.Dispatch<React.SetStateAction<string>>;
}

/** Only a decodable draft is stored, so an invalid edit leaves the last valid one restorable. */
export function useRallarServerCollectionDraft(
    defaultDraft: RallarServerRestCollectionDraft,
    authSession: AuthSession | undefined
): RallarServerCollectionDraft {
    const [initial] = useState(() =>
        readRallarServerRestCollectionDraft(browserUiStorage(), defaultDraft) ?? defaultDraft
    );
    const [selectedCollectionId, setSelectedCollectionId] = useState(initial.selectedCollectionId);
    const [collectionText, setCollectionText] = useState(() => json(initial.collection));
    const [collectionVariablesText, setCollectionVariablesText] = useState(() => json(initial.variables));
    useEffect(() => {
        decodeRallarServerCollectionDraftText(collectionText, collectionVariablesText).foldRight(
            ({ collection, variables }) =>
                writeRallarServerRestCollectionDraft(
                    browserUiStorage(),
                    { selectedCollectionId, collection, variables },
                    uiSecretValues(undefined, authSession)
                )
        );
    }, [authSession?.accessToken, collectionText, collectionVariablesText, selectedCollectionId]);
    return {
        selectedCollectionId,
        setSelectedCollectionId,
        collectionText,
        setCollectionText,
        collectionVariablesText,
        setCollectionVariablesText
    };
}
