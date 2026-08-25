import type { GroupRef } from '@shared/api/group-types.ts';
import type {
    RallarAiDiagnosticsSink,
    RallarAiGenerationPolicy,
    RallarAiJsonProvider,
    RallarAiJsonRequest,
    RallarAiJsonResult
} from '@shared/rallar-ai/mod.ts';
import type { RallarDataDurability, RallarDataScope } from './rallar-data.ts';
import type {
    RallarFacade,
    RallarMessageSendResult,
    RallarRealtimeSendResult
} from './rallar.ts';

export { createRallarBrowserAi } from './ai/create-rallar-browser-ai.ts';

export type RallarBrowserAiTransport =
    | 'realtime'
    | 'messages.rtc'
    | 'messages.ws';

export type RallarBrowserAiRallar = Pick<RallarFacade, 'data' | 'messages' | 'realtime'>;

export type CreateRallarBrowserAiOptions = Readonly<{
    rallar: RallarBrowserAiRallar;
    provider: RallarAiJsonProvider;
    policy?: RallarAiGenerationPolicy;
    diagnostics?: RallarAiDiagnosticsSink;
    readCurrentStateRevision?: (
        request: RallarAiJsonRequest
    ) => string | undefined;
}>;

export type RallarBrowserAiBroadcastInput<TValue = unknown> = Readonly<{
    result: RallarAiJsonResult<TValue>;
    transport?: RallarBrowserAiTransport;
    laneId?: string;
    roomId?: string;
    roomRef?: GroupRef;
    topicId?: string;
    typeId?: string;
}>;

export type RallarBrowserAiBroadcastResult = Readonly<{
    transport: RallarBrowserAiTransport;
    realtime?: readonly RallarRealtimeSendResult[];
    message?: RallarMessageSendResult;
}>;

export type RallarBrowserAiPersistInput<TValue = unknown> = Readonly<{
    result: RallarAiJsonResult<TValue>;
    storeName?: string;
    key?: string;
    scope?: RallarDataScope;
    durability?: RallarDataDurability;
}>;

export type RallarBrowserAiFacade = Readonly<{
    generateJson<TValue = unknown, TContext = unknown>(
        request: RallarAiJsonRequest<TContext>
    ): Promise<RallarAiJsonResult<TValue>>;
    broadcastJson<TValue = unknown>(
        input: RallarBrowserAiBroadcastInput<TValue>
    ): Promise<RallarBrowserAiBroadcastResult>;
    persistJson<TValue = unknown>(
        input: RallarBrowserAiPersistInput<TValue>
    ): Promise<void>;
}>;
