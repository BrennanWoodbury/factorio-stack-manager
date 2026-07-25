import { afterEach, describe, expect, test } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { StatusBadge } from './StatusBadge';

afterEach(cleanup);

describe('StatusBadge', () => {
  test('a crash-looping server is not shown as merely stopped', () => {
    // The regression this guards: status was derived from Docker's `Running` flag
    // alone, so a container dying on startup and being restarted forever rendered
    // as "Stopped" — the one badge that suggests nothing is wrong.
    render(<StatusBadge status="crashed" />);
    expect(screen.getByText('Crash looping')).toBeTruthy();
    expect(screen.queryByText('Stopped')).toBeNull();
  });

  test('running and stopped are unchanged', () => {
    const { unmount } = render(<StatusBadge status="running" />);
    expect(screen.getByText('Running')).toBeTruthy();
    unmount();

    render(<StatusBadge status="stopped" />);
    expect(screen.getByText('Stopped')).toBeTruthy();
  });

  test('an unrecognised status reads as stopped rather than blank', () => {
    render(<StatusBadge status="" />);
    expect(screen.getByText('Stopped')).toBeTruthy();
  });
});
