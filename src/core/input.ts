export class Input {
  private keys = new Set<string>();
  private mouseButtons = new Set<number>();
  flipRequested = false;
  muteToggled = false;
  pauseToggled = false;
  /** edge-triggered: true for exactly one consume after each press */
  specialPressed = false;

  constructor() {
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      if (e.code === 'KeyR') this.flipRequested = true;
      if (e.code === 'KeyM') this.muteToggled = true;
      if (e.code === 'Escape') this.pauseToggled = true;
      if (e.code === 'KeyE') this.specialPressed = true;
      if (['Space', 'ArrowUp', 'ArrowDown'].includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('mousedown', (e) => {
      this.mouseButtons.add(e.button);
      if (e.button === 2) this.specialPressed = true;
    });
    window.addEventListener('mouseup', (e) => this.mouseButtons.delete(e.button));
    window.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.mouseButtons.clear();
    });
  }

  private down(...codes: string[]) {
    return codes.some((c) => this.keys.has(c));
  }

  get throttle(): number {
    let t = 0;
    if (this.down('KeyW', 'ArrowUp')) t += 1;
    if (this.down('KeyS', 'ArrowDown')) t -= 1;
    return t;
  }

  /** positive = turn left */
  get steer(): number {
    let s = 0;
    if (this.down('KeyA', 'ArrowLeft')) s += 1;
    if (this.down('KeyD', 'ArrowRight')) s -= 1;
    return s;
  }

  get handbrake() { return this.down('Space'); }
  get turbo() { return this.down('ShiftLeft', 'ShiftRight'); }
  get fireMG() { return this.mouseButtons.has(0) || this.down('KeyF'); }
  get fireMissile() { return this.down('KeyG'); }
  get dropMine() { return this.down('KeyQ', 'KeyX'); }
  /** one-shot per press — holding the button must NOT re-trigger (a held
   *  special would e.g. instantly detonate a just-launched remote bomb) */
  consumeSpecial() { const s = this.specialPressed; this.specialPressed = false; return s; }

  consumeFlip() { const f = this.flipRequested; this.flipRequested = false; return f; }
  consumeMute() { const m = this.muteToggled; this.muteToggled = false; return m; }
  consumePause() { const p = this.pauseToggled; this.pauseToggled = false; return p; }
}
