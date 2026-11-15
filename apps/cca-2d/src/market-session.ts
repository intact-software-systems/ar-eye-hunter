import {
    computeMarketTick,
    createMarket,
    createRunner,
    type MarketControl,
    type MarketState
} from '../../../packages/cca-game/market-rules.ts';

export interface MarketSession {
    readonly playerId: string;
    getState(): MarketState;
    getStatus(): string;
    advance(seconds: number, control: MarketControl): void;
    stop(): void;
}

export class PracticeSession implements MarketSession {
    readonly playerId = 'practice';
    private state: MarketState = { ...createMarket(), players: [createRunner(this.playerId, 0)] };
    private remainder = 0;
    getState(): MarketState {
        return this.state;
    }
    getStatus(): string {
        return 'SOLO PRACTICE';
    }
    advance(seconds: number, control: MarketControl): void {
        this.remainder += Math.min(seconds, 0.1);
        while (this.remainder >= 1 / 30) {
            this.state = computeMarketTick(this.state, [control], 1 / 30);
            this.remainder -= 1 / 30;
        }
    }
    stop(): void {
        this.remainder = 0;
    }
}
