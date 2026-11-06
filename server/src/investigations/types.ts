export interface TruthFact {eventId:number;actorId:string|null;actorName:string;action:string;targetId:string|null;targetName:string;locationId:string|null;locationName:string;amount:number|null;gameTimeMs:number}
export interface ScoreMatch {eventId:number;quote:string;quality:number}
export interface ScoreEvaluation {matches:ScoreMatch[];source:'local'|'network'}
