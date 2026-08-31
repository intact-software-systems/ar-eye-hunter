import { notifyListener } from '@shared-web/browser/messages/rallar-listener-delivery.ts';
import type { ApiMiddleware } from '@shared-web/browser/rallar-connection-facade.ts';
import type {
    RallarRtcLifecycleKind,
    RallarRtcLifecycleListener,
    RallarRtcStatus,
    RallarRtcStatusListener,
    RallarRtcStatusOptions,
    RallarRtcStatusSubscriptionOptions
} from '@shared-web/browser/rallar-rtc-facade.ts';
import type { RallarUnsubscribe } from '@shared-web/browser/rallar-shared-contracts.ts';
import type { QRtcPeerDto } from '@shared/services/web-rtc-connection-service.ts';
import type { QRtcClientCallbacks } from '@shared/webrtc/QRtcClientCallbacks.ts';

const RALLAR_RTC_STATUS_CALLBACK_ID = 'rallar:rtc:status';

interface RallarRtcStatusSubscription {
    readonly listener: RallarRtcStatusListener;
    readonly options: RallarRtcStatusSubscriptionOptions;
}

interface RallarRtcLifecycleSubscription {
    readonly listener: RallarRtcLifecycleListener;
    readonly options: RallarRtcStatusSubscriptionOptions;
}

interface RallarRtcLifecycleEventInput {
    readonly peerId?: string;
    readonly laneId?: string;
}

export namespace BrowserRtcLifecycleRuntime {
    export interface Input {
        readMiddleware(): ApiMiddleware | undefined;
        readStatus(options?: RallarRtcStatusOptions): RallarRtcStatus;
    }
}

/** Owns RTC status/lifecycle subscriptions and low-level callback lifetime. */
export class BrowserRtcLifecycleRuntime {
    private readonly statusListeners = new Set<RallarRtcStatusSubscription>();
    private readonly lifecycleListeners = new Set<RallarRtcLifecycleSubscription>();
    private readonly input: BrowserRtcLifecycleRuntime.Input;

    public constructor(input: BrowserRtcLifecycleRuntime.Input) {
        this.input = input;
    }

    public onStatus(
        listener: RallarRtcStatusListener,
        options: RallarRtcStatusSubscriptionOptions
    ): RallarUnsubscribe {
        const subscription = { listener, options };
        this.statusListeners.add(subscription);
        this.registerCallbacks();
        if (options.emitCurrent ?? true) {
            notifyListener(listener, this.input.readStatus(options));
        }

        return () => {
            this.statusListeners.delete(subscription);
            this.unregisterCallbacksIfUnused();
        };
    }

    public onLifecycle(
        listener: RallarRtcLifecycleListener,
        options: RallarRtcStatusSubscriptionOptions
    ): RallarUnsubscribe {
        const subscription = { listener, options };
        this.lifecycleListeners.add(subscription);
        this.registerCallbacks();
        if (options.emitCurrent ?? true) {
            this.notifyLifecycleSubscription(subscription, 'snapshot');
        }

        return () => {
            this.lifecycleListeners.delete(subscription);
            this.unregisterCallbacksIfUnused();
        };
    }

    public attach(context = this.input.readMiddleware()): void {
        this.registerCallbacks(context);
    }

    public connected(): void {
        this.emitLifecycle('connected');
    }

    public detach(context = this.input.readMiddleware()): void {
        this.unregisterCallbacks(context);
    }

    public disconnected(): void {
        this.emitLifecycle('disconnected');
    }

    private registerCallbacks(context = this.input.readMiddleware()): void {
        if (!context || !this.hasSubscriptions()) {
            return;
        }

        const service = context.middleware.webRtcConnectionService;
        service.onRtcPeerLifecycleDo(RALLAR_RTC_STATUS_CALLBACK_ID, {
            onCreated: (peer) => {
                this.registerPeerCallbacks(peer);
                this.emitLifecycle('peer-created', { peerId: peer.peerId });
            },
            onDeleted: (peer) => {
                this.unregisterPeerCallbacks(peer);
                queueMicrotask(() => this.emitLifecycle('peer-deleted', { peerId: peer.peerId }));
            },
            onConnectTimeout: (peer) => {
                this.emitLifecycle('peer-timeout', { peerId: peer.peerId });
            }
        });

        for (const peerId of service.knownPeerIds()) {
            const peer = service.readPeer(peerId);
            if (peer) {
                this.registerPeerCallbacks(peer);
            }
        }
    }

    private registerPeerCallbacks(peer: QRtcPeerDto): void {
        for (const [laneId, channel] of peer.channels.entries()) {
            channel.onRtcCallbacksDo(
                RALLAR_RTC_STATUS_CALLBACK_ID,
                this.laneLifecycleCallbacks(peer.peerId, laneId)
            );
        }
    }

    private laneLifecycleCallbacks(peerId: string, laneId: string): QRtcClientCallbacks {
        return {
            onOpen: async () => this.emitLifecycle('lane-open', { peerId, laneId }),
            onClose: async () => this.emitLifecycle('lane-close', { peerId, laneId }),
            onError: async () => this.emitLifecycle('lane-error', { peerId, laneId })
        };
    }

    private unregisterCallbacksIfUnused(): void {
        if (!this.hasSubscriptions()) {
            this.unregisterCallbacks();
        }
    }

    private unregisterCallbacks(context = this.input.readMiddleware()): void {
        if (!context) {
            return;
        }

        const service = context.middleware.webRtcConnectionService;
        service.removeRtcPeerLifecycleById(RALLAR_RTC_STATUS_CALLBACK_ID);
        for (const peerId of service.knownPeerIds()) {
            const peer = service.readPeer(peerId);
            if (peer) {
                this.unregisterPeerCallbacks(peer);
            }
        }
    }

    private unregisterPeerCallbacks(peer: QRtcPeerDto): void {
        for (const channel of peer.channels.values()) {
            channel.removeRtcCallbackById(RALLAR_RTC_STATUS_CALLBACK_ID);
        }
    }

    private hasSubscriptions(): boolean {
        return this.statusListeners.size > 0 || this.lifecycleListeners.size > 0;
    }

    private emitLifecycle(
        kind: RallarRtcLifecycleKind,
        input: RallarRtcLifecycleEventInput = {}
    ): void {
        this.emitStatus();
        for (const subscription of this.lifecycleListeners) {
            this.notifyLifecycleSubscription(subscription, kind, input);
        }
    }

    private emitStatus(): void {
        for (const subscription of this.statusListeners) {
            notifyListener(
                subscription.listener,
                this.input.readStatus(subscription.options)
            );
        }
    }

    private notifyLifecycleSubscription(
        subscription: RallarRtcLifecycleSubscription,
        kind: RallarRtcLifecycleKind,
        input: RallarRtcLifecycleEventInput = {}
    ): void {
        const status = this.input.readStatus(subscription.options);
        const peer = input.peerId
            ? status.peers.find((candidate) => candidate.peerId === input.peerId)
            : undefined;
        const lane = input.laneId
            ? peer?.lanes.find((candidate) => candidate.laneId === input.laneId)
            : undefined;

        notifyListener(subscription.listener, {
            kind,
            atEpochMs: Date.now(),
            status,
            peerId: input.peerId,
            laneId: input.laneId,
            peer,
            lane
        });
    }
}
