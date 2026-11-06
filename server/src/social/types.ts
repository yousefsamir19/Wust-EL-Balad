export type Provenance='observation'|'told'|'belief'|'rumor'|'summary';
export interface SocialEvent { id:number;world_version:number;game_time_ms:number;type:string;actor_id:string|null;target:string|null;amount:number|null;importance:number;visibility:string;details:string }
export interface PublicRelationship {otherId:string;name:string;trust:number;affection:number;respect:number;fear:number;debt:number;grudge:number;suspicion:number;dependence:number}
export interface PublicMemory {id:number;layer:string;content:string;gameTimeMs:number;provenance:Provenance;confidence:number;sourceEventId:number|null}
export interface PublicSocial {citizenId:string;reputation:number;relationships:PublicRelationship[];memories:PublicMemory[]}
