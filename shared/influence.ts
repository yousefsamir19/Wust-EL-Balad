export type InterventionStrength='subtle'|'medium'|'strong';
export type InterventionOutcome='accepted'|'considered'|'ignored'|'rejected';
export interface InterventionRecord {id:string;day:number;citizenId:string;strength:InterventionStrength;suggestion:string;cost:number;outcome:InterventionOutcome;eventId:number|null}
export interface InfluenceWallet {balance:number;day:number;available:boolean;costs:Record<InterventionStrength,number>;history:InterventionRecord[]}
export interface InterventionResponse {intervention:InterventionRecord;wallet:InfluenceWallet}
