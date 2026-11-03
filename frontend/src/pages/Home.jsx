import { Link } from 'react-router-dom';
import { useQueueState } from '../hooks/useQueueState.js';
import { useAppConfig } from '../hooks/useAppConfig.js';
import StatusBadge from '../components/StatusBadge.jsx';

export default function Home() {
  const { state, tokens, announcement, loading } = useQueueState();
  const cfg = useAppConfig();
  const tokenList = Object.values(tokens || {});
  const waiting = tokenList.filter(token => token.status === 'waiting').length;
  const nowServing = state?.currentTokenNumber || 0;

  return (
    <div className="home-page">
      {announcement?.message && (
        <div className="home-announcement" role="status">
          <span className="live-dot" />
          <span>{announcement.message}</span>
        </div>
      )}

      <section className="home-hero">
        <div className="home-copy">
          <div className="eyebrow">
            <span className="eyebrow-mark" />
            {cfg.orgName && cfg.orgName !== 'QueueLess' ? cfg.orgName : 'A calmer way to wait'}
          </div>
          <h1>
            Make waiting<br />
            <em>work around you.</em>
          </h1>
          <p className="home-intro">
            Join the right queue from wherever you are. Follow your place live, then arrive when it’s
            nearly your turn — not before.
          </p>
          <div className="home-actions">
            <Link to="/take" className="home-cta">
              Take a token <span aria-hidden="true">↗</span>
            </Link>
            <Link to="/lookup" className="home-track-link">Already have a token? Track it</Link>
          </div>
          <div className="home-assurance">
            <span>No app to install</span>
            <span>Live updates</span>
            <span>Free to use</span>
          </div>
        </div>

        <aside className="live-board" aria-label="Live queue status">
          <div className="live-board-top">
            <div>
              <span className="board-kicker">Live queue</span>
              <h2>{cfg.orgName && cfg.orgName !== 'QueueLess' ? cfg.orgName : 'QueueLess'}</h2>
            </div>
            {!loading && <StatusBadge status={state?.status || 'running'} />}
          </div>
          <div className="board-number">
            <span className="board-kicker">Now serving</span>
            <span className="board-token num">
              {nowServing > 0 ? String(nowServing).padStart(2, '0') : '—'}
            </span>
            <span className="board-caption">
              {state?.status === 'paused' ? 'Service is paused for now' : 'At the counter'}
            </span>
          </div>
          <div className="board-foot">
            <div>
              <span className="board-kicker">In line</span>
              <span className="board-waiting num">{String(waiting).padStart(2, '0')}</span>
            </div>
            <div className="board-live-note">
              <span className="live-dot" />
              Updates automatically
            </div>
          </div>
          <div className="board-rule" />
          <p className="board-note">
            Take your place online. We’ll keep your position current while you get on with your day.
          </p>
        </aside>
      </section>

      <section className="home-how" aria-label="How QueueLess works">
        <div className="home-how-heading">
          <span className="eyebrow">A better use of your time</span>
          <span className="home-how-aside">Three easy steps</span>
        </div>
        <div className="home-steps">
          <div className="home-step">
            <span className="step-number">01</span>
            <div><h3>Choose your service</h3><p>Tell us what you’re here for.</p></div>
          </div>
          <div className="home-step">
            <span className="step-number">02</span>
            <div><h3>Keep your place</h3><p>Your queue position follows along live.</p></div>
          </div>
          <div className="home-step">
            <span className="step-number">03</span>
            <div><h3>Arrive when called</h3><p>Come to the counter when it’s your turn.</p></div>
          </div>
        </div>
      </section>
    </div>
  );
}
