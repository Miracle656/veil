import { StyleSheet, Text, View } from 'react-native';
import { useMemo } from 'react';

export function OriginDisplay({ url }: { url: string }) {
  const { host, full } = useMemo(() => {
    try {
      const parsed = new URL(url);
      return { host: parsed.hostname, full: parsed.origin };
    } catch {
      return { host: url, full: url };
    }
  }, [url]);

  const parts = host.split('.');
  let emphasized = host;
  let prefix = '';
  if (parts.length > 2) {
    emphasized = parts.slice(-2).join('.');
    prefix = parts.slice(0, -2).join('.') + '.';
  }

  const hasUnicode = /[^\x00-\x7F]/.test(host);

  return (
    <View style={styles.container}>
      <Text style={styles.host} numberOfLines={0}>
        <Text style={styles.prefix}>{prefix}</Text>
        <Text style={styles.emphasized}>{emphasized}</Text>
      </Text>
      {hasUnicode && !host.startsWith('xn--') && (
        <Text style={styles.warning}>Unicode characters detected in host</Text>
      )}
      {full !== host && (
        <Text style={styles.full} numberOfLines={0}>{full}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: 12,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderRadius: 8,
    marginTop: 12,
  },
  host: {
    fontSize: 16,
    writingDirection: 'ltr',
    color: '#fff',
  },
  prefix: {
    color: '#94a3b8',
  },
  emphasized: {
    fontWeight: 'bold',
    color: '#fff',
  },
  full: {
    fontSize: 12,
    color: '#64748b',
    marginTop: 4,
    writingDirection: 'ltr',
  },
  warning: {
    fontSize: 12,
    color: '#ef4444',
    marginTop: 4,
  },
});
