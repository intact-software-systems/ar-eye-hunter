export interface MarketPoint {
    readonly x: number;
    readonly y: number;
}
export interface MarketObstacle extends MarketPoint {
    readonly width: number;
    readonly height: number;
}
export interface MarketControl extends MarketPoint {
    readonly id: string;
    readonly bank: boolean;
    readonly dash: number;
}
export interface MarketRunner extends MarketPoint {
    readonly id: string;
    readonly colour: number;
    readonly bag: number;
    readonly banked: number;
    readonly deposit: number;
    readonly facingX: number;
    readonly facingY: number;
    readonly dashRemaining: number;
    readonly cooldown: number;
    readonly lastDash: number;
}
export interface MarketCoin extends MarketPoint {
    readonly id: number;
    readonly availableAt: number;
}
export interface MarketState {
    readonly tick: number;
    readonly elapsed: number;
    readonly players: readonly MarketRunner[];
    readonly coins: readonly MarketCoin[];
}
export const MARKET_SIZE = 384;
export const MARKET_BANKS: readonly MarketPoint[] = [{ x: 54, y: 328 }, { x: 330, y: 56 }];
export const MARKET_OBSTACLES: readonly MarketObstacle[] = [
    { x: 38, y: 68, width: 64, height: 48 },
    { x: 148, y: 46, width: 64, height: 48 },
    { x: 252, y: 142, width: 68, height: 48 },
    { x: 86, y: 220, width: 66, height: 48 },
    { x: 236, y: 272, width: 68, height: 48 }
];

export function createMarket(): MarketState {
    const positions: readonly MarketPoint[] = [
        { x: 54, y: 288 },
        { x: 54, y: 252 },
        { x: 54, y: 204 },
        { x: 54, y: 156 },
        { x: 112, y: 166 },
        { x: 154, y: 166 },
        { x: 192, y: 166 },
        { x: 192, y: 210 },
        { x: 192, y: 252 },
        { x: 192, y: 294 },
        { x: 192, y: 336 },
        { x: 144, y: 328 },
        { x: 330, y: 110 },
        { x: 336, y: 220 },
        { x: 292, y: 230 },
        { x: 236, y: 230 },
        { x: 256, y: 106 },
        { x: 296, y: 106 }
    ];
    return {
        tick: 0,
        elapsed: 0,
        players: [],
        coins: positions.map((point, id) => ({ ...point, id, availableAt: 0 }))
    };
}

export function createRunner(id: string, colour: number): MarketRunner {
    return {
        id,
        colour,
        x: 54 + colour * 36,
        y: 328,
        bag: 0,
        banked: 0,
        deposit: 0,
        facingX: 0,
        facingY: -1,
        dashRemaining: 0,
        cooldown: 0,
        lastDash: 0
    };
}

export function computeMarketTick(
    state: MarketState,
    controls: readonly MarketControl[],
    seconds: number
): MarketState {
    const elapsed = state.elapsed + seconds;
    const coins = state.coins.map((coin) => ({ ...coin }));
    const players = state.players.map((runner) => {
        const control = controls.find((item) => item.id === runner.id) ??
            { id: runner.id, x: 0, y: 0, bank: false, dash: runner.lastDash };
        const moved = computeRunnerMovement(runner, control, seconds);
        let bag = moved.bag;
        for (const coin of coins) {
            if (bag < 30 && coin.availableAt <= elapsed && Math.hypot(coin.x - moved.x, coin.y - moved.y) < 14) {
                bag += 1;
                coin.availableAt = elapsed + 8;
            }
        }
        return computeRunnerBank({ ...moved, bag }, control, seconds);
    });
    return { tick: state.tick + 1, elapsed, players, coins };
}

function computeRunnerMovement(runner: MarketRunner, control: MarketControl, seconds: number): MarketRunner {
    const magnitude = Math.max(1, Math.hypot(control.x, control.y));
    const moving = Math.hypot(control.x, control.y) > 0.05;
    const facingX = moving ? control.x / magnitude : runner.facingX;
    const facingY = moving ? control.y / magnitude : runner.facingY;
    const newDash = control.dash > runner.lastDash && runner.cooldown <= 0;
    const dashRemaining = newDash ? 0.2 : Math.max(0, runner.dashRemaining - seconds);
    const speed = dashRemaining > 0 ? 270 : 90;
    const velocityX = dashRemaining > 0 ? facingX : control.x / magnitude;
    const velocityY = dashRemaining > 0 ? facingY : control.y / magnitude;
    const candidateX = Math.max(12, Math.min(372, runner.x + velocityX * speed * seconds));
    const x = isMarketWalkable(candidateX, runner.y) ? candidateX : runner.x;
    const candidateY = Math.max(12, Math.min(372, runner.y + velocityY * speed * seconds));
    const y = isMarketWalkable(x, candidateY) ? candidateY : runner.y;
    return {
        ...runner,
        x,
        y,
        facingX,
        facingY,
        dashRemaining,
        cooldown: newDash ? 4 : Math.max(0, runner.cooldown - seconds),
        lastDash: Math.max(runner.lastDash, control.dash)
    };
}

function computeRunnerBank(runner: MarketRunner, control: MarketControl, seconds: number): MarketRunner {
    const inBank = MARKET_BANKS.some((bank) => Math.hypot(bank.x - runner.x, bank.y - runner.y) < 29);
    const deposit = inBank && control.bank && runner.bag > 0 && runner.dashRemaining === 0
        ? runner.deposit + seconds
        : 0;
    if (deposit + 0.000001 < 0.9) {
        return { ...runner, deposit };
    }
    const bonus = runner.bag >= 20 ? 0.4 : runner.bag >= 10 ? 0.2 : 0;
    return { ...runner, deposit: 0, bag: 0, banked: runner.banked + runner.bag + Math.floor(runner.bag * bonus) };
}

export function isMarketWalkable(x: number, y: number): boolean {
    return !MARKET_OBSTACLES.some((stall) =>
        x > stall.x - 9 && x < stall.x + stall.width + 9 && y > stall.y - 9 && y < stall.y + stall.height + 9
    );
}
