import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import type { CharacterMessage, ImportantEvent, ObserverMessage, StreamPage } from '../../../shared/chats';
import type { VisibleCitizen } from '../../../shared/world';
import { CitizenPortrait } from './CharacterSheet';
import { portrait } from './characters';
import { observerAppearance } from './pixels';
import { texture } from './textures';
import './chat.css';

const PAGE_SIZE = 40;
const POLL_MS = 5000;
const GAME_DAY_MS = 86400000;

type Identified = { id: number };
type StreamState<T> = {
  items: T[];
  olderCursor: number | null;
  hasMore: boolean;
  loading: boolean;
  olderLoading: boolean;
  error: string | null;
};

type StreamHandle<T> = StreamState<T> & {
  loadOlder: () => void;
  appendItem: (item: T) => void;
};

function mergeById<T extends Identified>(current: T[], incoming: T[]): T[] {
  const byId = new Map<number, T>();
  for (const item of current) byId.set(item.id, item);
  for (const item of incoming) byId.set(item.id, item);
  return Array.from(byId.values()).sort((left, right) => left.id - right.id);
}

function errorForResponse(response: Response): string {
  if (response.status === 401) return 'Sign in to view these records.';
  if (response.status === 403) return 'You do not have access to these records.';
  if (response.status === 404) return 'These records are unavailable.';
  if (response.status === 429) return 'Too many requests. Try again shortly.';
  return `The records could not be loaded (${response.status}).`;
}

function errorForFailure(failure: unknown): string {
  if (failure instanceof Error && failure.message) return failure.message;
  return 'The records could not be loaded. Check your connection and try again.';
}

async function fetchPage<T extends Identified>(
  endpoint: string,
  signal: AbortSignal,
  direction?: 'before' | 'after',
  cursor?: number,
): Promise<StreamPage<T>> {
  const params = new URLSearchParams();
  if (direction && cursor !== undefined) params.set(direction, String(cursor));
  params.set('limit', String(PAGE_SIZE));
  const response = await fetch(`${endpoint}${endpoint.includes('?') ? '&' : '?'}${params.toString()}`, { signal, credentials: 'same-origin' });
  if (!response.ok) throw new Error(errorForResponse(response));
  const parsed = await response.json() as Partial<StreamPage<T>>;
  return {
    items: Array.isArray(parsed.items) ? parsed.items.filter((item): item is T => Boolean(item && typeof item === 'object' && typeof (item as Identified).id === 'number')) : [],
    olderCursor: typeof parsed.olderCursor === 'number' ? parsed.olderCursor : null,
    hasMore: parsed.hasMore === true,
  };
}

function useStream<T extends Identified>(endpoint: string, revision: number): StreamHandle<T> {
  const [state, setState] = useState<StreamState<T>>({ items: [], olderCursor: null, hasMore: false, loading: true, olderLoading: false, error: null });
  const itemsRef = useRef<T[]>([]);
  const latestIdRef = useRef<number | null>(null);
  const oldestIdRef = useRef<number | null>(null);
  const olderCursorRef = useRef<number | null>(null);
  const hasMoreRef = useRef(false);
  const olderBusyRef = useRef(false);
  const pollBusyRef = useRef(false);
  const mountedRef = useRef(false);
  const controllersRef = useRef(new Set<AbortController>());
  const refreshRef=useRef<()=>Promise<void>>(async()=>{});

  const updateRefs = useCallback((items: T[], page?: StreamPage<T>) => {
    itemsRef.current = items;
    latestIdRef.current = items.length ? items[items.length - 1].id : null;
    oldestIdRef.current = items.length ? items[0].id : null;
    if (page) {
      olderCursorRef.current = page.olderCursor;
      hasMoreRef.current = page.hasMore;
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    itemsRef.current = [];
    latestIdRef.current = null;
    oldestIdRef.current = null;
    olderCursorRef.current = null;
    hasMoreRef.current = false;
    olderBusyRef.current=false;pollBusyRef.current=false;
    setState({ items: [], olderCursor: null, hasMore: false, loading: true, olderLoading: false, error: null });

    const controller = new AbortController();
    controllersRef.current.add(controller);
    const loadInitial = async () => {
      try {
        const page = await fetchPage<T>(endpoint, controller.signal);
        if (!mountedRef.current||controller.signal.aborted) return;
        const items = mergeById(itemsRef.current, page.items);
        updateRefs(items, page);
        setState({ items, olderCursor: page.olderCursor, hasMore: page.hasMore, loading: false, olderLoading: false, error: null });
      } catch (failure) {
        if (!mountedRef.current || (failure instanceof DOMException && failure.name === 'AbortError')) return;
        setState((current) => ({ ...current, loading: false, error: errorForFailure(failure) }));
      } finally {
        controllersRef.current.delete(controller);
      }
    };
    void loadInitial();

    const requestNewer = async () => {
      if (!mountedRef.current || document.visibilityState === 'hidden' || pollBusyRef.current) return;
      pollBusyRef.current = true;
      const after = latestIdRef.current;
      const pollController = new AbortController();
      controllersRef.current.add(pollController);
      try {
        const page = await fetchPage<T>(endpoint, pollController.signal, after===null?undefined:'after', after??undefined);
        if (!mountedRef.current||pollController.signal.aborted) return;
        const items = mergeById(itemsRef.current, page.items);
        updateRefs(items,after===null?page:undefined);
        setState((current) => ({ ...current, items,loading:false,...(after===null?{olderCursor:page.olderCursor,hasMore:page.hasMore}:{}), error: null }));
      } catch (failure) {
        if (!mountedRef.current || (failure instanceof DOMException && failure.name === 'AbortError')) return;
        setState((current) => ({ ...current, error: errorForFailure(failure) }));
      } finally {
        controllersRef.current.delete(pollController);
        pollBusyRef.current = false;
      }
    };

    refreshRef.current=requestNewer;
    const timer = window.setInterval(() => { void requestNewer(); }, POLL_MS);
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') void requestNewer();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      mountedRef.current = false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      for (const activeController of controllersRef.current) activeController.abort();
      controllersRef.current.clear();
    };
  }, [endpoint, updateRefs]);
  useEffect(()=>{void refreshRef.current();},[revision]);

  const loadOlder = useCallback(() => {
    if (!mountedRef.current || olderBusyRef.current || !hasMoreRef.current || olderCursorRef.current === null) return;
    olderBusyRef.current = true;
    const controller = new AbortController();
    controllersRef.current.add(controller);
    setState((current) => ({ ...current, olderLoading: true, error: null }));
    const load = async () => {
      try {
        const page = await fetchPage<T>(endpoint, controller.signal, 'before', olderCursorRef.current ?? undefined);
        if (!mountedRef.current||controller.signal.aborted) return;
        const items = mergeById(itemsRef.current, page.items);
        updateRefs(items, page);
        setState((current) => ({ ...current, items, olderCursor: page.olderCursor, hasMore: page.hasMore, olderLoading: false, error: null }));
      } catch (failure) {
        if (!mountedRef.current || (failure instanceof DOMException && failure.name === 'AbortError')) return;
        setState((current) => ({ ...current, olderLoading: false, error: errorForFailure(failure) }));
      } finally {
        controllersRef.current.delete(controller);
        olderBusyRef.current = false;
      }
    };
    void load();
  }, [endpoint, updateRefs]);

  const appendItem = useCallback((item: T) => {
    if (!mountedRef.current) return;
    const items = mergeById(itemsRef.current, [item]);
    updateRefs(items);
    setState((current) => ({ ...current, items, error: null }));
  }, [updateRefs]);

  return { ...state, loadOlder, appendItem };
}

function ProceduralObserverPortrait({ avatar, size = 32 }: { avatar: number; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const context = ref.current?.getContext('2d');
    if (!context) return;
    context.clearRect(0, 0, 32, 32);
    context.imageSmoothingEnabled = false;
    context.drawImage(texture(portrait(observerAppearance(avatar))), 0, 0);
  }, [avatar]);
  return <canvas ref={ref} width={32} height={32} style={{ width: size, height: size, imageRendering: 'pixelated' }} aria-hidden="true" />;
}

function DaySeparator({ day }: { day: number }) {
  return <div className="chat-day" role="separator">Day {day}</div>;
}

function formatClock(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? '' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatGameClock(gameTimeMs: number): string {
  const minutes = Math.floor(((gameTimeMs % GAME_DAY_MS) + GAME_DAY_MS) % GAME_DAY_MS / 60000);
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

function eventDay(gameTimeMs: number): number {
  return Math.floor(gameTimeMs / GAME_DAY_MS) + 1;
}

function statusText<T extends Identified>(stream: StreamHandle<T>): ReactNode {
  if (stream.loading) return <p className="chat-status">Loading records…</p>;
  if (!stream.items.length) return <p className="chat-status">No records yet.</p>;
  return null;
}

function LoadOlder<T extends Identified>({ stream }: { stream: StreamHandle<T> }) {
  if (!stream.hasMore) return null;
  return <button className="chat-load-older" type="button" onClick={stream.loadOlder} disabled={stream.olderLoading}>{stream.olderLoading ? 'Loading older…' : 'Load older records'}</button>;
}

function ErrorNotice({ message }: { message: string | null }) {
  return message ? <p className="chat-error" role="alert">{message}</p> : null;
}

function ObserverRows({ items }: { items: ObserverMessage[] }) {
  let previousDay: number | undefined;
  const rows: ReactNode[] = [];
  for (const message of items) {
    if (message.day !== previousDay) {
      rows.push(<DaySeparator day={message.day} key={`day-${message.day}`} />);
      previousDay = message.day;
    }
    rows.push(<article className="chat-row chat-row--observer" key={message.id}>
      <ProceduralObserverPortrait avatar={message.avatar} />
      <div className="chat-row__content">
        <div className="chat-row__meta"><strong>{message.username}</strong><time>{formatClock(message.createdAt)}</time></div>
        <p>{message.text}</p>
      </div>
    </article>);
  }
  return <>{rows}</>;
}

function CharacterRows({ items, citizens }: { items: CharacterMessage[]; citizens: VisibleCitizen[] }) {
  const byId = useMemo(() => new Map(citizens.map((citizen) => [citizen.id, citizen])), [citizens]);
  let previousDay: number | undefined;
  const rows: ReactNode[] = [];
  for (const message of items) {
    if (message.day !== previousDay) {
      rows.push(<DaySeparator day={message.day} key={`day-${message.day}`} />);
      previousDay = message.day;
    }
    const speaker = byId.get(message.speakerId);
    rows.push(<article className="chat-row chat-row--character" key={message.id}>
      {speaker ? <CitizenPortrait citizen={speaker} size={32} /> : <span className="chat-portrait-placeholder" aria-hidden="true" />}
      <div className="chat-row__content">
        <div className="chat-row__meta"><strong>{message.speakerName} <span className="chat-arrow" aria-hidden="true">→</span> {message.recipientName}</strong><span className={`chat-visibility chat-visibility--${message.visibility}`}>{message.visibility}</span></div>
        <p className="chat-utterance">{message.text}</p>
      </div>
    </article>);
  }
  return <>{rows}</>;
}

function ImportantEventRows({ items }: { items: ImportantEvent[] }) {
  let previousDay: number | undefined;
  const rows: ReactNode[] = [];
  for (const event of items.filter((item) => item.importance >= 50)) {
    const day = eventDay(event.gameTimeMs);
    if (day !== previousDay) {
      rows.push(<DaySeparator day={day} key={`day-${day}`} />);
      previousDay = day;
    }
    const subject = event.actorName && event.targetName ? `${event.actorName} → ${event.targetName}` : event.actorName || event.targetName;
    rows.push(<article className="chat-row chat-row--event" key={event.id}>
      <div className="chat-event-mark" aria-hidden="true">!</div>
      <div className="chat-row__content">
        <div className="chat-row__meta"><strong>{event.type.replaceAll('_', ' ')}</strong><time>{formatGameClock(event.gameTimeMs)}</time></div>
        <p>{event.text || event.activity || subject || 'A noteworthy public event occurred.'}</p>
        {subject ? <small>{subject}</small> : null}
      </div>
    </article>);
  }
  return <>{rows}</>;
}

function PanelFrame<T extends Identified>({
  title,
  subtitle,
  stream,
  compact,
  children,
  footer,
}: {
  title: string;
  subtitle?: string;
  stream: StreamHandle<T>;
  compact?: boolean;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return <section className={`chat-panel${compact ? ' chat-panel--compact' : ''}`}>
    <header className="chat-panel__header"><div><h2>{title}</h2>{subtitle ? <p>{subtitle}</p> : null}</div></header>
    <ErrorNotice message={stream.error} />
    {!compact && !stream.loading && stream.hasMore ? <LoadOlder stream={stream} /> : null}
    <div className="chat-panel__stream">{children}{statusText(stream)}</div>
    {footer}
  </section>;
}

export function ObserverChat({ revision, compact = false }: { revision: number; compact?: boolean }) {
  const stream = useStream<ObserverMessage>('/api/chats/observer', revision);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);
  const commandIdRef = useRef<string | null>(null);
  const commandTextRef=useRef<string|null>(null),inputId=useId();
  const postControllerRef = useRef<AbortController | null>(null);
  const visibleItems = compact ? stream.items.slice(-4) : stream.items;

  useEffect(() => () => { postControllerRef.current?.abort(); }, []);

  const submit = async () => {
    const text = draft.trim();
    if (busy || !text || text.length > 1000) {
      if (text.length > 1000) setPostError('Messages must be 1–1000 characters.');
      return;
    }
    const commandId = commandIdRef.current&&commandTextRef.current===text?commandIdRef.current:crypto.randomUUID();
    commandIdRef.current = commandId;
    commandTextRef.current=text;
    const controller = new AbortController();
    postControllerRef.current?.abort();
    postControllerRef.current = controller;
    setBusy(true);
    setPostError(null);
    try {
      const response = await fetch('/api/chats/observer', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, commandId }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(errorForResponse(response));
      const message = await response.json() as ObserverMessage;
      if (typeof message?.id !== 'number') throw new Error('The server returned an invalid message.');
      stream.appendItem(message);
      commandIdRef.current = null;
      commandTextRef.current=null;
      setDraft('');
    } catch (failure) {
      if (!(failure instanceof DOMException && failure.name === 'AbortError')) setPostError(errorForFailure(failure));
    } finally {
      if (postControllerRef.current === controller) postControllerRef.current = null;
      setBusy(false);
    }
  };

  const footer = <form className="chat-composer" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
    <label htmlFor={inputId}>Message the observers</label>
    <textarea id={inputId} value={draft} maxLength={1000} onChange={(event) => { setDraft(event.target.value); if (postError) setPostError(null); }} placeholder="Write a message…" rows={2} disabled={busy} />
    <div className="chat-composer__actions"><span>{draft.trim().length}/1000</span><button type="submit" disabled={busy || !draft.trim()}>{busy ? 'Sending…' : 'Send'}</button></div>
    {postError ? <p className="chat-error" role="alert">{postError}</p> : null}
  </form>;

  return <PanelFrame title="Observer Chat" subtitle="Human discussion · not visible to AI citizens" stream={stream} compact={compact} footer={footer}>
    {visibleItems.length ? <ObserverRows items={visibleItems} /> : null}
  </PanelFrame>;
}

export function CharacterChat({
  citizenId,
  citizens,
  onCitizenChange,
  revision,
  day,
}: {
  citizenId: string;
  citizens: VisibleCitizen[];
  onCitizenChange: (id: string) => void;
  revision: number;
  day?: number;
}) {
  const dayQuery = Number.isInteger(day) && day !== undefined && day >= 1 ? `?day=${encodeURIComponent(String(day))}` : '';
  const endpoint = `/api/chats/characters/${encodeURIComponent(citizenId)}${dayQuery}`;
  const stream = useStream<CharacterMessage>(endpoint, revision);
  return <PanelFrame title="Character Chat" subtitle="Recorded utterances involving this citizen" stream={stream}>
    <div className="chat-citizen-picker">
      <label htmlFor="character-chat-citizen">Citizen</label>
      <select id="character-chat-citizen" value={citizenId} onChange={(event) => onCitizenChange(event.target.value)}>
        {citizens.map((citizen) => <option value={citizen.id} key={citizen.id}>{citizen.name}</option>)}
      </select>
    </div>
    {stream.items.length ? <CharacterRows items={stream.items} citizens={citizens} /> : null}
  </PanelFrame>;
}

export function ImportantEvents({ revision, compact = false }: { revision: number; compact?: boolean }) {
  const stream = useStream<ImportantEvent>('/api/events', revision);
  const importantItems = stream.items.filter((event) => event.importance >= 50);
  const visibleItems = compact ? importantItems.slice(-3) : importantItems;
  return <PanelFrame title="Important Events" subtitle="Public events of lasting importance" stream={stream} compact={compact}>
    {visibleItems.length ? <ImportantEventRows items={visibleItems} /> : null}
  </PanelFrame>;
}
