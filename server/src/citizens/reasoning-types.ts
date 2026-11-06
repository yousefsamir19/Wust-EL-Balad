import type { TownBuilding } from '../../../shared/world.js';
export type CitizenIntent='wait'|'go'|'speak'|'transfer';
export type CitizenGoal='idle'|'work'|'eat'|'sleep'|'socialize'|'bank';
export type SpeechStance='personal'|'observation'|'told'|'belief'|'lie';
export interface CitizenAction {action:CitizenIntent;target:string;goal:CitizenGoal;amount:number;text:string;stance:SpeechStance;sources:string[]}
export interface ReasoningFrame {citizenId:string;gameTimeMs:number;worldVersion:number;self:{id:string;name:string;job:string;money:number;x:number;y:number;buildingId:string|null;homeId:string;workplaceId:string|null;activity:string;mood:string;needs:{hunger:number;energy:number;social:number}};context:Record<string,unknown>;nearby:{id:string;name:string;job:string;trust:number;affection:number;fear:number;grudge:number;suspicion:number}[];buildings:TownBuilding[];sources:{id:string;kind:string;claim:string;confidence:number}[];canSpeak:boolean;trigger:string}
export interface ActionResult {accepted:boolean;action:CitizenIntent;reason:string|null;eventId?:number}
export const ACTION_SCHEMA={type:'object',properties:{action:{type:'string',enum:['wait','go','speak','transfer']},target:{type:'string'},goal:{type:'string',enum:['idle','work','eat','sleep','socialize','bank']},amount:{type:'integer',minimum:0},text:{type:'string'},stance:{type:'string',enum:['personal','observation','told','belief','lie']},sources:{type:'array',items:{type:'string'},maxItems:8}},required:['action','target','goal','amount','text','stance','sources'],additionalProperties:false};
export const waitAction=():CitizenAction=>({action:'wait',target:'',goal:'idle',amount:0,text:'',stance:'personal',sources:[]});
