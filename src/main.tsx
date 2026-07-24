import {Component, StrictMode, Suspense, lazy, type ReactNode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

const HoloPage = lazy(() => import('./holo/HoloPage.tsx'));

class HoloErrorBoundary extends Component<{children: ReactNode}, {hasError: boolean}> {
  state = {hasError: false};

  static getDerivedStateFromError() {
    return {hasError: true};
  }

  render() {
    if (this.state.hasError) {
      return (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: '#000',
            color: '#eafaff',
            display: 'grid',
            placeItems: 'center',
            fontSize: 12,
            letterSpacing: '0.25em',
            fontFamily: 'Inter, system-ui, sans-serif',
          }}
        >
          DATA CONNECTION LOST
        </div>
      );
    }
    return this.props.children;
  }
}

const isHolo = window.location.pathname.replace(/\/+$/, '') === '/holo';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isHolo ? (
      <HoloErrorBoundary>
        <Suspense fallback={<div style={{position: 'fixed', inset: 0, background: '#000'}} />}>
          <HoloPage />
        </Suspense>
      </HoloErrorBoundary>
    ) : (
      <App />
    )}
  </StrictMode>,
);
