export interface InvestigationResult {correctEvents:number;totalEvents:number;accuracy:number;influenceAwarded:number;source:'local'|'network'}
export interface InvestigationSubmission {id:string;day:number;answer:string;status:'pending'|'submitted'|'skipped';result:InvestigationResult|null}
export interface InvestigationView {day:number;status:'open'|'pending'|'submitted'|'skipped';own:InvestigationSubmission|null;others:{playerId:string;username:string;answer:string;result:InvestigationResult|null}[]}
export interface InvestigationDay {day:number;status:'open'|'pending'|'submitted'|'skipped'}
