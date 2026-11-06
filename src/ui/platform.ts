/** Small platform probes for the mobile layer (DESIGN 17.4 / 17.5). All of them are safe to call anywhere. */

export function isIos(): boolean {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua)) return true;
  // iPadOS 13+ reports itself as a Mac
  return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
}

export function isAndroid(): boolean {
  return /Android/i.test(navigator.userAgent);
}

/** Launched from the home screen / installed PWA (no browser UI). */
export function isStandalone(): boolean {
  try {
    if ((navigator as Navigator & { standalone?: boolean }).standalone === true) return true;
    return window.matchMedia('(display-mode: standalone)').matches || window.matchMedia('(display-mode: fullscreen)').matches;
  } catch {
    return false;
  }
}

/** iOS Safari browser tab: the "Add to Home Screen" hint belongs here (not in standalone). */
export function shouldShowA2hsHint(): boolean {
  return isIos() && !isStandalone();
}

/** Vibrate where supported (iOS has no navigator.vibrate). Never throws, never logs. */
export function haptic(ms: number): void {
  try {
    const nav = navigator as Navigator & { userActivation?: { hasBeenActive: boolean } };
    if (typeof nav.vibrate !== 'function') return;
    // Chrome prints an "intervention" message when vibrate() runs before any tap
    if (nav.userActivation && !nav.userActivation.hasBeenActive) return;
    nav.vibrate(ms);
  } catch {
    /* ignore */
  }
}

/** Ask the OS to keep playing through the iOS silent switch (Safari 17+; elsewhere a no-op). */
export function setAudioSessionPlayback(): void {
  try {
    const s = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
    if (s) s.type = 'playback';
  } catch {
    /* unsupported */
  }
}

/** Android: go fullscreen from a user gesture. Failure (denied / unsupported) is ignored. */
export function tryFullscreen(el: HTMLElement): void {
  try {
    if (!document.fullscreenEnabled || document.fullscreenElement) return;
    void el.requestFullscreen({ navigationUI: 'hide' }).catch(() => undefined);
  } catch {
    /* ignore */
  }
}
