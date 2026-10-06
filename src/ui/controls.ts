/**
 * The control scheme, in one place.
 *
 * It is shown on the loading screen and again from the pause menu, and it was
 * previously typed out as static markup in index.html — so a second copy for
 * the pause panel would have been a second thing to forget when a key changes.
 * Both render from this.
 */
export const CONTROLS: { keys: string[]; action: string }[] = [
  { keys: ['W', 'S'], action: 'drive / reverse' },
  { keys: ['A', 'D'], action: 'steer' },
  { keys: ['SHIFT'], action: 'turbo boost' },
  { keys: ['SPACE'], action: 'handbrake / drift' },
  { keys: ['CLICK', 'F'], action: 'machine gun' },
  { keys: ['RCLICK', 'E'], action: 'special weapon' },
  { keys: ['G'], action: 'homing missile' },
  { keys: ['Q'], action: 'drop mine' },
  { keys: ['C'], action: 'nuke (rare pickup)' },
  { keys: ['R'], action: 'flip car upright' },
  { keys: ['ESC'], action: 'pause' },
  { keys: ['M'], action: 'mute' },
];

export function renderControls(el: HTMLElement) {
  el.innerHTML = CONTROLS.map(
    (c) => `<div class="lc-row"><span class="keys">${c.keys.map((k) => `<kbd>${k}</kbd>`).join('')
      }</span><span>${c.action}</span></div>`,
  ).join('');
}
