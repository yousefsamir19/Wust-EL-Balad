import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PROJECT, type HealthResponse } from '../../shared/index';
import './style.css';
import { AccountPanel } from './AccountPanel';
import { AssetGallery } from './game/AssetGallery';
import { TownHUD } from './game/TownHUD';
import type { PlayerProfile } from '../../shared/auth';

function App() {
  const [status, setStatus] = useState('Connecting to backend…');
  const [townPlayer, setTownPlayer] = useState<PlayerProfile | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/health', { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('Backend unavailable');
        const health: HealthResponse = await response.json();
        setStatus(health.status === 'ok' ? 'Backend connected' : 'Backend unavailable');
      })
      .catch(() => { if (!controller.signal.aborted) setStatus('Backend unavailable'); });
    return () => controller.abort();
  }, []);
  if (townPlayer) return <TownHUD player={townPlayer} onBack={() => setTownPlayer(null)} />;
  return (
    <main className="min-h-screen flex items-center justify-center p-6">
      <section className="foundation max-w-2xl w-full p-8 sm:p-12">
        <p className="eyebrow">{PROJECT.setting} · {PROJECT.currency}</p>
        <h1 className="text-4xl sm:text-5xl font-bold mt-4">{PROJECT.name}</h1>
        <p className="mt-6 text-lg">The player does not control the story. The player discovers the story.</p>
        <div className="status mt-8" role="status">{status}</div>
        <AccountPanel onEnterTown={setTownPlayer} />
        <AssetGallery />
        <footer className="mt-8">{PROJECT.newspaper} · Project foundation</footer>
      </section>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
