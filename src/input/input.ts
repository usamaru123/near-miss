export type Action = 'space' | 'retry' | 'pause' | 'mute' | 'tap' | 'overdrive' | 'flash';

/** Keyboard + touch input. Continuous state is polled; discrete actions go through a callback. */
export class InputManager {
  move = 0;
  focus = false;
  private left = false;
  private right = false;
  private focusKey = false;
  private focusTouch = false;
  private touchMove = 0;
  onAction: (a: Action) => void = () => {};

  constructor(root: HTMLElement) {
    window.addEventListener('keydown', (e) => this.keyDown(e));
    window.addEventListener('keyup', (e) => this.keyUp(e));
    window.addEventListener('blur', () => this.clear());

    const ignore = (t: EventTarget | null): boolean =>
      t instanceof Element && t.closest('.toggle, #focus-btn, button, input, label') !== null;

    root.addEventListener(
      'touchstart',
      (e) => {
        if (ignore(e.target)) return;
        e.preventDefault();
        this.onAction('tap');
        if (e.touches.length >= 2) this.onAction('overdrive');
        this.updateTouch(e);
      },
      { passive: false },
    );
    root.addEventListener(
      'touchmove',
      (e) => {
        if (ignore(e.target)) return;
        e.preventDefault();
        this.updateTouch(e);
      },
      { passive: false },
    );
    const end = (e: TouchEvent): void => {
      this.updateTouch(e);
    };
    root.addEventListener('touchend', end);
    root.addEventListener('touchcancel', end);
    root.addEventListener('mousedown', (e) => {
      if (ignore(e.target)) return;
      this.onAction('tap');
    });

    const fb = document.getElementById('focus-btn');
    if (fb) {
      const on = (e: Event): void => {
        e.preventDefault();
        e.stopPropagation();
        this.focusTouch = true;
        this.refresh();
      };
      const off = (e: Event): void => {
        e.stopPropagation();
        this.focusTouch = false;
        this.refresh();
      };
      fb.addEventListener('pointerdown', on);
      fb.addEventListener('pointerup', off);
      fb.addEventListener('pointercancel', off);
      fb.addEventListener('pointerleave', off);
      fb.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });
    }
  }

  private updateTouch(e: TouchEvent): void {
    const t = e.touches;
    if (t.length === 0) this.touchMove = 0;
    else {
      const x = t[0].clientX;
      this.touchMove = x < window.innerWidth / 2 ? -1 : 1;
    }
    this.refresh();
  }

  private clear(): void {
    this.left = this.right = this.focusKey = this.focusTouch = false;
    this.touchMove = 0;
    this.refresh();
  }

  private refresh(): void {
    const k = (this.right ? 1 : 0) - (this.left ? 1 : 0);
    this.move = k !== 0 ? k : this.touchMove;
    this.focus = this.focusKey || this.focusTouch;
  }

  private keyDown(e: KeyboardEvent): void {
    switch (e.code) {
      case 'ArrowLeft':
      case 'KeyA':
        this.left = true;
        break;
      case 'ArrowRight':
      case 'KeyD':
        this.right = true;
        break;
      case 'ShiftLeft':
      case 'ShiftRight':
        this.focusKey = true;
        break;
      case 'Space':
        if (!e.repeat) this.onAction('space');
        break;
      case 'Enter':
        if (!e.repeat) this.onAction('tap');
        break;
      case 'KeyR':
        if (!e.repeat) this.onAction('retry');
        break;
      case 'Escape':
      case 'KeyP':
        if (!e.repeat) this.onAction('pause');
        break;
      case 'KeyM':
        if (!e.repeat) this.onAction('mute');
        break;
      case 'KeyF':
        if (!e.repeat) this.onAction('flash');
        break;
      default:
        return;
    }
    if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
    this.refresh();
  }

  private keyUp(e: KeyboardEvent): void {
    switch (e.code) {
      case 'ArrowLeft':
      case 'KeyA':
        this.left = false;
        break;
      case 'ArrowRight':
      case 'KeyD':
        this.right = false;
        break;
      case 'ShiftLeft':
      case 'ShiftRight':
        this.focusKey = false;
        break;
      default:
        return;
    }
    this.refresh();
  }
}
