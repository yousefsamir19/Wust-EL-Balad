import { useEffect, useMemo, useRef, useState } from 'react';
import type { VisibleCitizen } from '../../../shared/world';
import type { InfluenceWallet, InterventionOutcome, InterventionResponse, InterventionStrength } from '../../../shared/influence';
import './influence.css';

const strengths: InterventionStrength[] = ['subtle', 'medium', 'strong'];
const outcomes: InterventionOutcome[] = ['accepted', 'considered', 'ignored', 'rejected'];
const MAX_SUGGESTION_LENGTH = 280;

type InterventionPayload = { citizenId: string; strength: InterventionStrength; suggestion: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readServerMessage(value: unknown): string | null {
  return isRecord(value) && typeof value.error === 'string' ? value.error : null;
}

function parseWallet(value: unknown): InfluenceWallet {
  if (!isRecord(value) || typeof value.balance !== 'number' || !Number.isFinite(value.balance) || typeof value.day !== 'number' || !Number.isFinite(value.day) || typeof value.available !== 'boolean' || !isRecord(value.costs) || !Array.isArray(value.history)) throw new Error('The influence wallet response was incomplete.');
  const costs = value.costs;
  if (!strengths.every(strength => typeof costs[strength] === 'number' && Number.isFinite(costs[strength]) && costs[strength] >= 0)) throw new Error('The influence costs were unavailable.');
  return value as unknown as InfluenceWallet;
}

function parseIntervention(value: unknown): InterventionResponse {
  if (!isRecord(value) || !isRecord(value.intervention) || !('wallet' in value)) throw new Error('The influence response was incomplete.');
  return { intervention: value.intervention as unknown as InterventionResponse['intervention'], wallet: parseWallet(value.wallet) };
}

function titleCase(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function httpMessage(status: number, payload: unknown) {
  const serverMessage = readServerMessage(payload);
  if (serverMessage) return serverMessage;
  if (status === 401) return 'Sign in required to use influence.';
  if (status === 403) return 'Influence is not available today.';
  if (status === 409) return 'Today’s influence opportunity is already used.';
  if (status === 429) return 'Too many influence requests. Please wait and retry the same suggestion.';
  if (status >= 500) return 'The influence service is unavailable. Retry the same suggestion.';
  return `The influence request was rejected (HTTP ${status}).`;
}

export function InfluencePanel({ citizens, selectedCitizenId, onCitizenChange }: { citizens: VisibleCitizen[]; selectedCitizenId: string | null; onCitizenChange: (id: string) => void }) {
  const [wallet, setWallet] = useState<InfluenceWallet | null>(null);
  const [loading, setLoading] = useState(true);
  const [posting, setPosting] = useState(false);
  const [suggestion, setSuggestion] = useState('');
  const [strength, setStrength] = useState<InterventionStrength>('medium');
  const [error, setError] = useState<string | null>(null);
  const [retryAvailable, setRetryAvailable] = useState(false);
  const walletSnapshot = useRef<InfluenceWallet | null>(null);
  const walletRequest = useRef<AbortController | null>(null);
  const postRequest = useRef<AbortController | null>(null);
  const walletRequestId = useRef(0);
  const pendingPayload = useRef<InterventionPayload | null>(null);

  useEffect(() => {
    let mounted = true;
    const refreshWallet = async () => {
      if (!mounted || postRequest.current) return;
      walletRequest.current?.abort();
      const controller = new AbortController();
      walletRequest.current = controller;
      const requestId = ++walletRequestId.current;
      if (!walletSnapshot.current) setLoading(true);
      try {
        const response = await fetch('/api/influence', { credentials: 'same-origin', signal: controller.signal });
        const payload: unknown = await response.json().catch(() => null);
        if (!response.ok) throw new Error(httpMessage(response.status, payload));
        const nextWallet = parseWallet(payload);
        if (!mounted || controller.signal.aborted || walletRequestId.current !== requestId || postRequest.current) return;
        walletSnapshot.current = nextWallet;
        setWallet(nextWallet);
        setLoading(false);
        setError(null);
      } catch (reason) {
        if (controller.signal.aborted || !mounted || walletRequestId.current !== requestId) return;
        setLoading(false);
        setError(reason instanceof Error ? reason.message : 'The influence wallet was unavailable.');
      } finally {
        if (walletRequest.current === controller) walletRequest.current = null;
      }
    };
    void refreshWallet();
    const timer = window.setInterval(() => void refreshWallet(), 10000);
    return () => {
      mounted = false;
      window.clearInterval(timer);
      walletRequest.current?.abort();
      postRequest.current?.abort();
    };
  }, []);

  const currentCitizenId = citizens.some(citizen => citizen.id === selectedCitizenId) ? selectedCitizenId as string : (citizens[0]?.id ?? '');
  const affordableStrengths = useMemo(() => wallet ? strengths.filter(option => wallet.costs[option] <= wallet.balance) : [], [wallet]);
  const selectedStrength = affordableStrengths.includes(strength) ? strength : (affordableStrengths[0] ?? '');
  const hasSuggestion = suggestion.trim().length > 0;
  const canSubmit = Boolean(wallet?.available && currentCitizenId && affordableStrengths.length && hasSuggestion && !loading && !posting);
  const allowanceUsed = wallet?.history.some(record => record.day === wallet.day) ?? false;

  async function submit() {
    if (posting || loading) return;
    const payload = pendingPayload.current ?? (wallet?.available && currentCitizenId && selectedStrength && hasSuggestion ? { citizenId: currentCitizenId, strength: selectedStrength as InterventionStrength, suggestion: suggestion.trim() } : null);
    if (!payload || payload.suggestion.length > MAX_SUGGESTION_LENGTH || !wallet || !wallet.available || wallet.costs[payload.strength] > wallet.balance) return;
    walletRequest.current?.abort();
    walletRequestId.current += 1;
    const controller = new AbortController();
    postRequest.current = controller;
    pendingPayload.current = payload;
    setPosting(true);
    setError(null);
    try {
      const response = await fetch('/api/influence/interventions', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: controller.signal });
      const responsePayload: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(httpMessage(response.status, responsePayload));
      const result = parseIntervention(responsePayload);
      if (controller.signal.aborted) return;
      walletSnapshot.current = result.wallet;
      setWallet(result.wallet);
      setSuggestion('');
      setRetryAvailable(false);
      pendingPayload.current = null;
    } catch (reason) {
      if (controller.signal.aborted) return;
      setRetryAvailable(true);
      setError(reason instanceof Error ? `The response was lost. ${reason.message} Retry the same suggestion.` : 'The response was lost. Retry the same suggestion.');
    } finally {
      if (postRequest.current === controller) {
        postRequest.current = null;
        setPosting(false);
      }
    }
  }

  return <section className="influence-panel">
    <header className="influence-header"><div><h2>Influence</h2><p>One opportunity per game day.</p></div><div className="influence-balance" aria-live="polite"><span>LIVE balance</span><b>{wallet ? wallet.balance : '—'}</b></div></header>
    {loading && !wallet ? <p className="influence-status">Loading influence wallet…</p> : null}
    {error ? <p className="influence-error" role="alert">{error}</p> : null}
    {wallet ? <>
      <p className="influence-note">A suggestion, not a command. Even strong influence is not guaranteed.</p>
      {!allowanceUsed ? <form className="influence-form" onSubmit={event => { event.preventDefault(); void submit(); }}>
        <label>Citizen<select value={currentCitizenId} onChange={event => onCitizenChange(event.target.value)} disabled={loading || posting || retryAvailable || !wallet.available || !citizens.length}>{citizens.map(citizen => <option key={citizen.id} value={citizen.id}>{citizen.name}</option>)}</select></label>
        <label>Strength<select value={selectedStrength} onChange={event => setStrength(event.target.value as InterventionStrength)} disabled={loading || posting || retryAvailable || !wallet.available || !affordableStrengths.length}>{affordableStrengths.map(option => <option key={option} value={option}>{titleCase(option)} · {wallet.costs[option]} points</option>)}</select></label>
        {!affordableStrengths.length ? <p className="influence-status">No strength is affordable with the live balance.</p> : null}
        {!wallet.available && affordableStrengths.length ? <p className="influence-status">Today’s influence opportunity is unavailable.</p> : null}
        <label>Suggestion<textarea value={suggestion} onChange={event => setSuggestion(event.target.value)} maxLength={MAX_SUGGESTION_LENGTH} rows={3} disabled={loading || posting || retryAvailable || !wallet.available} placeholder="What might this citizen consider?"/><small className="influence-count">{suggestion.length}/{MAX_SUGGESTION_LENGTH}</small></label>
        <button type="submit" disabled={!canSubmit}>{posting ? 'Submitting…' : retryAvailable ? 'Retry suggestion' : 'Suggest'}</button>
      </form> : <p className="influence-status">Today’s influence opportunity is already used. Review the record below.</p>}
      <section className="influence-history" aria-live="polite"><h3>Influence history · Day {wallet.day}</h3>{wallet.history.length ? [...wallet.history].reverse().map(record => <article key={record.id}><p><b>{citizens.find(citizen => citizen.id === record.citizenId)?.name ?? 'Citizen'}</b> · {titleCase(record.strength)} · {record.cost} points</p><p className="influence-suggestion">{record.suggestion}</p><small>{outcomes.includes(record.outcome) ? titleCase(record.outcome) : 'Recorded'} · Day {record.day}</small></article>) : <p>No interventions recorded yet.</p>}</section>
    </> : null}
  </section>;
}
