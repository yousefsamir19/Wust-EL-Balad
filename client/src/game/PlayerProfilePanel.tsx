import { useCallback, useEffect, useRef, useState } from 'react';
import type { PlayerProfile } from '../../../shared/auth';
import type { LeaderboardEntry } from '../../../shared/players';
import { PixelAvatar } from './AssetGallery';
import { AccountPanel } from '../AccountPanel';
import './players.css';

function formatAccuracy(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return `${value.toFixed(1)}%`;
}

function formatError(status: number, message: unknown): string {
  if (typeof message === 'object' && message !== null && 'error' in message && typeof message.error === 'string') return message.error;
  if (status === 401) return 'Sign in to view this profile.';
  if (status === 403) return 'This profile is not available.';
  if (status === 404) return 'That observer profile was not found.';
  return 'The observer profile could not be loaded.';
}

async function readProfile(response: Response): Promise<LeaderboardEntry> {
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(formatError(response.status, body));
  if (!body || typeof body !== 'object' || !('player' in body)) throw new Error('The observer profile response was incomplete.');
  return (body as { player: LeaderboardEntry }).player;
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return <div className="players-stat"><dt>{label}</dt><dd>{value}</dd></div>;
}

export function PlayerProfilePanel({
  player,
  viewedPlayerId,
  onProfileChange,
}: {
  player: PlayerProfile;
  viewedPlayerId?: string;
  onProfileChange: (player: PlayerProfile) => void;
}) {
  const targetId = viewedPlayerId ?? player.id;
  const isSelf = targetId === player.id;
  const [profile, setProfile] = useState<LeaderboardEntry | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const requestRef = useRef<AbortController | null>(null);
  const requestIdRef = useRef(0);

  const load = useCallback(async () => {
    requestRef.current?.abort();
    const controller = new AbortController();
    const requestId = ++requestIdRef.current;
    requestRef.current = controller;
    setLoading(true);
    setError('');
    try {
      const response = await fetch(`/api/players/${encodeURIComponent(targetId)}`, { credentials: 'same-origin', signal: controller.signal });
      const nextProfile = await readProfile(response);
      if (controller.signal.aborted || requestId !== requestIdRef.current) return;
      setProfile(nextProfile);
      if (isSelf) onProfileChange(nextProfile);
    } catch (failure) {
      if (controller.signal.aborted || requestId !== requestIdRef.current) return;
      setError(failure instanceof Error ? failure.message : 'The observer profile could not be loaded.');
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null;
        if (!controller.signal.aborted && requestId === requestIdRef.current) setLoading(false);
      }
    }
  }, [isSelf, onProfileChange, targetId]);

  useEffect(() => {
    setProfile(null);
    void load();
    return () => {
      requestIdRef.current += 1;
      requestRef.current?.abort();
    };
  }, [load]);

  const displayed = profile ?? (isSelf ? player : null);
  const rank = profile?.rank;

  return (
    <section className="players players-profile" aria-label="Player Profile">
      <header className="players-header">
        <div>
          <h2>{isSelf ? 'Player Profile' : 'Public Player Profile'}</h2>
          <p className="players-subtitle">{isSelf ? 'Your public observer record.' : 'A read-only public observer record.'}</p>
        </div>
        <button className="players-refresh" type="button" onClick={() => void load()} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </header>
      <p className="players-definition">Success = accepted suggestion, not guaranteed action. No streaks.</p>
      {error && <p className="players-error" role="alert">{error}</p>}
      {loading && !displayed && <p className="players-status">Loading observer profile…</p>}
      {displayed && (
        <div className="players-profile-card">
          <div className="players-profile-heading">
            <PixelAvatar avatar={displayed.avatar} label={`${displayed.username}'s observer avatar`} size={76} />
            <div>
              <p className="players-rank-label">{rank === undefined ? 'Rank —' : `Rank #${rank}`}</p>
              <h3>{displayed.username}</h3>
              <p className="players-profile-role">{isSelf ? 'Your observer account' : 'Public observer'}</p>
            </div>
          </div>
          <dl className="players-stats players-profile-stats">
            <Stat label="Current influence" value={profile?.influence ?? (isSelf ? player.influence : '—')} />
            <Stat label="Completed investigations" value={profile?.statistics.investigations ?? '—'} />
            <Stat label="Weighted investigation accuracy" value={formatAccuracy(profile?.statistics.accuracy ?? null)} />
            <Stat label="Major events discovered" value={profile?.statistics.majorEventsDiscovered ?? '—'} />
            <Stat label="Successful accepted nudges" value={profile?.statistics.successfulInterventions ?? '—'} />
            <Stat label="Approved published rumor participation" value={profile?.statistics.approvedRumors ?? '—'} />
          </dl>
          {isSelf && <details className="players-account"><summary>Edit username and pixel avatar</summary><AccountPanel onProfileChange={updated=>{onProfileChange(updated);void load();}}/></details>}
        </div>
      )}
    </section>
  );
}
