import { useCallback, useEffect, useRef, useState } from 'react';
import type { LeaderboardEntry, LeaderboardResponse } from '../../../shared/players';
import { PixelAvatar } from './AssetGallery';
import './players.css';

type LoadState = 'loading' | 'ready' | 'error';

function formatAccuracy(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return `${value.toFixed(1)}%`;
}

function formatError(status: number, message: unknown, fallback: string): string {
  return typeof message === 'object' && message !== null && 'error' in message && typeof message.error === 'string'
    ? message.error
    : status === 401
      ? 'Sign in to view the leaderboard.'
      : status === 403
        ? 'This leaderboard is not available for this account.'
        : fallback;
}

async function readResponse(response: Response): Promise<LeaderboardResponse> {
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(formatError(response.status, body, 'The leaderboard could not be loaded.'));
  if (!body || typeof body !== 'object' || !Array.isArray((body as { players?: unknown }).players)) {
    throw new Error('The leaderboard response was incomplete.');
  }
  return body as LeaderboardResponse;
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return <div className="players-stat"><dt>{label}</dt><dd>{value}</dd></div>;
}

export function Leaderboard({ onProfile }: { onProfile: (id: string) => void }) {
  const [players, setPlayers] = useState<LeaderboardEntry[]>([]);
  const [state, setState] = useState<LoadState>('loading');
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const requestRef = useRef<AbortController | null>(null);

  const load = useCallback(async (initial = false) => {
    if (requestRef.current) return;
    const controller = new AbortController();
    requestRef.current = controller;
    setRefreshing(true);
    if (initial) setState('loading');
    setError('');
    try {
      const response = await fetch('/api/leaderboard', { credentials: 'same-origin', signal: controller.signal });
      const payload = await readResponse(response);
      if (!controller.signal.aborted) {
        setPlayers(payload.players);
        setState('ready');
      }
    } catch (failure) {
      if (!controller.signal.aborted) {
        setState('error');
        setError(failure instanceof Error ? failure.message : 'The leaderboard could not be loaded.');
      }
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null;
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    void load(true);
    return () => requestRef.current?.abort();
  }, [load]);

  return (
    <section className="players players-leaderboard" aria-label="Leaderboard">
      <header className="players-header">
        <div>
          <h2>Leaderboard</h2>
          <p className="players-subtitle">Public observer progress, based on the town record.</p>
        </div>
        <button className="players-refresh" type="button" onClick={() => void load()} disabled={refreshing}>
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </header>
      <p className="players-definition">Success = accepted suggestion, not guaranteed action. No streaks.</p>
      {error && <p className="players-error" role="alert">{error}</p>}
      {state === 'loading' && players.length === 0 && <p className="players-status">Loading leaderboard…</p>}
      {state !== 'loading' && !error && players.length === 0 && <p className="players-status">No public observer records yet.</p>}
      {players.length > 0 && (
        <div className="players-list" aria-live="polite">
          {players.map((entry) => (
            <article className="players-card" key={entry.id}>
              <button className="players-card-link" type="button" onClick={() => onProfile(entry.id)} aria-label={`View public profile for ${entry.username}`}>
                <span className="players-rank" aria-label={`Rank ${entry.rank}`}>#{entry.rank}</span>
                <PixelAvatar avatar={entry.avatar} label={`${entry.username}'s observer avatar`} size={56} />
                <span className="players-identity"><strong>{entry.username}</strong><small>Public profile</small></span>
              </button>
              <dl className="players-stats">
                <Stat label="Current influence" value={entry.influence} />
                <Stat label="Completed investigations" value={entry.statistics.investigations} />
                <Stat label="Weighted investigation accuracy" value={formatAccuracy(entry.statistics.accuracy)} />
                <Stat label="Major events discovered" value={entry.statistics.majorEventsDiscovered} />
                <Stat label="Successful accepted nudges" value={entry.statistics.successfulInterventions} />
                <Stat label="Approved published rumor participation" value={entry.statistics.approvedRumors} />
              </dl>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
