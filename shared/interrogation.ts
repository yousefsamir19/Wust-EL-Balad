export type TestimonyBasis='observed'|'heard'|'believed'|'personal'|'mixed'|'unknown'|'refused';
export interface InterrogationRecord {id:string;citizenId:string;question:string;answer:string|null;basis:TestimonyBasis;status:'pending'|'done'|'failed';gameTimeMs:number;createdAt:string;source:'local'|'network'}
export interface TestimonyChoice {sources:string[];response:'share'|'unsure'|'refuse'}
