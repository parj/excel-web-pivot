import type { CSSProperties } from 'react';

import type { SaveState } from '../api';

const styles: Record<string, CSSProperties> = {
  base: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    padding: '3px 9px',
    borderRadius: 4,
    fontSize: 11,
    fontWeight: 500,
    border: '1px solid transparent',
  },
};

export function SaveBadge({ state, error }: { state: SaveState; error?: string | null }) {
  if (state === 'idle') return null;
  if (state === 'saving') {
    return (
      <span style={{ ...styles.base, color: 'var(--pv-text-2)', borderColor: 'var(--pv-border-strong)' }}>
        ● Saving…
      </span>
    );
  }
  if (state === 'saved') {
    return (
      <span style={{ ...styles.base, color: '#16a34a', borderColor: 'rgba(22,163,74,0.3)' }}>✓ Saved</span>
    );
  }
  return (
    <span
      style={{
        ...styles.base,
        color: 'var(--pv-accent)',
        background: 'var(--pv-accent-bg)',
        borderColor: 'var(--pv-accent-border)',
      }}
      title={error ?? undefined}
    >
      ⚠ Save failed{error ? `: ${error}` : ''}
    </span>
  );
}
