export interface CatchUpDay {day:number;headline:string|null;newspaperReady:boolean;publicEvents:number;conversations:number;investigationStatus:'open'|'pending'|'submitted'|'skipped';reviewed:boolean}
export interface CatchUpBoard {currentDay:number;fromGameMs:number;days:CatchUpDay[];hasMore:boolean}
