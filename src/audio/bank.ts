import { SAMPLES } from './manifest';
import type { SampleId } from './manifest';
import { SampleBank } from './samples';

/** Fetch + decode with a throw-away OfflineAudioContext (no live node, so no autoplay warning, no Tone). */
let decodeCtx: OfflineAudioContext | null = null;
export async function decodeUrl(url: string): Promise<AudioBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
  const data = await res.arrayBuffer();
  decodeCtx ??= new OfflineAudioContext(2, 1, 44100);
  return decodeCtx.decodeAudioData(data);
}

export function assetBase(): string {
  const b = (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? './';
  return (b.endsWith('/') ? b : b + '/') + 'audio/';
}

export type Bank = SampleBank<AudioBuffer, SampleId>;

export function createBank(): Bank {
  return new SampleBank<AudioBuffer, SampleId>(SAMPLES, decodeUrl, assetBase());
}
