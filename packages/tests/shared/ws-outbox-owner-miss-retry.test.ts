import { Temporal } from '@js-temporal/polyfill';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { ALAdmissionBackendConflictError } from '@shared/alm/ALAdmissionBackendConflictError.ts';
import {
  createALOutboundAdmissionStore,
  createInMemoryALOutboundAdmissionState,
  type ALOutboundAdmissionStore,
} from '@shared/alm/ALOutboundAdmissionStore.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import { InMemoryQueueBox } from '@shared/queuebox/InMemoryQueueBox.ts';
import { ResilienceDto } from '@shared/queuebox/DequeueResourceEntryController.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { CircuitBreakerPolicy } from '@shared/resilience/circuit-breaker.ts';
import { QueueBoxUtilities } from '@shared/services/QueueBoxUtilities.ts';
import { WsQueueBoxServerService } from '@shared/services/WsQueueBoxServerService.ts';
import type { JsonWebSocketServer } from '@shared/websocket/JsonWebSocketServer.ts';
import type { RallarTimingEvent } from '@shared-server/rallar-system/services/timing.ts';
import {
  installQueueBoxPubSubBridge,
  type QueueBoxPubSubBridge,
  type QueueBoxPubSubMessage,
} from '@shared-server/rallar-system/pubsub/QueueBoxPubSubBridge.ts';
import { requeueRemoteWsOutboxDeliveryFailure } from
  '@shared-server/rallar-system/pubsub/RemoteWsOutboxDeliveryFailure.ts';

describe('durable WS outbox owner misses', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries a non-owner miss so the process with the target socket can deliver', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000);
    const outbox = new InMemoryQueueBox();
    const entry = QueueBoxUtilities.toResourceEntryFromMsg(
      createUnicastMessage(),
      EnqueuedType.WS_OUTBOX,
    );
    await outbox.enqueue(entry);
    const ownerSocket = createSocket();
    const misses: unknown[] = [];
    const nonOwner = new WsQueueBoxServerService(
      new InMemoryQueueBox(),
      outbox,
      createSocket().socket,
      'server-without-target',
      {
        targetResolver: { resolvePeerRecipients: () => [] },
        outboundDeliveryOutcome: (outcome) => misses.push(outcome),
      },
    );
    const owner = new WsQueueBoxServerService(
      new InMemoryQueueBox(),
      outbox,
      ownerSocket.socket,
      'server-with-target',
      {
        targetResolver: {
          resolvePeerRecipients: () => [{ peerId: 'writer-session', connectionId: 'writer-session' }],
        },
      },
    );

    await nonOwner.dequeueOutbox(WsQueueBoxServerService.OUTBOX_DEQUEUE_TYPES, createResilience());

    expect(readEntry(outbox).status).toBe(EntityStatus.RETRY);
    expect(misses.length).toBeGreaterThanOrEqual(1);
    expect(misses.every((outcome) => JSON.stringify(outcome) === JSON.stringify({
      status: 'no-current-recipient', messageId: 'durable-reply-1',
    }))).toBe(true);

    vi.advanceTimersByTime(1);
    await owner.dequeueOutbox(WsQueueBoxServerService.OUTBOX_DEQUEUE_TYPES, createResilience());

    expect(readEntry(outbox).status).toBe(EntityStatus.COMPLETED);
    expect(ownerSocket.send).toHaveBeenCalledWith('writer-session', expect.anything());
  });

  it('redrives a durable send after a shared admission claim conflict', async () => {
    const outbox = new InMemoryQueueBox();
    await outbox.enqueue(QueueBoxUtilities.toResourceEntryFromMsg(
      createUnicastMessage(),
      EnqueuedType.WS_OUTBOX,
    ));
    const ownerSocket = createSocket();
    const base = createALOutboundAdmissionStore({
      kind: 'memory',
      namespace: 'ws-owner-claim-conflict',
      supersedenceTrackTtlMs: 60_000,
      state: createInMemoryALOutboundAdmissionState(),
    });
    let claimCalls = 0;
    const admissionStore = proxyAdmissionStore(base, async (...args) => {
      claimCalls += 1;
      if (claimCalls === 2) throw new ALAdmissionBackendConflictError('simulated shared claim race');
      return await base.claimReadyEffects(...args);
    });
    const owner = new WsQueueBoxServerService(
      new InMemoryQueueBox(),
      outbox,
      ownerSocket.socket,
      'server-with-target',
      {
        targetResolver: {
          resolvePeerRecipients: () => [{ peerId: 'writer-session', connectionId: 'writer-session' }],
        },
        outboundStores: { admissionStore },
      },
    );

    await owner.dequeueOutbox(WsQueueBoxServerService.OUTBOX_DEQUEUE_TYPES, createResilience());
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(claimCalls).toBeGreaterThanOrEqual(3);
    expect(ownerSocket.send).toHaveBeenCalledWith('writer-session', expect.anything());
  });

  it('publishes a wrong-claimant outbox key so the socket owner delivers it', async () => {
    const outbox = new InMemoryQueueBox();
    await outbox.enqueue(QueueBoxUtilities.toResourceEntryFromMsg(
      createUnicastMessage(),
      EnqueuedType.WS_OUTBOX,
    ));
    const bus = createBridgeBus();
    const ownerSocket = createSocket();
    const nonOwner = createService(outbox, createSocket(), 'non-owner', () => []);
    const owner = createService(outbox, ownerSocket, 'owner', () => [
      { peerId: 'writer-session', connectionId: 'writer-session' },
    ]);
    installQueueBoxPubSubBridge({
      wsQBoxServerService: nonOwner, bridge: bus, channel: 'ws', publisherId: 'non-owner', delivery: 'key',
    });
    installQueueBoxPubSubBridge({
      wsQBoxServerService: owner, bridge: bus, channel: 'ws', publisherId: 'owner', delivery: 'key',
    });

    await nonOwner.dequeueOutbox(WsQueueBoxServerService.OUTBOX_DEQUEUE_TYPES, createResilience());

    expect(readEntry(outbox).status).toBe(EntityStatus.COMPLETED);
    expect(ownerSocket.sendEncoded).toHaveBeenCalledWith('writer-session', expect.anything());
  });

  it('delivers a distributed broadcast on the claimant and every remote process', async () => {
    const outbox = new InMemoryQueueBox();
    const broadcast = { ...createUnicastMessage(), targets: { mode: 'broadcast' as const, scope: 'all' as const } };
    await outbox.enqueue(QueueBoxUtilities.toResourceEntryFromMsg(broadcast, EnqueuedType.WS_OUTBOX));
    const bus = createBridgeBus();
    const timing: RallarTimingEvent[] = [];
    const claimantSocket = createSocket();
    const remoteSocket = createSocket();
    const claimant = createService(outbox, claimantSocket, 'claimant', () => [
      { peerId: 'local-session', connectionId: 'local-session' },
    ]);
    const remote = createService(outbox, remoteSocket, 'remote', () => [
      { peerId: 'remote-session', connectionId: 'remote-session' },
    ]);
    installQueueBoxPubSubBridge({
      wsQBoxServerService: claimant, bridge: bus, channel: 'ws', publisherId: 'claimant',
      delivery: 'key', timing: (event) => timing.push(event),
    });
    installQueueBoxPubSubBridge({
      wsQBoxServerService: remote, bridge: bus, channel: 'ws', publisherId: 'remote', delivery: 'key',
      timing: (event) => timing.push(event),
    });

    await claimant.dequeueOutbox(WsQueueBoxServerService.OUTBOX_DEQUEUE_TYPES, createResilience());

    expect(claimantSocket.sendEncoded).toHaveBeenCalledWith('local-session', expect.anything());
    expect(remoteSocket.sendEncoded).toHaveBeenCalledWith('remote-session', expect.anything());
    expect(timing).toEqual(expect.arrayContaining([
      expect.objectContaining({ operation: 'outbox-cluster-publish' }),
      expect.objectContaining({ operation: 'outbox-key-loaded' }),
      expect.objectContaining({
        operation: 'outbox-direct-send',
        details: expect.objectContaining({ recipientCount: 1, sentCount: 1, failedCount: 0 }),
      }),
    ]));
  });

  it('gates the first remote publication on the actual listener readiness', async () => {
    const outbox = new InMemoryQueueBox();
    const bus = createDelayedSecondSubscriberBridgeBus();
    const claimant = createService(outbox, createSocket(), 'claimant', () => []);
    const remoteSocket = createSocket();
    const remote = createService(outbox, remoteSocket, 'remote', () => [
      { peerId: 'writer-session', connectionId: 'writer-session' },
    ]);
    const claimantReadiness = installQueueBoxPubSubBridge({
      wsQBoxServerService: claimant,
      bridge: bus,
      channel: 'ws',
      publisherId: 'claimant',
      delivery: 'key',
    });
    await claimantReadiness;
    const remoteReadiness = installQueueBoxPubSubBridge({
      wsQBoxServerService: remote,
      bridge: bus,
      channel: 'ws',
      publisherId: 'remote',
      delivery: 'key',
    });
    await outbox.enqueue(QueueBoxUtilities.toResourceEntryFromMsg(
      createUnicastMessage('published-before-readiness', 'reply-before-readiness'),
      EnqueuedType.WS_OUTBOX,
    ));

    await claimant.dequeueOutbox(
      WsQueueBoxServerService.OUTBOX_DEQUEUE_TYPES,
      createResilience(),
    );

    expect(remoteSocket.sendEncoded).not.toHaveBeenCalled();

    bus.releaseSecondSubscription();
    await remoteReadiness;
    await outbox.enqueue(QueueBoxUtilities.toResourceEntryFromMsg(
      createUnicastMessage('published-after-readiness', 'reply-after-readiness'),
      EnqueuedType.WS_OUTBOX,
    ));

    await claimant.dequeueOutbox(
      WsQueueBoxServerService.OUTBOX_DEQUEUE_TYPES,
      createResilience(),
    );

    expect(remoteSocket.sendEncoded).toHaveBeenCalledOnce();
    expect(remoteSocket.sendEncoded).toHaveBeenCalledWith(
      'writer-session',
      expect.stringContaining('published-after-readiness'),
    );
  });

  it('keeps a published durable message with invalid targets retryable after one attempt', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000);
    const outbox = new InMemoryQueueBox();
    const invalid = { ...createUnicastMessage(), targets: undefined };
    await outbox.enqueue(QueueBoxUtilities.toResourceEntryFromMsg(invalid, EnqueuedType.WS_OUTBOX));
    const service = createService(outbox, createSocket(), 'claimant', () => []);
    installQueueBoxPubSubBridge({
      wsQBoxServerService: service,
      bridge: createBridgeBus(),
      channel: 'ws',
      publisherId: 'claimant',
      delivery: 'key',
    });

    await service.dequeueOutbox(WsQueueBoxServerService.OUTBOX_DEQUEUE_TYPES, createResilience());

    expect(readEntry(outbox)).toMatchObject({
      status: EntityStatus.RETRY,
      dequeueAudit: { attempts: 1 },
    });
  });

  it('retries the durable row when cluster publication fails', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000);
    const outbox = new InMemoryQueueBox();
    await outbox.enqueue(QueueBoxUtilities.toResourceEntryFromMsg(
      createUnicastMessage(), EnqueuedType.WS_OUTBOX,
    ));
    const service = createService(outbox, createSocket(), 'claimant', () => []);
    const bus = {
      ...createBridgeBus(),
      publish: async () => { throw new Error('simulated pub/sub outage'); },
    };
    installQueueBoxPubSubBridge({
      wsQBoxServerService: service,
      bridge: bus,
      channel: 'ws',
      publisherId: 'claimant',
      delivery: 'key',
    });

    await service.dequeueOutbox(WsQueueBoxServerService.OUTBOX_DEQUEUE_TYPES, createResilience());

    expect(readEntry(outbox).status).toBe(EntityStatus.RETRY);
  });

  it.each(['before', 'after'] as const)(
    'durably retries a remote owner send failure %s claimant completion',
    async (race) => {
      const outbox = new InMemoryQueueBox();
      const original = QueueBoxUtilities.toResourceEntryFromMsg(
        createUnicastMessage(), EnqueuedType.WS_OUTBOX,
      );
      await outbox.enqueue(original);
      const bus = race === 'before' ? createBridgeBus() : createFireAndForgetBridgeBus();
      const claimant = createService(outbox, createSocket(), 'claimant', () => []);
      const remoteSocket = createSocket();
      remoteSocket.sendEncoded.mockImplementationOnce(() => {
        throw new Error('simulated remote socket failure');
      });
      const remote = createService(outbox, remoteSocket, 'remote', () => [
        { peerId: 'writer-session', connectionId: 'writer-session' },
      ]);
      const remoteRetryPolicy = {
        ...createResilience().retryPolicy,
        delaysAfterAttemptMs: [50, 50],
        maxDelayMs: 50,
      };
      installQueueBoxPubSubBridge({
        wsQBoxServerService: claimant, bridge: bus, channel: 'ws', publisherId: 'claimant', delivery: 'key',
      });
      installQueueBoxPubSubBridge({
        wsQBoxServerService: remote, bridge: bus, channel: 'ws', publisherId: 'remote', delivery: 'key',
        retryPolicy: remoteRetryPolicy, jitterUnit: () => 0,
      });

      await claimant.dequeueOutbox(WsQueueBoxServerService.OUTBOX_DEQUEUE_TYPES, createResilience());
      await bus.drain?.();

      const retry = readEntry(outbox);
      expect(retry.status).toBe(EntityStatus.RETRY);
      expect(retry.resource).toBe(original.resource);
      expect((JSON.parse(retry.resource) as ALMessage).id.msgId).toBe('durable-reply-1');
      await expect(requeueRemoteWsOutboxDeliveryFailure(outbox, retry, {
        retryPolicy: remoteRetryPolicy, jitterUnit: () => 0,
      })).resolves.toBeUndefined();
      await expect(requeueRemoteWsOutboxDeliveryFailure(
        outbox,
        { ...retry, resource: `${retry.resource} ` },
        { retryPolicy: remoteRetryPolicy, jitterUnit: () => 0 },
      )).resolves.toBeUndefined();

      await new Promise((resolve) => setTimeout(resolve, 55));
      await claimant.dequeueOutbox(WsQueueBoxServerService.OUTBOX_DEQUEUE_TYPES, createResilience());
      await bus.drain?.();

      expect(readEntry(outbox)).toMatchObject({
        status: EntityStatus.COMPLETED,
        resource: original.resource,
        dequeueAudit: { attempts: 2 },
      });
      expect(remoteSocket.sendEncoded).toHaveBeenCalledTimes(2);
    },
  );
});

function createUnicastMessage(
  msgId = 'durable-reply-1',
  resourceId = 'reply-1',
): ALMessage {
  return {
    id: { v: 2, msgId, ts: Date.now(), senderId: 'server-worker' },
    route: { topicId: 'app.crdt', resourceId, contextId: 'rallar-server' },
    targets: { mode: 'unicast', toPeerId: 'writer-session' },
    constraints: { expiresAtMs: Date.now() + 60_000 },
    payload: { typeId: 'rallar.crdt.append-response.v1', contentType: 'application/json', resource: '{}' },
    audit: { createdBy: 'server-worker', createdTs: Date.now() },
  };
}

function createSocket() {
  const send = vi.fn();
  const sendEncoded = vi.fn();
  const socket = {
    connections: new Map([['writer-session', { id: 'writer-session', isOpen: true }]]),
    onMessageDo: () => undefined,
    encode: vi.fn((message: ALMessage) => JSON.stringify(message)),
    send,
    sendEncoded,
  } as unknown as JsonWebSocketServer;
  return { socket, send, sendEncoded };
}

function createService(
  outbox: InMemoryQueueBox,
  socket: ReturnType<typeof createSocket>,
  name: string,
  resolveRecipients: () => readonly { peerId: string; connectionId: string }[],
): WsQueueBoxServerService {
  return new WsQueueBoxServerService(new InMemoryQueueBox(), outbox, socket.socket, name, {
    targetResolver: {
      resolvePeerRecipients: resolveRecipients,
      resolveBroadcastRecipients: resolveRecipients,
    },
  });
}

function createBridgeBus(): QueueBoxPubSubBridge {
  const subscribers: ((message: QueueBoxPubSubMessage) => Promise<void> | void)[] = [];
  return {
    subscribe: async (_channel, subscriber) => { subscribers.push(subscriber); },
    publish: async (_channel, message) => {
      await Promise.all(subscribers.map(async (subscriber) => await subscriber(message)));
    },
  };
}

function createFireAndForgetBridgeBus(): QueueBoxPubSubBridge & { drain(): Promise<void> } {
  const subscribers: ((message: QueueBoxPubSubMessage) => Promise<void> | void)[] = [];
  let published: QueueBoxPubSubMessage[] = [];
  return {
    subscribe: async (_channel, subscriber) => { subscribers.push(subscriber); },
    publish: async (_channel, message) => {
      published.push(message);
    },
    drain: async () => {
      const current = published;
      published = [];
      await Promise.allSettled(current.flatMap((message) =>
        subscribers.map(async (subscriber) => await subscriber(message))
      ));
    },
  };
}

function createDelayedSecondSubscriberBridgeBus(): QueueBoxPubSubBridge & Readonly<{
  releaseSecondSubscription(): void;
}> {
  const subscribers: ((message: QueueBoxPubSubMessage) => Promise<void> | void)[] = [];
  let subscriptionCount = 0;
  let releaseSecondSubscription: () => void = () => undefined;
  const secondSubscription = new Promise<void>((resolve) => {
    releaseSecondSubscription = resolve;
  });

  return {
    subscribe: async (_channel, subscriber) => {
      subscriptionCount += 1;
      if (subscriptionCount === 2) {
        await secondSubscription;
      }
      subscribers.push(subscriber);
    },
    publish: async (_channel, message) => {
      await Promise.all(
        subscribers.map(async (subscriber) => await subscriber(message)),
      );
    },
    releaseSecondSubscription,
  };
}

function createResilience(): ResilienceDto {
  const duration = Temporal.Duration.from({ seconds: 10 });
  return ResilienceDto.toResilienceDto(
    new CircuitBreakerPolicy(10, duration, duration, duration),
    1,
    10,
    1,
    1,
    10,
    { maxAttempts: 3, delaysAfterAttemptMs: [1, 1], maxDelayMs: 1, jitterRatio: 0, staleDueThresholdMs: 1 },
  );
}

function readEntry(queue: InMemoryQueueBox): ResourceEntry {
  const entries = [...(queue as unknown as { data: Map<string, ResourceEntry> }).data.values()];
  if (!entries[0]) throw new Error('Expected queued entry');
  return entries[0];
}

function proxyAdmissionStore(
  inner: ALOutboundAdmissionStore,
  claimReadyEffects: ALOutboundAdmissionStore['claimReadyEffects'],
): ALOutboundAdmissionStore {
  return new Proxy(inner, {
    get(target, property) {
      if (property === 'claimReadyEffects') return claimReadyEffects;
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
