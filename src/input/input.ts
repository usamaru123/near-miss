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
  /** Steering fingers by touch identifier (insertion order = oldest first). Fingers on buttons never get in here. */
  private readonly steer = new Map<number, number>();
  onAction: (a: Action) => void = () => {};

  constructor(root: HTMLElement) {
    window.addEventListener('keydown', (e) => this.keyDown(e));
    window.addEventListener('keyup', (e) => this.keyUp(e));
    // window 'blur' fires spuriously on iOS (long press, system gestures, toolbar); it must only release keys,
    // never pause, and must not drop fingers that are still down (touchend / touchcancel handle those)
    window.addEventListener('blur', () => this.releaseKeys());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.clear();
    });

    const ignore = (t: EventTarget | null): boolean => t instanceof Element && t.closest('.toggle, button, input, label') !== null;

    root.addEventListener(
      'touchstart',
      (e) => {
        if (ignore(e.target)) return;
        e.preventDefault();
        for (let i = 0; i < e.changedTouches.length; i++) {
          const t = e.changedTouches[i];
          this.steer.set(t.identifier, t.clientX);
        }
        this.onAction('tap');
        // second steering finger = OVERDRIVE (kept as a helper next to the button); a finger held on FOCUS does not count
        if (this.steer.size >= 2) this.onAction('overdrive');
        this.updateTouch();
      },
      { passive: false },
    );
    root.addEventListener(
      'touchmove',
      (e) => {
        if (ignore(e.target)) return;
        e.preventDefault();
        for (let i = 0; i < e.changedTouches.length; i++) {
          const t = e.changedTouches[i];
          if (this.steer.has(t.identifier)) this.steer.set(t.identifier, t.clientX);
        }
        this.updateTouch();
      },
      { passive: false },
    );
    const end = (e: TouchEvent): void => {
      for (let i = 0; i < e.changedTouches.length; i++) this.steer.delete(e.changedTouches[i].identifier);
      this.updateTouch();
    };
    root.addEventListener('touchend', end);
    root.addEventListener('touchcancel', end);
    root.addEventListener('mousedown', (e) => {
      if (ignore(e.target)) return;
      this.onAction('tap');
    });

    // iOS Safari ignores user-scalable=no: block pinch, double-tap zoom, long-press menu and text selection by hand
    const stop = (e: Event): void => e.preventDefault();
    for (const type of ['gesturestart', 'gesturechange', 'gestureend', 'dblclick']) {
      document.addEventListener(type, stop, { passive: false });
    }
    // long-press menu: only in touch mode (desktop keeps its right-click menu)
    document.addEventListener('contextmenu', (e) => {
      if (document.body.dataset.input === 'touch') e.preventDefault();
    });
    document.addEventListener('selectstart', (e) => {
      if (!(e.target instanceof Element && e.target.closest('input'))) e.preventDefault();
    });

    // OVERDRIVE: a tap on the button
    const od = document.getElementById('od-btn');
    if (od) {
      od.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.onAction('overdrive');
      });
    }

    // PAUSE: fires on click (finger lifted on the button), so a finger sliding in from the steering area cannot pause
    const pb = document.getElementById('pause-btn');
    if (pb) {
      pb.addEventListener('click', (e) => {
        e.stopPropagation();
        this.onAction('pause');
      });
      pb.addEventListener('pointerdown', (e) => e.stopPropagation());
    }

    // FOCUS: hold
    const fb = document.getElementById('focus-btn');
    if (fb) {
      const set = (v: boolean): void => {
        this.focusTouch = v;
        fb.classList.toggle('held', v);
        this.refresh();
      };
      fb.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        set(true);
      });
      const off = (e: Event): void => {
        e.stopPropagation();
        set(false);
      };
      fb.addEventListener('pointerup', off);
      fb.addEventListener('pointercancel', off);
      fb.addEventListener('pointerleave', off);
      fb.addEventListener('contextmenu', (e) => e.preventDefault());
    }
    for (const b of [od, pb, fb]) b?.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });
  }

  private updateTouch(): void {
    this.touchMove = 0;
    for (const x of this.steer.values()) {
      this.touchMove = x < window.innerWidth / 2 ? -1 : 1;
      break; // the oldest finger steers
    }
    this.refresh();
  }

  /** Forget every finger (pause / backgrounding): the matching touchend may never arrive. */
  releaseTouch(): void {
    this.focusTouch = false;
    this.steer.clear();
    this.touchMove = 0;
    document.getElementById('focus-btn')?.classList.remove('held');
    this.refresh();
  }

  private releaseKeys(): void {
    this.left = this.right = this.focusKey = false;
    this.refresh();
  }

  private clear(): void {
    this.left = this.right = this.focusKey = this.focusTouch = false;
    this.steer.clear();
    this.touchMove = 0;
    document.getElementById('focus-btn')?.classList.remove('held');
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
