import { h, render } from '/vendor/preact.js';
import { useCallback, useEffect, useState } from '/vendor/hooks.js';
import htm from '/vendor/htm.js';
const html = htm.bind(h);

async function request(path, options = {}) {
  const response = await fetch('/api' + path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.csrf ? { 'X-CSRF-Token': options.csrf } : {}), ...options.headers },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Request failed. Please try again.');
  return data;
}
const date = stamp => new Date(stamp * 1000).toLocaleDateString();

function Shell({ user, csrf, children }) {
  const logout = async () => { await request('/logout', { method: 'POST', csrf }); location.href = '/'; };
  return html`<div class="app-shell"><header class="navbar"><a class="navbar-brand" href="/" aria-label="Reader home"><img src="/icon-192.png" width="22" height="22" alt=""/>Reader</a><nav aria-label="Account navigation">${user && html`<span class="address">${user.name || 'Reader'}</span><button class="button-link" onClick=${logout}>Sign out</button>`}</nav></header><main>${children}</main><footer><span>Reader</span><span>Part of lsong.org</span></footer></div>`;
}
function Landing() {
  const error = new URLSearchParams(location.search).get('error');
  return html`<${Shell}><section class="site-hero">${error && html`<div class="alert error" role="alert">Sign-in could not be completed. Please try again.</div>`}<p class="eyebrow">Reader · Your personal reading space</p><h1 class="site-hero-title">Follow what matters.<br/>Read at your pace.</h1><p class="site-hero-copy">One place for your RSS subscriptions. Your subscriptions, reading progress and saved articles stay with your account.</p><a class="button button-primary" href="/login">Sign in with my.lsong.org</a></section><p class="landing-developer-link"><a href="/health">Service health</a></p><//>`;
}
function FeedList({ feeds, active, choose, reload, api }) {
  return html`<div id="feeds">${!feeds.length && html`<p class="muted">No subscriptions yet. Add a feed below.</p>`}${feeds.map(feed => html`<div class="feed" key=${feed.id}><button class=${feed.id === active ? 'active' : ''} onClick=${() => choose(feed.id)}>${feed.title} (${feed.unread})</button>${feed.folder && html`<small class="muted">${feed.folder}</small>`}${feed.error && html`<small class="error">${feed.error} Retrying automatically.</small>`}<details><summary>Manage</summary><${ManageFeed} feed=${feed} api=${api} reload=${reload}/></details></div>`)}</div>`;
}
function ManageFeed({ feed, api, reload }) {
  const [title, setTitle] = useState(feed.title), [folder, setFolder] = useState(feed.folder);
  const save = async event => { event.preventDefault(); await api(`/subscriptions/${feed.id}`, { method: 'PATCH', body: { title, folder } }); await reload(); };
  const remove = async () => { if (!confirm(`Unsubscribe from ${feed.title}?`)) return; await api(`/subscriptions/${feed.id}`, { method: 'DELETE' }); await reload(true); };
  return html`<form onSubmit=${save}><label>Title<input value=${title} onInput=${e => setTitle(e.currentTarget.value)}/></label><label>Folder<input value=${folder} onInput=${e => setFolder(e.currentTarget.value)}/></label><button>Save</button><button type="button" onClick=${remove}>Unsubscribe</button></form>`;
}
function Subscribe({ api, reload, report }) {
  const [busy, setBusy] = useState(false);
  const submit = async event => { event.preventDefault(); setBusy(true); report('Finding your feed…'); try { const data = new FormData(event.currentTarget); await api('/subscriptions', { method: 'POST', body: { url: data.get('url'), folder: data.get('folder') } }); event.currentTarget.reset(); await reload(); report('Subscription added.'); } catch (error) { report(error.message, true); } finally { setBusy(false); } };
  return html`<details><summary>Add a subscription</summary><form onSubmit=${submit}><label>Feed or website URL<input type="url" name="url" placeholder="https://example.com/feed.xml" required/></label><label>Folder (optional)<input name="folder" maxlength="100"/></label><button disabled=${busy}>${busy ? 'Finding…' : 'Subscribe'}</button></form></details>`;
}
function Article({ item, api, afterChange }) {
  if (!item) return html`<div class="empty"><h2>A little room to read.</h2><p>Choose an article, or add your first subscription.</p></div>`;
  const set = async patch => { await api(`/items/${item.id}`, { method: 'PATCH', body: patch }); await afterChange(); };
  return html`<div><h2>${item.title}</h2><p class="muted">${[item.author, new Date(item.published_at * 1000).toLocaleString()].filter(Boolean).join(' · ')}</p><div class="article-actions"><button onClick=${() => set({ starred: !item.starred })}>${item.starred ? '★ Saved' : '☆ Save'}</button><button onClick=${() => set({ read: false })}>Mark unread</button>${item.url && html`<a href=${item.url} target="_blank" rel="noopener noreferrer">Open original ↗</a>`}</div><div class="article-content" dangerouslySetInnerHTML=${{ __html: item.content }}/></div>`;
}
function Reader({ auth }) {
  const [feeds, setFeeds] = useState([]), [items, setItems] = useState([]), [filter, setFilter] = useState('unread'), [feed, setFeed] = useState(0), [before, setBefore] = useState(0), [article, setArticle] = useState(null), [message, setMessage] = useState(null);
  const api = useCallback((path, options = {}) => request(path, { ...options, csrf: auth.csrf }), [auth.csrf]);
  const report = (text, error = false) => setMessage({ text, error });
  const loadFeeds = useCallback(async () => setFeeds(await api('/subscriptions')), [api]);
  const loadItems = useCallback(async (append = false) => { const rows = await api(`/items?filter=${filter}&feed=${feed}${append && before ? `&before=${before}` : ''}`); setItems(old => append ? [...old, ...rows] : rows); setBefore(rows.at(-1)?.id || 0); }, [api, filter, feed, before]);
  const reload = useCallback(async reset => { if (reset) { setFeed(0); setArticle(null); } await Promise.all([loadFeeds(), loadItems(false)]); }, [loadFeeds, loadItems]);
  useEffect(() => { setBefore(0); loadItems(false).catch(e => report(e.message, true)); }, [filter, feed]);
  useEffect(() => { loadFeeds().catch(e => report(e.message, true)); }, []);
  const open = async id => { const value = await api('/items/' + id); setArticle(value); if (!value.read) await api('/items/' + id, { method: 'PATCH', body: { read: true } }); await Promise.all([loadFeeds(), loadItems(false)]); };
  const addRead = async () => { await api('/mark-read', { method: 'POST', body: { feed } }); await reload(); report('Marked all current articles as read.'); };
  return html`<${Shell} user=${auth.user} csrf=${auth.csrf}><div class="reader-heading"><div><p class="eyebrow">Your reading space</p><h1>Welcome${auth.user.name ? `, ${auth.user.name}` : ''}</h1></div><button onClick=${async () => { await reload(); report('Updated. Feeds are fetched automatically in the background.'); }}>Refresh</button></div>${message && html`<div class=${message.error ? 'alert error' : 'alert notice'} role=${message.error ? 'alert' : 'status'}>${message.text}</div>`}<div class="reader-grid"><aside aria-label="Subscriptions"><nav class="filters">${[['unread','Unread'],['all','All articles'],['starred','Saved']].map(([key,label]) => html`<button aria-pressed=${filter === key} onClick=${() => setFilter(key)}>${label}</button>`)}</nav><h2>Subscriptions</h2><button onClick=${() => setFeed(0)}>All feeds</button><${FeedList} feeds=${feeds} active=${feed} choose=${setFeed} reload=${reload} api=${api}/><${Subscribe} api=${api} reload=${reload} report=${report}/><p><a href="/settings">Client settings</a></p></aside><section aria-label="Articles"><div class="list-toolbar"><h2>${filter === 'unread' ? 'Unread' : filter === 'starred' ? 'Saved' : 'All articles'}</h2><button onClick=${addRead}>Mark all read</button></div><div>${!items.length && html`<p class="empty">${filter === 'unread' ? 'You’re all caught up.' : 'No articles here yet.'}</p>`}${items.map(item => html`<button class=${`item ${item.read ? 'is-read' : ''}`} onClick=${() => open(item.id)}><small>${item.feed_title}</small><strong>${item.starred ? '★ ' : ''}${item.title}</strong><time>${date(item.published_at)}</time></button>`)}</div>${items.length >= 50 && html`<button onClick=${() => loadItems(true)}>Load more</button>`}</section><article aria-label="Reading pane"><${Article} item=${article} api=${api} afterChange=${async () => { if (article) setArticle(await api('/items/' + article.id)); await reload(); }}/></article></div><//>`;
}
function Settings({ auth }) { return html`<${Shell} user=${auth.user} csrf=${auth.csrf}><section class="settings"><p class="eyebrow">Reader clients</p><h1>Client settings</h1><p>Fever-compatible client access will appear here in the next milestone.</p><a href="/">← Back to Reader</a></section><//>`; }
function App() {
  const [auth, setAuth] = useState(undefined), [error, setError] = useState('');
  useEffect(() => { request('/me').then(setAuth).catch(e => e.message.includes('Sign in') ? setAuth(null) : setError(e.message)); }, []);
  if (error) return html`<p class="alert error">${error}</p>`;
  if (auth === undefined) return html`<p class="boot">Opening Reader…</p>`;
  if (!auth) return html`<${Landing}/>`;
  return location.pathname === '/settings' ? html`<${Settings} auth=${auth}/>` : html`<${Reader} auth=${auth}/>`;
}
render(html`<${App}/>`, document.querySelector('#app'));
