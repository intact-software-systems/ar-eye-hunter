import {
    P2pCursor,
    P2pRole,
    P2pSignalType,
    type ClientId,
    type P2pSessionId,
    type P2pToken,
    type CreateP2pSessionRequest,
    type CreateP2pSessionResponse,
    type JoinP2pSessionRequest,
    type JoinP2pSessionResponse,
    type PostP2pSignalRequest,
    type PostP2pSignalResponse,
    type GetP2pSignalsResponse,
    type P2pSignalRecord,
} from '@shared/mod';

export enum NAString {
    NA = 'NA',
}

export enum SignalingStateKind {
    Idle = 'Idle',
    Ready = 'Ready',
}

export type SignalingState =
    | { kind: SignalingStateKind.Idle }
    | {
    kind: SignalingStateKind.Ready;
    sessionId: P2pSessionId;
    role: P2pRole;
    token: P2pToken;
    expiresAtEpochMs: number;
};

export type SignalHandler = (signal: P2pSignalRecord) => void;

function httpBaseUrl(): string {
    const env = (import.meta as any).env;
    const raw = (env?.VITE_API_BASE_URL as string) || '';
    return raw.length > 0 ? raw : '';
}

async function readTextSafe(res: Response): Promise<string> {
    try {
        return await res.text();
    } catch {
        return '';
    }
}

async function apiJson<TReq, TRes>(
    baseUrl: string,
    path: string,
    method: 'GET' | 'POST',
    body: TReq | NAString
): Promise<TRes> {
    const url = `${baseUrl}${path}`;

    const init: RequestInit = {
        method,
        headers: { 'content-type': 'application/json' },
    };

    if (method === 'POST') {
        if (body === NAString.NA) throw new Error(`POST ${path} requires a body`);
        init.body = JSON.stringify(body);
    }

    const res = await fetch(url, init);
    if (!res.ok) {
        const txt = await readTextSafe(res);
        throw new Error(`API ${method} ${path} failed: ${res.status} ${txt}`);
    }

    return (await res.json()) as TRes;
}

export enum PumpKind {
    Stopped = 'Stopped',
    Running = 'Running',
}

export class P2pSignalingClient {
    private readonly baseUrl: string = httpBaseUrl();

    private state: SignalingState = { kind: SignalingStateKind.Idle };
    private cursor: string = P2pCursor.NA;

    private pump: { kind: PumpKind.Stopped } | { kind: PumpKind.Running; timerId: number } = {
        kind: PumpKind.Stopped,
    };

    public getState(): SignalingState {
        return this.state;
    }

    public reset(): void {
        this.stopPump();
        this.state = { kind: SignalingStateKind.Idle };
        this.cursor = P2pCursor.NA;
    }

    public async createSession(clientId: ClientId): Promise<SignalingState> {
        const req: CreateP2pSessionRequest = { clientId };
        const res = await apiJson<CreateP2pSessionRequest, CreateP2pSessionResponse>(
            this.baseUrl,
            '/api/p2p/sessions',
            'POST',
            req
        );

        this.state = {
            kind: SignalingStateKind.Ready,
            sessionId: res.sessionId,
            role: res.role,
            token: res.token,
            expiresAtEpochMs: res.expiresAtEpochMs,
        };

        this.cursor = P2pCursor.NA;
        return this.state;
    }

    public async joinSession(sessionId: P2pSessionId, clientId: ClientId): Promise<SignalingState> {
        const req: JoinP2pSessionRequest = { clientId };
        const res = await apiJson<JoinP2pSessionRequest, JoinP2pSessionResponse>(
            this.baseUrl,
            `/api/p2p/sessions/${sessionId}/join`,
            'POST',
            req
        );

        this.state = {
            kind: SignalingStateKind.Ready,
            sessionId: res.sessionId,
            role: res.role,
            token: res.token,
            expiresAtEpochMs: res.expiresAtEpochMs,
        };

        this.cursor = P2pCursor.NA;
        return this.state;
    }

    public async postSignal(type: P2pSignalType, payload: unknown): Promise<void> {
        if (this.state.kind !== SignalingStateKind.Ready) {
            throw new Error('Signaling client is not ready.');
        }

        const req: PostP2pSignalRequest = {
            token: this.state.token,
            type,
            payload,
        };

        await apiJson<PostP2pSignalRequest, PostP2pSignalResponse>(
            this.baseUrl,
            `/api/p2p/sessions/${this.state.sessionId}/signals`,
            'POST',
            req
        );
    }

    public startPump(handler: SignalHandler, intervalMs: number): void {
        if (this.state.kind !== SignalingStateKind.Ready) {
            throw new Error('Cannot start pump: signaling client is not ready.');
        }

        if (this.pump.kind === PumpKind.Running) {
            return;
        }

        const timerId = window.setInterval(() => {
            void this.tick(handler);
        }, intervalMs);

        this.pump = { kind: PumpKind.Running, timerId };
    }

    public stopPump(): void {
        if (this.pump.kind === PumpKind.Running) {
            clearInterval(this.pump.timerId);
        }
        this.pump = { kind: PumpKind.Stopped };
    }

    private async tick(handler: SignalHandler): Promise<void> {
        if (this.state.kind !== SignalingStateKind.Ready) {
            this.stopPump();
            return;
        }

        // GET /signals?token=...&cursor=...
        const sessionId = this.state.sessionId;
        const token = encodeURIComponent(this.state.token);
        const cursor = encodeURIComponent(this.cursor);

        const path = `/api/p2p/sessions/${sessionId}/signals?token=${token}&cursor=${cursor}&limit=50`;

        const res = await apiJson<NAString, GetP2pSignalsResponse>(this.baseUrl, path, 'GET', NAString.NA);

        for (const s of res.signals) {
            handler(s);
        }

        this.cursor = res.nextCursor;
    }
}