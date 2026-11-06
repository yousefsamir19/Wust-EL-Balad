import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type {
  AiConnectionResult,
  AiJsonMode,
  AiKeyView,
  AiProviderEdit,
  AiProviderKind,
  AiProviderView,
  AiSettingsView,
} from '../../../shared/ai';
import './hud.css';

const PROVIDER_KINDS: AiProviderKind[] = ['gemini', 'nim', 'openrouter', 'groq', 'ollama', 'compatible'];
const JSON_MODES: AiJsonMode[] = ['schema', 'object', 'prompt'];
const PROVIDER_PATH = '/api/admin/ai/providers';

type ProviderDraft = AiProviderEdit;
type TestNotice = { tone: 'ok' | 'warning' | 'error'; text: string };
type ApiError = Error & { status?: number };

type ApiBody = Record<string, unknown>;

function errorText(body: unknown, fallback: string) {
  if (!body || typeof body !== 'object') return fallback;
  const value = body as ApiBody;
  if (typeof value.error === 'string') return value.error;
  if (typeof value.message === 'string') return value.message;
  if (value.error && typeof value.error === 'object' && typeof (value.error as ApiBody).message === 'string') {
    return String((value.error as ApiBody).message);
  }
  return fallback;
}

async function apiFetch<T>(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (init.body !== undefined) headers.set('Content-Type', 'application/json');
  const response = await fetch(path, { ...init, headers, credentials: 'same-origin' });
  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = null; }
  }
  if (!response.ok) {
    const failure = new Error(errorText(body, `Request failed (${response.status})`)) as ApiError;
    failure.status = response.status;
    throw failure;
  }
  return body as T;
}

function settingsFrom(body: unknown): AiSettingsView {
  const candidate = body && typeof body === 'object' && 'settings' in body
    ? (body as { settings: unknown }).settings
    : body;
  if (!candidate || typeof candidate !== 'object' || !Array.isArray((candidate as AiSettingsView).providers)) {
    throw new Error('The AI settings response was not understood.');
  }
  return candidate as AiSettingsView;
}

function draftFrom(provider: AiProviderView): ProviderDraft {
  return {
    label: provider.label,
    kind: provider.kind,
    model: provider.model,
    baseUrl: provider.baseUrl,
    enabled: provider.enabled,
    priority: provider.priority,
    jsonMode: provider.jsonMode,
    maxRequestsPerMinute: provider.maxRequestsPerMinute,
  };
}

function blankDraft(defaults?: AiSettingsView['defaults']): ProviderDraft {
  const fallback = defaults?.gemini;
  return {
    label: '',
    kind: 'gemini',
    model: '',
    baseUrl: fallback?.baseUrl ?? '',
    enabled: true,
    priority: 100,
    jsonMode: fallback?.jsonMode ?? 'schema',
    maxRequestsPerMinute: 20,
  };
}

function keyLabelsFor(provider: AiProviderView | undefined) {
  return Object.fromEntries((provider?.keys ?? []).map((key) => [key.id, key.label]));
}

function cooldownText(until: number) {
  if (!until) return '';
  const remaining = until - Date.now();
  if (remaining <= 0) return '';
  return `cooldown ${Math.ceil(remaining / 1000)}s`;
}

function dateText(value: string | number | null | undefined) {
  if (!value) return 'never';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'unknown' : date.toLocaleString();
}

function isConnectionResult(value: unknown): value is AiConnectionResult {
  return Boolean(value && typeof value === 'object' && (value as AiConnectionResult).source && (value as AiConnectionResult).value);
}

export function AiSettings() {
  const [settings, setSettings] = useState<AiSettingsView | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ProviderDraft | null>(null);
  const [keyLabels, setKeyLabels] = useState<Record<string, string>>({});
  const [newKeyLabel, setNewKeyLabel] = useState('');
  const [isAdding, setIsAdding] = useState(false);
  const [busyAction, setBusyAction] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [forbidden, setForbidden] = useState(false);
  const [loading, setLoading] = useState(true);
  const [testNotice, setTestNotice] = useState<TestNotice | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const selectedIdRef = useRef<string | null>(null);
  const forbiddenRef = useRef(false);
  const isAddingRef = useRef(false);

  const selectedProvider = useMemo(
    () => settings?.providers.find((provider) => provider.id === selectedId) ?? null,
    [settings, selectedId],
  );

  function adopt(next: AiSettingsView, syncDraft = false, preferredId?: string | null) {
    if(isAddingRef.current&&!syncDraft&&preferredId===undefined){setSettings(next);return;}
    const currentId = preferredId === undefined ? selectedIdRef.current : preferredId;
    const nextProvider = currentId ? next.providers.find((provider) => provider.id === currentId) : undefined;
    const provider = nextProvider ?? next.providers[0];
    const id = provider?.id ?? null;
    selectedIdRef.current = id;
    setSettings(next);
    setSelectedId(id);
    if (syncDraft || (!isAddingRef.current && (!currentId || !nextProvider))) {
      setDraft(provider ? draftFrom(provider) : blankDraft(next.defaults));
      setKeyLabels(keyLabelsFor(provider));
    }
  }

  useEffect(() => {
    let disposed = false;
    let timer: number | undefined;
    let lastFetch = 0;
    forbiddenRef.current = false;
    setForbidden(false);

    const load = async (silent = false) => {
      if (disposed || forbiddenRef.current) return;
      const now = Date.now();
      if (silent && now - lastFetch < 10000) return;
      lastFetch = now;
      if (!silent) setLoading(true);
      try {
        const body = await apiFetch<unknown>(PROVIDER_PATH);
        if (!disposed) {
          adopt(settingsFrom(body));
          setError('');
        }
      } catch (failure) {
        if (disposed) return;
        const apiError = failure as ApiError;
        if (apiError.status === 403) {
          forbiddenRef.current = true;
          setForbidden(true);
          setError('');
        } else {
          setError(apiError.message || 'Unable to load AI settings.');
        }
      } finally {
        if (!disposed) setLoading(false);
      }
    };

    const schedule = () => {
      if (disposed || forbiddenRef.current || document.visibilityState !== 'visible') return;
      if (timer !== undefined) window.clearTimeout(timer);
      const wait = Math.max(10000 - (Date.now() - lastFetch), 0);
      timer = window.setTimeout(async () => {
        await load(true);
        schedule();
      }, wait || 10000);
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        void load(true);
        schedule();
      } else if (timer !== undefined) {
        window.clearTimeout(timer);
        timer = undefined;
      }
    };

    void load();
    schedule();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [reloadToken]);

  function selectProvider(id: string) {
    const provider = settings?.providers.find((item) => item.id === id);
    if (!provider) return;
    selectedIdRef.current = id;
    setSelectedId(id);
    setIsAdding(false);
    isAddingRef.current = false;
    setDraft(draftFrom(provider));
    setKeyLabels(keyLabelsFor(provider));
    setNewKeyLabel('');
    setTestNotice(null);
    setNotice('');
    setError('');
  }

  function startAdding() {
    setIsAdding(true);
    isAddingRef.current = true;
    setSelectedId(null);
    selectedIdRef.current = null;
    setDraft(blankDraft(settings?.defaults));
    setKeyLabels({});
    setNewKeyLabel('');
    setTestNotice(null);
    setNotice('');
    setError('');
  }

  function cancelAdding() {
    setIsAdding(false);
    isAddingRef.current = false;
    const provider = settings?.providers[0];
    selectedIdRef.current = provider?.id ?? null;
    setSelectedId(provider?.id ?? null);
    setDraft(provider ? draftFrom(provider) : blankDraft(settings?.defaults));
    setKeyLabels(keyLabelsFor(provider));
  }

  function updateDraft(field: keyof ProviderDraft, value: string | number | boolean) {
    setDraft((current) => current ? { ...current, [field]: value } : current);
  }

  function changeKind(kind: AiProviderKind) {
    const defaults = settings?.defaults[kind];
    setDraft((current) => current ? {
      ...current,
      kind,
      baseUrl: defaults?.baseUrl ?? current.baseUrl,
      jsonMode: defaults?.jsonMode ?? current.jsonMode,
    } : current);
  }

  async function mutate(path: string, init: RequestInit, action: string, syncDraft = true, preferredId?: string | null) {
    setBusyAction(action);
    setError('');
    try {
      const next = settingsFrom(await apiFetch<unknown>(path, init));
      adopt(next, syncDraft, preferredId);
      setNotice('Saved. Runtime changes are active without a rebuild.');
      return next;
    } catch (failure) {
      const apiError = failure as ApiError;
      if (apiError.status === 403) {
        forbiddenRef.current = true;
        setForbidden(true);
      }
      setError(apiError.message || 'Request failed.');
      return null;
    } finally {
      setBusyAction('');
    }
  }

  async function saveProvider(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft || !draft.label.trim() || !draft.model.trim()) {
      setError('Provider label and model are required.');
      return;
    }
    const payload: ProviderDraft = {
      ...draft,
      label: draft.label.trim(),
      model: draft.model.trim(),
      baseUrl: draft.baseUrl.trim(),
      priority: Number(draft.priority),
      maxRequestsPerMinute: Number(draft.maxRequestsPerMinute),
    };
    if (isAdding) {
      const previousIds = new Set(settings?.providers.map((provider) => provider.id) ?? []);
      const next = await mutate(PROVIDER_PATH, { method: 'POST', body: JSON.stringify(payload) }, 'provider-save', true);
      if (next) {
        const created = next.providers.find((provider) => !previousIds.has(provider.id));
        setIsAdding(false);
        isAddingRef.current = false;
        if (created) {
          selectedIdRef.current = created.id;
          setSelectedId(created.id);
          setDraft(draftFrom(created));
          setKeyLabels(keyLabelsFor(created));
        }
      }
    } else if (selectedId) {
      await mutate(`${PROVIDER_PATH}/${encodeURIComponent(selectedId)}`, { method: 'PATCH', body: JSON.stringify(payload) }, 'provider-save');
    }
  }

  async function removeProvider() {
    if (!selectedId) return;
    const next = await mutate(`${PROVIDER_PATH}/${encodeURIComponent(selectedId)}`, { method: 'DELETE' }, 'provider-delete', true, null);
    if (next) {
      setNotice('Provider removed.');
      setIsAdding(false);
    }
  }

  async function setActive(providerId: string | null) {
    const next = await mutate('/api/admin/ai/active', { method: 'PUT', body: JSON.stringify({ providerId }) }, 'active');
    if (next) setNotice(providerId ? 'Preferred provider updated.' : 'Automatic priority order selected.');
  }

  async function testProvider() {
    if (!selectedId) return;
    setBusyAction('test');
    setError('');
    setTestNotice(null);
    try {
      const body = await apiFetch<unknown>(`${PROVIDER_PATH}/${encodeURIComponent(selectedId)}/test`, { method: 'POST' });
      const result = (body && typeof body === 'object' && 'result' in body ? (body as { result: unknown }).result : body) as unknown;
      if (!isConnectionResult(result)) throw new Error('The connection test response was not understood.');
      if (result.source === 'network' && result.value.ready) {
        setTestNotice({ tone: 'ok', text: 'Network connection ready.' });
      } else if (result.source === 'local') {
        setTestNotice({ tone: 'warning', text: `Local fallback used: ${result.reason ?? 'network connection unavailable.'}` });
      } else {
        setTestNotice({ tone: 'error', text: result.reason ?? 'Network connection was not ready.' });
      }
    } catch (failure) {
      const apiError = failure as ApiError;
      if (apiError.status === 403) {
        forbiddenRef.current = true;
        setForbidden(true);
      }
      setTestNotice({ tone: 'error', text: apiError.message || 'Connection test failed.' });
    } finally {
      setBusyAction('');
    }
  }

  async function addKey(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedId) return;
    const form = event.currentTarget;
    const formData = new FormData(form);
    const label = String(formData.get('label') ?? '').trim();
    const value = String(formData.get('value') ?? '');
    if (!label || !value) {
      setError('A key label and key value are required.');
      return;
    }
    setBusyAction('key-add');
    setError('');
    try {
      const next = settingsFrom(await apiFetch<unknown>(`${PROVIDER_PATH}/${encodeURIComponent(selectedId)}/keys`, {
        method: 'POST',
        body: JSON.stringify({ label, value, enabled: true }),
      }));
      adopt(next, true);
      setNewKeyLabel('');
      setNotice('Key added. The value is not retained or displayed.');
    } catch (failure) {
      const apiError = failure as ApiError;
      if (apiError.status === 403) { forbiddenRef.current = true; setForbidden(true); }
      setError(apiError.message || 'Unable to add key.');
    } finally {
      form.reset();
      setNewKeyLabel('');
      setBusyAction('');
    }
  }

  async function replaceKey(event: FormEvent<HTMLFormElement>, key: AiKeyView) {
    event.preventDefault();
    if (!selectedId) return;
    const form = event.currentTarget;
    const value = String(new FormData(form).get('value') ?? '');
    if (!value) {
      setError('Enter a replacement key value.');
      return;
    }
    setBusyAction(`key-replace:${key.id}`);
    setError('');
    try {
      const next = settingsFrom(await apiFetch<unknown>(`${PROVIDER_PATH}/${encodeURIComponent(selectedId)}/keys/${encodeURIComponent(key.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ value }),
      }));
      adopt(next, true);
      setNotice('Key replaced. The value is not retained or displayed.');
    } catch (failure) {
      const apiError = failure as ApiError;
      if (apiError.status === 403) { forbiddenRef.current = true; setForbidden(true); }
      setError(apiError.message || 'Unable to replace key.');
    } finally {
      form.reset();
      setBusyAction('');
    }
  }

  async function updateKey(key: AiKeyView, patch: { enabled: boolean } | { label: string }) {
    if (!selectedId) return;
    setBusyAction(`key:${key.id}`);
    setError('');
    try {
      const next = settingsFrom(await apiFetch<unknown>(`${PROVIDER_PATH}/${encodeURIComponent(selectedId)}/keys/${encodeURIComponent(key.id)}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }));
      adopt(next, true);
      setNotice('Key settings saved.');
    } catch (failure) {
      const apiError = failure as ApiError;
      if (apiError.status === 403) { forbiddenRef.current = true; setForbidden(true); }
      setError(apiError.message || 'Unable to update key.');
    } finally {
      setBusyAction('');
    }
  }

  async function deleteKey(key: AiKeyView) {
    if (!selectedId) return;
    const next = await mutate(`${PROVIDER_PATH}/${encodeURIComponent(selectedId)}/keys/${encodeURIComponent(key.id)}`, { method: 'DELETE' }, `key-delete:${key.id}`);
    if (next) setNotice('Key removed.');
  }

  const activeValue = settings?.activeProviderId ?? '';
  const originChanged = Boolean(selectedProvider && draft && (selectedProvider.kind !== draft.kind || selectedProvider.baseUrl !== draft.baseUrl));
  const audit = settings?.audit?.[0];

  if (forbidden) {
    return <section className="retro-panel ai-settings" aria-label="AI settings">
      <div className="ai-settings__header"><div><h2>AI CONTROL</h2><p className="quiet">Runtime provider administration</p></div></div>
      <div className="ai-settings__message" role="alert"><strong>Administrator access required.</strong><p>Sign in with an administrator account to manage AI providers and keys.</p><button type="button" onClick={() => setReloadToken((token) => token + 1)}>Retry access</button></div>
    </section>;
  }

  if (loading && !settings) {
    return <section className="retro-panel ai-settings" aria-label="AI settings"><h2>AI CONTROL</h2><p className="quiet">Loading runtime settings…</p></section>;
  }

  return <section className="retro-panel ai-settings" aria-label="AI settings">
    <div className="ai-settings__header">
      <div><h2>AI CONTROL</h2><p className="quiet">Runtime routing · no rebuild required</p></div>
      <button type="button" onClick={startAdding} disabled={busyAction !== ''}>＋ Add provider</button>
    </div>

    <div className="ai-settings__summary">
      <label>Preferred active provider
        <select value={activeValue} onChange={(event) => void setActive(event.target.value || null)} disabled={busyAction !== ''}>
          <option value="">Automatic priority order</option>
          {settings?.providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.label}{provider.enabled ? '' : ' (disabled)'}</option>)}
        </select>
      </label>
      <div className="ai-settings__stats" aria-label="AI queue status">
        <span>ACTIVE {settings?.queue.active ?? 0}</span><span>QUEUED {settings?.queue.queued ?? 0}</span><span>PLAYERS {settings?.queue.activePlayers ?? 0}</span><span>LOCAL {settings?.queue.localFallbacks ?? 0}</span>
      </div>
    </div>

    {error && <p className="ai-settings__error" role="alert">{error}</p>}
    {notice && <p className="ai-settings__notice" role="status">{notice}</p>}

    <div className="ai-settings__layout">
      <aside className="ai-settings__providers" aria-label="AI providers">
        {settings?.providers.length ? settings.providers.map((provider) => <button type="button" key={provider.id} className={provider.id === selectedId && !isAdding ? 'selected' : ''} onClick={() => selectProvider(provider.id)}>
          <span><strong>{provider.label || 'Unnamed provider'}</strong><small>{provider.kind} · {provider.model || 'no model'}</small></span>
          <small>{provider.enabled ? 'ON' : 'OFF'} · R{provider.status.requests}</small>
        </button>) : <p className="quiet">No providers configured.</p>}
        {audit && <div className="ai-settings__audit"><strong>LAST AUDIT</strong><span>{audit.action}</span><small>{dateText(audit.createdAt)}</small></div>}
      </aside>

      <div className="ai-settings__editor">
        {draft && (isAdding || selectedProvider) ? <>
          <form onSubmit={saveProvider}>
            <div className="ai-settings__form-heading"><h3>{isAdding ? 'Add provider' : 'Provider metadata'}</h3>{isAdding && <button type="button" onClick={cancelAdding} disabled={busyAction !== ''}>Cancel</button>}</div>
            <div className="ai-settings__fields">
              <label>Label<input value={draft.label} onChange={(event) => updateDraft('label', event.target.value)} maxLength={80} required /></label>
              <label>Kind<select value={draft.kind} onChange={(event) => changeKind(event.target.value as AiProviderKind)}>{PROVIDER_KINDS.map((kind) => <option key={kind} value={kind}>{kind}</option>)}</select></label>
              <label>Model<input value={draft.model} onChange={(event) => updateDraft('model', event.target.value)} maxLength={160} required /></label>
              <label>Base URL<input value={draft.baseUrl} onChange={(event) => updateDraft('baseUrl', event.target.value)} maxLength={500} inputMode="url" /></label>
              <label>JSON mode<select value={draft.jsonMode} onChange={(event) => updateDraft('jsonMode', event.target.value as AiJsonMode)}>{JSON_MODES.map((mode) => <option key={mode} value={mode}>{mode}</option>)}</select></label>
              <label>Priority<input type="number" min={0} max={1000} step={1} value={draft.priority} onChange={(event) => updateDraft('priority', Number(event.target.value))} /></label>
              <label>Requests / minute<input type="number" min={0} max={1000} step={1} value={draft.maxRequestsPerMinute} onChange={(event) => updateDraft('maxRequestsPerMinute', Number(event.target.value))} /></label>
              <label className="ai-settings__check"><input type="checkbox" checked={draft.enabled} onChange={(event) => updateDraft('enabled', event.target.checked)} /> Enabled</label>
            </div>
            {originChanged && <p className="ai-settings__safety">Safety notice: changing provider type or base URL/origin disables its existing keys server-side. Review and re-enable only the keys you trust.</p>}
            <div className="ai-settings__actions"><button type="submit" disabled={busyAction !== ''}>{busyAction === 'provider-save' ? 'Saving…' : 'Save provider'}</button>{selectedProvider && <button type="button" onClick={() => void testProvider()} disabled={busyAction !== ''}>Test connection</button>}{selectedProvider && <button type="button" className="ai-settings__danger" onClick={() => void removeProvider()} disabled={busyAction !== ''}>Remove</button>}</div>
            {testNotice && <p className={`ai-settings__test ai-settings__test--${testNotice.tone}`} role="status">{testNotice.text}</p>}
          </form>

          {selectedProvider && <>
            <div className="ai-settings__metrics"><span>REQUESTS {selectedProvider.status.requests}</span><span>INPUT {selectedProvider.status.inputTokens}</span><span>OUTPUT {selectedProvider.status.outputTokens}</span><span>LAST OK {dateText(selectedProvider.status.lastSuccess)}</span></div>
            {(cooldownText(selectedProvider.status.cooldownUntil) || selectedProvider.status.lastError) && <p className="ai-settings__warning">{cooldownText(selectedProvider.status.cooldownUntil)}{selectedProvider.status.lastError ? ` · ${selectedProvider.status.lastError}` : ''}</p>}

            <section className="ai-settings__keys" aria-label="Provider keys">
              <h3>Keys <small>values are write-only</small></h3>
              {selectedProvider.keys.length ? selectedProvider.keys.map((key) => <article className="ai-settings__key" key={key.id}>
                <div className="ai-settings__key-main">
                  <label>Label<input value={keyLabels[key.id] ?? key.label} onChange={(event) => setKeyLabels((current) => ({ ...current, [key.id]: event.target.value }))} maxLength={80} /></label>
                  <label className="ai-settings__check"><input type="checkbox" checked={key.enabled} onChange={(event) => void updateKey(key, { enabled: event.target.checked })} disabled={busyAction !== ''} /> Enabled</label>
                  <button type="button" onClick={() => void updateKey(key, { label: (keyLabels[key.id] ?? key.label).trim() })} disabled={busyAction !== '' || !(keyLabels[key.id] ?? key.label).trim()}>Save label</button>
                  <button type="button" className="ai-settings__danger" onClick={() => void deleteKey(key)} disabled={busyAction !== ''}>Delete</button>
                </div>
                <div className="ai-settings__key-meta"><span>{key.configured ? 'configured' : 'not configured'} · {key.enabled ? 'enabled' : 'disabled'}</span>{cooldownText(key.cooldownUntil) && <span>{cooldownText(key.cooldownUntil)}</span>}{key.lastError && <span>{key.lastError}</span>}</div>
                <form className="ai-settings__replace" onSubmit={(event) => void replaceKey(event, key)}><label>Optional replacement<input type="password" name="value" autoComplete="new-password" placeholder="Enter new key" /></label><button type="submit" disabled={busyAction !== ''}>{busyAction === `key-replace:${key.id}` ? 'Replacing…' : 'Replace'}</button></form>
              </article>) : <p className="quiet">No keys configured.</p>}
              <form className="ai-settings__add-key" onSubmit={(event) => void addKey(event)}>
                <h4>Add key</h4><label>Label<input name="label" value={newKeyLabel} onChange={(event) => setNewKeyLabel(event.target.value)} maxLength={80} required /></label><label>Key value<input type="password" name="value" autoComplete="new-password" required /></label><button type="submit" disabled={busyAction !== ''}>{busyAction === 'key-add' ? 'Adding…' : 'Add key'}</button>
              </form>
            </section>
          </>}
        </> : <p className="quiet">Select a provider or add one to begin.</p>}
      </div>
    </div>
  </section>;
}
