import type { MarketControl } from '../../../packages/cca-game/market-rules.ts';

export class MarketInput {
    private readonly lifetime = new AbortController();
    private readonly keys = new Set<string>();
    private movement: { x: number; y: number; } = { x: 0, y: 0 };
    private joystickPointer: number | undefined;
    private bankPointer: number | undefined;
    private dash = 0;
    private readonly pad: HTMLElement;
    private readonly puck: HTMLElement;

    constructor(pad: HTMLElement, puck: HTMLElement, actions: { dash: HTMLButtonElement; bank: HTMLButtonElement; }) {
        this.pad = pad;
        this.puck = puck;
        const options = { signal: this.lifetime.signal };
        pad.addEventListener('pointerdown', (event) => this.startJoystick(event), options);
        pad.addEventListener('pointermove', (event) => this.moveJoystick(event), options);
        pad.addEventListener('pointerup', (event) => this.endJoystick(event), options);
        pad.addEventListener('lostpointercapture', (event) => this.endJoystick(event), options);
        actions.dash.addEventListener('pointerdown', (event) => {
            event.preventDefault();
            this.dash += 1;
        }, options);
        actions.dash.addEventListener('keydown', (event) => {
            if (event.code === 'Enter' && !event.repeat) {
                this.dash += 1;
            }
        }, options);
        actions.bank.addEventListener('pointerdown', (event) => {
            event.preventDefault();
            this.bankPointer = event.pointerId;
            actions.bank.setPointerCapture(event.pointerId);
        }, options);
        actions.bank.addEventListener('pointerup', () => {
            this.bankPointer = undefined;
        }, options);
        actions.bank.addEventListener('lostpointercapture', () => {
            this.bankPointer = undefined;
        }, options);
        window.addEventListener('keydown', (event) => this.pressKey(event), options);
        window.addEventListener('keyup', (event) => this.keys.delete(event.code), options);
        window.addEventListener('blur', () => this.clear(), options);
        window.addEventListener('resize', () => this.clear(), options);
        document.addEventListener('visibilitychange', () => this.clear(), options);
        window.addEventListener('pointercancel', () => this.clear(), options);
    }
    getControl(id: string): MarketControl {
        const x = Number(this.keys.has('KeyD') || this.keys.has('ArrowRight')) -
            Number(this.keys.has('KeyA') || this.keys.has('ArrowLeft'));
        const y = Number(this.keys.has('KeyS') || this.keys.has('ArrowDown')) -
            Number(this.keys.has('KeyW') || this.keys.has('ArrowUp'));
        return {
            id,
            x: x || this.movement.x,
            y: y || this.movement.y,
            bank: this.bankPointer !== undefined || this.keys.has('KeyE'),
            dash: this.dash
        };
    }
    clear(): void {
        this.keys.clear();
        this.movement = { x: 0, y: 0 };
        this.joystickPointer = undefined;
        this.bankPointer = undefined;
        this.puck.style.transform = 'translate(0px, 0px)';
    }
    stop(): void {
        this.clear();
        this.lifetime.abort();
    }
    private pressKey(event: KeyboardEvent): void {
        if (event.target instanceof HTMLInputElement) {
            return;
        }
        if (
            !['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight', 'Space', 'KeyE']
                .includes(event.code)
        ) {
            return;
        }
        event.preventDefault();
        if (event.code === 'Space' && !event.repeat) {
            this.dash += 1;
        }
        this.keys.add(event.code);
    }
    private startJoystick(event: PointerEvent): void {
        if (this.joystickPointer !== undefined) {
            return;
        }
        event.preventDefault();
        this.joystickPointer = event.pointerId;
        this.pad.setPointerCapture(event.pointerId);
        this.moveJoystick(event);
    }
    private moveJoystick(event: PointerEvent): void {
        if (this.joystickPointer !== event.pointerId) {
            return;
        }
        const bounds = this.pad.getBoundingClientRect();
        const x = event.clientX - bounds.left - bounds.width / 2;
        const y = event.clientY - bounds.top - bounds.height / 2;
        const radius = bounds.width * 0.3;
        const distance = Math.max(radius, Math.hypot(x, y));
        this.movement = { x: x / distance, y: y / distance };
        this.puck.style.transform = `translate(${this.movement.x * radius}px, ${this.movement.y * radius}px)`;
    }
    private endJoystick(event: PointerEvent): void {
        if (event.pointerId !== this.joystickPointer) {
            return;
        }
        this.joystickPointer = undefined;
        this.movement = { x: 0, y: 0 };
        this.puck.style.transform = 'translate(0px, 0px)';
    }
}
