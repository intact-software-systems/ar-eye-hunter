import type { AuthSession } from '@shared/api/api-config.ts';
import type {
    RallarCrdtDocumentRef,
    RallarCrdtOperationBatch,
} from '@shared/crdt/crdt-types.ts';
import type { RallarCrdtDocument } from '@shared-web/browser/rallar-crdt.ts';
import type { RallarBlackBoxTestState } from '@shared-test/rallar-bb-test/types.ts';
import type { CrdtEditorValue } from '../../../crdt-editor.ts';
import type { RallarBlackBoxBootstrapConfig } from '../../../runtime-store.ts';
import type { CommandCenterGlobalValues } from '../../shell/global-context-model.ts';

export type CrdtPanelInput = Readonly<{
    state: RallarBlackBoxTestState;
    bootstrap: RallarBlackBoxBootstrapConfig;
    authSession?: AuthSession;
    globalValues: CommandCenterGlobalValues;
}>;

export type CrdtAdminDocumentStatus = Readonly<{
    document: RallarCrdtDocumentRef;
    documentKey: string;
    lifecycle: string;
    rollout?: string;
    updateCount: number;
    snapshotCount: number;
    lastAppendSequence: number;
    updatedAtEpochMs: number;
    quarantineReason?: string;
}>;

export type CrdtAdminListResult = Readonly<{
    documents: readonly CrdtAdminDocumentStatus[];
    hasMore: boolean;
    nextCursor?: string;
}>;

export type CrdtEditorDocument = RallarCrdtDocument<
    CrdtEditorValue,
    RallarCrdtOperationBatch
>;
