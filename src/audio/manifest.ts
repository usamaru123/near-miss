/**
 * Sample manifest. Every sample is peak-normalised to 0 dBFS at load time, so `db` is a relative mix trim.
 * Sources are listed in public/audio/CREDITS.md. Any entry may fail to load: every use has a synth fallback.
 */
export interface SampleDef {
  file: string;
  /** Relative trim in dB (after peak normalisation). */
  db?: number;
}

export const SAMPLES = {
  kickHeavy: { file: 'kick_heavy.wav', db: -3 },
  kickClub: { file: 'kick_club.wav', db: -4 },
  subBoom: { file: 'sub_boom.wav', db: -2 },
  subDrop: { file: 'sub_drop.wav', db: -2 },
  snare: { file: 'snare.wav', db: -6 },
  snareRoll: { file: 'snare_roll.wav', db: -8 },
  clap: { file: 'clap.wav', db: -8 },
  clapBig: { file: 'clap_big.wav', db: -8 },
  hatClosed: { file: 'hat_closed.wav', db: -14 },
  hatOpen: { file: 'hat_open.wav', db: -14 },
  hat16: { file: 'hat_16.wav', db: -16 },
  crash: { file: 'crash.wav', db: -8 },
  crashBig: { file: 'crash_big.wav', db: -6 },
  smashMetal: { file: 'smash_metal.wav', db: -3 },
  smashMetal2: { file: 'smash_metal2.wav', db: -3 },
  smashImpact: { file: 'smash_impact.wav', db: -3 },
  debris: { file: 'debris.wav', db: -6 },
  stomp: { file: 'stomp.wav', db: -4 },
  debrisPing: { file: 'debris_ping.wav', db: -6 },
  glass: { file: 'glass.wav', db: -3 },
  glassChime: { file: 'glass_chime.wav', db: -8 },
  whoosh: { file: 'whoosh.wav', db: -4 },
  whoosh2: { file: 'whoosh2.wav', db: -4 },
  fxSweep: { file: 'fx_sweep.wav', db: -8 },
  fxRumble: { file: 'fx_rumble.wav', db: -6 },
  fxJet: { file: 'fx_jet.wav', db: -8 },
  fxWarp: { file: 'fx_warp.wav', db: -6 },
  fxZap: { file: 'fx_zap.wav', db: -8 },
  fxPling: { file: 'fx_pling.wav', db: -12 },
  coin: { file: 'coin.wav', db: -8 },
  uiBeep: { file: 'ui_beep.wav', db: -12 },
  uiTick: { file: 'ui_tick.wav', db: -14 },
  uiBlip: { file: 'ui_blip.wav', db: -8 },
} as const satisfies Record<string, SampleDef>;

export type SampleId = keyof typeof SAMPLES;
export const SAMPLE_IDS = Object.keys(SAMPLES) as SampleId[];
