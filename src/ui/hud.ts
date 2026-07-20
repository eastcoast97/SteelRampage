import type { Vehicle } from '../game/vehicle';
import type { Game } from '../game/game';
import { MODES } from '../game/game';

const $ = (id: string) => document.getElementById(id)!;
const THREE_clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

export class Hud {
  private healthBar = $('health-bar');
  private turboBar = $('turbo-bar');
  private specialBar = $('special-bar');
  private specialLabel = $('special-label');
  private missileCount = $('missile-count');
  private mineCount = $('mine-count');
  private scoreboard = $('scoreboard');
  private killfeed = $('killfeed');
  private lockIndicator = $('lock-indicator');
  private lockRing = $('lock-ring');
  private hitmarker = $('hitmarker');
  private vignette = $('vignette');
  private respawnOverlay = $('respawn-overlay');
  private respawnTimer = $('respawn-timer');
  private timer = $('timer');
  private statusChips = $('status-chips');
  private radar = $('radar') as HTMLCanvasElement;
  private radarCtx = this.radar.getContext('2d')!;

  private hitmarkerTimer = 0;
  private vignetteLevel = 0;
  private lastMissiles = -1;
  private lastMines = -1;
  private radarMap: HTMLCanvasElement | null = null;
  private shieldRow = $('shield-row');
  private panic = $('panic');
  private popups = $('dmg-popups');
  private healthSegs: HTMLElement[] = [];
  private shieldSegs: HTMLElement[] = [];

  constructor() {
    // segmented bars: 10 armor blocks (10 HP each), 10 shield blocks (1s each)
    this.healthSegs = this.buildSegs(this.healthBar, 10);
    this.shieldSegs = this.buildSegs($('shield-bar'), 10);
  }

  private buildSegs(container: HTMLElement, n: number): HTMLElement[] {
    const fills: HTMLElement[] = [];
    for (let i = 0; i < n; i++) {
      const seg = document.createElement('div');
      seg.className = 'seg';
      const fill = document.createElement('div');
      fill.className = 'fill';
      seg.appendChild(fill);
      container.appendChild(seg);
      fills.push(fill);
    }
    return fills;
  }

  private fillSegs(fills: HTMLElement[], ratio: number) {
    const n = fills.length;
    for (let i = 0; i < n; i++) {
      const segFill = THREE_clamp(ratio * n - i, 0, 1);
      fills[i].style.width = `${segFill * 100}%`;
    }
  }

  show() { $('hud').classList.remove('hidden'); }
  hide() { $('hud').classList.add('hidden'); }

  update(dt: number, player: Vehicle, vehicles: Vehicle[], game: Game) {
    const hpRatio = player.health / player.spec.maxHealth;
    this.fillSegs(this.healthSegs, hpRatio);
    // panic state below 30%: bar flashes + screen-edge red pulse
    const panicking = hpRatio < 0.3 && player.alive;
    this.healthBar.classList.toggle('critical', panicking);
    this.panic.classList.toggle('on', panicking);
    // shield bar exists only while shielded (10s timer, one block per second);
    // final 2 seconds blink the whole row as the expiry warning
    this.shieldRow.classList.toggle('hidden', player.shieldTime <= 0 || !player.alive);
    if (player.shieldTime > 0) {
      this.fillSegs(this.shieldSegs, player.shieldTime / 10);
      this.shieldRow.classList.toggle('expiring', player.shieldTime < 2);
    }
    this.turboBar.style.width = `${(player.turboMeter / player.spec.turboMax) * 100}%`;

    // special weapon bar
    const active = player.specialActiveTime > 0;
    const ready = player.specialEnergy >= 1 && !active;
    this.specialBar.style.width = `${(active ? 1 : player.specialEnergy) * 100}%`;
    this.specialBar.classList.toggle('active', active);
    if (player.spec.specialId === 'bomb' && player.bombOut) {
      this.specialLabel.textContent = `${player.spec.specialName} — PRESS AGAIN TO DETONATE`;
      this.specialLabel.className = 'bar-label special ready';
    } else {
      this.specialLabel.textContent = player.spec.specialName + (ready ? ' — READY' : '');
      this.specialLabel.className = 'bar-label special' + (ready ? ' ready' : '');
    }

    // capacity shown inline — no center-screen announcements needed
    this.missileCount.textContent = `🚀 ${player.missiles}/3`;
    this.mineCount.textContent = `💣 ${player.minesAmmo}/6`;
    this.missileCount.style.opacity = player.missiles > 0 ? '1' : '0.35';
    this.mineCount.style.opacity = player.minesAmmo > 0 ? '1' : '0.35';
    // acquire punch on counter increase
    if (player.missiles > this.lastMissiles && this.lastMissiles >= 0) this.pulse(this.missileCount, 'punch');
    if (player.minesAmmo > this.lastMines && this.lastMines >= 0) this.pulse(this.mineCount, 'punch');
    this.lastMissiles = player.missiles;
    this.lastMines = player.minesAmmo;

    // status chips
    const chips: string[] = [];
    if (player.shieldTime > 0) chips.push(`<span class="chip shield">SHIELD ${player.shieldTime.toFixed(0)}s</span>`);
    if (player.overdriveTime > 0) chips.push(`<span class="chip overdrive">OVERDRIVE ${player.overdriveTime.toFixed(0)}s</span>`);
    if (player.spawnProtection > 0 && player.alive) chips.push(`<span class="chip protected">PROTECTED</span>`);
    this.statusChips.innerHTML = chips.join('');

    // timer (timed mode)
    if (game.mode === 'timed') {
      const t = Math.max(0, game.timeLeft);
      const mm = Math.floor(t / 60);
      const ss = Math.floor(t % 60).toString().padStart(2, '0');
      this.timer.textContent = `${mm}:${ss}`;
      this.timer.classList.remove('hidden');
      this.timer.classList.toggle('urgent', t < 30);
    } else {
      this.timer.classList.add('hidden');
    }

    // scoreboard
    const mode = MODES[game.mode];
    const sorted = [...vehicles].sort((a, b) => b.score - a.score);
    const header = game.mode === 'survival'
      ? `<div class="row" style="color:#888;font-size:11px"><span>SURVIVAL</span><span>K&nbsp;&nbsp;♥</span></div>`
      : game.mode === 'timed'
        ? `<div class="row" style="color:#888;font-size:11px"><span>TIME ATTACK</span><span>K</span></div>`
        : `<div class="row" style="color:#888;font-size:11px"><span>FIRST TO ${mode.scoreLimit}</span><span>K</span></div>`;
    this.scoreboard.innerHTML = header + sorted.map((v) => {
      const cls = `row${v === player ? ' me' : ''}${v.eliminated ? ' out' : ''}`;
      const right = game.mode === 'survival'
        ? `${v.score}&nbsp;&nbsp;${v.eliminated ? '☠' : '♥'.repeat(Math.max(0, v.lives))}`
        : `${v.score}`;
      return `<div class="${cls}"><span>${v.name}</span><span class="k">${right}</span></div>`;
    }).join('');

    // lock-on reticle: hidden → LOCKING (progress ring) → LOCKED (pulsing)
    const locked = !!player.lockTarget && player.alive;
    const acquiring = !locked && player.lockProgress > 0 && player.alive;
    this.lockIndicator.classList.toggle('hidden', !locked && !acquiring);
    this.lockIndicator.classList.toggle('locking', acquiring);
    this.lockIndicator.textContent = locked ? '◈ LOCKED — FIRE ◈' : 'LOCKING';
    this.lockRing.classList.toggle('hidden', !acquiring && !locked);
    const pct = locked ? 100 : player.lockProgress * 100;
    this.lockRing.style.background =
      `conic-gradient(${locked ? '#ff6a1a' : '#ffcc66'} ${pct}%, rgba(255,255,255,0.12) ${pct}%)`;
    this.lockRing.classList.toggle('locked', locked);

    if (this.hitmarkerTimer > 0) {
      this.hitmarkerTimer -= dt;
      if (this.hitmarkerTimer <= 0) this.hitmarker.classList.add('hidden');
    }

    if (this.vignetteLevel > 0) {
      this.vignetteLevel = Math.max(0, this.vignetteLevel - dt * 1.8);
      this.vignette.style.opacity = String(this.vignetteLevel);
    }

    if (!player.alive && !player.eliminated) {
      this.respawnOverlay.classList.remove('hidden');
      this.respawnTimer.textContent = Math.ceil(player.respawnTimer).toString();
    } else {
      this.respawnOverlay.classList.add('hidden');
    }

    this.drawRadar(player, vehicles, game);
  }

  /** static street-layout underlay, drawn once (mirrors arena.ts geometry) */
  private buildRadarMap(): HTMLCanvasElement {
    const S = this.radar.width;
    const s = (S / 2) / 120;                 // world meters → map px
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d')!;
    const px = (w: number) => w * s + S / 2;
    // perimeter
    g.strokeStyle = 'rgba(255,255,255,0.14)';
    g.lineWidth = 2;
    g.strokeRect(px(-120), px(-120), 240 * s, 240 * s);
    // boulevards
    g.fillStyle = 'rgba(255,255,255,0.13)';
    g.fillRect(px(-9), px(-120), 18 * s, 240 * s);
    g.fillRect(px(-120), px(-9), 240 * s, 18 * s);
    // octagonal ring highway
    const oct: [number, number][] = [[-32, -78], [32, -78], [78, -32], [78, 32], [32, 78], [-32, 78], [-78, 32], [-78, -32]];
    g.strokeStyle = 'rgba(255,255,255,0.15)';
    g.lineWidth = 20 * s;
    g.lineJoin = 'round';
    g.beginPath();
    oct.forEach(([x, z], i) => (i === 0 ? g.moveTo(px(x), px(z)) : g.lineTo(px(x), px(z))));
    g.closePath();
    g.stroke();
    // skyway (elevated track) — its theme orange
    g.strokeStyle = 'rgba(255,130,40,0.5)';
    g.lineWidth = 10 * s;
    g.beginPath();
    g.moveTo(px(-68), px(-78));
    g.lineTo(px(68), px(-78));
    g.stroke();
    // central bridge
    g.fillStyle = 'rgba(120,200,255,0.3)';
    g.fillRect(px(-10), px(-9.4), 20 * s, 18.8 * s);
    return c;
  }

  private drawRadar(player: Vehicle, vehicles: Vehicle[], game: Game) {
    const ctx = this.radarCtx;
    const S = this.radar.width;
    const C = S / 2;
    const RANGE = 120;
    ctx.clearRect(0, 0, S, S);

    const pPos = player.position;
    const fwd = player.forward;
    const heading = Math.atan2(-fwd.x, -fwd.z);
    const cos = Math.cos(-heading), sin = Math.sin(-heading);

    // street-layout underlay, rotated into the player's frame
    if (!this.radarMap) this.radarMap = this.buildRadarMap();
    const s = C / RANGE;
    ctx.save();
    ctx.beginPath();
    ctx.arc(C, C, S * 0.47, 0, Math.PI * 2);
    ctx.clip();
    ctx.translate(C, C);
    ctx.transform(cos, sin, -sin, cos, 0, 0);
    ctx.globalAlpha = 0.6;
    ctx.drawImage(this.radarMap, -(pPos.x * s + C), -(pPos.z * s + C));
    ctx.restore();

    ctx.strokeStyle = 'rgba(120,255,170,0.25)';
    ctx.beginPath(); ctx.arc(C, C, S * 0.32, 0, Math.PI * 2); ctx.stroke();

    // high-value pickups (only while spawned in)
    const PICKUP_DOTS: Record<string, string> = { missiles: '#ff8a3a', overdrive: '#ff44dd', shield: '#7d95ff' };
    for (const pk of (game.pickups as any)['pickups']) {
      if (!pk.active || !PICKUP_DOTS[pk.type]) continue;
      const dx = pk.pos.x - pPos.x;
      const dz = pk.pos.z - pPos.z;
      const rx = dx * cos - dz * sin;
      const rz = dx * sin + dz * cos;
      const gx = C + (rx / RANGE) * C;
      const gy = C + (rz / RANGE) * C;
      if (gx < 6 || gx > S - 6 || gy < 6 || gy > S - 6) continue;
      ctx.fillStyle = PICKUP_DOTS[pk.type];
      ctx.fillRect(gx - 1.5, gy - 1.5, 3, 3);
    }

    for (const v of vehicles) {
      if (v === player || !v.alive) continue;
      const dx = v.position.x - pPos.x;
      const dz = v.position.z - pPos.z;
      const rx = dx * cos - dz * sin;
      const rz = dx * sin + dz * cos;
      const px = C + (rx / RANGE) * C;
      const py = C + (rz / RANGE) * C;
      if (px < 4 || px > S - 4 || py < 4 || py > S - 4) continue;
      ctx.fillStyle = v === player.lockTarget ? '#ff3355' : '#ff9944';
      ctx.beginPath();
      ctx.arc(px, py, 4, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.fillStyle = '#7dffb0';
    ctx.beginPath();
    ctx.moveTo(C, C - 7);
    ctx.lineTo(C - 5, C + 5);
    ctx.lineTo(C + 5, C + 5);
    ctx.closePath();
    ctx.fill();
  }

  /** floating damage number at a projected screen position (self-animating) */
  popDamage(xPct: number, yPct: number, text: string, color: string) {
    const el = document.createElement('div');
    el.className = 'dmg-pop';
    el.textContent = text;
    el.style.color = color;
    el.style.left = `${xPct}%`;
    el.style.top = `${yPct}%`;
    this.popups.appendChild(el);
    while (this.popups.children.length > 12) this.popups.firstChild?.remove();
    setTimeout(() => el.remove(), 950);
  }

  private pulse(el: HTMLElement, cls: string) {
    el.classList.remove(cls);
    void el.offsetWidth; // restart the CSS animation
    el.classList.add(cls);
  }

  /** shake the ammo chip when the player fires on empty */
  deny(kind: 'missile' | 'mine') {
    this.pulse(kind === 'missile' ? this.missileCount : this.mineCount, 'deny');
  }

  /** big, unmissable center-screen announcement (pickups, specials) */
  toast(text: string, color = '#ffd25e') {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = text;
    el.style.color = color;
    el.style.textShadow = `0 0 18px ${color}`;
    $('toasts').prepend(el);
    while ($('toasts').children.length > 3) $('toasts').lastChild?.remove();
    setTimeout(() => el.remove(), 1600);
  }

  showHitmarker() {
    this.hitmarker.classList.remove('hidden');
    this.hitmarkerTimer = 0.12;
  }

  showDamage(intensity: number) {
    this.vignetteLevel = Math.min(1, this.vignetteLevel + intensity);
    this.vignette.style.opacity = String(this.vignetteLevel);
  }

  addKillFeed(killer: string, victim: string) {
    const div = document.createElement('div');
    div.className = 'kf';
    div.innerHTML = `<b>${killer}</b> 💥 ${victim}`;
    this.killfeed.prepend(div);
    while (this.killfeed.children.length > 5) this.killfeed.lastChild?.remove();
    setTimeout(() => div.remove(), 5000);
  }
}
