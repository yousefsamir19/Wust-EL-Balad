export type Wallet = `citizen:${string}` | `business:${string}` | `bank:${string}` | `system:${string}`;
export interface Business { id:string; owner_id:string|null; balance:number; stock:number; wage:number; capacity:number; job_title:string }
export const MEAL_PRICE = 2500;
export const RENT = 2000;
export const DAY_MS = 86400000;
export const businessDefaults: Record<string,{owner:string|null;wage:number;capacity:number;job:string}> = {
  cafe:{owner:'laila',wage:10000,capacity:3,job:'Cafe worker'},bank:{owner:null,wage:12000,capacity:3,job:'Bank clerk'},
  police:{owner:null,wage:11000,capacity:2,job:'Police officer'},mechanic:{owner:'karim',wage:10000,capacity:3,job:'Mechanic'},
  store:{owner:'youssef',wage:9000,capacity:2,job:'Store clerk'},square:{owner:null,wage:8000,capacity:3,job:'Market worker'},
};
