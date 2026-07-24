import { useCallback, useEffect, useRef, useState } from 'react';
import { useHoloData, type HoloStats, type RealtimeStatus } from './useHoloData';
import './holo.css';

const SCENE_COUNT = 4;
const SCENE_DURATION_MS = 3500;
const CONTROLS_HIDE_MS = 4000;

const usd = new Intl.NumberFormat('en-US');
const money = (value: number) => `$ ${usd.format(Math.round(value))}`;

function SceneContent({ scene, stats, updateKey }: { scene: number; stats: HoloStats; updateKey: number }) {
  switch (scene) {
    case 0:
      return (
        <div className="holo-scene" key={`s0-${updateKey}`}>
          <div className="holo-logo">N</div>
          <div className="holo-brand">NUR EXCHANGE</div>
          <div className="holo-kicker">LIVE OPERATIONS</div>
        </div>
      );
    case 1:
      return (
        <div className="holo-scene" key={`s1-${updateKey}`}>
          <div className="holo-bank">AKTIV BANK</div>
          <div className="holo-count holo-value-updated">{stats.aktiv.count}</div>
          <div className="holo-label">Transfers today</div>
          <div className="holo-divider" />
          <div className="holo-amount holo-value-updated">{money(stats.aktiv.amount)}</div>
        </div>
      );
    case 2:
      return (
        <div className="holo-scene" key={`s2-${updateKey}`}>
          <div className="holo-bank">IBT BANK</div>
          <div className="holo-count holo-value-updated">{stats.ibt.count}</div>
          <div className="holo-label">Transfers today</div>
          <div className="holo-divider" />
          <div className="holo-amount holo-value-updated">{money(stats.ibt.amount)}</div>
        </div>
      );
    default:
      return (
        <div className="holo-scene" key={`s3-${updateKey}`}>
          <div className="holo-logo">N</div>
          <div className="holo-count holo-value-updated">{stats.totalTransfers}</div>
          <div className="holo-label">Total transfers today</div>
          <div className="holo-kicker">NUR EXCHANGE</div>
        </div>
      );
  }
}

function liveLabel(status: RealtimeStatus, dataLost: boolean): { text: string; cls: string } {
  if (dataLost) return { text: 'OFFLINE', cls: 'holo-live--offline' };
  if (status === 'connected') return { text: 'LIVE', cls: '' };
  if (status === 'offline') return { text: 'OFFLINE', cls: 'holo-live--offline' };
  return { text: 'RECONNECTING', cls: 'holo-live--reconnecting' };
}

export default function HoloPage() {
  const demoMode =
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('demo') === 'true';

  const { stats, loading, dataLost, diagnostics, refresh } = useHoloData(demoMode);

  const [scene, setScene] = useState(0);
  const [paused, setPaused] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(false);
  const [showDiag, setShowDiag] = useState(false);
  const [updateKey, setUpdateKey] = useState(0);

  const hideTimerRef = useRef<number | null>(null);
  const wakeLockRef = useRef<{ release: () => Promise<void> } | null>(null);

  // Scene loop
  useEffect(() => {
    if (paused) return;
    const timer = window.setInterval(() => {
      setScene((s) => (s + 1) % SCENE_COUNT);
    }, SCENE_DURATION_MS);
    return () => window.clearInterval(timer);
  }, [paused]);

  // Flash animation when data changes (no full refresh / white screen)
  useEffect(() => {
    setUpdateKey((k) => k + 1);
  }, [stats]);

  // Screen wake lock (standard API, released on unmount / ignored if unsupported)
  useEffect(() => {
    let cancelled = false;
    const requestLock = async () => {
      try {
        const nav = navigator as Navigator & {
          wakeLock?: { request: (type: 'screen') => Promise<{ release: () => Promise<void> }> };
        };
        if (!nav.wakeLock) return;
        const lock = await nav.wakeLock.request('screen');
        if (cancelled) void lock.release();
        else wakeLockRef.current = lock;
      } catch {
        /* not critical */
      }
    };
    void requestLock();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void requestLock();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibility);
      void wakeLockRef.current?.release().catch(() => undefined);
      wakeLockRef.current = null;
    };
  }, []);

  const scheduleHide = useCallback(() => {
    if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
    hideTimerRef.current = window.setTimeout(() => {
      setControlsVisible(false);
      setShowDiag(false);
    }, CONTROLS_HIDE_MS);
  }, []);

  useEffect(() => () => {
    if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
  }, []);

  const handleStageTap = useCallback(() => {
    setControlsVisible((v) => !v);
    scheduleHide();
  }, [scheduleHide]);

  const handleFullscreen = useCallback(async (event: React.MouseEvent) => {
    event.stopPropagation();
    try {
      if (!document.fullscreenElement) {
        await document.documentElement.requestFullscreen();
      } else {
        await document.exitFullscreen();
      }
    } catch {
      /* unsupported */
    }
    scheduleHide();
  }, [scheduleHide]);

  const live = liveLabel(diagnostics.realtimeStatus, dataLost);

  return (
    <div className="holo-root" onClick={handleStageTap}>
      {loading && <div className="holo-loading">NUR HOLO</div>}

      <div className="holo-rotate">ROTATE YOUR PHONE</div>

      <div className={`holo-live ${live.cls}`}>
        <span className="holo-live-dot" />
        <span>{live.text}</span>
      </div>

      {dataLost && <div className="holo-data-lost">DATA CONNECTION LOST</div>}
      {demoMode && diagnostics.demoActive && (
        <div className="holo-data-lost" style={{ color: 'var(--holo-muted)' }}>DEMO DATA</div>
      )}

      <section className="holo-cross" aria-label="NurExchange hologram">
        {(['top', 'right', 'bottom', 'left'] as const).map((side) => (
          <div key={side} className={`holo-panel holo-panel--${side}`}>
            <div className="holo-content">
              <SceneContent scene={scene} stats={stats} updateKey={updateKey} />
            </div>
          </div>
        ))}
      </section>

      <div className={`holo-controls ${controlsVisible ? 'holo-controls--visible' : ''}`}>
        <button className="holo-btn" type="button" onClick={handleFullscreen}>
          Full screen
        </button>
        <button
          className="holo-btn"
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setPaused((p) => !p);
            scheduleHide();
          }}
        >
          {paused ? 'Play' : 'Pause'}
        </button>
        <button
          className="holo-btn"
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            refresh();
            scheduleHide();
          }}
        >
          Refresh data
        </button>
        <button
          className="holo-btn"
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setShowDiag((v) => !v);
            scheduleHide();
          }}
        >
          Diagnostics
        </button>
      </div>

      {showDiag && (
        <aside className="holo-diag" onClick={(e) => e.stopPropagation()}>
          <div><strong>Supabase:</strong> {diagnostics.supabaseStatus}</div>
          <div><strong>Realtime:</strong> {diagnostics.realtimeStatus}</div>
          <div><strong>Last refresh:</strong> {diagnostics.lastRefresh ?? '—'}</div>
          <div><strong>Dushanbe date:</strong> {diagnostics.dushanbeDate}</div>
          <div><strong>Aktiv records:</strong> {diagnostics.aktivRecords}</div>
          <div><strong>IBT records:</strong> {diagnostics.ibtRecords}</div>
          <div><strong>Demo mode:</strong> {demoMode ? (diagnostics.demoActive ? 'active (fallback)' : 'armed') : 'off'}</div>
          <div><strong>Last error:</strong> {diagnostics.lastError ?? 'none'}</div>
        </aside>
      )}
    </div>
  );
}
