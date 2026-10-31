/** Shown while WindVeal works out who's signed in. Same markup and styles as the splash in index.html, so start-up is one smooth step. */
export function Splash() {
  return (
    <div className="boot" role="status" aria-label="Loading WindVeal">
      <img className="boot-light" src="/logo.png" alt="" draggable={false} />
      <img className="boot-dark" src="/logo-light.png" alt="" draggable={false} />
      <span className="boot-bar" />
    </div>
  );
}
