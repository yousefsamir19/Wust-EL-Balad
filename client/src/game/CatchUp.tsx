import { useCallback, useEffect, useRef, useState } from 'react';
import type { CatchUpBoard, CatchUpDay } from '../../../shared/catchup';
import './catchup.css';

export type CatchUpView = 'newspaper' | 'timeline' | 'character-chat' | 'investigation';

type CatchUpAction = 'review' | 'skip';
const DAY_MS = 86400000;
const STATUSES = new Set<CatchUpDay['investigationStatus']>(['open', 'pending', 'submitted', 'skipped']);

function mergeDays(current: CatchUpDay[], incoming: CatchUpDay[]): CatchUpDay[] {
  const byDay = new Map<number, CatchUpDay>();
  for (const day of current) byDay.set(day.day, day);
  for (const day of incoming) byDay.set(day.day, day);
  return [...byDay.values()].sort((left, right) => right.day - left.day);
}

function boardPayload(payload: unknown): unknown {
  if (payload && typeof payload === 'object' && 'board' in payload) return (payload as { board?: unknown }).board;
  return payload;
}

function parseBoard(payload: unknown): CatchUpBoard | null {
  const raw = boardPayload(payload);
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Partial<CatchUpBoard>;
  if (!Number.isSafeInteger(value.currentDay) || typeof value.fromGameMs !== 'number' || !Array.isArray(value.days)) return null;
  const days = value.days.filter((item): item is CatchUpDay => {
    if (!item || typeof item !== 'object') return false;
    const day = item as Partial<CatchUpDay>;
    return Number.isSafeInteger(day.day) && typeof day.headline === 'string' ||
      Number.isSafeInteger(day.day) && day.headline === null;
  }).map((item) => {
    const day = item as Partial<CatchUpDay>;
    return {
      day: day.day as number,
      headline: typeof day.headline === 'string' ? day.headline : null,
      newspaperReady: day.newspaperReady === true,
      publicEvents: typeof day.publicEvents === 'number' && day.publicEvents >= 0 ? day.publicEvents : 0,
      conversations: typeof day.conversations === 'number' && day.conversations >= 0 ? day.conversations : 0,
      investigationStatus: STATUSES.has(day.investigationStatus as CatchUpDay['investigationStatus']) ? day.investigationStatus as CatchUpDay['investigationStatus'] : 'open',
      reviewed: day.reviewed === true,
    };
  });
  return { currentDay: value.currentDay as number, fromGameMs: value.fromGameMs, days, hasMore: value.hasMore === true };
}

async function responseError(response: Response, fallback: string): Promise<Error> {
  let message = '';
  try {
    const payload = await response.json() as { error?: unknown };
    if (typeof payload?.error === 'string') message = payload.error;
  } catch {
    // Keep the stable client message when the server did not return JSON.
  }
  return new Error(message || `${fallback} (HTTP ${response.status}).`);
}

function statusLabel(status: CatchUpDay['investigationStatus']): string {
  if (status === 'submitted') return 'Investigation submitted';
  if (status === 'skipped') return 'Investigation skipped';
  if (status === 'pending') return 'Investigation pending';
  return 'Investigation open';
}

export function CatchUp({ onOpen }: { onOpen: (view: CatchUpView, day: number) => void }) {
  const [board, setBoard] = useState<CatchUpBoard | null>(null);
  const [loading, setLoading] = useState(true);
  const [olderLoading, setOlderLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionBusyDays, setActionBusyDays] = useState<Set<number>>(() => new Set());
  const [actionErrors, setActionErrors] = useState<Record<number, string>>({});
  const [retryToken, setRetryToken] = useState(0);
  const boardRef = useRef<CatchUpBoard | null>(null);
  const olderBusyRef = useRef(false);
  const actionBusyRef = useRef(new Set<number>());
  const actionKindsRef = useRef<Record<number, CatchUpAction>>({});
  const protectedDaysRef = useRef(new Set<number>());
  const mountedRef = useRef(false);

  const mergeBoard = useCallback((incoming: CatchUpBoard, authoritative = false) => {
    setBoard((current) => {
      const existing = current?.days ?? boardRef.current?.days ?? [];
      const protectedIncoming = authoritative ? incoming.days : incoming.days.map((day) => protectedDaysRef.current.has(day.day) ? existing.find((currentDay) => currentDay.day === day.day) ?? day : day);
      const next = { ...incoming, days: mergeDays(existing, protectedIncoming) };
      boardRef.current = next;
      return next;
    });
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void fetch('/api/catch-up', { credentials: 'same-origin', signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw await responseError(response, 'Catch-up board unavailable');
      const parsed = parseBoard(await response.json());
      if (!parsed) throw new Error('Catch-up board unavailable.');
      return parsed;
    }).then((next) => {
      if (!controller.signal.aborted) mergeBoard(next);
    }).catch((reason) => {
      if (!controller.signal.aborted && mountedRef.current) setError(reason instanceof Error ? reason.message : 'Catch-up board unavailable.');
    }).finally(() => {
      if (!controller.signal.aborted && mountedRef.current) setLoading(false);
    });
    return () => controller.abort();
  }, [mergeBoard, retryToken]);

  const loadOlder = useCallback(() => {
    const current = boardRef.current;
    const oldestDay = current?.days.at(-1)?.day;
    if (!current?.hasMore || oldestDay === undefined || olderBusyRef.current) return;
    olderBusyRef.current = true;
    setOlderLoading(true);
    setError(null);
    const controller = new AbortController();
    void fetch(`/api/catch-up?beforeDay=${encodeURIComponent(String(oldestDay))}`, { credentials: 'same-origin', signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw await responseError(response, 'Older catch-up days unavailable');
      const parsed = parseBoard(await response.json());
      if (!parsed) throw new Error('Older catch-up days unavailable.');
      return parsed;
    }).then((next) => {
      if (mountedRef.current && !controller.signal.aborted) mergeBoard(next);
    }).catch((reason) => {
      if (mountedRef.current && !controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Older catch-up days unavailable.');
    }).finally(() => {
      olderBusyRef.current = false;
      if (mountedRef.current && !controller.signal.aborted) setOlderLoading(false);
    });
  }, [mergeBoard]);

  async function performAction(day: number, action: CatchUpAction) {
    const current = boardRef.current?.days.find((item) => item.day === day);
    if (!current || actionBusyRef.current.has(day) || (action === 'skip' && current.investigationStatus !== 'open')) return;
    actionBusyRef.current.add(day);
    actionKindsRef.current[day] = action;
    setActionBusyDays((previous) => new Set(previous).add(day));
    setActionErrors((previous) => { const next = { ...previous }; delete next[day]; return next; });
    try {
      const response = await fetch(`/api/catch-up/${day}/${action}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (!response.ok) throw await responseError(response, action === 'skip' ? 'Could not skip this investigation' : 'Could not mark this day reviewed');
      const next = parseBoard(await response.json());
      if (!next) throw new Error('The catch-up response was incomplete.');
      protectedDaysRef.current.add(day);
      if (mountedRef.current) mergeBoard(next, true);
    } catch (reason) {
      if (mountedRef.current) setActionErrors((previous) => ({ ...previous, [day]: reason instanceof Error ? reason.message : 'The action could not be completed. Retry the same action.' }));
    } finally {
      actionBusyRef.current.delete(day);
      if (mountedRef.current) setActionBusyDays((previous) => { const next = new Set(previous); next.delete(day); return next; });
    }
  }

  const days = board?.days ?? [];
  const closedDays = board ? days.filter((day) => day.day < board.currentDay) : [];
  const publicEvents = closedDays.reduce((total, day) => total + day.publicEvents, 0);
  const conversations = closedDays.reduce((total, day) => total + day.conversations, 0);
  const investigations = closedDays.filter((day) => day.investigationStatus !== 'skipped').length;
  const headlines = closedDays.filter((day) => day.headline).slice(0, 3);
  const returnDay = board ? Math.max(1, Math.floor(board.fromGameMs / DAY_MS) + 1) : null;

  return <section className="catch-up">
    <header className="catch-up__header"><div><h2>Catch-up board</h2><p>See what the town did while you were away.</p></div></header>
    <p className="catch-up__offline-note">The town kept moving. Offline time has no Influence or streak penalty.</p>
    {error ? <p className="catch-up__error" role="alert">{error} <button type="button" onClick={() => setRetryToken((value) => value + 1)}>Retry</button></p> : null}
    {loading && !board ? <p className="catch-up__status">Loading catch-up…</p> : null}
    {board ? <>
      <section className="catch-up__summary" aria-label="Quick catch-up summary">
        <h3>Quick catch-up</h3>
        <p>Returned from game day {returnDay}. {closedDays.length} closed day{closedDays.length === 1 ? '' : 's'} in view.</p>
        <dl><div><dt>Public events</dt><dd>{publicEvents}</dd></div><div><dt>Conversations</dt><dd>{conversations}</dd></div><div><dt>Investigations</dt><dd>{investigations}</dd></div></dl>
        {headlines.length ? <ul>{headlines.map((day) => <li key={day.day}><strong>Day {day.day}:</strong> {day.headline}</li>)}</ul> : <p>No headlines were recorded in these closed days.</p>}
      </section>
      {days.length ? <div className="catch-up__days" aria-label="Missed closed days">
        {days.map((day) => {
          const busy = actionBusyDays.has(day.day);
          const finalized = day.investigationStatus === 'submitted' || day.investigationStatus === 'skipped';
          return <article className="catch-up-day" key={day.day}>
            <div className="catch-up-day__heading"><div><h3>Day {day.day}</h3>{day.headline ? <p className="catch-up-day__headline">{day.headline}</p> : null}</div><span className={`catch-up-day__status catch-up-day__status--${day.investigationStatus}`}>{statusLabel(day.investigationStatus)}</span></div>
            <p className="catch-up-day__counts">{day.publicEvents} public event{day.publicEvents === 1 ? '' : 's'} · {day.conversations} conversation{day.conversations === 1 ? '' : 's'}</p>
            <div className="catch-up-day__links"><button type="button" disabled={!day.newspaperReady} onClick={() => onOpen('newspaper', day.day)}>Newspaper</button><button type="button" onClick={() => onOpen('timeline', day.day)}>Timeline</button><button type="button" onClick={() => onOpen('character-chat', day.day)}>Conversations</button><button type="button" onClick={() => onOpen('investigation', day.day)}>Investigate</button></div>
            <div className="catch-up-day__actions">
              {day.reviewed ? <span className="catch-up-day__reviewed">Reviewed</span> : <button type="button" disabled={busy} onClick={() => void performAction(day.day, 'review')}>{busy ? 'Saving…' : 'Mark reviewed'}</button>}
              {day.investigationStatus === 'open' && !finalized ? <button type="button" disabled={busy} onClick={() => void performAction(day.day, 'skip')}>{busy ? 'Saving…' : 'Skip investigation (0 Influence)'}</button> : null}
            </div>
            {actionErrors[day.day] ? <p className="catch-up-day__error" role="alert">{actionErrors[day.day]} <button type="button" disabled={busy} onClick={() => void performAction(day.day, actionKindsRef.current[day.day] ?? 'review')}>Retry</button></p> : null}
          </article>;
        })}
        {board.hasMore ? <button className="catch-up__older" type="button" disabled={olderLoading} onClick={loadOlder}>{olderLoading ? 'Loading older days…' : 'Load older days'}</button> : null}
      </div> : <p className="catch-up__status">No closed days are waiting for review.</p>}
    </> : null}
  </section>;
}
