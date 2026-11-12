import { empty, json, type EndpointRequest } from '@spacefast/zero/server';
import { person, type Writer } from './access';
import { consumeRate } from './rate';
import { parseHtml, type HtmlNode } from './vendor/ember-richtext';

const maxBytes = 128 * 1024;
const cacheLifetime = 30 * 60 * 1000;
const privateHeaders = { 'Cache-Control': 'private, no-store' };

function previewUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\\]/.test(value)) return null;
  const authority = /^https:\/\/([a-z0-9.-]+)(?=\/|\?|#|$)/i.exec(value);
  if (!authority) return null;
  const host = authority[1].toLowerCase();
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host)) return null;
  if (/\.(?:local|localhost|internal|test|invalid|onion)$/.test(host)) return null;
  const suffix = value.slice(authority[0].length).split('#', 1)[0];
  return 'https://' + host + (suffix.startsWith('/') ? suffix : '/' + suffix);
}

type Preview = { title: string; url: string; description: string; image: null };
function cleanText(value: string | undefined, limit: number): string {
  return (value ?? '').replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function metadata(markup: string, url: string): Preview | null {
  const root: HtmlNode = parseHtml(markup);
  let title = '';
  let description = '';
  let openGraphTitle = '';
  let openGraphDescription = '';
  const nodes = [...(root.children ?? [])].reverse();
  while (nodes.length) {
    const node = nodes.pop()!;
    if (node.kind !== 'element') continue;
    if (node.name === 'title' && !title) {
      title = cleanText(node.children?.map(child => child.value ?? '').join(''), 160);
    }
    if (node.name === 'meta') {
      const attr = (name: string) => node.attrs?.find(item => item.name === name)?.value;
      const name = (attr('property') ?? attr('name'))?.toLowerCase();
      if (name === 'og:title' && !openGraphTitle) openGraphTitle = cleanText(attr('content'), 160);
      if (name === 'og:description' && !openGraphDescription) openGraphDescription = cleanText(attr('content'), 280);
      if (name === 'description' && !description) description = cleanText(attr('content'), 280);
    }
    if (node.children && node.name !== 'template' && node.name !== 'body') {
      for (let index = node.children.length - 1; index >= 0; index--) nodes.push(node.children[index]);
    }
  }
  return openGraphTitle || title
    ? { title: openGraphTitle || title, url, description: openGraphDescription || description, image: null }
    : null;
}

async function readMarkup(response: Response): Promise<string | null> {
  if (Number(response.headers.get('content-length')) > maxBytes) return null;
  const reader = response.body?.getReader?.();
  if (!reader) {
    // Zero may return a buffered broker response without a stream.
    if (typeof response.arrayBuffer === 'function' && typeof TextDecoder === 'function') {
      const bytes = await response.arrayBuffer();
      return bytes.byteLength <= maxBytes ? new TextDecoder().decode(bytes) : null;
    }
    const markup = await response.text();
    return markup.length * 3 <= maxBytes ? markup : null;
  }
  const decoder = new TextDecoder();
  let bytes = 0;
  let markup = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return markup + decoder.decode();
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        return null;
      }
      markup += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

async function fetchPreview(url: string): Promise<Preview | null> {
  // Spacefast's HTTPS broker blocks private network and metadata addresses.
  // Never forward visitor headers or credentials. The range lets compliant
  // sites return just enough HTML for the preview.
  const response = await fetch(url, {
    redirect: 'manual',
    headers: { Accept: 'text/html', Range: 'bytes=0-' + (maxBytes - 1) },
  });
  if (!response.ok || !/^text\/html(?:;|$)/i.test(response.headers.get('content-type') ?? '')) return null;
  // Some runners handle redirects in the broker. Reject a different final URL
  // rather than trusting a redirected page's metadata.
  if (response.redirected || (response.url && previewUrl(response.url) !== url)) return null;
  const markup = await readMarkup(response);
  return markup === null ? null : metadata(markup, url);
}

export async function linkPreview(ctx: Writer, request: EndpointRequest) {
  const noPreview = (reason = 'unavailable') => empty({ headers: { ...privateHeaders, 'X-Ember-Preview': reason } });
  let actor;
  try {
    actor = await person(ctx);
  } catch {
    return empty({ status: 403, headers: privateHeaders });
  }
  if (!/^application\/json(?:;|$)/i.test(request.headers.get('content-type') ?? '')) return noPreview();
  const origin = /^https?:\/\/[^/]+/.exec(request.url)?.[0];
  const submittedOrigin = request.headers.get('origin');
  const fetchSite = request.headers.get('sec-fetch-site');
  const sameOrigin = submittedOrigin !== null &&
    (submittedOrigin === origin || submittedOrigin === ctx.env.EMBER_PUBLIC_URL || fetchSite === 'same-origin');
  if (!sameOrigin || (fetchSite && fetchSite !== 'same-origin')) return noPreview('origin');

  let url: string | null;
  try {
    const raw = await request.text();
    if (raw.length > 2500) return noPreview();
    url = previewUrl(JSON.parse(raw)?.url);
  } catch {
    return noPreview();
  }
  if (!url || (origin && url.startsWith(origin + '/')) || url.startsWith(submittedOrigin + '/')) return noPreview('url');

  const key = await ctx.crypto.sha256('v2\n' + actor.id + '\n' + url);
  const cached = await ctx.db.linkPreviews.withIndex('by_key', index => index.eq('key', key)).first();
  const now = new Date().toISOString();
  if (cached && cached.expiresAt > now) {
    return cached.title
      ? json({ title: cached.title, description: cached.description, url, image: null }, { headers: privateHeaders })
      : noPreview();
  }

  try {
    await consumeRate(ctx, actor.id, 'link-preview', 12, 60_000);
  } catch {
    return empty({ status: 429, headers: privateHeaders });
  }

  let preview: Preview | null = null;
  try {
    preview = await fetchPreview(url);
  } catch (error) {
    // Capture only a stable broker code. Error details may contain a private URL.
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null;
    const reason = typeof code === 'string' && /^zero_fetch_[a-z_]+$/.test(code) ? code : 'request-failed';
    ctx.log?.info('Ember link preview fetch unavailable', { reason });
    return noPreview(reason);
  }
  const fields = {
    key, title: preview?.title ?? '', description: preview?.description ?? '',
    expiresAt: new Date(Date.now() + cacheLifetime).toISOString(),
  };
  if (cached) await ctx.db.linkPreviews.update(cached.id, fields);
  else await ctx.db.linkPreviews.insert(fields);
  const expired = await ctx.db.linkPreviews.withIndex('by_expiry', index => index.lt('expiresAt', now)).take(8);
  for (const row of expired) await ctx.db.linkPreviews.delete(row.id);

  return preview ? json(preview, { headers: privateHeaders }) : noPreview();
}
