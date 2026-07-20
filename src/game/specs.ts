export type SpecialId = 'dash' | 'minigun' | 'flame' | 'turret' | 'slam' | 'bomb' | 'repair' | 'minetrail';

export interface CarSpec {
  id: string;
  name: string;
  desc: string;
  maxHealth: number;   // universal 100 pool
  armor: number;       // mitigation rating: damageTaken = raw * 100/(100+armor)
  accel: number;      // m/s^2
  topSpeed: number;   // m/s
  steerMax: number;   // rad
  grip: number;       // lateral velocity kill rate (1/s)
  turboMax: number;   // seconds of turbo
  /** chassis half-extents */
  size: { x: number; y: number; z: number };
  color: number;
  accent: number;
  build: 'speed' | 'muscle' | 'sports' | 'suv' | 'tank' | 'hearse' | 'ambulance' | 'taxi';
  specialId: SpecialId;
  specialName: string;
  specialDesc: string;
  specialRecharge: number; // seconds to refill energy
}

export const CAR_SPECS: CarSpec[] = [
  {
    id: 'viper',
    name: 'VIPER',
    desc: 'Blistering speed, paper armor. Hit and run.',
    maxHealth: 100,
    armor: 0,
    accel: 34, topSpeed: 36.0, steerMax: 0.62, grip: 5.0, turboMax: 4.0,
    size: { x: 0.68, y: 0.34, z: 1.56 },
    color: 0xb8a11c,
    accent: 0x1a1812,
    build: 'speed',
    specialId: 'dash',
    specialName: 'NITRO RAM',
    specialDesc: 'Explosive dash — your car becomes the weapon',
    specialRecharge: 13,
  },
  {
    id: 'hellcat',
    name: 'HELLCAT',
    desc: 'Bone-white muscle. The guns never stop.',
    maxHealth: 100,
    armor: 55,
    accel: 26, topSpeed: 28.5, steerMax: 0.56, grip: 6.5, turboMax: 2.8,
    size: { x: 0.76, y: 0.42, z: 1.6 },
    color: 0xcfc8b8,
    accent: 0x7a2018,
    build: 'muscle',
    specialId: 'minigun',
    specialName: 'TWIN MINIGUNS',
    specialDesc: '4 seconds of shredding fire rate',
    specialRecharge: 16,
  },
  {
    id: 'scorch',
    name: 'SCORCH',
    desc: 'Sleek, fast, and permanently furious.',
    maxHealth: 100,
    armor: 25,
    accel: 31, topSpeed: 33.0, steerMax: 0.6, grip: 7.2, turboMax: 3.2,
    size: { x: 0.74, y: 0.32, z: 1.64 },
    color: 0xa01620,
    accent: 0x9ba0a8,
    build: 'sports',
    specialId: 'flame',
    specialName: 'FLAMETHROWER',
    specialDesc: 'Cone of fire — melt anything that gets close',
    specialRecharge: 14,
  },
  {
    id: 'rampart',
    name: 'RAMPART',
    desc: 'Riot-issue law. The turret does the talking.',
    maxHealth: 100,
    armor: 115,
    accel: 20, topSpeed: 21.5, steerMax: 0.54, grip: 7.0, turboMax: 2.3,
    size: { x: 0.82, y: 0.5, z: 1.68 },
    color: 0x14161c,
    accent: 0xe8e4da,
    build: 'suv',
    specialId: 'turret',
    specialName: 'AUTO-TURRET',
    specialDesc: 'Roof turret hunts targets in every direction',
    specialRecharge: 18,
  },
  {
    id: 'juggernaut',
    name: 'JUGGERNAUT',
    desc: 'A rolling fortress. Slow, furious, unkillable.',
    maxHealth: 100,
    armor: 200,
    accel: 16, topSpeed: 14.5, steerMax: 0.5, grip: 7.8, turboMax: 2.2,
    size: { x: 0.88, y: 0.54, z: 1.8 },
    color: 0x3d4c54,
    accent: 0xb8b0a0,
    build: 'tank',
    specialId: 'slam',
    specialName: 'SEISMIC SLAM',
    specialDesc: 'Shockwave that flings everything nearby',
    specialRecharge: 12,
  },
  {
    id: 'mortis',
    name: 'MORTIS',
    desc: 'The hearse always gets its passenger.',
    maxHealth: 100,
    armor: 90,
    accel: 22, topSpeed: 24.0, steerMax: 0.52, grip: 5.6, turboMax: 2.6,
    size: { x: 0.76, y: 0.44, z: 1.88 },
    color: 0x1f1826,
    accent: 0x7a3fa0,
    build: 'hearse',
    specialId: 'bomb',
    specialName: 'REMOTE BOMB',
    specialDesc: 'Lob it, then detonate on your command',
    specialRecharge: 15,
  },
  {
    id: 'medic',
    name: 'MEDIC',
    desc: 'First response. Last thing you ever see.',
    maxHealth: 100,
    armor: 85,
    accel: 21, topSpeed: 23.0, steerMax: 0.53, grip: 6.8, turboMax: 2.4,
    size: { x: 0.8, y: 0.5, z: 1.72 },
    color: 0xe8e4dc,
    accent: 0xd03030,
    build: 'ambulance',
    specialId: 'repair',
    specialName: 'ADRENALINE',
    specialDesc: 'Emergency field repair — instant armor',
    specialRecharge: 16,
  },
  {
    id: 'jackrabbit',
    name: 'JACKRABBIT',
    desc: 'The meter is running. So should you.',
    maxHealth: 100,
    armor: 30,
    accel: 28, topSpeed: 30.5, steerMax: 0.58, grip: 6.2, turboMax: 3.0,
    size: { x: 0.74, y: 0.42, z: 1.6 },
    color: 0xe8b820,
    accent: 0x181410,
    build: 'taxi',
    specialId: 'minetrail',
    specialName: 'MINE SALVO',
    specialDesc: 'Dumps a trail of three live mines',
    specialRecharge: 14,
  },
];

export const BOT_NAMES = ['VULTURE', 'COBRA', 'BRUISER', 'WRAITH', 'PIRANHA', 'HAVOC', 'JACKAL'];
