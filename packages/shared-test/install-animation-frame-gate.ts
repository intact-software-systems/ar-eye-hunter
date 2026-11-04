export function installAnimationFrameGate(): void {
    const request = window.requestAnimationFrame.bind(window);
    const cancel = window.cancelAnimationFrame.bind(window);
    const pending = new Map<number, FrameRequestCallback>();
    const native = new Map<number, number>();
    let paused = false;
    let sequence = 0;
    const schedule = (id: number, callback: FrameRequestCallback): void => {
        native.set(
            id,
            request((timestamp) => {
                native.delete(id);
                if (paused) {
                    pending.set(id, callback);
                }
                else {
                    callback(timestamp);
                }
            })
        );
    };
    window.requestAnimationFrame = (callback) => {
        const id = ++sequence;
        schedule(id, callback);
        return id;
    };
    window.cancelAnimationFrame = (id) => {
        pending.delete(id);
        const handle = native.get(id);
        if (handle !== undefined) {
            cancel(handle);
            native.delete(id);
        }
    };
    window.addEventListener('test-pause-animation-frames', () => {
        paused = true;
    });
    window.addEventListener('test-resume-animation-frames', () => {
        paused = false;
        for (const [id, callback] of pending) {
            schedule(id, callback);
        }
        pending.clear();
    });
}
