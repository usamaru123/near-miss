export type ScreenName = 'title' | 'pause' | 'gameover' | 'none';

function el<T extends HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (!e) throw new Error('missing #' + id);
  return e as T;
}

export interface GameOverStats {
  score: number;
  best: number;
  newRecord: boolean;
  maxCombo: number;
  topSpeedKmh: number;
  tier: number;
}

/** Title / pause / game-over overlays. */
export class Screens {
  private readonly title = el('title');
  private readonly pause = el('pause');
  private readonly gameover = el('gameover');
  private readonly bestTitle = el('best-title');
  private readonly reduce = el<HTMLInputElement>('reduce-flash');
  private readonly muteInd = el('mute-ind');
  private muteTimer = 0;
  private readonly loader = el('loader');
  private readonly loadFill = el('load-fill');
  private readonly loadText = el('load-text');
  private readonly press = el('press');
  private readonly sliders = {
    master: el<HTMLInputElement>('vol-master'),
    bgm: el<HTMLInputElement>('vol-bgm'),
    se: el<HTMLInputElement>('vol-se'),
  };
  onReducedFlashChange: (v: boolean) => void = () => {};
  onVolume: (kind: 'master' | 'bgm' | 'se', v: number) => void = () => {};

  constructor() {
    this.reduce.addEventListener('change', () => this.onReducedFlashChange(this.reduce.checked));
    for (const k of ['master', 'bgm', 'se'] as const) {
      const input = this.sliders[k];
      input.addEventListener('input', () => this.onVolume(k, Number(input.value) / 100));
      // don't keep keyboard focus: arrow keys must steer the ship, not the slider
      input.addEventListener('change', () => input.blur());
    }
  }

  show(name: ScreenName): void {
    this.title.classList.toggle('hidden', name !== 'title');
    this.pause.classList.toggle('hidden', name !== 'pause');
    this.gameover.classList.toggle('hidden', name !== 'gameover');
  }

  setBest(best: number): void {
    this.bestTitle.textContent = 'BEST ' + best;
  }

  setReducedFlash(v: boolean): void {
    this.reduce.checked = v;
  }

  showGameOver(s: GameOverStats): void {
    el('go-score').textContent = String(s.score);
    el('go-best').textContent = String(s.best);
    el('go-combo').textContent = String(s.maxCombo);
    el('go-speed').textContent = s.topSpeedKmh + ' km/h';
    el('go-tier').textContent = String(s.tier);
    el('new-record').classList.toggle('hidden', !s.newRecord);
    this.show('gameover');
  }

  /** Audio decode progress on the title. */
  setLoading(done: number, total: number): void {
    const pct = total > 0 ? Math.round((done / total) * 100) : 100;
    this.loadFill.style.width = pct + '%';
    this.loadText.textContent = 'LOADING AUDIO ' + pct + '%';
  }

  /** Everything decoded: show the START prompt. */
  setReady(): void {
    this.loader.classList.add('hidden');
    this.press.classList.remove('hidden');
  }

  setVolumes(v: { master: number; bgm: number; se: number }): void {
    this.sliders.master.value = String(Math.round(v.master * 100));
    this.sliders.bgm.value = String(Math.round(v.bgm * 100));
    this.sliders.se.value = String(Math.round(v.se * 100));
  }

  flashMute(muted: boolean): void {
    this.muteInd.textContent = muted ? 'MUTED' : 'SOUND ON';
    this.muteInd.classList.remove('hidden');
    window.clearTimeout(this.muteTimer);
    this.muteTimer = window.setTimeout(() => this.muteInd.classList.add('hidden'), 1200);
  }
}

