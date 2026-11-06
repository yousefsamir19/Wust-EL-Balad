export type RumorStatus='pending'|'published'|'expired';
export interface RumorRecord {id:string;proposerId:string;proposerName:string;text:string;revision:number;status:RumorStatus;proposedDay:number;expiresAt:number;publishedGameMs:number|null;publishedEventId:number|null;voters:{id:string;username:string;approved:boolean}[];approvedCount:number;requiredCount:number}
export interface RumorBoard {currentDay:number;nextOpportunityDay:number;canPropose:boolean;rumors:RumorRecord[]}
