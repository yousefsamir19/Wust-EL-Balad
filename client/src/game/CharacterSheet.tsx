import { useEffect, useRef } from 'react';
import type { VisibleCitizen, TownBuilding } from '../../../shared/world';
import { icon } from './icons';
import { portrait } from './characters';
import { texture } from './textures';
export function PixelIcon({ name }: { name: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => { const ctx = ref.current!.getContext('2d')!; ctx.clearRect(0,0,16,16); ctx.imageSmoothingEnabled=false; ctx.drawImage(texture(icon(name)),0,0); }, [name]);
  return <canvas ref={ref} width={16} height={16} className="pixel-icon" aria-hidden="true" />;
}
export function CitizenPortrait({ citizen, size = 64 }: { citizen: VisibleCitizen; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const { hair, clothing, accessory } = citizen.appearance;
  useEffect(() => { const ctx=ref.current!.getContext('2d')!; ctx.clearRect(0,0,32,32); ctx.imageSmoothingEnabled=false; ctx.drawImage(texture(portrait({hair,clothing,accessory})),0,0); }, [hair,clothing,accessory]);
  return <canvas ref={ref} width={32} height={32} style={{width:size,height:size,imageRendering:'pixelated'}} role="img" aria-label={`${citizen.name}'s portrait`} />;
}
export function CharacterSheet({ citizen, buildings, followId, onFollow, onTool }: { citizen: VisibleCitizen | undefined; buildings: TownBuilding[]; followId:string|null; onFollow:(id:string|null)=>void; onTool:(view:string)=>void }) {
  if (!citizen) return <p className="quiet">Tap a citizen or choose a name to inspect their character sheet.</p>;
  const location = buildings.find((building)=>building.id===citizen.buildingId)?.name ?? `Street (${citizen.x}, ${citizen.y})`;
  return <>
    <div className="character-heading"><CitizenPortrait citizen={citizen}/><h2>{citizen.name}</h2></div>
    <dl className="character-facts"><dt>Job</dt><dd>{citizen.job}</dd><dt>Cash</dt><dd>EGP {(citizen.money/100).toLocaleString('en-EG',{minimumFractionDigits:2,maximumFractionDigits:2})}</dd><dt>Savings</dt><dd>EGP {(citizen.savings/100).toFixed(2)}</dd><dt>Debt</dt><dd>EGP {(citizen.debt/100).toFixed(2)}</dd><dt>Mood</dt><dd>{citizen.mood}</dd><dt>Location</dt><dd>{location}</dd><dt>Activity</dt><dd>{citizen.activity}</dd></dl>
    <h3>Current thought</h3><p className="thought">“{citizen.publicThought}”</p>
    <div className="needs">{Object.entries(citizen.needs).map(([name,value])=><label key={name}>{name}<meter min={0} max={100} value={value} aria-label={`${citizen.name} ${name}`}/></label>)}</div>
    <p className="quiet">Relationships and memories arrive in Task 10.</p>
    <div className="character-actions"><button onClick={()=>onFollow(followId===citizen.id?null:citizen.id)}>{followId===citizen.id?'Stop following':'Follow on map'}</button><button onClick={()=>onTool('character-chat')}>Character Chat</button><button onClick={()=>onTool('interrogation')}>Interrogate</button></div>
  </>;
}
