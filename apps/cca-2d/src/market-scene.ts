import Phaser from 'phaser';
import { MARKET_BANKS, MARKET_OBSTACLES, type MarketState } from '../../../packages/cca-game/market-rules.ts';
import type { MarketInput } from './market-input.ts';
import type { MarketSession } from './market-session.ts';

export interface MarketSceneView {
    render(state: MarketState, session: MarketSession): void;
}

export class MarketScene extends Phaser.Scene {
    private readonly session: MarketSession;
    private readonly controls: MarketInput;
    private readonly view: MarketSceneView;
    private readonly runners = new Map<string, Phaser.GameObjects.Image>();
    private readonly coins = new Map<number, Phaser.GameObjects.Arc>();
    private marker: Phaser.GameObjects.Arc | undefined;
    constructor(session: MarketSession, controls: MarketInput, view: MarketSceneView) {
        super('market');
        this.session = session;
        this.controls = controls;
        this.view = view;
    }
    preload(): void {
        this.load.image('runner', '/art/runner.webp');
        this.load.image('stall', '/art/stall.webp');
        this.load.image('bank', '/art/bank.webp');
        this.load.image('ground', '/art/ground.webp');
    }
    create(): void {
        this.add.tileSprite(192, 192, 384, 384, 'ground').setTileScale(0.08);
        for (const bank of MARKET_BANKS) {
            this.add.circle(bank.x, bank.y, 29, 0x65baa1, 0.4).setStrokeStyle(2, 0xd5f5be);
            this.add.image(bank.x, bank.y - 10, 'bank').setDisplaySize(54, 54);
            this.add.text(bank.x, bank.y + 24, 'BANK', {
                fontFamily: 'monospace',
                fontSize: '9px',
                color: '#183747',
                backgroundColor: '#d3efc4'
            }).setOrigin(0.5);
        }
        for (const stall of MARKET_OBSTACLES) {
            this.add.rectangle(
                stall.x + stall.width / 2,
                stall.y + stall.height / 2 + 5,
                stall.width,
                stall.height,
                0x7d5249,
                0.3
            );
            this.add.image(stall.x + stall.width / 2, stall.y + stall.height / 2 - 5, 'stall').setDisplaySize(
                stall.width + 14,
                stall.height + 28
            );
        }
        for (const coin of this.session.getState().coins) {
            this.coins.set(coin.id, this.add.circle(coin.x, coin.y, 4, 0xffd65e).setStrokeStyle(1.5, 0x91582b));
        }
        this.marker = this.add.circle(0, 0, 13, 0xaff6d0, 0.2).setStrokeStyle(1.5, 0xd2ffe1).setDepth(1);
    }
    update(_time: number, milliseconds: number): void {
        this.session.advance(milliseconds / 1000, this.controls.getControl(this.session.playerId));
        const state = this.session.getState();
        this.drawRunners(state);
        for (const coin of state.coins) {
            this.coins.get(coin.id)?.setVisible(coin.availableAt <= state.elapsed);
        }
        this.view.render(state, this.session);
    }
    private drawRunners(state: MarketState): void {
        for (const [id, image] of this.runners) {
            if (!state.players.some((player) => player.id === id)) {
                image.destroy();
                this.runners.delete(id);
            }
        }
        for (const runner of state.players) {
            let image = this.runners.get(runner.id);
            if (!image) {
                image = this.add.image(runner.x, runner.y, 'runner').setDisplaySize(40, 40).setDepth(2);
                if (runner.colour > 0) {
                    image.setTint(0xd1b5ff);
                }
                this.runners.set(runner.id, image);
            }
            image.setPosition(runner.x, runner.y - 7);
            image.setFlipX(runner.facingX < 0);
            image.setAlpha(runner.dashRemaining > 0 ? 0.7 : 1);
            if (runner.id === this.session.playerId) {
                this.marker?.setPosition(runner.x, runner.y + 4);
            }
        }
    }
}
