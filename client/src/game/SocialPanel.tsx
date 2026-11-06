import { useEffect,useState } from 'react';
import type { PublicSocial } from '../../../server/src/social/types';
export function SocialPanel({citizenId}:{citizenId:string}) {
  const [social,setSocial]=useState<PublicSocial|null>(null),[error,setError]=useState(false);
  useEffect(()=>{
    const controller=new AbortController();let live=true;setSocial(null);setError(false);
    const load=async()=>{try{const response=await fetch(`/api/social/${encodeURIComponent(citizenId)}`,{signal:controller.signal});if(!response.ok)throw new Error('Unavailable');const next=await response.json() as PublicSocial;if(live){setSocial(next);setError(false);}}catch{if(live)setError(true);}};
    void load();const timer=setInterval(()=>{void load();},10000);
    return()=>{live=false;controller.abort();clearInterval(timer);};
  },[citizenId]);
  if(!social)return <p className="quiet">{error?'Social records unavailable.':'Loading social records…'}</p>;
  return <section className="social-panel"><h3>Reputation</h3><p>{social.reputation}/100</p><h3>Outgoing relationships</h3><p className="quiet">How this citizen sees others; the reverse relationship can differ.</p>
    {social.relationships.map(relation=><details key={relation.otherId}><summary>{relation.name} · Trust {relation.trust}</summary><dl>{Object.entries(relation).filter(([key])=>!['name','otherId'].includes(key)).map(([key,value])=><div key={key}><dt>{key}</dt><dd>{key==='debt'?`EGP ${(Number(value)/100).toFixed(2)}`:String(value)}</dd></div>)}</dl></details>)}
    <h3>Disclosed memories</h3><p className="quiet">Heard claims and impressions are not confirmed facts. Private knowledge stays private.</p>
    {social.memories.length?social.memories.map(memory=><article key={memory.id}><small>{memory.layer.replaceAll('_',' ')} · {memory.provenance} · {memory.confidence}% confidence</small><p>{memory.content}</p></article>):<p className="quiet">No public memories yet.</p>}
  </section>;
}
