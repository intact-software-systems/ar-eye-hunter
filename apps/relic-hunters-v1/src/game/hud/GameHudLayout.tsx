import type { ReactNode } from 'react';

export type GameHudLayoutProps = Readonly<{
    scene: ReactNode;
    top: ReactNode;
    side: ReactNode;
    bottom: ReactNode;
    floating?: ReactNode;
    overlays?: ReactNode;
}>;

export function GameHudLayout({
                                  scene,
                                  top,
                                  side,
                                  bottom,
                                  floating,
                                  overlays,
                              }: GameHudLayoutProps) {
    return (
        <main className="app-root">
            <div className="scene-layer">
                {scene}
            </div>
            <div className="hud-layout" aria-label="Game status and controls">
                <div className="hud-region hud-region-top">
                    {top}
                </div>
                <div className="hud-region hud-region-side">
                    {side}
                </div>
                <div className="hud-region hud-region-bottom">
                    {bottom}
                </div>
            </div>
            {floating && (
                <div className="hud-floating-layer">
                    {floating}
                </div>
            )}
            {overlays && (
                <div className="hud-overlay-layer">
                    {overlays}
                </div>
            )}
        </main>
    );
}
