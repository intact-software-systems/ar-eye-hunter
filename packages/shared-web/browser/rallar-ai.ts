import type { GroupRef } from '@shared/api/group-types.ts';
import type {
    RallarAiDiagnosticsSink,
    RallarAiGenerationPolicy,
    RallarAiJsonProvider,
    RallarAiJsonRequest,
    RallarAiJsonResult
} from '@shared/rallar-ai/mod.ts';
import type { RallarDataDurability, RallarDataScope } from './rallar-data.ts';
import type { RallarFacade, RallarMessageHandle, RallarRealtimeSendResult } from './rallar.ts';

export { createRallarBrowserAi } from './ai/create-rallar-browser-ai.ts';

export type RallarBrowserAiTransport =
    | 'realtime'
    | 'messages.rtc'
    | 'messages.ws';

export type RallarBrowserAiRallar = Pick<RallarFacade, 'data' | 'messages' | 'realtime'>;

export interface CreateRallarBrowserAiOptions {
    readonly rallar: RallarBrowserAiRallar;
    readonly provider: RallarAiJsonProvider;
    readonly policy?: RallarAiGenerationPolicy;
    readonly diagnostics?: RallarAiDiagnosticsSink;
    readonly readCurrentStateRevision?: (
        request: RallarAiJsonRequest
    ) => string | undefined;
}

export interface RallarBrowserAiBroadcastInput<TValue = unknown> {
    readonly result: RallarAiJsonResult<TValue>;
    readonly transport?: RallarBrowserAiTransport;
    readonly laneId?: string;
    readonly roomId?: string;
    readonly roomRef?: GroupRef;
    readonly topicId?: string;
    readonly typeId?: string;
}

export interface RallarBrowserAiBroadcastResult {
    readonly transport: RallarBrowserAiTransport;
    readonly realtime?: readonly RallarRealtimeSendResult[];
    readonly message?: RallarMessageHandle;
}

export interface RallarBrowserAiPersistInput<TValue = unknown> {
    readonly result: RallarAiJsonResult<TValue>;
    readonly storeName?: string;
    readonly key?: string;
    readonly scope?: RallarDataScope;
    readonly durability?: RallarDataDurability;
}

export interface RallarBrowserAiFacade {
    generateJson<TValue = unknown, TContext = unknown>(
        request: RallarAiJsonRequest<TContext>
    ): Promise<RallarAiJsonResult<TValue>>;
    broadcastJson<TValue = unknown>(
        input: RallarBrowserAiBroadcastInput<TValue>
    ): Promise<RallarBrowserAiBroadcastResult>;
    persistJson<TValue = unknown>(
        input: RallarBrowserAiPersistInput<TValue>
    ): Promise<void>;
}
