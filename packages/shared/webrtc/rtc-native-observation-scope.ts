import type { RtcSignalingDiagnostics } from './rtc-signaling-diagnostics.ts';

export namespace RtcNativeObservationScope {
    export interface Dependencies {
        readonly createScopeId?: () => string;
    }
    export interface Available {
        readonly status: 'available';
        readonly scope: RtcNativeObservationScope;
    }
    export interface Unavailable {
        readonly status: 'unavailable';
        readonly reason: 'initialization-failed';
    }
    export type Capability = Available | Unavailable;
    export type Kind = 'setup' | 'pc' | 'channel';
    export interface TerminalReservation {
        final: boolean;
        timeout: boolean;
    }
    export interface Admission {
        readonly id: RtcSignalingDiagnostics.Readout<string>;
        readonly kind: Kind;
        readonly admitted: boolean;
    }
}

/** Owns finite scope identity and publication admission; native lifecycle state stays with its owners. */
export class RtcNativeObservationScope {
    static readonly SOURCE_BYTES = 8_192;
    private scopeId: RtcSignalingDiagnostics.Readout<string>;
    private ordinal = 0;
    private sequence = 0;
    private readonly counts = { setup: 0, pc: 0, channel: 0 };
    private ordinaryRemaining = 4_096;
    private terminalReservations = new WeakMap<
        RtcNativeObservationScope.Admission,
        RtcNativeObservationScope.TerminalReservation
    >();
    private readonly statusUsed = { initialized: false, disposed: false };
    private noticeUsed = false;
    private disposed = false;
    private ordinaryRowsSuppressed = false;
    private admissionLimited = false;
    private payloadLimited = false;

    private constructor(dependencies: RtcNativeObservationScope.Dependencies) {
        this.scopeId = readScopeId(dependencies);
    }

    static create(dependencies: RtcNativeObservationScope.Dependencies): RtcNativeObservationScope.Capability {
        try {
            return Object.freeze({ status: 'available', scope: new RtcNativeObservationScope(dependencies) });
        }
        catch {
            return Object.freeze({ status: 'unavailable', reason: 'initialization-failed' });
        }
    }

    allocate(kind: RtcNativeObservationScope.Kind): RtcNativeObservationScope.Admission {
        const cap = kind === 'channel' ? 1_024 : 256;
        if (this.disposed || !Object.hasOwn(this.counts, kind) || this.counts[kind] >= cap) {
            this.admissionLimited ||= !this.disposed;
            return Object.freeze({
                kind,
                admitted: false,
                id: Object.freeze({
                    status: 'unavailable',
                    reason: this.disposed ? 'scope-disposed' : 'admission-limit'
                })
            });
        }
        this.counts[kind]++;
        this.ordinal++;
        const id: RtcSignalingDiagnostics.Readout<string> = this.scopeId.status === 'observed'
            ? Object.freeze({ status: 'observed', value: `${this.scopeId.value}-${kind}-${this.ordinal}` })
            : this.scopeId;
        const admission = Object.freeze({ kind, admitted: true, id });
        this.terminalReservations.set(admission, { final: true, timeout: kind === 'setup' });
        return admission;
    }

    consumeOrdinary(): boolean {
        if (this.disposed) {
            return false;
        }
        if (this.ordinaryRemaining === 0) {
            this.ordinaryRowsSuppressed = true;
            return false;
        }
        this.ordinaryRemaining--;
        return true;
    }

    consumeTerminal(admission: RtcNativeObservationScope.Admission, slot: 'final' | 'timeout'): boolean {
        const reservation = this.terminalReservations.get(admission);
        if (this.disposed || !reservation?.[slot]) {
            return false;
        }
        reservation[slot] = false;
        return true;
    }

    consumeStatus(stage: 'initialized' | 'disposed'): boolean {
        if (this.statusUsed[stage] || (this.disposed && stage !== 'disposed')) {
            return false;
        }
        this.statusUsed[stage] = true;
        return true;
    }

    consumeLimitNotice(): 'admission' | 'ordinary-rows' | 'payload-bytes' | undefined {
        if (this.disposed || this.noticeUsed) {
            return undefined;
        }
        const limit = this.admissionLimited
            ? 'admission'
            : this.ordinaryRowsSuppressed
            ? 'ordinary-rows'
            : this.payloadLimited
            ? 'payload-bytes'
            : undefined;
        if (limit) {
            this.noticeUsed = true;
        }
        return limit;
    }

    markPayloadLimited(): void {
        this.payloadLimited = true;
    }
    nextSequence(): number {
        return ++this.sequence;
    }
    getActive(): boolean {
        return !this.disposed;
    }
    getOrdinaryAvailable(): boolean {
        return !this.disposed && this.ordinaryRemaining > 0;
    }

    getCaptureStatus(): RtcSignalingDiagnostics.CaptureStatus {
        return Object.freeze({
            scopeId: this.scopeId,
            scope: this.disposed ? 'disposed' : 'active',
            ordinaryRowsSuppressed: this.ordinaryRowsSuppressed,
            admissionLimited: this.admissionLimited,
            payloadLimited: this.payloadLimited
        });
    }

    dispose(): RtcSignalingDiagnostics.CaptureStatus | undefined {
        if (this.disposed) {
            return undefined;
        }
        this.disposed = true;
        const status = this.getCaptureStatus();
        this.scopeId = Object.freeze({ status: 'unavailable', reason: 'scope-disposed' });
        this.terminalReservations = new WeakMap();
        this.ordinaryRemaining = 0;
        return status;
    }
}

function readScopeId(dependencies: RtcNativeObservationScope.Dependencies): RtcSignalingDiagnostics.Readout<string> {
    if (!dependencies.createScopeId) {
        return Object.freeze({ status: 'unavailable', reason: 'identity-source-absent' });
    }
    try {
        const value = dependencies.createScopeId();
        return typeof value === 'string' && value.length > 0 && value.length <= 64 && /^[A-Za-z0-9_-]+$/.test(value)
            ? Object.freeze({ status: 'observed', value })
            : Object.freeze({ status: 'unavailable', reason: 'identity-invalid' });
    }
    catch {
        return Object.freeze({ status: 'unavailable', reason: 'identity-source-failed' });
    }
}
