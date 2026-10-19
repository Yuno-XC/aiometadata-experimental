import consola from 'consola';
import { LRUCache } from 'lru-cache';
import { envInt } from '../../utils/envNumber';
import { normaliseStreamBase } from './streams';

const logger = consola.withTag('Jellyfin');

const cache = new LRUCache<string, string[]>({
  max: 200,
  ttl: envInt('JELLYFIN_BADGE_PACK_CACHE_TTL', 300, 1) * 1000,
});

/**
 * AIOS (experimental) publishes badge-pack JSON URLs on
 * `/jellyfin/.../System/Info/Public` as `aiostreams.defaultBadgePacks`.
 * AIOM's stream addon URL is a Stremio base; map it to that Jellyfin info URL.
 */
export function jellyfinInfoUrlFromStreamBase(streamBase: string): string | null {
  const base = normaliseStreamBase(streamBase);
  if (!base) return null;
  try {
    const parsed = new URL(base);
    let path = parsed.pathname.replace(/\/+$/, '');
    if (/\/stremio(\/|$)/i.test(path)) {
      path = path.replace(/\/stremio(\/|$)/i, '/jellyfin$1');
    } else if (!/\/jellyfin(\/|$)/i.test(path)) {
      path = `${path}/jellyfin`.replace(/\/{2,}/g, '/');
    }
    parsed.pathname = `${path}/System/Info/Public`.replace(/\/{2,}/g, '/');
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return null;
  }
}

function uniqueHttpUrls(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const out: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const url = value.trim();
    if (!/^https?:\/\//i.test(url)) continue;
    if (out.includes(url)) continue;
    out.push(url);
  }
  return out;
}

/**
 * Badge packs for this AIOM configuration: pulled from the configured stream
 * addon's Jellyfin System/Info so clients never hardcode pack URLs.
 */
export async function badgePacksForConfig(config: any | null | undefined): Promise<string[]> {
  const raw = typeof config?.jellyfinStreamUrl === 'string' ? config.jellyfinStreamUrl : '';
  const infoUrl = jellyfinInfoUrlFromStreamBase(raw);
  if (!infoUrl) return [];

  const cached = cache.get(infoUrl);
  if (cached) return cached;

  // Keep this short — System/Info must not stall the whole Jellyfin handshake.
  const timeoutMs = envInt('JELLYFIN_BADGE_PACK_TIMEOUT_MS', 2500, 250);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(infoUrl, {
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response.ok) {
        logger.debug(`Badge packs ${infoUrl} returned ${response.status}`);
        cache.set(infoUrl, []);
        return [];
      }
      const body: any = await response.json();
      const packs = uniqueHttpUrls(body?.aiostreams?.defaultBadgePacks);
      cache.set(infoUrl, packs);
      return packs;
    } finally {
      clearTimeout(timer);
    }
  } catch (error: any) {
    logger.debug(`Badge packs ${infoUrl} failed: ${error?.message || error}`);
    cache.set(infoUrl, []);
    return [];
  }
}
