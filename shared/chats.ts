import type { PublicEvent } from './realtime.js';
export interface ObserverMessage {id:number;playerId:string;username:string;avatar:number;text:string;createdAt:string;gameTimeMs:number;day:number}
export interface CharacterMessage {id:number;gameTimeMs:number;day:number;speakerId:string;speakerName:string;recipientId:string;recipientName:string;text:string;visibility:'public'|'private'}
export interface StreamPage<T> {items:T[];olderCursor:number|null;hasMore:boolean}
export interface ImportantEvent extends PublicEvent {actorName:string;targetName:string}
