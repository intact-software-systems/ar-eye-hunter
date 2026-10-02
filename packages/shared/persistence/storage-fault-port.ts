import { LatestRepository } from '../cache/LatestRepository.ts';
import type {
    IndexedDbOperation,
    IndexedDbOperationKind,
    IndexedDbOperationObserver,
    IndexedDbOperationOwner
} from './indexed-db-operation-observer.ts';

export interface StorageFaultMatch {
    readonly owner: IndexedDbOperationOwner;
    /** Undefined matches every kind of the owner; a `quota` fault still fails only its writes. */
    readonly kind: IndexedDbOperationKind | undefined;
}

export interface ScriptedStorageFault {
    readonly faultId: string;
    readonly carrier: 'storage';
    readonly match: StorageFaultMatch;
    readonly action: 'fail' | 'quota' | Readonly<{ delayMs: number; }>;
    readonly remaining: number | 'until-cleared';
}

export interface StorageFaultObservation {
    readonly faultId: string;
    readonly operation: IndexedDbOperation;
    readonly decision: 'fail' | 'quota' | 'delay';
}

export interface ScriptedStorageFaultPort extends IndexedDbOperationObserver {
    inject(fault: ScriptedStorageFault): void;
    clear(): void;
    getObservations(): readonly StorageFaultObservation[];
}

const WRITE_KINDS: ReadonlySet<IndexedDbOperationKind> = new Set([
    'write',
    'work-write',
    'work-reserve',
    'work-release',
    'work-cleanup'
]);

export function createScriptedStorageFaultPort(): ScriptedStorageFaultPort {
    return new ScriptedStorageFaults();
}

class ScriptedStorageFaults implements ScriptedStorageFaultPort {
    private readonly faults = new LatestRepository<string, ScriptedStorageFault>();
    private readonly observations: StorageFaultObservation[] = [];

    inject(fault: ScriptedStorageFault): void {
        this.faults.set(fault.faultId, fault);
    }

    clear(): void {
        this.faults.clearAll();
        this.observations.length = 0;
    }

    getObservations(): readonly StorageFaultObservation[] {
        return [...this.observations];
    }

    observe(operation: IndexedDbOperation): Promise<void> | void {
        const fault = this.faults.readAllValues().find((candidate) => matchesStorageFault(candidate, operation));
        if (fault === undefined) {
            return undefined;
        }
        if (fault.remaining !== 'until-cleared') {
            this.faults.set(fault.faultId, { ...fault, remaining: fault.remaining - 1 });
        }
        const decision = typeof fault.action === 'string' ? fault.action : 'delay';
        this.observations.push({ faultId: fault.faultId, operation, decision });
        return startStorageFaultDecision(fault);
    }
}

function matchesStorageFault(fault: ScriptedStorageFault, operation: IndexedDbOperation): boolean {
    return (fault.remaining === 'until-cleared' || fault.remaining > 0) &&
        fault.match.owner === operation.owner &&
        (fault.match.kind === undefined || fault.match.kind === operation.kind) &&
        (fault.action !== 'quota' || WRITE_KINDS.has(operation.kind));
}

/** The message names the fault, so the storage failure a store reports reads back to the fault that caused it. */
function startStorageFaultDecision({ action, faultId }: ScriptedStorageFault): Promise<void> {
    if (action === 'quota') {
        return Promise.reject(new DOMException(`Scripted storage quota fault ${faultId}`, 'QuotaExceededError'));
    }
    if (action === 'fail') {
        return Promise.reject(new DOMException(`Scripted storage fault ${faultId}`, 'UnknownError'));
    }
    return new Promise((resolve) => {
        setTimeout(resolve, action.delayMs);
    });
}
