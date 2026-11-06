import { useEffect,useRef,useState } from 'react';
import type { PlayerProfile } from '../../../shared/auth';
import type { PublicEvent, WorldSnapshot } from '../../../shared/realtime';
import { timeLabel, useWorld } from '../realtime/useWorld';
import { AccountPanel } from '../AccountPanel';
import { CharacterSheet, CitizenPortrait, PixelIcon } from './CharacterSheet';
import { TownMap } from './TownMap';
import { AiSettings } from './AiSettings';
import { ObserverChat,CharacterChat,ImportantEvents } from './ChatPanels';
import { Interrogation } from './Interrogation';
import { TownArchives } from './TownArchives';
import { Investigation } from './Investigation';
import { InfluencePanel } from './InfluencePanel';
import { Rumors } from './Rumors';
import { CatchUp } from './CatchUp';
import './hud.css';

const core = [{id:'map',label:'Map',icon:'map'},{id:'citizens',label:'Citizens',icon:'citizens'},{id:'events',label:'Events',icon:'events'},{id:'players',label:'Players',icon:'players'},{id:'influence',label:'Influence',icon:'influence'}];
const titles: Record<string,string> = { 'ai-settings':'AI Settings','character-chat':'Character Chat','observer-chat':'Observer Chat',interrogation:'Interrogation',investigation:'Investigation',rumors:'Rumors',leaderboard:'Leaderboard',timeline:'Town Archives',newspaper:'The Downtown Gazette',profile:'Player Profile',events:'Important Events',players:'Observers',influence:'Influence',catchup:'Catch up' };
const coming: Record<string,number> = { leaderboard:21 };
export function eventLabel(event: PublicEvent, world: WorldSnapshot) {
  const actor=world.citizens.find((citizen)=>citizen.id===event.actorId)?.name ?? 'Town';
  const target=world.buildings.find((building)=>building.id===event.target)?.name ?? world.citizens.find((citizen)=>citizen.id===event.target)?.name ?? '';
  if (event.type==='citizen_arrived') return `${actor} entered ${target}.`;
  if (event.type==='citizen_departed') return `${actor} left ${target}.`;
  if (event.type==='citizen_spoke') return `${actor} is talking to ${target}.`;
  if (event.type==='day_ended') return 'A new day begins in downtown Cairo.';
  return `${actor}: ${event.type.replaceAll('_',' ')}${target?` — ${target}`:''}`;
}
export function TownHUD({ player: initialPlayer, onBack }: { player:PlayerProfile; onBack:()=>void }) {
  const {world,status,observerRevision,characterRevision}=useWorld();
  const [player,setPlayer]=useState(initialPlayer);
  const [view,setView]=useState('map');
  const [selectedId,setSelectedId]=useState<string|null>('karim');
  const [followId,setFollowId]=useState<string|null>(null);
  const [sheetOpen,setSheetOpen]=useState(false);
  const [archiveDay,setArchiveDay]=useState<number|undefined>();
  const lastDay=useRef<number|null>(null),gameDay=world?.day;
  useEffect(()=>{if(gameDay===undefined)return;const previous=lastDay.current;lastDay.current=gameDay;if(previous!==null&&gameDay>previous){setArchiveDay(undefined);setView('newspaper');}},[gameDay]);
  if (!world || status==='Login required') return <main className="hud loading"><h1>Wust El Balad</h1><p>{status}…</p><button onClick={onBack}>Back to account</button></main>;
  const selected=world.citizens.find((citizen)=>citizen.id===selectedId);
  const importantRevision=world.events.filter(event=>event.importance>=50).at(-1)?.id??0;
  function select(id:string|null) { setSelectedId(id); setView('map'); setSheetOpen(!!id); }
  function citizens() { return <div className="citizen-list">{world!.citizens.map((citizen)=><button key={citizen.id} className={selectedId===citizen.id?'selected':''} onClick={()=>select(citizen.id)}><CitizenPortrait citizen={citizen} size={32}/><span>{citizen.name}<small>{citizen.activity}</small></span></button>)}</div>; }
  function details() { return <CharacterSheet citizen={selected} buildings={world!.buildings} followId={followId} onFollow={setFollowId} onTool={tool=>{setArchiveDay(undefined);setView(tool);}}/>; }
  function tool() {
    if (view==='citizens') return <><h2>Citizens</h2>{citizens()}</>;
    if (view==='profile') return <AccountPanel onProfileChange={setPlayer}/>;
    if (view==='ai-settings') return player.role==='admin'?<AiSettings/>:<p>Admin access required.</p>;
    if(view==='observer-chat')return <ObserverChat revision={observerRevision}/>;
    if(view==='character-chat')return <CharacterChat day={archiveDay} citizenId={selectedId??world!.citizens[0].id} citizens={world!.citizens} onCitizenChange={setSelectedId} revision={characterRevision}/>;
    if(view==='interrogation')return <Interrogation citizenId={selectedId??world!.citizens[0].id} citizens={world!.citizens} onCitizenChange={setSelectedId}/>;
    if(view==='timeline'||view==='newspaper')return <TownArchives key={`archive-${archiveDay??'current'}`} initialDay={archiveDay} mode={view} currentDay={world!.day} onModeChange={setView}/>;
    if(view==='investigation')return <Investigation key={`investigation-${archiveDay??'choose'}`} initialDay={archiveDay} currentDay={world!.day}/>;
    if(view==='rumors')return <Rumors/>;
    if(view==='catchup')return <CatchUp onOpen={(next,day)=>{setArchiveDay(day);setView(next);}}/>;
    if (coming[view]) return <><h2>{titles[view]}</h2><p className="quiet">This gameplay panel will be implemented in Task {coming[view]}.</p></>;
    if (view==='events') return <><ImportantEvents revision={importantRevision}/><button onClick={()=>setView('timeline')}>Timeline</button><button onClick={()=>setView('newspaper')}>Newspaper</button><button onClick={()=>setView('investigation')}>Investigate</button></>;
    if (view==='players') return <><h2>Observers</h2><p>{world!.playerCount}/6 players connected.</p><p className="quiet">AI citizens cannot see player discussion.</p><button onClick={()=>setView('observer-chat')}>Observer Chat</button><button onClick={()=>setView('profile')}>Profile</button><button onClick={()=>setView('leaderboard')}>Leaderboard</button></>;
    if (view==='influence') return <InfluencePanel citizens={world!.citizens} selectedCitizenId={selectedId} onCitizenChange={setSelectedId}/>;
    return null;
  }
  const showTool=view!=='map';
  return <main className="hud" data-view={view}>
    <header className="hud-top"><div className="hud-brand"><PixelIcon name="map"/><h1>Wust El Balad</h1><span>Downtown Cairo</span></div><div className="hud-clock"><PixelIcon name="clock"/><strong>DAY {world.day}</strong><span>{timeLabel(world.minute)}</span><span className={status==='Live'?'live':'quiet'}>{status.toUpperCase()}</span><span>PLAYERS {world.playerCount}/6</span></div><button onClick={onBack} className="account-return">Account</button></header>
    <nav className="hud-nav" aria-label="Town views">{core.map((item)=><button key={item.id} aria-pressed={view===item.id} onClick={()=>{setArchiveDay(undefined);setView(item.id);setSheetOpen(false);}}><PixelIcon name={item.icon}/><span>{item.label}</span></button>)}<label className="more-tools">Tools<select aria-label="More gameplay views" value={core.some((item)=>item.id===view)?'':view} onChange={(event)=>{if(event.target.value){setArchiveDay(undefined);setView(event.target.value);setSheetOpen(false);}}}><option value="">Choose…</option>{Object.entries(titles).filter(([id])=>!core.some((item)=>item.id===id)&&(id!=='ai-settings'||player.role==='admin')).map(([id,title])=><option key={id} value={id}>{title}</option>)}</select></label></nav>
    <section className="hud-world"><aside className="retro-panel citizens-panel"><h2>Citizens</h2>{citizens()}</aside><section className="map-panel retro-panel"><TownMap world={world} selectedId={selectedId} onSelect={select} followId={followId} onStopFollow={()=>setFollowId(null)}/><div className="activity-strip" aria-live="off">{world.events.length?eventLabel(world.events.at(-1)!,world):'The town is finding its rhythm.'}</div>{showTool&&<section className={`retro-panel tool-sheet ${view==='citizens'?'mobile-citizens':''}`} aria-label={titles[view]??view}><button className="sheet-close" onClick={()=>setView('map')}>Close</button>{tool()}</section>}{view==='map'&&sheetOpen&&<section className="retro-panel mobile-character"><button className="sheet-close" onClick={()=>setSheetOpen(false)}>Close</button>{details()}</section>}</section><aside className="retro-panel character-panel"><h2>Character Sheet</h2>{details()}</aside></section>
    <footer className="hud-bottom"><section className="retro-panel"><ImportantEvents revision={importantRevision} compact/></section><section className="retro-panel"><ObserverChat revision={observerRevision} compact/></section></footer>
  </main>;
}
