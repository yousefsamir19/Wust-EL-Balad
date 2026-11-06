import { useEffect, useRef, useState } from 'react';
import type { RumorBoard, RumorRecord } from '../../../shared/rumors';
import './rumors.css';

const MAX_TEXT_LENGTH = 240;
const POLL_MS = 3000;

type RumorAction =
  | { kind: 'create'; text: string }
  | { kind: 'edit'; id: string; revision: number; text: string }
  | { kind: 'approve'; id: string; revision: number };

type PostState = { action: RumorAction; retry: boolean };

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseBoard(value: unknown): RumorBoard {
  if (!isRecord(value) || typeof value.currentDay !== 'number' || typeof value.nextOpportunityDay !== 'number' || typeof value.canPropose !== 'boolean' || !Array.isArray(value.rumors)) {
    throw new Error('The rumor board response was incomplete.');
  }
  if (value.rumors.some(rumor => !isRecord(rumor) || typeof rumor.id !== 'string' || typeof rumor.text !== 'string' || typeof rumor.revision !== 'number' || typeof rumor.status !== 'string' || !Array.isArray(rumor.voters))) {
    throw new Error('The rumor board contained an invalid rumor.');
  }
  return value as unknown as RumorBoard;
}

function serverMessage(value: unknown): string | null {
  return isRecord(value) && typeof value.error === 'string' ? value.error : null;
}

class RumorHttpError extends Error {
  readonly stale: boolean;
  readonly retryable: boolean;

  constructor(message: string, stale = false, retryable = false) {
    super(message);
    this.name = 'RumorHttpError';
    this.stale = stale;
    this.retryable = retryable;
  }
}

function httpError(status: number, payload: unknown): RumorHttpError {
  const message = serverMessage(payload);
  if (status === 409 && message?.toLowerCase().includes('stale')) return new RumorHttpError(`${message} Refreshing the board; your draft is preserved.`, true);
  if (message) return new RumorHttpError(`${message} (HTTP ${status}).`, false, status === 429 || status >= 500);
  if (status === 401) return new RumorHttpError('Sign in required to post or approve rumors.');
  if (status === 403) return new RumorHttpError('This rumor action is not allowed.');
  if (status === 404) return new RumorHttpError('That rumor is no longer available.');
  if (status === 429) return new RumorHttpError('Too many rumor requests. Retry the same action.', false, true);
  if (status >= 500) return new RumorHttpError('The rumor service is unavailable. Retry the same action.', false, true);
  return new RumorHttpError(`The rumor request was rejected (HTTP ${status}).`);
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function actionLabel(action: RumorAction): string {
  if (action.kind === 'create') return 'proposal';
  if (action.kind === 'edit') return 'edit';
  return 'approval';
}

function statusLabel(status: RumorRecord['status']): string {
  return status === 'pending' ? 'Pending' : status === 'published' ? 'Published' : 'Expired';
}

function deadlineLabel(expiresAt: number): string {
  const date = new Date(expiresAt);
  return Number.isNaN(date.getTime()) ? 'unknown date' : date.toLocaleString();
}

function remainingMinutes(expiresAt: number, now: number): number {
  return Math.max(0, Math.ceil((expiresAt - now) / 60000));
}

export function Rumors() {
  const [board, setBoard] = useState<RumorBoard | null>(null);
  const [loading, setLoading] = useState(true);
  const [composeText, setComposeText] = useState('');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [editRevisions,setEditRevisions]=useState<Record<string,number>>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [postState, setPostState] = useState<PostState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const boardRequest = useRef<AbortController | null>(null);
  const postRequest = useRef<{ action: RumorAction; controller: AbortController } | null>(null);

  async function refreshBoard(silent = false, duringPost = false) {
    if (!duringPost && (postRequest.current || boardRequest.current)) return;
    boardRequest.current?.abort();
    const controller = new AbortController();
    boardRequest.current = controller;
    if (!silent) setLoading(true);
    try {
      const response = await fetch('/api/rumors', { credentials: 'same-origin', signal: controller.signal });
      const payload = await readJson(response);
      if (!response.ok) throw httpError(response.status, payload);
      const nextBoard = parseBoard(payload);
      if (controller.signal.aborted) return;
      setBoard(nextBoard);
      if (!silent) setError(null);
      setLoading(false);
    } catch (reason) {
      if (controller.signal.aborted) return;
      setLoading(false);
      if (!silent || !board) setError(reason instanceof Error ? reason.message : 'The rumor board was unavailable.');
    } finally {
      if (boardRequest.current === controller) boardRequest.current = null;
    }
  }

  useEffect(() => {
    void refreshBoard();
    const poll = window.setInterval(() => void refreshBoard(true), POLL_MS);
    const clock = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {
      window.clearInterval(poll);
      window.clearInterval(clock);
      boardRequest.current?.abort();
      postRequest.current?.controller.abort();
    };
  }, []);

  async function post(action: RumorAction) {
    if (postRequest.current) return;
    const path = action.kind === 'create' ? '/api/rumors' : `/api/rumors/${encodeURIComponent(action.id)}${action.kind === 'approve' ? '/approve' : ''}`;
    const body = action.kind === 'create' ? { text: action.text } : action.kind === 'edit' ? { revision: action.revision, text: action.text } : { revision: action.revision };
    const controller = new AbortController();
    postRequest.current = { action, controller };
    setPostState({ action, retry: false });
    setError(null);
    try {
      const response = await fetch(path, {
        method: action.kind === 'edit' ? 'PATCH' : 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const payload = await readJson(response);
      if (!response.ok) throw httpError(response.status, payload);
      const nextBoard = parseBoard(payload);
      if (controller.signal.aborted) return;
      setBoard(nextBoard);
      setPostState(null);
      if (action.kind === 'create') {
        setComposeText(current => current === action.text ? '' : current);
      } else if (action.kind === 'edit') {
        setDrafts(current => ({ ...current, [action.id]: action.text }));
        setEditingId(null);
      }
    } catch (reason) {
      if (controller.signal.aborted) return;
      if (reason instanceof RumorHttpError && reason.stale) {
        setPostState(null);
        setEditingId(null);
        setError(`${reason.message} Review the current text and reopen Edit rumor before saving your preserved draft.`);
        void refreshBoard(true, true);
      } else if (!(reason instanceof RumorHttpError) || reason.retryable) {
        setPostState({ action, retry: true });
        setError(`The ${actionLabel(action)} response was lost. Retry the same ${actionLabel(action)}; the text and revision will not change.`);
      } else {
        setPostState(null);
        setError(reason instanceof Error ? reason.message : `The ${actionLabel(action)} was not completed.`);
      }
    } finally {
      if (postRequest.current?.controller === controller) postRequest.current = null;
    }
  }

  function beginEdit(rumor: RumorRecord) {
    if (rumor.status !== 'pending' || postState) return;
    setDrafts(current => current[rumor.id] === undefined ? { ...current, [rumor.id]: rumor.text } : current);
    setEditRevisions(current=>({...current,[rumor.id]:rumor.revision}));
    setEditingId(rumor.id);
    setError(null);
  }

  function editText(rumor: RumorRecord): string {
    return drafts[rumor.id] ?? rumor.text;
  }

  const pending = board?.rumors.filter(rumor => rumor.status === 'pending') ?? [];
  const finalized = board?.rumors.filter(rumor => rumor.status !== 'pending') ?? [];
  const busy = postState !== null;

  return <section className="rumors">
    <header className="rumors-header">
      <div><h2>Rumor Board</h2><p>Players share uncertain claims for the town to weigh.</p></div>
      {board ? <div className="rumors-day"><span>SIM DAY</span><b>{board.currentDay}</b></div> : null}
    </header>
    <p className="rumors-note">Unconfirmed beliefs, not facts. No Influence cost or direct NPC control.</p>
    <p className="rumors-note">All registered, non-banned accounts—including admins and the proposer—must approve this revision. Edits reset votes.</p>
    {error ? <p className="rumors-error" role="alert">{error}</p> : null}
    {postState?.retry ? <div className="rumors-retry" role="status"><span>The previous {actionLabel(postState.action)} may have reached the town.</span><button type="button" onClick={() => void post(postState.action)}>Retry same {actionLabel(postState.action)}</button></div> : null}
    {loading && !board ? <p className="rumors-status">Loading rumor board…</p> : null}
    {board ? <>
      <section className="rumors-compose" aria-label="Compose a rumor">
        {board.canPropose?<h3>Propose a rumor</h3>:null}
        {board.canPropose ? <form onSubmit={event => { event.preventDefault(); const text = composeText.trim(); if (text && text.length <= MAX_TEXT_LENGTH) void post({ kind: 'create', text }); }}>
          <label htmlFor="rumor-compose-text">Plaintext claim<textarea id="rumor-compose-text" value={composeText} onChange={event => setComposeText(event.target.value)} maxLength={MAX_TEXT_LENGTH} rows={3} disabled={busy} placeholder="What have people been saying?" /></label>
          <small className="rumors-count">{composeText.length}/{MAX_TEXT_LENGTH}</small>
          <button type="submit" disabled={busy || !composeText.trim() || composeText.trim().length > MAX_TEXT_LENGTH}>{busy && postState?.action.kind === 'create' ? 'Posting…' : 'Post rumor'}</button>
        </form> : <p className="rumors-status">The next proposal opportunity is Day {board.nextOpportunityDay}. Rumors may be proposed once every three sim days.</p>}
        {board.canPropose?<p className="rumors-opportunity">Next three-sim-day opportunity: Day {board.nextOpportunityDay}.</p>:null}
      </section>
      {pending.length?<section className="rumors-list" aria-live="polite">
        <h3>Active board</h3>
        {pending.length ? pending.map(rumor => <RumorCard key={rumor.id} rumor={rumor} now={now} draft={editText(rumor)} editing={editingId === rumor.id} busy={busy} onEdit={() => beginEdit(rumor)} onDraft={text => setDrafts(current => ({ ...current, [rumor.id]: text }))} onCancel={() => setEditingId(null)} onSave={() => { const text = editText(rumor).trim(); if (text && text.length <= MAX_TEXT_LENGTH) void post({ kind: 'edit', id: rumor.id, revision: editRevisions[rumor.id]??rumor.revision, text }); }} onApprove={() => void post({ kind: 'approve', id: rumor.id, revision: rumor.revision })} />) : <p className="rumors-status">No pending rumors are awaiting the town’s unanimous approval.</p>}
      </section>:null}
      <section className="rumors-history" aria-live="polite">
        <h3>Finalized history</h3>
        {finalized.length ? finalized.map(rumor => <RumorCard key={rumor.id} rumor={rumor} now={now} />) : <p className="rumors-status">No rumors have been finalized yet.</p>}
      </section>
    </> : null}
  </section>;
}

function RumorCard({ rumor, now, draft, editing, busy, onEdit, onDraft, onCancel, onSave, onApprove }: { rumor: RumorRecord; now: number; draft?: string; editing?: boolean; busy?: boolean; onEdit?: () => void; onDraft?: (text: string) => void; onCancel?: () => void; onSave?: () => void; onApprove?: () => void }) {
  const approved = rumor.voters.filter(voter => voter.approved);
  return <article className={`rumor-card rumor-${rumor.status}`}>
    <div className="rumor-card-header"><span className={`rumor-status rumor-status-${rumor.status}`}>{statusLabel(rumor.status)}</span><span>Revision {rumor.revision}</span></div>
    <p className="rumor-text">{rumor.text}</p>
    {editing && rumor.status === 'pending' ? <form className="rumor-edit-form" onSubmit={event => { event.preventDefault(); onSave?.(); }}><label htmlFor={`rumor-edit-${rumor.id}`}>Edit this revision<textarea id={`rumor-edit-${rumor.id}`} value={draft ?? rumor.text} onChange={event => onDraft?.(event.target.value)} maxLength={MAX_TEXT_LENGTH} rows={3} disabled={busy} /></label><small className="rumors-count">{(draft ?? rumor.text).length}/{MAX_TEXT_LENGTH}</small><div className="rumor-actions"><button type="submit" disabled={busy || !(draft ?? '').trim() || (draft ?? '').trim().length > MAX_TEXT_LENGTH}>Save edit</button><button type="button" onClick={onCancel} disabled={busy}>Cancel</button></div><p className="rumors-edit-note">Saving changes the displayed revision and clears all approvals.</p></form> : null}
    <dl className="rumor-meta"><div><dt>Proposed by</dt><dd>{rumor.proposerName}</dd></div><div><dt>Approvals</dt><dd>{rumor.approvedCount}/{rumor.requiredCount}</dd></div><div><dt>Deadline</dt><dd>{deadlineLabel(rumor.expiresAt)}{rumor.status === 'pending' ? ` · ${remainingMinutes(rumor.expiresAt, now)} min left` : ''}</dd></div></dl>
    {rumor.voters.length ? <div className="rumor-voters"><h4>Voters</h4><ul>{rumor.voters.map(voter => <li key={voter.id} className={voter.approved ? 'voter-approved' : 'voter-waiting'}><span aria-hidden="true">{voter.approved ? '✓' : '○'}</span> {voter.username} <small>{voter.approved ? 'approved' : 'not yet'}</small></li>)}</ul><p className="rumor-count-note">{approved.length} approved · {rumor.voters.length - approved.length} not yet</p></div> : <p className="rumors-status">No eligible voters are listed for this revision.</p>}
    {rumor.status === 'pending' && !editing ? <div className="rumor-actions"><button type="button" onClick={onApprove} disabled={busy}>Approve revision {rumor.revision}</button><button type="button" onClick={onEdit} disabled={busy}>Edit rumor</button></div> : null}
    {rumor.status !== 'pending' ? <p className="rumors-immutable">Finalized history is immutable: no edits or approvals are accepted.</p> : null}
  </article>;
}
