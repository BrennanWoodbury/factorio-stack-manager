/**
 * `crashed` is its own state on purpose: a server whose mods won't load exits and
 * Docker restarts it forever, which used to render as plain "Stopped" — the one
 * badge that suggests nothing is wrong.
 */
export function StatusBadge({ status }: { status: string }) {
  if (status === 'crashed') {
    return (
      <span className="badge crashed" title="The container keeps exiting and restarting">
        <span className="dot" />
        Crash looping
      </span>
    );
  }
  const running = status === 'running';
  return (
    <span className={`badge ${running ? 'running' : 'stopped'}`}>
      <span className="dot" />
      {running ? 'Running' : 'Stopped'}
    </span>
  );
}
