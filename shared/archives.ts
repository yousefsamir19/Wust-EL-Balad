import type { PublicEvent } from './realtime.js';
export type NewsLabel='confirmed'|'rumor'|'unverified';
export interface ArchiveEvent extends PublicEvent {actorName:string;targetName:string;causeId:number|null;causeDay:number|null;label:NewsLabel}
export interface NewsItem {eventId:number;text:string;label:NewsLabel;gameTimeMs:number;causeId:number|null;causeDay:number|null}
export interface Newspaper {day:number;title:'The Downtown Gazette';headline:string;items:NewsItem[];source:'local'|'network';snapshotHash:string;closedGameMs:number}
export interface ArchiveDay {day:number;closedGameMs:number;status:'pending'|'done';majorEvents:number}
export interface TimelinePage {items:ArchiveEvent[];olderCursor:number|null;hasMore:boolean}
