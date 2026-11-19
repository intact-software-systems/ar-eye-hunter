import { createSeededRandom } from '../random/create-seeded-random.ts';
import {
    validateSeededTransportFaultAction,
    type SeededTransportFaultAction
} from './seeded-transport-fault-action.ts';

/** What a seeded fault does to one matching frame. */
export type SeededTransportFaultEffect =
    | Readonly<{ kind: 'pass'; }>
    | Readonly<{ kind: 'drop'; }>
    | Readonly<{ kind: 'delay'; delayMs: number; }>;

/** The sequence of each armed seeded fault: one number per matching frame, from its seed alone. */
export class SeededTransportFaultDraws {
    private readonly draws = new Map<string, () => number>();

    /** Starts the fault's sequence at its seed, or forgets it when the fault is no longer seeded. */
    rearm(faultId: string, action: SeededTransportFaultAction | undefined): void {
        this.draws.delete(faultId);
        if (action === undefined) {
            return;
        }
        const issues = validateSeededTransportFaultAction(action);
        if (issues.length > 0) {
            throw new TypeError(`Transport fault ${faultId} cannot be injected: ${issues.join('; ')}.`);
        }
        this.draws.set(faultId, createSeededRandom('loss' in action ? action.loss.seed : action.jitter.seed));
    }

    clear(): void {
        this.draws.clear();
    }

    decideFrame(faultId: string, action: SeededTransportFaultAction): SeededTransportFaultEffect {
        const draw = this.draws.get(faultId);
        if (draw === undefined) {
            throw new Error(`Transport fault ${faultId} is seeded and holds no sequence.`);
        }
        if ('loss' in action) {
            return { kind: draw() < action.loss.ratio ? 'drop' : 'pass' };
        }
        const { minDelayMs, maxDelayMs } = action.jitter;
        return { kind: 'delay', delayMs: minDelayMs + Math.floor(draw() * (maxDelayMs - minDelayMs + 1)) };
    }
}
