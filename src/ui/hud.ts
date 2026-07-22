import type { Vehicle } from '../game/vehicle';
import type { Game } from '../game/game';
import { MODES } from '../game/game';
import { STREETS, ARCS, ROUNDABOUT, STREETS_DOCKS } from '../game/arena';

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
  private radarArenaIdx = -1;
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

    // special weapon bar — three states:
    //   windowed (E pressed): 45s countdown drains, special freely usable
    //   charged: full bar, READY
    //   charging: energy fraction
    const windowed = player.specialWindow > 0;
    const active = player.specialActiveTime > 0;
    const ready = player.specialEnergy >= 1 && !windowed;
    this.specialBar.style.width = `${(windowed ? player.specialWindow / 45 : player.specialEnergy) * 100}%`;
    this.specialBar.classList.toggle('active', windowed || active);
    if (player.spec.specialId === 'bomb' && player.bombOut) {
      this.specialLabel.textContent = `${player.spec.specialName} — PRESS AGAIN TO DETONATE`;
      this.specialLabel.className = 'bar-label special ready';
    } else if (windowed) {
      this.specialLabel.textContent = `${player.spec.specialName} — ${Math.ceil(player.specialWindow)}s`;
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
      // streak flame at 3+, gold bounty ring on the marked leader
      const tags = `${v.killStreak >= 3 ? ' 🔥' : ''}${v === (game as any).bountyTarget ? ' <span style="color:#ffd24a">◎</span>' : ''}`;
      return `<div class="${cls}"><span>${v.name}${tags}</span><span class="k">${right}</span></div>`;
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
  private buildRadarMap(arenaIdx = 0): HTMLCanvasElement {
    // drawn from the arena's own street data so the radar can never drift
    const S = this.radar.width;
    const s = (S / 2) / 160;                 // world meters → map px
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d')!;
    const px = (w: number) => w * s + S / 2;
    g.strokeStyle = 'rgba(255,255,255,0.15)';
    g.lineCap = 'round';
    // streets
    for (const [x0, z0, x1, z1, w] of (arenaIdx === 1 ? STREETS_DOCKS : STREETS)) {
      g.lineWidth = w * s;
      g.beginPath();
      g.moveTo(px(x0), px(z0));
      g.lineTo(px(x1), px(z1));
      g.stroke();
    }
    if (arenaIdx === 1) {
      // docks: water band east + the two drive-through warehouses in cyan
      g.fillStyle = 'rgba(40,90,160,0.35)';
      g.fillRect(px(140), px(-160), 20 * s, 320 * s);
      g.strokeStyle = 'rgba(80,200,255,0.45)';
      g.lineWidth = 3;
      g.strokeRect(px(32), px(-75), 24 * s, 60 * s);
      g.strokeRect(px(32), px(15), 24 * s, 60 * s);
      return c;
    }
    // perimeter corner arcs
    for (const [cx, cz, r, th0, thLen, w] of ARCS) {
      g.lineWidth = w * s;
      g.beginPath();
      g.arc(px(cx), px(cz), r * s, th0, th0 + thLen);
      g.stroke();
    }
    // roundabout + island
    g.lineWidth = ROUNDABOUT.w * s;
    g.beginPath();
    g.arc(px(0), px(0), ROUNDABOUT.r * s, 0, Math.PI * 2);
    g.stroke();
    g.fillStyle = 'rgba(220,190,130,0.35)';
    g.beginPath();
    g.arc(px(0), px(0), ROUNDABOUT.islandR * s, 0, Math.PI * 2);
    g.fill();
    // diagonal tunnels — cyan like their neon
    g.strokeStyle = 'rgba(80,200,255,0.45)';
    g.lineWidth = 14 * s;
    for (const d of [1, -1]) {
      g.beginPath();
      g.moveTo(px(d * 28), px(-d * 28));
      g.lineTo(px(d * 63), px(-d * 63));
      g.stroke();
    }
    // skyway (elevated track) — theme orange
    g.strokeStyle = 'rgba(255,130,40,0.5)';
    g.lineWidth = 10 * s;
    g.beginPath();
    g.moveTo(px(-90), px(120));
    g.lineTo(px(90), px(120));
    g.stroke();
    return c;
  }

  private drawRadar(player: Vehicle, vehicles: Vehicle[], game: Game) {
    const ctx = this.radarCtx;
    const S = this.radar.width;
    const C = S / 2;
    const RANGE = 160;   // MUST match buildRadarMap's scale or the underlay drifts
    ctx.clearRect(0, 0, S, S);

    const pPos = player.position;
    const fwd = player.forward;
    const heading = Math.atan2(-fwd.x, -fwd.z);
    const cos = Math.cos(-heading), sin = Math.sin(-heading);

    // street-layout underlay, rotated into the player's frame (per-arena cache)
    const arenaIdx = (game as any).arenaIdx ?? 0;
    if (!this.radarMap || this.radarArenaIdx !== arenaIdx) {
      this.radarMap = this.buildRadarMap(arenaIdx);
      this.radarArenaIdx = arenaIdx;
    }
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
      // gold bounty ring — the marked leader is visible map-wide
      if (v === (game as any).bountyTarget) {
        ctx.strokeStyle = '#ffd24a';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(px, py, 7, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // sudden-death ring: red circle centred on the town square (world origin)
    const sdR = (game as any).suddenDeathR;
    if (sdR !== Infinity && sdR !== undefined) {
      const s2 = C / RANGE;
      const rx = (0 - pPos.x) * cos - (0 - pPos.z) * sin;
      const rz = (0 - pPos.x) * sin + (0 - pPos.z) * cos;
      ctx.strokeStyle = 'rgba(255,60,40,0.8)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(C + rx * s2, C + rz * s2, sdR * s2, 0, Math.PI * 2);
      ctx.stroke();
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
