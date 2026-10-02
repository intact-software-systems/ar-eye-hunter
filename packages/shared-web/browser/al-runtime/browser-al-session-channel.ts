import type { ALDeliverySettlement, ALDeliverySettlementSink } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type { ALDurableWorkCommit } from '@shared/alm/work/al-durable-work-ownership.ts';
import type { ALWorkCommittedRows } from '@shared/alm/work/al-work-readiness-memory.ts';
import type { StateScope } from '@shared/api/state-types.ts';

export namespace BrowserALSessionChannel {
    /** The part of `BroadcastChannel` the session channel uses. */
    export interface Port {
        onmessage: ((event: MessageEvent) => void) | null;
        postMessage(message: Message): void;
        close(): void;
    }

    /** Undefined where the browser has no `BroadcastChannel`: the tab then reaches no other tab. */
    export type OpenPort = (name: string) => Port | undefined;

    export interface Input {
        readonly scope: StateScope;
        readonly sessionId: string;
        /** Distinct per channel object: a message carrying it is this object's own echo. */
        readonly instanceId: string;
        readonly openPort: OpenPort;
        /** This tab's own observers; they ignore a msgId this tab holds no handle for. */
        readonly applySettlement: ALDeliverySettlementSink;
    }

    export interface Envelope {
        readonly version: 1;
        readonly sessionKey: string;
        /** The posting channel object's, so it can recognise its own echo. */
        readonly instanceId: string;
    }

    export interface CommittedBody {
        readonly kind: 'committed';
        readonly workType: string;
        readonly rows: ALWorkCommittedRows;
    }

    export interface SettlementBody {
        readonly kind: 'settlement';
        readonly settlement: ALDeliverySettlement;
    }

    export type Body = CommittedBody | SettlementBody;

    export type Message = Envelope & Body;
}

/** The global `BroadcastChannel`, behind the same missing-API guard as the Rallar Data and CRDT channels. */
export function openBrowserALSessionChannelPort(name: string): BrowserALSessionChannel.Port | undefined {
    return typeof BroadcastChannel === 'undefined' ? undefined : new BroadcastChannel(name);
}

/** Each part of the scope is URI-encoded, as the scope's database name is, so a colon cannot alias another scope. */
export function toBrowserALSessionKey(scope: StateScope, sessionId: string): string {
    return `${encodeURIComponent(scope.applicationId)}:${encodeURIComponent(scope.workspaceId)}:${sessionId}`;
}

/**
 * The tabs of one session and scope, for one connect: a commit a tab that does not own the session's
 * durable work announces to the tab that does, and a settlement a tab records for a message it holds no
 * handle for, relayed to the tab that holds it.
 */
export class BrowserALSessionChannel {
    private readonly input: BrowserALSessionChannel.Input;
    private readonly sessionKey: string;
    private readonly port: BrowserALSessionChannel.Port | undefined;
    private readonly commitListeners = new Set<(commit: ALDurableWorkCommit) => void>();

    constructor(input: BrowserALSessionChannel.Input) {
        this.input = input;
        this.sessionKey = toBrowserALSessionKey(input.scope, input.sessionId);
        this.port = input.openPort(`rallar-alm:${this.sessionKey}`);
        if (this.port !== undefined) {
            this.port.onmessage = (event) => this.receive(event.data as Partial<BrowserALSessionChannel.Message>);
        }
    }

    announceCommit(commit: ALDurableWorkCommit): void {
        this.post({ kind: 'committed', ...commit });
    }

    onCommitted(listener: (commit: ALDurableWorkCommit) => void): () => void {
        this.commitListeners.add(listener);
        return () => {
            this.commitListeners.delete(listener);
        };
    }

    relaySettlement(settlement: ALDeliverySettlement): void {
        this.post({ kind: 'settlement', settlement });
    }

    close(): void {
        this.port?.close();
        this.commitListeners.clear();
    }

    private post(body: BrowserALSessionChannel.Body): void {
        this.port?.postMessage({ version: 1, sessionKey: this.sessionKey, instanceId: this.input.instanceId, ...body });
    }

    private receive(message: Partial<BrowserALSessionChannel.Message>): void {
        if (
            message.version !== 1 ||
            message.sessionKey !== this.sessionKey ||
            message.instanceId === this.input.instanceId
        ) {
            return;
        }
        if (message.kind === 'committed' && message.workType !== undefined && message.rows !== undefined) {
            const commit: ALDurableWorkCommit = { workType: message.workType, rows: message.rows };
            for (const listener of this.commitListeners) {
                listener(commit);
            }
        }
        else if (message.kind === 'settlement' && message.settlement !== undefined) {
            this.input.applySettlement(message.settlement);
        }
    }
}
