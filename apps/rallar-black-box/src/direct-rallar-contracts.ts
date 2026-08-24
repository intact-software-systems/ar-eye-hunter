import type { RallarBlackBoxTestRuntimeEventInput } from '@shared-test/rallar-bb-test/types.ts';
import type {
    RallarFacade,
    RallarMessageHandler,
    RallarMessageSelectorInput,
    RallarUnsubscribe,
    RallarWsSendInput
} from '@shared-web/browser/rallar.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { RallarBlackBoxProviderMode } from './client-defaults.ts';

export interface DirectRallarOperationContext {
    readonly providerMode: RallarBlackBoxProviderMode;
    readonly apiBaseUrl: string;
    readonly applicationId: string;
    readonly workspaceId: string;
    readonly roomId?: string;
    readonly actor?: string;
    readonly connection?: string;
    readonly authSession?: AuthSession;
    readonly timeoutMs?: number;
}

export interface DirectRallarWsSendInput {
    readonly scope?: 'room' | 'world' | 'all';
    readonly typeId: string;
    readonly topicId?: string;
    readonly contextId?: string;
    readonly resourceId?: string;
    readonly payload: unknown;
    readonly minSnapshotVersion?: number;
}

export interface DirectRallarMessageHandler {
    (message: Record<string, unknown>): void | Promise<void>;
}

export interface DirectRallarWsMessagesFacade {
    send<T>(input: RallarWsSendInput<T>): Promise<unknown>;
    onMessage(
        selector: RallarMessageSelectorInput,
        handler: RallarMessageHandler<unknown>
    ): RallarUnsubscribe;
}

export interface DirectRallarMessagesFacade {
    readonly ws: DirectRallarWsMessagesFacade;
}

export interface DirectRallarFacade extends
    Pick<
        RallarFacade,
        | 'configure'
        | 'setDefaults'
        | 'defaults'
        | 'start'
        | 'status'
        | 'isConnected'
        | 'session'
    > {
    readonly auth: Pick<RallarFacade['auth'], 'restore'>;
    readonly rooms: Pick<RallarFacade['rooms'], 'current' | 'list' | 'create' | 'join'>;
    readonly people: Pick<RallarFacade['people'], 'list'>;
    readonly messages: DirectRallarMessagesFacade;
    readonly ws: Pick<RallarFacade['ws'], 'status'>;
    readonly rtc: Pick<RallarFacade['rtc'], 'status'>;
}

export interface DirectRallarFacadeLoader {
    (): Promise<DirectRallarFacade>;
}

export interface DirectRallarWsPayload extends RallarWsSendInput<unknown> {
    readonly applicationId: string;
    readonly workspaceId: string;
    readonly groupId?: string;
}

export interface CreateDirectRallarRuntimeEventInput {
    readonly topic: string;
    readonly context: DirectRallarOperationContext;
    readonly kind?: RallarBlackBoxTestRuntimeEventInput['kind'];
    readonly transport?: RallarBlackBoxTestRuntimeEventInput['transport'];
    readonly severity?: RallarBlackBoxTestRuntimeEventInput['severity'];
    readonly payload?: unknown;
}

export interface DirectRallarStartResult {
    readonly session: AuthSession;
    readonly connected: boolean;
    readonly roomState?: unknown;
    readonly peopleState?: unknown;
}
