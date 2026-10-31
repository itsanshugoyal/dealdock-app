/** Parsed connection data shared by API and workers. Never log the input URL. */
export interface RedisConnection {
  host: string;
  port: number;
  username?: string;
  password?: string;
  db: number;
  tls?: { servername?: string };
}

/** Preserve TLS, ACL credentials and database selection instead of silently dropping them. */
export function parseRedisConnection(value: string): RedisConnection {
  try {
    const url = new URL(value);
    if (!['redis:', 'rediss:'].includes(url.protocol) || !url.hostname || url.search || url.hash) {
      throw new Error('unsupported connection URL');
    }
    const database = url.pathname.replace(/^\//, '');
    if (database && !/^\d+$/.test(database)) throw new Error('invalid database');
    const db = database ? Number(database) : 0;
    const port = Number(url.port || 6379);
    if (!Number.isSafeInteger(db) || db < 0 || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('invalid connection settings');
    }
    const host = url.hostname.replace(/^\[|\]$/g, '');
    return {
      host,
      port,
      ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
      ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
      db,
      ...(url.protocol === 'rediss:' ? { tls: { ...(!host.includes(':') && !/^\d+\.\d+\.\d+\.\d+$/.test(host) ? { servername: host } : {}) } } : {}),
    };
  } catch {
    // URLs often contain credentials; expose only a fixed, non-sensitive error.
    throw new Error('REDIS_URL must be a valid redis:// or rediss:// URL with an optional numeric database.');
  }
}
