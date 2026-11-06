export interface PlayerProfile {
  id: string;
  username: string;
  role: 'player' | 'admin';
  avatar: number;
  influence: number;
}
