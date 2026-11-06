import type { WorldDatabase } from '../db/index.js';
import type { WorldState } from '../simulation/clock.js';
import { entrance, findPath, tileKey, walkable } from '../simulation/navigation.js';
import type { TilePoint, TownBuilding, VisibleCitizen } from '../../../shared/world.js';
import { consumeMeal, economicArrival, economicChoice } from '../economy/actions.js';
import { applyCitizenAction,captureCitizenFrame } from './actions.js';
import { enrichDialogue } from './policy.js';
import { waitAction } from './reasoning-types.js';
import { activeHint } from '../influence/service.js';

interface Needs { hunger: number; energy: number; social: number }
interface Citizen extends TilePoint {
  id: string; name: string; job: string; money: number; mood: string; needs: string;
  home_id: string; workplace_id: string | null; building_id: string | null; activity: string;
  personality: string;
}
interface Routine {
  citizen_id: string; goal_action: string; target_building_id: string | null; path: string;
  next_decision_game_ms: number; movement_remainder: number; next_speech_game_ms: number;
  direction: VisibleCitizen['direction'];
  decision_cause_id: number | null;
}
interface Schedule { shift_start: number; shift_end: number }
export interface UtilityChoice { action: 'eat' | 'sleep' | 'work' | 'socialize' | 'idle'; targetId: string; score: number }
const clamp = (value: number) => Math.max(0, Math.min(100, value));

export function initializeRoutines(db: WorldDatabase) {
  db.prepare(`INSERT OR IGNORE INTO citizen_routines (citizen_id) SELECT id FROM citizens`).run();
  db.prepare(`INSERT OR IGNORE INTO schedules (citizen_id,shift_start,shift_end)
    SELECT id, CASE workplace_id WHEN 'cafe' THEN 420 WHEN 'bank' THEN 540 WHEN 'police' THEN 540 ELSE 480 END,
    CASE workplace_id WHEN 'cafe' THEN 900 WHEN 'store' THEN 1080 ELSE 1020 END FROM citizens`).run();
}

export function chooseUtility(citizen: Citizen, needs: Needs, minute: number, schedule: Schedule, hint?:{goal:string;bonus:number}|null): UtilityChoice {
  const night = minute >= 1320 || minute < 420;
  const onShift = minute >= schedule.shift_start && minute < schedule.shift_end;
  const trait = (JSON.parse(citizen.personality) as { trait: string }).trait;
  const choices: UtilityChoice[] = [
    { action: 'eat', targetId: night ? citizen.home_id : 'cafe', score: needs.hunger >= 40 ? needs.hunger * 1.4 + (needs.hunger >= 85 ? 40 : 0) : 0 },
    { action: 'sleep', targetId: citizen.home_id, score: night ? 80 + (100 - needs.energy) * .6 : needs.energy <= 50 ? (100 - needs.energy) * 1.2 : 0 },
    { action: 'socialize', targetId: 'square', score: needs.social >= 35 ? needs.social * .9 : 0 },
    { action: 'idle', targetId: ['outgoing', 'curious', 'optimistic'].includes(trait) ? 'square' : citizen.home_id, score: 10 },
  ];
  if (citizen.workplace_id && onShift) choices.push({ action: 'work', targetId: citizen.workplace_id, score: 65 });
  if(hint&&needs.hunger<85&&needs.energy>15){const candidate=choices.find(choice=>choice.action===hint.goal&&choice.score>0);if(candidate)candidate.score+=Math.max(0,Math.min(20,hint.bonus));}
  return choices.sort((a, b) => b.score - a.score)[0];
}

export function contextualDialogue(citizen: Citizen, other: Citizen, needs: Needs, trust: number, social?:{fear:number;grudge:number;suspicion:number}) {
  if(social?.fear&&social.fear>=60)return `${other.name}, I'd like to keep things calm between us.`;
  if(social?.grudge&&social.grudge>=60)return `${other.name}, I have not forgotten our differences.`;
  if(social?.suspicion&&social.suspicion>=65)return `${other.name}, I am not ready to believe everything I hear.`;
  if (trust < 35) return `${other.name}, I'd rather keep my personal worries to myself.`;
  if (citizen.money < 30000) return `${other.name}, I need to be careful with my EGP this week.`;
  if (needs.hunger > 45) return `${other.name}, I could use something to eat before heading back to work.`;
  if (needs.energy < 40) return `${other.name}, I'm tired after a long day as a ${citizen.job.toLowerCase()}.`;
  if (citizen.mood === 'Lonely') return `It's good to see you, ${other.name}. I needed someone to talk to.`;
  return `How is your day going, ${other.name}? I've been busy as a ${citizen.job.toLowerCase()}.`;
}

export function advanceCitizens(db: WorldDatabase, world: WorldState, realElapsedMs: number, gameElapsedMs: number) {
  const buildings = db.prepare('SELECT * FROM buildings ORDER BY id').all() as TownBuilding[];
  const buildingById = new Map(buildings.map((building) => [building.id, building]));
  const citizens = db.prepare('SELECT * FROM citizens ORDER BY id').all() as Citizen[];
  const occupied = new Set(citizens.map(tileKey));
  const hours = gameElapsedMs / 3600000;
  const minute = world.game_time_ms % 86400000 / 60000;
  const event = (type: string, citizen: Citizen, target: string | null, details: Record<string, unknown>) =>
    db.prepare(`INSERT INTO events (world_version,game_time_ms,type,actor_id,target,visibility,details,cause_id) VALUES (?,?,?,?,?,'public',?,?)`)
      .run(world.version, world.game_time_ms, type, citizen.id, target, JSON.stringify({...details,witnessIds:citizens.filter(person=>person.id===citizen.id||person.building_id===citizen.building_id&&Math.abs(person.x-citizen.x)+Math.abs(person.y-citizen.y)<=3).map(person=>person.id)}), (db.prepare('SELECT decision_cause_id FROM citizen_routines WHERE citizen_id=?').get(citizen.id) as {decision_cause_id:number|null}).decision_cause_id);

  for (const citizen of citizens) {
    const routine = db.prepare('SELECT * FROM citizen_routines WHERE citizen_id = ?').get(citizen.id) as Routine;
    const schedule = db.prepare('SELECT shift_start, shift_end FROM schedules WHERE citizen_id = ?').get(citizen.id) as Schedule;
    const needs = JSON.parse(citizen.needs) as Needs;
    const eating = (citizen.activity === 'eating' || citizen.activity === 'hungry') && consumeMeal(db, world, citizen);
    needs.hunger = clamp(needs.hunger + hours * (eating ? -240 : 8));
    needs.energy = clamp(needs.energy + hours * (citizen.activity === 'sleeping' ? 18 : citizen.activity === 'working' ? -6 : -3));
    needs.social = clamp(needs.social + hours * (citizen.activity === 'socializing' ? -120 : 5));
    citizen.mood = needs.hunger >= 75 ? 'Hungry' : needs.energy <= 20 ? 'Tired' : needs.social >= 75 ? 'Lonely' : 'Calm';
    let path = JSON.parse(routine.path) as TilePoint[];
    let blocked = false;
    occupied.delete(tileKey(citizen));
    const onShift = minute >= schedule.shift_start && minute < schedule.shift_end;
    const reconsider = routine.next_decision_game_ms <= world.game_time_ms || !routine.target_building_id ||
      (routine.goal_action === 'work' && !onShift) || (routine.goal_action === 'eat' && needs.hunger < 15) ||
      (routine.goal_action === 'socialize' && needs.social < 10);
    if (reconsider) {
      const hint=activeHint(db,citizen.id,world.game_time_ms),base=chooseUtility(citizen,needs,minute,schedule);
      const choice = economicChoice(db, world, citizen, chooseUtility(citizen, needs, minute, schedule,hint));
      routine.decision_cause_id=hint&&choice.action===hint.goal&&(choice.action!==base.action||choice.targetId!==base.targetId)?hint.eventId:null;
      if (choice.action !== routine.goal_action || choice.targetId !== routine.target_building_id || citizen.activity === 'blocked') {
        routine.goal_action = choice.action;
        routine.target_building_id = choice.targetId;
        const building = buildingById.get(choice.targetId);
        const goal = building ? entrance(building, buildings, occupied, citizen.id) : null;
        const route = goal ? findPath(citizen, goal, buildings, occupied) : null;
        path = route ?? [];
        blocked = route === null;
      }
      routine.next_decision_game_ms = world.game_time_ms + 5 * 60000;
      db.prepare('UPDATE citizen_routines SET decision_cause_id=? WHERE citizen_id=?').run(routine.decision_cause_id,citizen.id);
    }
    const target = routine.target_building_id ? buildingById.get(routine.target_building_id) : undefined;
    if (path.length && (!walkable(path[0], buildings) || occupied.has(tileKey(path[0])) || Math.abs(path[0].x - citizen.x) + Math.abs(path[0].y - citizen.y) !== 1)) {
      const goal = target ? entrance(target, buildings, occupied, citizen.id) : null;
      const route = goal ? findPath(citizen, goal, buildings, occupied) : null;
      path = route ?? [];
      blocked = route === null;
    }
    routine.movement_remainder += realElapsedMs / 500;
    const previousBuilding = citizen.building_id;
    while (path.length && routine.movement_remainder >= 1) {
      const next = path[0];
      if (!walkable(next, buildings) || occupied.has(tileKey(next)) || Math.abs(next.x - citizen.x) + Math.abs(next.y - citizen.y) !== 1) break;
      path.shift();
      routine.direction = next.x > citizen.x ? 'right' : next.x < citizen.x ? 'left' : next.y > citizen.y ? 'down' : 'up';
      citizen.x = next.x; citizen.y = next.y;
      citizen.building_id = null;
      routine.movement_remainder -= 1;
    }
    const arrived = !blocked && !!target && walkable(citizen, buildings) && path.length === 0 && Math.abs(citizen.x - target.door_x) + Math.abs(citizen.y - target.door_y) <= 2;
    if (arrived) {
      citizen.building_id = target!.id;
      const activities: Record<string,string> = { work:citizen.workplace_id?'working':'job_seeking', eat:'eating', sleep:'sleeping', socialize:'socializing', idle:'idle', bank:'banking' };
      citizen.activity = activities[routine.goal_action] ?? 'idle';
      if (routine.goal_action === 'eat' && !consumeMeal(db, world, citizen)) citizen.activity = 'hungry';
      routine.movement_remainder = 0;
    } else if (path.length) citizen.activity = 'walking';
    else { citizen.activity = 'blocked'; blocked = true; routine.movement_remainder = 0; }
    if (previousBuilding && previousBuilding !== citizen.building_id) event('citizen_departed', citizen, previousBuilding, {});
    if (citizen.building_id && previousBuilding !== citizen.building_id) event('citizen_arrived', citizen, citizen.building_id, { activity: citizen.activity });
    if (blocked && reconsider) event('route_blocked', citizen, routine.target_building_id, {});
    const thoughts = target ? `I want to ${routine.goal_action} at ${target.name}.` : 'I need to find a safe route.';
    db.prepare('UPDATE citizens SET x=?,y=?,building_id=?,activity=?,needs=?,mood=?,thoughts=? WHERE id=?')
      .run(citizen.x, citizen.y, citizen.building_id, citizen.activity, JSON.stringify(needs), citizen.mood, thoughts, citizen.id);
    db.prepare(`UPDATE citizen_routines SET goal_action=?,target_building_id=?,path=?,next_decision_game_ms=?,movement_remainder=?,next_speech_game_ms=?,direction=? WHERE citizen_id=?`)
      .run(routine.goal_action, routine.target_building_id, JSON.stringify(path), routine.next_decision_game_ms, routine.movement_remainder, routine.next_speech_game_ms, routine.direction, citizen.id);
    economicArrival(db, world, citizen.id);
    if(citizen.activity==='socializing'&&routine.next_speech_game_ms<=world.game_time_ms){
      const frame=captureCitizenFrame(db,world,citizen.id,'social_opportunity'),peer=frame.nearby[0],other=peer?citizens.find(p=>p.id===peer.id):undefined;
      if(peer&&other){const base=contextualDialogue(citizen,other,needs,peer.trust,peer);applyCitizenAction(db,world,frame,{...waitAction(),action:'speak',target:peer.id,...enrichDialogue(frame,peer.id,base)},`routine:${citizen.id}:${world.tick}`);}
    }
    occupied.add(tileKey(citizen));
  }
}
