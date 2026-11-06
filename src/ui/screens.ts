import { shouldShowA2hsHint } from './platform';

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
  /** how the run compares to the previous best (null on the very first run) */
  vs?: { beat: boolean; delta: number; pct: number } | null;
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
    // iOS Safari tab only (not standalone): tell the player how to get a full-screen game
    if (shouldShowA2hsHint()) el('a2hs').classList.remove('hidden');
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
    const vs = el('go-vs');
    const bar = el('go-bar');
    if (s.vs) {
      vs.classList.toggle('beat', s.vs.beat);
      vs.textContent = s.vs.beat ? 'ベスト +' + s.vs.delta.toLocaleString('en-US') + ' 点' : 'ベストまで あと ' + s.vs.delta.toLocaleString('en-US') + ' 点';
      bar.classList.toggle('hidden', s.vs.beat);
      const pct = Math.round(s.vs.pct * 100);
      el('go-bar-fill').style.width = '0%';
      el('go-pct').textContent = 'ベストの ' + pct + '% まで到達';
      window.setTimeout(() => {
        el('go-bar-fill').style.width = pct + '%';
      }, 60);
    } else {
      vs.textContent = '';
      bar.classList.add('hidden');
    }
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

