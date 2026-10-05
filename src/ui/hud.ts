import type { Vehicle } from '../game/vehicle';
import type { Game } from '../game/game';
import { MODES } from '../game/game';
import { STREETS, ARCS, ROUNDABOUT, STREETS_DOCKS, ARENA_HALF } from '../game/arena';
import { MAX_MISSILES, MAX_MINES, MAX_NUKES } from '../game/specs';

const $ = (id: string) => document.getElementById(id)!;

/**
 * Radar half-width in metres. Used by BOTH the underlay and the live draw, so
 * they cannot drift apart.
 *
 * It used to be 160 — the arena's own half-width, i.e. the whole map squeezed
 * into 150px. That is a map, not a radar: everything you actually need to react
 * to sat in a few pixels around the centre. 95m is roughly "who can shoot me in
 * the next few seconds", and anything further is clamped to the rim instead of
 * being dropped.
 */
const RADAR_RANGE = 95;
const THREE_clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

export class Hud {
  private healthBar = $('health-bar');
  private turboBar = $('turbo-bar');
  private specialBar = $('special-bar');
  private specialLabel = $('special-label');
  private missileCount = $('missile-count');
  private mineCount = $('mine-count');
  private nukeCount = $('nuke-count');
  private blastFlash = $('blast-flash');
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
  private blastLevel = 0;
  private lastNukes = -1;
  private lastMissiles = -1;
  private lastMines = -1;
  private radarMap: HTMLCanvasElement | null = null;
  private radarArenaIdx = -1;
  private shieldRow = $('shield-row');
  private panic = $('panic');
  private popups = $('dmg-popups');
  private shieldBar = $('shield-bar');
  private shieldLabel = $('shield-label');

  constructor() {
    // Shield stays segmented — its 10 blocks ARE the 10 remaining seconds, so
    // counting them is the point. Armour is a continuous bar like turbo and
    // special: as a health value there is nothing to count, and the blocks just
    // made the busiest corner of the HUD noisier than the bars beside it.
  }

  show() { $('hud').classList.remove('hidden'); }
  hide() { $('hud').classList.add('hidden'); }

  update(dt: number, player: Vehicle, vehicles: Vehicle[], game: Game) {
    const hpRatio = player.health / player.spec.maxHealth;
    this.healthBar.style.width = `${hpRatio * 100}%`;
    this.healthBar.classList.toggle('warn', hpRatio <= 0.5 && hpRatio > 0.25);
    this.healthBar.classList.toggle('danger', hpRatio <= 0.25);
    // panic state below 30%: bar flashes + screen-edge red pulse
    const panicking = hpRatio < 0.3 && player.alive;
    this.healthBar.classList.toggle('critical', panicking);
    this.panic.classList.toggle('on', panicking);
    // shield bar exists only while shielded. It used to be ten blocks, one per
    // second — the blocks WERE the countdown. Now it is continuous like armour
    // and turbo, so the seconds moved into the label where they are actually
    // legible under pressure.
    // final 2 seconds blink the whole row as the expiry warning
    this.shieldRow.classList.toggle('hidden', player.shieldTime <= 0 || !player.alive);
    if (player.shieldTime > 0) {
      this.shieldBar.style.width = `${(player.shieldTime / 10) * 100}%`;
      this.shieldLabel.textContent = `SHIELD — ${player.shieldTime.toFixed(1)}s`;
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
    this.missileCount.textContent = `🚀 ${player.missiles}/${MAX_MISSILES}`;
    this.mineCount.textContent = `💣 ${player.minesAmmo}/${MAX_MINES}`;
    this.nukeCount.textContent = `☢ ${player.nukes}/${MAX_NUKES}`;
    this.missileCount.style.opacity = player.missiles > 0 ? '1' : '0.35';
    this.mineCount.style.opacity = player.minesAmmo > 0 ? '1' : '0.35';
    this.nukeCount.style.opacity = player.nukes > 0 ? '1' : '0.3';
    // acquire punch on counter increase
    if (player.missiles > this.lastMissiles && this.lastMissiles >= 0) this.pulse(this.missileCount, 'punch');
    if (player.minesAmmo > this.lastMines && this.lastMines >= 0) this.pulse(this.mineCount, 'punch');
    if (player.nukes > this.lastNukes && this.lastNukes >= 0) this.pulse(this.nukeCount, 'punch');
    this.lastMissiles = player.missiles;
    this.lastMines = player.minesAmmo;
    this.lastNukes = player.nukes;

    // status chips
    const chips: string[] = [];
    // no shield chip: the shield has its own bar now and the countdown lives in
    // its label, so a chip would print the same number twice
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

    if (this.blastLevel > 0) {
      this.blastLevel = Math.max(0, this.blastLevel - dt * 1.15);
      this.blastFlash.style.opacity = String(this.blastLevel * this.blastLevel);
    }

    if (!player.alive && !player.eliminated) {
      this.respawnOverlay.classList.remove('hidden');
      this.respawnTimer.textContent = Math.ceil(player.respawnTimer).toString();
    } else {
      this.respawnOverlay.classList.add('hidden');
    }

    this.drawRadar(player, vehicles, game);
  }

  /**
   * Static street-layout underlay, drawn once per arena.
   *
   * Sized from RADAR_RANGE rather than a hardcoded 160 so the scale can never
   * drift from drawRadar's — that drift used to be a standing hazard with a
   * comment warning about it, which is not the same as preventing it.
   */
  private buildRadarMap(arenaIdx = 0): HTMLCanvasElement {
    const s = (this.radar.width / 2) / RADAR_RANGE;      // world metres → map px
    const SPAN = ARENA_HALF * 2;
    const S = Math.ceil(SPAN * s);
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d')!;
    const px = (w: number) => w * s + S / 2;

    // ground wash, so streets read as cut INTO something rather than floating
    g.fillStyle = 'rgba(26, 32, 40, 0.55)';
    g.fillRect(0, 0, S, S);

    const streets = arenaIdx === 1 ? STREETS_DOCKS : STREETS;
    // two passes: a dark casing under a lighter fill is what makes a road legible
    // at this size — a single flat stroke mushes together at junctions
    for (const pass of [
      { col: 'rgba(10, 14, 20, 0.85)', pad: 2.5 },
      { col: 'rgba(150, 170, 190, 0.5)', pad: 0 },
    ]) {
      g.strokeStyle = pass.col;
      g.lineCap = 'round';
      for (const [x0, z0, x1, z1, w] of streets) {
        g.lineWidth = w * s + pass.pad;
        g.beginPath();
        g.moveTo(px(x0), px(z0));
        g.lineTo(px(x1), px(z1));
        g.stroke();
      }
      if (arenaIdx !== 1) {
        for (const [cx, cz, r, th0, thLen, w] of ARCS) {
          g.lineWidth = w * s + pass.pad;
          g.beginPath();
          g.arc(px(cx), px(cz), r * s, th0, th0 + thLen);
          g.stroke();
        }
        g.lineWidth = ROUNDABOUT.w * s + pass.pad;
        g.beginPath();
        g.arc(px(0), px(0), ROUNDABOUT.r * s, 0, Math.PI * 2);
        g.stroke();
      }
    }

    if (arenaIdx === 1) {
      g.fillStyle = 'rgba(32, 86, 150, 0.5)';
      g.fillRect(px(140), px(-ARENA_HALF), 20 * s, ARENA_HALF * 2 * s);
      g.strokeStyle = 'rgba(90, 210, 255, 0.55)';
      g.lineWidth = 2;
      g.strokeRect(px(32), px(-75), 24 * s, 60 * s);
      g.strokeRect(px(32), px(15), 24 * s, 60 * s);
      return c;
    }

    // roundabout island
    g.fillStyle = 'rgba(214, 180, 120, 0.4)';
    g.beginPath();
    g.arc(px(0), px(0), ROUNDABOUT.islandR * s, 0, Math.PI * 2);
    g.fill();
    // diagonal tunnels — cyan, matching their neon
    g.strokeStyle = 'rgba(90, 210, 255, 0.5)';
    g.lineWidth = 14 * s;
    for (const d of [1, -1]) {
      g.beginPath();
      g.moveTo(px(d * 28), px(-d * 28));
      g.lineTo(px(d * 63), px(-d * 63));
      g.stroke();
    }
    // skyway — orange, and dashed because it is ABOVE you, not a road you can
    // turn onto from here
    g.strokeStyle = 'rgba(255, 140, 50, 0.65)';
    g.lineWidth = 9 * s;
    g.setLineDash([10, 7]);
    g.beginPath();
    g.moveTo(px(-90), px(120));
    g.lineTo(px(90), px(120));
    g.stroke();
    g.setLineDash([]);
    return c;
  }

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

  private drawRadar(player: Vehicle, vehicles: Vehicle[], game: Game) {
    const ctx = this.radarCtx;
    const S = this.radar.width;
    const C = S / 2;
    const R = S * 0.47;                 // drawable radius inside the bezel
    const s = C / RADAR_RANGE;
    ctx.clearRect(0, 0, S, S);

    const pPos = player.position;
    const fwd = player.forward;
    const heading = Math.atan2(-fwd.x, -fwd.z);
    const cos = Math.cos(-heading), sin = Math.sin(-heading);
    /** world offset → radar pixel, rotated into the player's frame */
    const toRadar = (wx: number, wz: number) => {
      const dx = wx - pPos.x, dz = wz - pPos.z;
      return { x: C + (dx * cos - dz * sin) * s, y: C + (dx * sin + dz * cos) * s };
    };

    const arenaIdx = (game as any).arenaIdx ?? 0;
    if (!this.radarMap || this.radarArenaIdx !== arenaIdx) {
      this.radarMap = this.buildRadarMap(arenaIdx);
      this.radarArenaIdx = arenaIdx;
    }

    ctx.save();
    ctx.beginPath();
    ctx.arc(C, C, R, 0, Math.PI * 2);
    ctx.clip();

    // street underlay, rotated so the map turns with the car
    ctx.save();
    ctx.translate(C, C);
    ctx.transform(cos, sin, -sin, cos, 0, 0);
    ctx.globalAlpha = 0.85;
    const M = this.radarMap.width;
    ctx.drawImage(this.radarMap, -(pPos.x * s + M / 2), -(pPos.z * s + M / 2));
    ctx.restore();
    ctx.globalAlpha = 1;

    // forward cone: tells you at a glance which contacts are actually ahead
    ctx.fillStyle = 'rgba(150, 230, 255, 0.07)';
    ctx.beginPath();
    ctx.moveTo(C, C);
    ctx.arc(C, C, R, -Math.PI / 2 - 0.5, -Math.PI / 2 + 0.5);
    ctx.closePath();
    ctx.fill();

    // range rings at a third and two thirds, so distance is readable
    ctx.strokeStyle = 'rgba(150, 230, 255, 0.13)';
    ctx.lineWidth = 1;
    for (const f of [0.34, 0.67]) {
      ctx.beginPath(); ctx.arc(C, C, R * f, 0, Math.PI * 2); ctx.stroke();
    }

    // sudden-death ring, centred on the town square
    const sdR = (game as any).suddenDeathR;
    if (sdR !== Infinity && sdR !== undefined) {
      const o = toRadar(0, 0);
      ctx.strokeStyle = 'rgba(255, 60, 40, 0.85)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(o.x, o.y, sdR * s, 0, Math.PI * 2);
      ctx.stroke();
    }

    // high-value pickups — diamonds, so they never read as a vehicle
    const PICKUP_DOTS: Record<string, string> = {
      missiles: '#ff8a3a', overdrive: '#ff44dd', shield: '#7d95ff', nuke: '#aaff00',
    };
    for (const pk of (game.pickups as any)['pickups']) {
      if (!pk.active || !PICKUP_DOTS[pk.type]) continue;
      const q = toRadar(pk.pos.x, pk.pos.z);
      if (Math.hypot(q.x - C, q.y - C) > R - 3) continue;
      const big = pk.type === 'nuke';
      const r = big ? 5 : 3.2;
      if (big) {
        // the nuke is the one thing worth crossing the map for: give it a halo
        ctx.fillStyle = 'rgba(170, 255, 0, 0.22)';
        ctx.beginPath(); ctx.arc(q.x, q.y, 9, 0, Math.PI * 2); ctx.fill();
      }
      ctx.fillStyle = PICKUP_DOTS[pk.type];
      ctx.beginPath();
      ctx.moveTo(q.x, q.y - r); ctx.lineTo(q.x + r, q.y);
      ctx.lineTo(q.x, q.y + r); ctx.lineTo(q.x - r, q.y);
      ctx.closePath(); ctx.fill();
    }

    // contacts: arrowheads pointing the way they are DRIVING, so you can read
    // whether someone is closing on you or leaving. Anything beyond range is
    // pinned to the rim rather than dropped — losing the blip entirely is how
    // you get killed by someone you knew about a second ago.
    for (const v of vehicles) {
      if (v === player || !v.alive) continue;
      const q = toRadar(v.position.x, v.position.z);
      let dx = q.x - C, dy = q.y - C;
      const d = Math.hypot(dx, dy);
      const off = d > R - 6;
      if (off) { const k = (R - 6) / d; dx *= k; dy *= k; }
      const bx = C + dx, by = C + dy;

      const locked = v === player.lockTarget;
      const bounty = v === (game as any).bountyTarget;
      ctx.fillStyle = locked ? '#ff3355' : '#ffa23c';
      if (off) {
        // off-radar: a small chevron on the bezel, no heading (you cannot see them)
        ctx.globalAlpha = 0.55;
        ctx.beginPath(); ctx.arc(bx, by, 2.6, 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = 1;
      } else {
        const vh = Math.atan2(-v.forward.x, -v.forward.z) - heading;
        ctx.save();
        ctx.translate(bx, by);
        ctx.rotate(-vh);
        ctx.beginPath();
        ctx.moveTo(0, -5.5); ctx.lineTo(4, 4); ctx.lineTo(0, 1.8); ctx.lineTo(-4, 4);
        ctx.closePath(); ctx.fill();
        ctx.restore();
        if (bounty) {
          ctx.strokeStyle = '#ffd24a';
          ctx.lineWidth = 1.6;
          ctx.beginPath(); ctx.arc(bx, by, 8, 0, Math.PI * 2); ctx.stroke();
        }
      }
    }
    ctx.restore();

    // --- bezel furniture, drawn outside the clip ---
    // north marker: without one, a rotating map leaves you with no fixed frame
    const nx = C + Math.sin(-heading) * 0 - Math.sin(heading) * 0;
    ctx.save();
    ctx.translate(C, C);
    ctx.rotate(-heading);
    ctx.fillStyle = 'rgba(150, 230, 255, 0.75)';
    ctx.beginPath();
    ctx.moveTo(0, -R + 1); ctx.lineTo(4, -R + 9); ctx.lineTo(-4, -R + 9);
    ctx.closePath(); ctx.fill();
    ctx.restore();
    void nx;

    // player arrow, always dead centre and pointing up
    ctx.fillStyle = '#7dffb0';
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(C, C - 7); ctx.lineTo(C + 5, C + 5); ctx.lineTo(C, C + 2.5); ctx.lineTo(C - 5, C + 5);
    ctx.closePath();
    ctx.fill(); ctx.stroke();
  }

  private pulse(el: HTMLElement, cls: string) {
    el.classList.remove(cls);
    void el.offsetWidth; // restart the CSS animation
    el.classList.add(cls);
  }

  /** shake the ammo chip when the player fires on empty */
  deny(kind: 'missile' | 'mine' | 'nuke') {
    const el = kind === 'missile' ? this.missileCount : kind === 'mine' ? this.mineCount : this.nukeCount;
    this.pulse(el, 'deny');
  }

  /** detonation whiteout — scaled by how close the player was to the blast */
  blast(intensity: number) {
    this.blastLevel = Math.min(1, this.blastLevel + intensity);
    this.blastFlash.style.opacity = String(this.blastLevel);
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
