export type InputMode = 'touch' | 'kbd';

/**
 * Tracks which kind of input was used last (DESIGN 17.3) and mirrors it to `body[data-input]`,
 * which the CSS uses to swap wording and show the touch buttons. The initial value comes from
 * `(pointer: coarse)`. Mouse and keyboard both count as 'kbd'; any touch switches to 'touch'.
 */
export class InputModeTracker {
  mode: InputMode;
  onChange: (m: InputMode) => void = () => {};

  constructor() {
    let coarse = false;
    try {
      coarse = window.matchMedia('(pointer: coarse)').matches;
    } catch {
      /* matchMedia unavailable */
    }
    this.mode = coarse ? 'touch' : 'kbd';
    this.apply();
    const opts = { capture: true, passive: true } as const;
    window.addEventListener('touchstart', () => this.set('touch'), opts);
    window.addEventListener('keydown', () => this.set('kbd'), opts);
    // pointer events only: iOS fires emulated mouse events after a touch, but their pointerType is 'touch'
    window.addEventListener('pointerdown', (e) => this.set(e.pointerType === 'touch' ? 'touch' : 'kbd'), opts);
  }

  private set(m: InputMode): void {
    if (m === this.mode) return;
    this.mode = m;
    this.apply();
    this.onChange(m);
  }

  private apply(): void {
    document.body.dataset.input = this.mode;
  }
}
