import Phaser from 'phaser';
import { MARKET_BANKS, type MarketState } from '../../../packages/cca-game/market-rules.ts';
import { MarketInput } from './market-input.ts';
import { MarketScene, type MarketSceneView } from './market-scene.ts';
import { PracticeSession, type MarketSession } from './market-session.ts';

export class MarketApp implements MarketSceneView {
    private readonly root: HTMLElement;
    private readonly session: MarketSession;
    private readonly controls: MarketInput;
    private readonly game: Phaser.Game;
    private readonly bag: HTMLElement;
    private readonly banked: HTMLElement;
    private readonly status: HTMLElement;
    private readonly hint: HTMLElement;
    private readonly progress: HTMLProgressElement;
    private readonly dash: HTMLButtonElement;
    private readonly bank: HTMLButtonElement;
    constructor(root: HTMLElement, session: MarketSession) {
        this.root = root;
        this.session = session;
        root.innerHTML = gameMarkup();
        this.bag = requireElement(root, '#bag');
        this.banked = requireElement(root, '#banked');
        this.status = requireElement(root, '#status');
        this.hint = requireElement(root, '#hint');
        this.progress = requireElement<HTMLProgressElement>(root, '#deposit');
        this.dash = requireElement<HTMLButtonElement>(root, '#dash');
        this.bank = requireElement<HTMLButtonElement>(root, '#bank');
        this.controls = new MarketInput(requireElement(root, '#joystick'), requireElement(root, '#puck'), {
            dash: this.dash,
            bank: this.bank
        });
        this.game = new Phaser.Game({
            type: Phaser.AUTO,
            parent: requireElement(root, '#world'),
            width: 384,
            height: 384,
            pixelArt: true,
            backgroundColor: '#eeaa85',
            scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
            scene: new MarketScene(session, this.controls, this),
            audio: { noAudio: true }
        });
        requireElement(root, '#leave').addEventListener('click', () => location.reload());
    }
    render(state: MarketState, session: MarketSession): void {
        const player = state.players.find((runner) => runner.id === session.playerId);
        this.status.textContent = session.getStatus();
        const opponent = state.players.find((runner) => runner.id !== session.playerId);
        this.status.textContent += opponent ? ` · RIVAL BANKED ${opponent.banked}` : '';
        if (!player) {
            return;
        }
        this.bag.textContent = `${player.bag}/30`;
        this.banked.textContent = String(player.banked);
        const inBank = MARKET_BANKS.some((bank) => Math.hypot(bank.x - player.x, bank.y - player.y) < 29);
        this.bank.classList.toggle('available', inBank && player.bag > 0);
        this.progress.value = player.deposit / 0.9;
        this.dash.textContent = player.cooldown > 0 ? player.cooldown.toFixed(1) : 'DASH';
        this.hint.textContent = player.deposit > 0
            ? 'Hold… banking your bag'
            : inBank && player.bag > 0
            ? 'Hold BANK to stash your loot'
            : player.bag === 30
            ? 'Bag full — find a bank!'
            : 'Follow the gold. Bank it. Make another run.';
        this.root.dataset.playerX = player.x.toFixed(1);
        this.root.dataset.playerY = player.y.toFixed(1);
    }
    stop(): void {
        this.controls.stop();
        this.session.stop();
        this.game.destroy(true);
    }
}

export function startPractice(root: HTMLElement): MarketApp {
    return new MarketApp(root, new PracticeSession());
}
export function requireElement<T extends HTMLElement = HTMLElement>(root: HTMLElement, selector: string): T {
    const element = root.querySelector<T>(selector);
    if (!element) {
        throw new Error(`Missing application element: ${selector}`);
    }
    return element;
}
function gameMarkup(): string {
    return `<main class="game"><header class="hud"><div class="brand">CCA<span>MARKET MAYHEM</span></div><div><small>BANKED</small><strong id="banked">0</strong></div><div><small>BAG</small><strong id="bag">0/30</strong></div><button id="leave" aria-label="Leave practice">×</button></header><section class="stage"><div id="world" aria-label="Market playfield"></div></section><section class="message"><div id="status">LOADING MARKET…</div><p id="hint">Collect gold and carry it to a green bank.</p><progress id="deposit" max="1" value="0" aria-label="Banking progress"></progress></section><section class="controls" aria-label="Game controls"><div class="movement"><div id="joystick" role="application" aria-label="Movement joystick"><div id="puck"></div></div><small>MOVE <span>WASD</span></small></div><div class="actions"><div><button id="dash" aria-label="Dash">DASH</button><small>TAP<span> · SPACE</span></small></div><div><button id="bank" aria-label="Bank">BANK</button><small>HOLD<span> · E</span></small></div></div></section></main>`;
}
