import type {PlayerProfile} from './auth.js';
export interface PlayerStatistics {investigations:number;accuracy:number|null;majorEventsDiscovered:number;successfulInterventions:number;approvedRumors:number}
export interface LeaderboardEntry extends PlayerProfile {rank:number;statistics:PlayerStatistics}
export interface LeaderboardResponse {players:LeaderboardEntry[]}
export interface PlayerProfileResponse {player:LeaderboardEntry}
