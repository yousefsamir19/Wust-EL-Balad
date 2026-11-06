export const PROJECT = {
  name: 'Wust El Balad',
  setting: 'Downtown Cairo',
  currency: 'EGP',
  newspaper: 'The Downtown Gazette',
} as const;

export interface HealthResponse {
  status: 'ok';
  project: typeof PROJECT;
}
