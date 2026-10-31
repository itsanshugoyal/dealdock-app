import { describe, expect, it } from 'vitest';
import { parseRedisConnection } from '../src/redis';

describe('Redis connection configuration', () => {
  it('retains TLS, ACL credentials and a non-default database', () => {
    expect(parseRedisConnection('rediss://worker:p%40ss%3Aword@cache.example.com:6380/3')).toEqual({
      host: 'cache.example.com', port: 6380, username: 'worker', password: 'p@ss:word', db: 3,
      tls: { servername: 'cache.example.com' },
    });
  });

  it('parses a local connection without inventing credentials or TLS', () => {
    expect(parseRedisConnection('redis://127.0.0.1:6379')).toEqual({ host: '127.0.0.1', port: 6379, db: 0 });
  });

  it('supports IPv6 without passing brackets to the socket client', () => {
    expect(parseRedisConnection('rediss://[::1]:6380/12')).toEqual({ host: '::1', port: 6380, db: 12, tls: {} });
  });

  it.each(['https://cache.example.com', 'redis://cache.example.com/-1', 'redis://cache.example.com/1.5', 'redis://cache.example.com/9007199254740992', 'redis://cache.example.com/0?tls=false', 'redis://worker:SECRET%ZZ@cache.example.com/0'])('rejects invalid connection settings without leaking credentials', (url) => {
    expect(() => parseRedisConnection(url)).toThrow('REDIS_URL must be a valid');
    try { parseRedisConnection(url); } catch (error) { expect(String(error)).not.toContain('SECRET'); }
  });
});
