import type { PracticeInput } from './practice-rules.ts';

export class PracticeControls {
    private readonly lifetime = new AbortController();
    private readonly keys = new Set<string>();
    private readonly pad: HTMLElement;
    private readonly puck: HTMLElement;
    private readonly contacts = new Map<number, { x: number; y: number; }>();
    private pointer: number | undefined;
    private movement = { x: 0, z: 0 };
    private dash = 0;
    private zoom = 10;
    private pinchDistance = 0;
    private pinchZoom = 10;

    constructor(root: HTMLElement, canvas: HTMLCanvasElement) {
        this.pad = requirePracticeElement(root, '#joystick');
        this.puck = requirePracticeElement(root, '#puck');
        const options = { signal: this.lifetime.signal };
        this.pad.addEventListener('pointerdown', (event) => this.beginMovement(event), options);
        this.pad.addEventListener('pointermove', (event) => this.movePointer(event), options);
        this.pad.addEventListener('pointerup', (event) => this.endMovement(event), options);
        this.pad.addEventListener('lostpointercapture', (event) => this.endMovement(event), options);
        const dash = requirePracticeElement(root, '#dash');
        dash.addEventListener('pointerdown', (event) => {
            event.preventDefault();
            this.dash += 1;
        }, options);
        dash.addEventListener('click', (event) => {
            if (event.detail === 0) {
                this.dash += 1;
            }
        }, options);
        requirePracticeElement(root, '#zoom-in').addEventListener('click', () => this.changeZoom(-2), options);
        requirePracticeElement(root, '#zoom-out').addEventListener('click', () => this.changeZoom(2), options);
        window.addEventListener('keydown', (event) => this.pressKey(event), options);
        window.addEventListener('keyup', (event) => this.keys.delete(event.code), options);
        window.addEventListener('blur', () => this.clear(), options);
        window.addEventListener('resize', () => this.clear(), options);
        document.addEventListener('visibilitychange', () => this.clear(), options);
        window.addEventListener('pointercancel', () => this.clear(), options);
        this.bindZoom(canvas);
    }

    getInput(): PracticeInput {
        const keyboardX = Number(this.keys.has('KeyD') || this.keys.has('ArrowRight')) -
            Number(this.keys.has('KeyA') || this.keys.has('ArrowLeft'));
        const keyboardZ = Number(this.keys.has('KeyW') || this.keys.has('ArrowUp')) -
            Number(this.keys.has('KeyS') || this.keys.has('ArrowDown'));
        return { x: keyboardX || this.movement.x, z: keyboardZ || this.movement.z, dash: this.dash };
    }

    getZoom(): number {
        return this.zoom;
    }

    clear(): void {
        this.keys.clear();
        this.movement = { x: 0, z: 0 };
        if (this.pointer !== undefined && this.pad.hasPointerCapture(this.pointer)) {
            this.pad.releasePointerCapture(this.pointer);
        }
        this.pointer = undefined;
        this.contacts.clear();
        this.pinchDistance = 0;
        this.puck.style.transform = '';
    }

    stop(): void {
        this.clear();
        this.lifetime.abort();
    }

    private changeZoom(delta: number): void {
        this.zoom = Math.max(7, Math.min(16, this.zoom + delta));
    }

    private pressKey(event: KeyboardEvent): void {
        if (
            event.code === 'Space' && event.target instanceof HTMLElement &&
            event.target.closest('button, a, input, textarea, select, [contenteditable="true"]')
        ) {
            return;
        }
        if (event.code === 'Space') {
            event.preventDefault();
            if (!event.repeat) {
                this.dash += 1;
            }
        }
        if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight'].includes(event.code)) {
            event.preventDefault();
            this.keys.add(event.code);
        }
        if (event.key === '+' || event.key === '=') {
            this.changeZoom(-1);
        }
        if (event.key === '-') {
            this.changeZoom(1);
        }
    }

    private beginMovement(event: PointerEvent): void {
        if (this.pointer !== undefined) {
            return;
        }
        event.preventDefault();
        this.pointer = event.pointerId;
        this.pad.setPointerCapture(event.pointerId);
        this.movePointer(event);
    }

    private movePointer(event: PointerEvent): void {
        if (event.pointerId !== this.pointer) {
            return;
        }
        const bounds = this.pad.getBoundingClientRect();
        const x = event.clientX - bounds.left - bounds.width / 2;
        const y = event.clientY - bounds.top - bounds.height / 2;
        const radius = bounds.width * 0.3;
        const distance = Math.max(radius, Math.hypot(x, y));
        this.movement = { x: x / distance, z: -y / distance };
        this.puck.style.transform = `translate(${this.movement.x * radius}px, ${-this.movement.z * radius}px)`;
    }

    private endMovement(event: PointerEvent): void {
        if (event.pointerId !== this.pointer) {
            return;
        }
        this.pointer = undefined;
        this.movement = { x: 0, z: 0 };
        this.puck.style.transform = '';
    }

    private bindZoom(canvas: HTMLCanvasElement): void {
        const options = { signal: this.lifetime.signal };
        canvas.addEventListener('wheel', (event) => {
            event.preventDefault();
            this.changeZoom(Math.sign(event.deltaY));
        }, { ...options, passive: false });
        canvas.addEventListener('pointerdown', (event) => {
            this.contacts.set(event.pointerId, { x: event.clientX, y: event.clientY });
            canvas.setPointerCapture(event.pointerId);
            this.pinchDistance = this.computePinchDistance();
            this.pinchZoom = this.zoom;
        }, options);
        canvas.addEventListener('pointermove', (event) => {
            if (!this.contacts.has(event.pointerId)) {
                return;
            }
            this.contacts.set(event.pointerId, { x: event.clientX, y: event.clientY });
            const distance = this.computePinchDistance();
            if (distance > 20 && this.pinchDistance > 20) {
                this.zoom = Math.max(7, Math.min(16, this.pinchZoom * this.pinchDistance / distance));
            }
        }, options);
        canvas.addEventListener('pointerup', (event) => this.contacts.delete(event.pointerId), options);
        canvas.addEventListener('lostpointercapture', (event) => this.contacts.delete(event.pointerId), options);
    }

    private computePinchDistance(): number {
        const [first, second] = [...this.contacts.values()];
        return first && second ? Math.hypot(first.x - second.x, first.y - second.y) : 0;
    }
}

export function requirePracticeElement<T extends HTMLElement = HTMLElement>(root: HTMLElement, selector: string): T {
    const element = root.querySelector<T>(selector);
    if (!element) {
        throw new Error(`Missing practice element: ${selector}`);
    }
    return element;
}
