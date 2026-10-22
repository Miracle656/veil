import React, { useMemo } from 'react';

export function OriginDisplay({ url }: { url: string }) {
  const { host, origin } = useMemo(() => {
    try {
      const parsed = new URL(url);
      return { host: parsed.hostname, origin: parsed.origin };
    } catch {
      return { host: url, origin: url };
    }
  }, [url]);

  const parts = host.split('.');
  let emphasized = host;
  let prefix = '';
  
  if (parts.length > 2) {
    emphasized = parts.slice(-2).join('.');
    prefix = parts.slice(0, -2).join('.') + '.';
  }

  return (
    <div
      style={{
        wordBreak: 'break-all',
        direction: 'ltr',
        textAlign: 'left',
        padding: '0.75rem',
        background: 'rgba(0,0,0,0.3)',
        borderRadius: '0.5rem',
        marginTop: '0.75rem',
      }}
    >
      <div style={{ fontSize: '0.95rem', color: 'var(--off-white)' }}>
        <span style={{ color: 'rgba(246,247,248,0.45)' }}>{prefix}</span>
        <strong style={{ fontWeight: 600 }}>{emphasized}</strong>
      </div>
      {origin !== host && (
        <div style={{ color: 'rgba(246,247,248,0.45)', fontSize: '0.75rem', marginTop: '0.25rem' }}>
          {origin}
        </div>
      )}
    </div>
  );
}
