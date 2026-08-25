export type QuickRallarTransport = 'ws';

export type QuickRallarValues = Readonly<{
    transport: QuickRallarTransport;
    typeId: string;
    topicId: string;
    contextId: string;
    resourceId: string;
    payloadText: string;
    timeoutMs: number;
}>;

export type QuickRallarSubscriptionState = Readonly<{
    transport: QuickRallarTransport;
    label: string;
    groupId: string;
    subscribedAtEpochMs: number;
    unsubscribe(): void;
}>;

export type QuickRallarReceivedMessageRow = Readonly<{
    rowId: string;
    atEpochMs: number;
    transport: QuickRallarTransport;
    senderId: string;
    roomId: string;
    typeId: string;
    topicId: string;
    contextId: string;
    resourceId: string;
    payload?: unknown;
    raw?: unknown;
}>;

export type QuickRallarPayloadResult =
    | Readonly<{ ok: true; }>
    | Readonly<{ ok: false; error: string; }>;

export type QuickRallarWorkflowStep = Readonly<{
    id: string;
    label: string;
    detail: string;
    state: 'done' | 'current' | 'blocked' | 'pending';
}>;

export type QuickRallarTestViewModel = Readonly<{
    values: QuickRallarValues;
    busyAction?: string;
    localError?: string;
    lastResult?: Readonly<{
        status: 'completed' | 'failed';
    }>;
    subscription?: Readonly<{
        label: string;
        groupId: string;
        subscribedAtEpochMs: number;
    }>;
    receivedMessages: readonly Readonly<{
        rowId: string;
        atEpochMs: number;
        senderId: string;
        roomId: string;
        typeId: string;
        topicId: string;
        contextId: string;
        payload?: unknown;
    }>[];
    waitStatus: string;
    providerMode: 'simulated' | 'browser-rallar';
    realBackendReady: boolean;
    canUseDirectRallar: boolean;
    activeGroupId: string;
    activeTypeId: string;
    activeContextId: string;
    selectorLabel: string;
    payloadResult: QuickRallarPayloadResult;
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
    setupComplete: boolean;
    subscribed: boolean;
    workflowSteps: readonly QuickRallarWorkflowStep[];
}>;
