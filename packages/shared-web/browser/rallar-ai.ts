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
    rallar: RallarBrowserAiRallar;
    provider: RallarAiJsonProvider;
    policy?: RallarAiGenerationPolicy;
    diagnostics?: RallarAiDiagnosticsSink;
    readCurrentStateRevision?: (
        request: RallarAiJsonRequest
    ) => string | undefined;
}

export interface RallarBrowserAiBroadcastInput<TValue = unknown> {
    result: RallarAiJsonResult<TValue>;
    transport?: RallarBrowserAiTransport;
    laneId?: string;
    roomId?: string;
    roomRef?: GroupRef;
    topicId?: string;
    typeId?: string;
}

export interface RallarBrowserAiBroadcastResult {
    transport: RallarBrowserAiTransport;
    realtime?: readonly RallarRealtimeSendResult[];
    message?: RallarMessageHandle;
}

export interface RallarBrowserAiPersistInput<TValue = unknown> {
    result: RallarAiJsonResult<TValue>;
    storeName?: string;
    key?: string;
    scope?: RallarDataScope;
    durability?: RallarDataDurability;
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
