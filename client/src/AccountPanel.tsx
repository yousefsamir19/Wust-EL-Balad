import { useEffect, useState, type FormEvent } from 'react';
import type { PlayerProfile } from '../../shared/auth';
import { PixelAvatar } from './game/AssetGallery';
import { LiveStatus } from './realtime/LiveStatus';

export function AccountPanel() {
  const [player, setPlayer] = useState<PlayerProfile | null>(null);
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [username, setUsername] = useState('');
  const [avatar, setAvatar] = useState(0);
  function showProfile(profile: PlayerProfile) {
    setPlayer(profile); setUsername(profile.username); setAvatar(profile.avatar);
  }
  useEffect(() => {
    let active = true;
    fetch('/api/auth/me').then(async (res) => {
      if (res.ok && active) showProfile((await res.json()).player);
    }).catch(() => { /* login remains available */ });
    return () => { active = false; };
  }, []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('');
    const form = new FormData(event.currentTarget);
    const body = player
      ? { username, avatar }
      : { username: form.get('username'), password: form.get('password'), confirmPassword: form.get('confirmPassword') };
    try {
      const res = await fetch(player ? '/api/auth/profile' : `/api/auth/${mode}`, {
        method: player ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error ?? 'Request failed');
      showProfile(result.player);
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Request failed'); }
    finally { setBusy(false); }
  }
  async function logout() {
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/auth/logout', { method: 'POST' });
      if (!response.ok) throw new Error('Logout failed');
      setPlayer(null);
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Logout failed'); }
    finally { setBusy(false); }
  }
  return (
    <section className="accounts mt-8" aria-label="Player account">
      <h2 className="text-xl font-bold">{player ? `Observer: ${player.username}` : mode === 'signup' ? 'Create observer account' : 'Observer login'}</h2>
      {player && <div className="mt-3"><PixelAvatar avatar={avatar} label={`${player.username}'s selected observer avatar`} /></div>}
      {player && <p className="mt-2">{player.role} · Influence: {player.influence}</p>}
      {player && <LiveStatus />}
      <form onSubmit={submit} className="mt-4 flex flex-col gap-3">
        <label>Username<input key={player ? 'profile' : 'credentials'} name="username" required minLength={3} maxLength={24} pattern="[A-Za-z0-9_]+" autoComplete="username" {...(player ? { value: username, onChange: (e) => setUsername(e.target.value) } : {})} /></label>
        {!player && <label>Password<input name="password" type="password" required minLength={mode === 'signup' ? 10 : 1} maxLength={128} autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} /></label>}
        {!player && mode === 'signup' && <label>Confirm password<input name="confirmPassword" type="password" required minLength={10} maxLength={128} autoComplete="new-password" /></label>}
        {player && <label>Observer avatar<select value={avatar} onChange={(e) => setAvatar(Number(e.target.value))}>{Array.from({ length: 10 }, (_, index) => <option key={index} value={index}>Observer {index + 1}</option>)}</select></label>}
        <button disabled={busy} type="submit">{busy ? 'Please wait…' : player ? 'Save profile' : mode === 'signup' ? 'Sign up' : 'Log in'}</button>
      </form>
      {error && <p className="mt-3 text-red-300" role="alert">{error}</p>}
      {player ? <button className="mt-3" disabled={busy} onClick={logout}>Log out</button> : <button className="mt-3" disabled={busy} onClick={() => { setMode(mode === 'login' ? 'signup' : 'login'); setError(''); }}>{mode === 'login' ? 'Create an account' : 'Already registered? Log in'}</button>}
    </section>
  );
}
