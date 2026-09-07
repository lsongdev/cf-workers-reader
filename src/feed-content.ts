import { XMLParser, XMLValidator } from "fast-xml-parser";
import { now, sha256 } from "./crypto";

export function publicFeedUrl(value: string, base?: string): string {
  const url = new URL(value, base);
  const host = url.hostname.toLowerCase();
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      (url.port && !['80', '443'].includes(url.port)) || !host.includes('.') ||
      /^[\d.]+$/.test(host) || host.includes(':') || /\.(local|localhost|internal|test|invalid|example|onion)$/.test(host) ||
      host === 'localhost' || [...url.searchParams.keys()].some(key => /token|key|secret|auth|password|signature/i.test(key))) {
    throw new Error('Use a public HTTP(S) feed URL without credentials or private tokens.');
  }
  url.hash = '';
  return url.toString();
}

export function articleUrl(value: string, base: string): string {
  try { const u = new URL(value, base); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password ? u.href : ''; }
  catch { return ''; }
}

export async function boundedText(response: Response, limit = 5_000_000): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let size = 0, result = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit) throw new Error('Feed exceeds the 2 MB limit.');
      result += decoder.decode(chunk.value, { stream: true });
    }
    return result + decoder.decode();
  } finally { await reader.cancel(); }
}

export async function fetchPublic(value: string, headers: HeadersInit = {}): Promise<{ response: Response; url: string; aliases: string[] }> {
  let url = publicFeedUrl(value);
  const aliases: string[] = [];
  for (let hop = 0; hop < 6; hop++) {
    aliases.push(url);
    const response = await fetch(url, { headers: { 'User-Agent': 'LsongReader/1.0 (+https://read.lsong.org)', 'Accept': 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, text/html;q=0.5, */*;q=0.1', ...headers }, redirect: 'manual', signal: AbortSignal.timeout(15000) });
    if (![301, 302, 303, 307, 308].includes(response.status)) return { response, url, aliases };
    await response.body?.cancel();
    const location = response.headers.get('location');
    if (!location) throw new Error('Feed redirect is missing its destination.');
    url = publicFeedUrl(location, url);
  }
  throw new Error('Too many feed redirects.');
}

export async function sanitizeContent(content: string, base: string): Promise<string> {
  const allowed = new Set(['p','br','a','strong','b','em','i','ul','ol','li','blockquote','pre','code','h1','h2','h3','h4','hr','div','span','table','thead','tbody','tr','th','td','figure','figcaption','img']);
  const dangerous = new Set(['script','style','iframe','object','embed','svg','math','template']);
  return new HTMLRewriter().on('*', { element(element) {
    if (!allowed.has(element.tagName)) { dangerous.has(element.tagName) ? element.remove() : element.removeAndKeepContent(); return; }
    const href = element.tagName === 'a' ? articleUrl(element.getAttribute('href') || '', base) : '';
    const src = element.tagName === 'img' ? articleUrl(element.getAttribute('src') || '', base) : '';
    const alt = element.tagName === 'img' ? (element.getAttribute('alt') || '').slice(0, 1000) : '';
    const title = element.tagName === 'img' ? (element.getAttribute('title') || '').slice(0, 1000) : '';
    for (const [name] of Array.from(element.attributes)) if (name) element.removeAttribute(name);
    if (href) { element.setAttribute('href', href); element.setAttribute('rel', 'noopener noreferrer'); element.setAttribute('target', '_blank'); }
    if (element.tagName === 'img') {
      if (!src || !src.startsWith('https:')) { element.remove(); return; }
      element.setAttribute('src', src);
      if (alt) element.setAttribute('alt', alt);
      if (title) element.setAttribute('title', title);
      element.setAttribute('loading', 'lazy');
      element.setAttribute('decoding', 'async');
      element.setAttribute('referrerpolicy', 'no-referrer');
    }
  } }).transform(new Response(content)).text();
}

type Xml = Record<string, unknown>;
const obj = (value: unknown): Xml => typeof value === 'object' && value !== null ? value as Xml : {};
const list = (value: unknown): unknown[] => value === undefined ? [] : Array.isArray(value) ? value : [value];
const text = (value: unknown): string => typeof value === 'string' || typeof value === 'number' ? String(value) : typeof obj(value)['#text'] === 'string' ? String(obj(value)['#text']) : '';
function link(value: unknown, base: string): string {
  for (const entry of list(value)) {
    const row = obj(entry);
    if (row['@_rel'] && row['@_rel'] !== 'alternate') continue;
    const candidate = text(row['@_href']) || text(entry);
    if (candidate) return articleUrl(candidate, base);
  }
  return '';
}
export interface ParsedItem { guid: string; url: string; title: string; content: string; author: string; published_at: number }
export interface ParsedFeed { title: string; site_url: string; items: ParsedItem[] }
export interface OpmlSubscription { url: string; title: string; folder: string }

export function parseOpml(xml: string): OpmlSubscription[] {
  const xmlMarkup = xml.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');
  if (/<!DOCTYPE|<!ENTITY/i.test(xmlMarkup) || XMLValidator.validate(xml) !== true) throw new Error('Invalid OPML XML.');
  const root = obj(new XMLParser({ ignoreAttributes: false, parseTagValue: false, trimValues: true }).parse(xml)).opml;
  const body = obj(obj(root).body);
  if (!Object.keys(body).length) throw new Error('This file is not OPML.');
  const subscriptions: OpmlSubscription[] = [];
  const visit = (values: unknown, folders: string[]) => {
    for (const value of list(values)) {
      const row = obj(value);
      const url = text(row['@_xmlUrl'] ?? row['@_xmlurl']).trim();
      const label = text(row['@_title'] ?? row['@_text']).trim();
      if (url) {
        subscriptions.push({ url: url.slice(0, 2048), title: label.slice(0, 500), folder: folders.join(' / ').slice(0, 100) });
        if (subscriptions.length > 500) throw new Error('OPML contains more than 500 subscriptions.');
      }
      if (row.outline !== undefined) visit(row.outline, label ? [...folders, label] : folders);
    }
  };
  visit(body.outline, []);
  if (!subscriptions.length) throw new Error('No subscriptions were found in this OPML file.');
  return subscriptions;
}

export async function parseFeed(xml: string, base: string): Promise<ParsedFeed> {
  const xmlMarkup = xml.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');
  if (/<!DOCTYPE|<!ENTITY/i.test(xmlMarkup) || XMLValidator.validate(xml) !== true) throw new Error('Invalid or unsupported feed XML.');
  const parsed = obj(new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, parseTagValue: false, trimValues: true }).parse(xml));
  const atom = parsed.feed !== undefined;
  const channel = obj(atom ? parsed.feed : obj(parsed.rss).channel ?? obj(parsed.RDF).channel);
  if (!Object.keys(channel).length) throw new Error('This URL is not an RSS or Atom feed.');
  const rawItems = list(atom ? channel.entry : channel.item ?? obj(parsed.RDF).item).slice(0, 200);
  const items: ParsedItem[] = [];
  for (const value of rawItems) {
    const row = obj(value);
    const url = link(row.link, base);
    const title = (text(row.title) || 'Untitled').slice(0, 1000);
    const date = text(row.published || row.pubDate || row.updated || row.date);
    const stamp = Date.parse(date);
    const published_at = Number.isFinite(stamp) ? Math.min(Math.floor(stamp / 1000), now()) : now();
    const content = await sanitizeContent((text(row.encoded) || text(row.content) || text(row.description) || text(row.summary)).slice(0, 100_000), url || base);
    const guid = (text(row.id) || text(row.guid) || url || await sha256(`${title}\n${date}\n${content}`)).slice(0, 2048);
    items.push({ guid, url, title, content, author: (text(obj(row.author).name) || text(row.author) || text(row.creator)).slice(0, 300), published_at });
  }
  return { title: (text(channel.title) || new URL(base).hostname).slice(0, 500), site_url: link(channel.link, base), items };
}

export async function discoverFeed(value: string): Promise<{ parsed: ParsedFeed; url: string; aliases: string[]; response: Response }> {
  let result = await fetchPublic(value);
  if (!result.response.ok) { await result.response.body?.cancel(); throw new Error(`Feed returned HTTP ${result.response.status}.`); }
  let body = await boundedText(result.response);
  if (/text\/html/i.test(result.response.headers.get('content-type') || '') || /^\s*(?:<!doctype html[^>]*>\s*)?<html[\s>]/i.test(body)) {
    let alternate = '';
    await new HTMLRewriter().on('link', { element(e) {
      if (!alternate && (e.getAttribute('rel') || '').split(/\s+/).includes('alternate') && /application\/(rss|atom)\+xml/.test(e.getAttribute('type') || '')) alternate = e.getAttribute('href') || '';
    } }).transform(new Response(body)).text();
    if (!alternate) throw new Error('No RSS or Atom link was found on this page.');
    const sourceAliases = result.aliases;
    result = await fetchPublic(publicFeedUrl(alternate, result.url));
    result.aliases = [...sourceAliases, ...result.aliases];
    if (!result.response.ok) throw new Error(`Feed returned HTTP ${result.response.status}.`);
    body = await boundedText(result.response);
  }
  return { ...result, parsed: await parseFeed(body, result.url) };
}
