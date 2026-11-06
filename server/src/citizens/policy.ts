import { waitAction,type CitizenAction,type ReasoningFrame } from './reasoning-types.js';
export function enrichDialogue(frame:ReasoningFrame,targetId:string,baseText:string):Pick<CitizenAction,'text'|'stance'|'sources'> {
  const peer=frame.nearby.find(p=>p.id===targetId);if(!peer)return {text:baseText.slice(0,280),stance:'personal',sources:[]};
  if(peer.fear>=60)return {text:`${peer.name}, I would rather keep things calm.`,stance:'personal',sources:[]};
  if(peer.grudge>=60)return {text:`${peer.name}, I still feel uneasy about our differences.`,stance:'belief',sources:[]};
  if(peer.suspicion>=65)return {text:`${peer.name}, I am not ready to believe every claim I hear.`,stance:'belief',sources:[]};
  const incoming=frame.sources.find(s=>s.id.startsWith('conversation:')&&s.kind==='told');
  if(incoming&&peer.trust>=55)return {text:`${peer.name}, I heard what was said, but I want to judge it carefully. ${baseText}`.slice(0,280),stance:'told',sources:[incoming.id]};
  const memory=frame.sources.find(s=>s.kind==='observation'&&s.claim.length<150&&s.id.startsWith('memory:'));
  if(memory&&peer.trust>=60)return {text:`${peer.name}, I remember: ${memory.claim} ${baseText}`.slice(0,280),stance:'observation',sources:[memory.id]};
  return {text:baseText.slice(0,280),stance:'personal',sources:[]};
}
export function localCitizenPolicy(frame:ReasoningFrame):CitizenAction {
  const self=frame.self,needs=self.needs;
  if(needs.hunger>=65)return {...waitAction(),action:'go',target:needs.energy<30?self.homeId:'cafe',goal:'eat'};
  if(needs.energy<=25)return {...waitAction(),action:'go',target:self.homeId,goal:'sleep'};
  if(frame.canSpeak&&frame.nearby.length&&(self.activity==='socializing'||frame.trigger==='heard_dialogue'||self.mood==='Lonely')) {
    const peer=frame.nearby[0],base=self.money<30000?`${peer.name}, I need to watch my EGP and meet my obligations.`:self.mood==='Wary'?`${peer.name}, I am trying to understand what is happening without jumping to conclusions.`:`How are you, ${peer.name}? I have been busy as a ${self.job.toLowerCase()}.`;
    return {...waitAction(),action:'speak',target:peer.id,...enrichDialogue(frame,peer.id,base)};
  }
  if(Number(frame.context.debtTotal)>0&&self.money>5000&&self.activity!=='banking')return {...waitAction(),action:'go',target:'bank',goal:'bank'};
  if(needs.social>=65&&self.activity!=='socializing')return {...waitAction(),action:'go',target:'square',goal:'socialize'};
  return waitAction();
}
