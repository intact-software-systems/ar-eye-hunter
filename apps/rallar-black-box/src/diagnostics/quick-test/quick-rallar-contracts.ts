export type QuickRallarTransport = 'ws';

export interface QuickRallarJsonObject {
    readonly [key: string]: QuickRallarJsonValue;
}

export type QuickRallarJsonValue =
    | null
    | boolean
    | number
    | string
    | readonly QuickRallarJsonValue[]
    | QuickRallarJsonObject;

export interface QuickRallarValues {
    readonly transport: QuickRallarTransport;
    readonly typeId: string;
    readonly topicId: string;
    readonly contextId: string;
    readonly resourceId: string;
    readonly payloadText: string;
    readonly timeoutMs: number;
}

export interface QuickRallarSubscriptionState {
    readonly transport: QuickRallarTransport;
    readonly label: string;
    readonly groupId: string;
    readonly subscribedAtEpochMs: number;
    unsubscribe(): void;
}

export interface QuickRallarReceivedMessageRow {
    readonly rowId: string;
    readonly atEpochMs: number;
    readonly transport: QuickRallarTransport;
    readonly senderId: string;
    readonly roomId: string;
    readonly typeId: string;
    readonly topicId: string;
    readonly contextId: string;
    readonly resourceId: string;
    readonly payload?: QuickRallarJsonValue;
    readonly raw?: QuickRallarJsonObject;
}

export interface QuickRallarPayloadSuccess {
    readonly ok: true;
    readonly value: QuickRallarJsonValue;
}

export interface QuickRallarPayloadFailure {
    readonly ok: false;
    readonly error: string;
}

export type QuickRallarPayloadResult = QuickRallarPayloadSuccess | QuickRallarPayloadFailure;

export interface QuickRallarLastResultSummary {
    readonly status: 'completed' | 'failed';
}

export interface QuickRallarSubscriptionSummary {
    readonly label: string;
    readonly groupId: string;
    readonly subscribedAtEpochMs: number;
}

export interface QuickRallarReceivedMessageSummary {
    readonly rowId: string;
    readonly atEpochMs: number;
    readonly senderId: string;
    readonly roomId: string;
    readonly typeId: string;
    readonly topicId: string;
    readonly contextId: string;
    readonly payload?: QuickRallarJsonValue;
}

export interface QuickRallarWorkflowStep {
    readonly id: string;
    readonly label: string;
    readonly detail: string;
    readonly state: 'done' | 'current' | 'blocked' | 'pending';
}

export interface QuickRallarTestViewModel {
    readonly values: QuickRallarValues;
    readonly busyAction?: string;
    readonly localError?: string;
    readonly lastResult?: QuickRallarLastResultSummary;
    readonly subscription?: QuickRallarSubscriptionSummary;
    readonly receivedMessages: readonly QuickRallarReceivedMessageSummary[];
    readonly waitStatus: string;
    readonly providerMode: 'simulated' | 'browser-rallar';
    readonly realBackendReady: boolean;
    readonly canUseDirectRallar: boolean;
    readonly activeGroupId: string;
    readonly activeTypeId: string;
    readonly activeContextId: string;
    readonly selectorLabel: string;
    readonly payloadResult: QuickRallarPayloadResult;
    updateValue<K extends keyof QuickRallarValues>(
        key: K,
        value: QuickRallarValues[K]
    ): void;
    updateGroupId(groupId: string): void;
    createGroup(): Promise<void>;
    joinGroup(): Promise<void>;
    subscribeWs(): Promise<void>;
    unsubscribeWs(): void;
    sendWs(): Promise<void>;
    waitForReceive(): Promise<void>;
    copyDiagnostics(): void;
    copyRunnerRecipe(): void;
    readonly setupComplete: boolean;
    readonly subscribed: boolean;
    readonly workflowSteps: readonly QuickRallarWorkflowStep[];
}
