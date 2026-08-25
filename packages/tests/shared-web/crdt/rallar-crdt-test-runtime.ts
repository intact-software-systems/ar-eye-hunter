import type {
    RallarCrdtMessageTransport,
    RallarCrdtTransportKind,
    RallarCrdtTransportMessage,
    RallarCrdtTransportSendInput,
    RallarCrdtTransportSendResult
} from '@shared-web/browser/crdt/browser-crdt-transport.ts';
import { createRallarCrdtFacade } from '@shared-web/browser/rallar-crdt.ts';
import { createRallarDataFacade, type RallarDataScope } from '@shared-web/browser/rallar-data.ts';
import { RepositoryManager } from '@shared/cache/RepositoryManager.ts';
import {
    RALLAR_CRDT_APPEND_RESPONSE_TYPE_ID,
    RALLAR_CRDT_OPERATION_VERSION,
    RALLAR_CRDT_PROTOCOL_VERSION,
    RALLAR_CRDT_UPDATE_TYPE_ID,
    rallarCrdtBatch,
    toRallarCrdtDocumentKey,
    type RallarCrdtAppendResponseEnvelope,
    type RallarCrdtAppendResult,
    type RallarCrdtCatchUpResponseEnvelope,
    type RallarCrdtDocumentTypePolicy,
    type RallarCrdtEncryptionKeyring,
    type RallarCrdtUpdateEnvelope
} from '@shared/crdt/mod.ts';
import { expect } from 'vitest';

interface TransportDocumentOptions {
    policies?: readonly RallarCrdtDocumentTypePolicy[];
    encryption?: RallarCrdtEncryptionKeyring;
}

export interface CreateTransportDocumentInput {
    readonly replicaId: string;
    readonly network: FakeCrdtTransportNetwork;
    readonly transport: 'ws' | 'rtc' | 'ws-then-rtc' | 'rtc-with-ws-fallback';
    readonly options?: TransportDocumentOptions;
}

interface HttpCatchUpRequest {
    requestId: string;
    document: RallarCrdtUpdateEnvelope['document'];
}

interface FakeCrdtTransportNetworkOptions {
    rtcStatuses?: readonly string[];
    appendResponses?: 'accepted' | 'rejected';
}

interface FakeCrdtSentMessage {
    transport: RallarCrdtTransportKind;
    typeId: string;
}

interface FakeCrdtTransportSelector {
    topicId?: string;
    typeId?: string;
}

interface FakeCrdtTransportListener {
    selector: FakeCrdtTransportSelector;
    handler(message: RallarCrdtTransportMessage<object>): void | Promise<void>;
}

interface CrdtTestDocument {
    readonly [key: string]: string | number | boolean | null | object | undefined;
}

const roomRef = {
    applicationId: 'rallar-test',
    workspaceId: 'main',
    groupId: 'room-1'
};

const resolveTestDataScopeKey = (scope: RallarDataScope): string => String(scope);

export class FakeBroadcastChannel {
    private static readonly channels = new Map<string, Set<FakeBroadcastChannel>>();
    private static readonly createdNames = new Set<string>();

    public onmessage: ((event: MessageEvent) => void) | null = null;

    public readonly name: string;

    public constructor(name: string) {
        this.name = name;
        const channels = FakeBroadcastChannel.channels.get(name) ?? new Set();
        channels.add(this);
        FakeBroadcastChannel.channels.set(name, channels);
        FakeBroadcastChannel.createdNames.add(name);
    }

    public postMessage(message: object): void {
        for (const channel of FakeBroadcastChannel.channels.get(this.name) ?? []) {
            if (channel === this) {
                continue;
            }

            queueMicrotask(() => {
                channel.onmessage?.({ data: message } as MessageEvent);
            });
        }
    }

    public close(): void {
        FakeBroadcastChannel.channels.get(this.name)?.delete(this);
    }

    public static names(): string[] {
        return Array.from(FakeBroadcastChannel.createdNames).sort();
    }

    public static clear(): void {
        FakeBroadcastChannel.channels.clear();
        FakeBroadcastChannel.createdNames.clear();
    }
}

export async function waitFor(predicate: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
        if (predicate()) {
            return;
        }

        await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(predicate()).toBe(true);
}

export async function createTransportDocument(input: CreateTransportDocumentInput) {
    const endpoint = input.network.createEndpoint(input.replicaId);
    return await createRallarCrdtFacade({
        data: createRallarDataFacade({
            manager: new RepositoryManager(),
            resolveScopeKey: resolveTestDataScopeKey
        }),
        readTransport: () => endpoint
    }).open<CrdtTestDocument>('room-checklist', {
        applicationId: 'rallar-test',
        workspaceId: 'main',
        documentType: 'checklist',
        documentId: roomRef.groupId,
        scope: {
            kind: 'room',
            roomRef
        },
        persist: false,
        tabSync: false,
        replicaId: input.replicaId,
        transport: input.transport,
        policies: input.options?.policies,
        encryption: input.options?.encryption
    });
}

export function createHttpCatchUpResponse(
    request: HttpCatchUpRequest
): RallarCrdtCatchUpResponseEnvelope {
    const update: RallarCrdtUpdateEnvelope = {
        protocolVersion: RALLAR_CRDT_PROTOCOL_VERSION,
        document: request.document,
        updateId: 'http-catch-up-update-1',
        replicaId: 'server-replica',
        lamport: 1,
        parents: [],
        schemaVersion: 1,
        operationVersion: RALLAR_CRDT_OPERATION_VERSION,
        createdAtEpochMs: 4_000,
        payload: rallarCrdtBatch([
            {
                kind: 'map.set',
                path: [],
                key: 'title',
                value: 'HTTP durable title'
            }
        ])
    };

    return {
        protocolVersion: RALLAR_CRDT_PROTOCOL_VERSION,
        requestId: request.requestId,
        document: request.document,
        createdAtEpochMs: 5_000,
        page: {
            document: request.document,
            records: [
                {
                    document: request.document,
                    documentKey: toRallarCrdtDocumentKey(request.document),
                    update,
                    append: {
                        appendSequence: 1,
                        acceptedAtEpochMs: 4_500,
                        actorId: 'server-replica',
                        principalId: 'principal-a',
                        sessionId: 'session-a',
                        serverId: 'server-1',
                        authorizationScope: 'room',
                        acceptedUpdateHash: 'http-catch-up-hash'
                    }
                }
            ],
            firstSequence: 1,
            lastSequence: 1,
            hasMore: false
        }
    };
}

export class FakeCrdtTransportNetwork {
    private readonly endpoints = new Map<string, FakeCrdtTransportEndpoint>();
    private readonly sent: FakeCrdtSentMessage[] = [];
    private readonly rtcStatuses: string[];
    private readonly appendResponses: 'accepted' | 'rejected' | undefined;
    private appendSequence = 0;

    public constructor(options: FakeCrdtTransportNetworkOptions = {}) {
        this.rtcStatuses = [...(options.rtcStatuses ?? [])];
        this.appendResponses = options.appendResponses;
    }

    public createEndpoint(id: string): RallarCrdtMessageTransport {
        const endpoint = new FakeCrdtTransportEndpoint(id, this);
        this.endpoints.set(id, endpoint);
        return endpoint.transport;
    }

    public async send<TPayload>(
        fromEndpointId: string,
        transport: RallarCrdtTransportKind,
        input: RallarCrdtTransportSendInput<TPayload>
    ): Promise<RallarCrdtTransportSendResult> {
        this.sent.push({
            transport,
            typeId: input.typeId
        });
        const status = transport === 'rtc' ? (this.rtcStatuses.shift() ?? 'sent') : 'sent';
        if (status === 'sent') {
            for (const [endpointId, endpoint] of this.endpoints) {
                if (endpointId !== fromEndpointId) {
                    endpoint.deliver(transport, input);
                }
            }
            if (this.appendResponses && input.typeId === RALLAR_CRDT_UPDATE_TYPE_ID) {
                this.deliverAppendResponse(
                    fromEndpointId,
                    transport,
                    input as RallarCrdtTransportSendInput<RallarCrdtUpdateEnvelope>
                );
            }
        }

        return {
            transport,
            status
        };
    }

    public sentTransports(): RallarCrdtTransportKind[] {
        return this.sent.map((entry) => entry.transport);
    }

    public sentUpdateTransports(): RallarCrdtTransportKind[] {
        return this.sent
            .filter((entry) => entry.typeId === RALLAR_CRDT_UPDATE_TYPE_ID)
            .map((entry) => entry.transport);
    }

    private deliverAppendResponse(
        endpointId: string,
        transport: RallarCrdtTransportKind,
        input: RallarCrdtTransportSendInput<RallarCrdtUpdateEnvelope>
    ): void {
        const endpoint = this.endpoints.get(endpointId);
        if (!endpoint) {
            return;
        }

        const update = input.payload;
        this.appendSequence += 1;
        const result = this.appendResponses === 'accepted'
            ? createAcceptedAppendResult(update, this.appendSequence)
            : createRejectedAppendResult(update);
        const response: RallarCrdtAppendResponseEnvelope = {
            protocolVersion: RALLAR_CRDT_PROTOCOL_VERSION,
            requestId: update.updateId,
            document: update.document,
            acceptedAtEpochMs: 5_000,
            results: [result]
        };
        endpoint.deliver(transport, {
            ...input,
            typeId: RALLAR_CRDT_APPEND_RESPONSE_TYPE_ID,
            payload: response
        });
    }
}

function createAcceptedAppendResult(
    update: RallarCrdtUpdateEnvelope,
    appendSequence: number
): RallarCrdtAppendResult {
    return {
        status: 'accepted',
        update,
        append: {
            appendSequence,
            acceptedAtEpochMs: 5_000,
            actorId: update.replicaId,
            principalId: 'principal-a',
            sessionId: 'session-a',
            serverId: 'server-1',
            authorizationScope: 'room',
            acceptedUpdateHash: `hash-${update.updateId}`
        },
        document: {
            document: update.document,
            documentKey: 'test-document-key',
            documentRevision: appendSequence,
            lifecycle: 'active',
            createdAtEpochMs: 4_000,
            updatedAtEpochMs: 5_000,
            archivedAtEpochMs: null,
            destroyedAtEpochMs: null,
            lastAppendSequence: appendSequence,
            updateCount: appendSequence,
            snapshotCount: 0,
            storedUpdateBytes: 0,
            retention: null,
            quota: null,
            projectionIds: []
        }
    };
}

function createRejectedAppendResult(
    update: RallarCrdtUpdateEnvelope
): RallarCrdtAppendResult {
    return {
        status: 'rejected',
        update,
        code: 'document-archived',
        reason: 'Document is archived.',
        retryable: false
    };
}

class FakeCrdtTransportEndpoint {
    public readonly transport: RallarCrdtMessageTransport;

    private readonly listeners = {
        ws: new Set<FakeCrdtTransportListener>(),
        rtc: new Set<FakeCrdtTransportListener>()
    };

    private readonly id: string;
    private readonly network: FakeCrdtTransportNetwork;

    public constructor(id: string, network: FakeCrdtTransportNetwork) {
        this.id = id;
        this.network = network;
        this.transport = {
            ws: this.createLane('ws'),
            rtc: this.createLane('rtc')
        };
    }

    public deliver<TPayload>(
        transport: RallarCrdtTransportKind,
        input: RallarCrdtTransportSendInput<TPayload>
    ): void {
        for (const listener of this.listeners[transport]) {
            if (listener.selector.topicId && listener.selector.topicId !== input.topicId) {
                continue;
            }
            if (listener.selector.typeId && listener.selector.typeId !== input.typeId) {
                continue;
            }

            queueMicrotask(() => {
                void listener.handler({
                    payload: requireObjectPayload(input.payload),
                    topicId: input.topicId,
                    typeId: input.typeId,
                    transport
                });
            });
        }
    }

    private createLane(
        transport: RallarCrdtTransportKind
    ): NonNullable<RallarCrdtMessageTransport['ws']> {
        return {
            send: async (input) => await this.network.send(this.id, transport, input),
            onMessage: (selector, handler) => {
                const listener: FakeCrdtTransportListener = {
                    selector,
                    handler: handler as FakeCrdtTransportListener['handler']
                };
                this.listeners[transport].add(listener);
                return () => {
                    this.listeners[transport].delete(listener);
                };
            }
        };
    }
}

function requireObjectPayload<TPayload>(payload: TPayload): object {
    if (payload === null || typeof payload !== 'object') {
        throw new TypeError('Expected the CRDT test transport payload to be an object');
    }
    return payload;
}

export function testKeyring(): RallarCrdtEncryptionKeyring {
    return {
        activeKeyId: 'browser-test-key',
        keys: [
            {
                keyId: 'browser-test-key',
                secret: 'browser-rallar-crdt-encryption-secret'
            }
        ],
        now: () => 7_000,
        randomBytes: (length) => new Uint8Array(length).fill(9)
    };
}
