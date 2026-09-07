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

const shortDate = stamp => new Date(stamp * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const setTitle = title => { document.title = title ? `${title} · Reader` : 'Reader'; };

function navigate(to) {
  history.pushState({}, '', to);
  window.dispatchEvent(new PopStateEvent('popstate'));
  scrollTo({ top: 0, behavior: 'instant' });
}

function Link({ href, class: className, children, ...props }) {
  const follow = event => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(href);
  };
  return html`<a href=${href} class=${className} onClick=${follow} ...${props}>${children}</a>`;
}

function useRoute() {
  const [route, setRoute] = useState(() => location.pathname + location.search);
  useEffect(() => {
    const changed = () => setRoute(location.pathname + location.search);
    addEventListener('popstate', changed);
    return () => removeEventListener('popstate', changed);
  }, []);
  return route;
}

function Shell({ user, csrf, children }) {
  const logout = async () => { await request('/logout', { method: 'POST', csrf }); location.href = '/'; };
  const reading = location.pathname === '/' || location.pathname === '/articles' || location.pathname.startsWith('/article/');
  return html`<div class="app-shell">
    <header class="navbar">
      <${Link} class="navbar-brand" href="/" aria-label="Reader home"><img src="/icon-192.png" width="24" height="24" alt=""/>Reader<//>
      ${user && html`<nav aria-label="Primary navigation"><${Link} class=${reading ? 'nav-link active' : 'nav-link'} href="/">Subscriptions<//><${Link} class=${location.pathname === '/settings' ? 'nav-link active' : 'nav-link'} href="/settings">Client settings<//></nav>`}
      <nav class="account-nav" aria-label="Account navigation">${user && html`<span class="address">${user.name || 'Reader'}</span><button class="button-link" onClick=${logout}>Sign out</button>`}</nav>
    </header>
    <main>${children}</main>
    <footer><span>Reader</span><span>Part of lsong.org</span></footer>
  </div>`;
}

function Landing() {
  const error = new URLSearchParams(location.search).get('error');
  useEffect(() => setTitle(''), []);
  return html`<${Shell}><section class="site-hero">${error && html`<div class="alert error" role="alert">Sign-in could not be completed. Please try again.</div>`}<p class="eyebrow">Reader · Your personal reading space</p><h1 class="site-hero-title">Follow what matters.<br/>Read at your pace.</h1><p class="site-hero-copy">One place for your RSS subscriptions. Your subscriptions, reading progress and saved articles stay with your account.</p><a class="button button-primary" href="/login">Sign in with my.lsong.org</a></section><p class="landing-developer-link"><a href="/health">Service health</a></p><//>`;
}

function ViewHeader({ eyebrow, title, description, back, actions }) {
  return html`<header class="view-header"><div>${back && html`<${Link} class="back-link" href=${back.href}>← ${back.label}<//>`}<p class="eyebrow">${eyebrow}</p><h1>${title}</h1>${description && html`<p class="view-description">${description}</p>`}</div>${actions && html`<div class="view-actions">${actions}</div>`}</header>`;
}

function Notice({ value }) {
  return value && html`<div class=${`alert ${value.error ? 'error' : 'notice'}`} role=${value.error ? 'alert' : 'status'}>${value.text}</div>`;
}

function ManageFeed({ feed, api, reload }) {
  const [title, setFeedTitle] = useState(feed.title), [folder, setFolder] = useState(feed.folder), [busy, setBusy] = useState(false);
  const save = async event => { event.preventDefault(); setBusy(true); try { await api(`/subscriptions/${feed.id}`, { method: 'PATCH', body: { title, folder } }); await reload(); } finally { setBusy(false); } };
  const remove = async () => { if (!confirm(`Unsubscribe from ${feed.title}?`)) return; setBusy(true); await api(`/subscriptions/${feed.id}`, { method: 'DELETE' }); await reload(); };
  return html`<details class="feed-menu"><summary aria-label=${`Manage ${feed.title}`}>•••</summary><form class="popover" onSubmit=${save}><strong>Manage subscription</strong><label>Title<input value=${title} onInput=${e => setFeedTitle(e.currentTarget.value)}/></label><label>Folder<input value=${folder} onInput=${e => setFolder(e.currentTarget.value)}/></label><div class="form-actions"><button disabled=${busy}>Save</button><button class="danger-button" type="button" disabled=${busy} onClick=${remove}>Unsubscribe</button></div></form></details>`;
}

function Subscribe({ api, reload, report }) {
  const [busy, setBusy] = useState(false);
  const submit = async event => {
    event.preventDefault(); setBusy(true); report('Finding your feed…');
    try { const data = new FormData(event.currentTarget); await api('/subscriptions', { method: 'POST', body: { url: data.get('url'), folder: data.get('folder') } }); event.currentTarget.reset(); await reload(); report('Subscription added.'); }
    catch (error) { report(error.message, true); }
    finally { setBusy(false); }
  };
  return html`<details class="add-panel"><summary class="button button-primary">+ Add subscription</summary><form onSubmit=${submit}><label>Feed or website URL<input type="url" name="url" placeholder="https://example.com/feed.xml" required/></label><label>Folder <span class="optional">Optional</span><input name="folder" maxlength="100"/></label><div class="form-actions"><button class="button-primary" disabled=${busy}>${busy ? 'Finding…' : 'Subscribe'}</button></div></form></details>`;
}

function FeedsView({ auth }) {
  const api = useCallback((path, options = {}) => request(path, { ...options, csrf: auth.csrf }), [auth.csrf]);
  const [feeds, setFeeds] = useState(undefined), [message, setMessage] = useState(null);
  const load = useCallback(() => api('/subscriptions').then(setFeeds).catch(error => setMessage({ text: error.message, error: true })), [api]);
  useEffect(() => { setTitle('Subscriptions'); load(); }, []);
  const report = (text, error = false) => setMessage({ text, error });
  const unread = feeds?.reduce((total, feed) => total + feed.unread, 0) || 0;
  const groups = ['', ...new Set((feeds || []).map(feed => feed.folder).filter(Boolean))];
  return html`<${Shell} user=${auth.user} csrf=${auth.csrf}><section class="view feeds-view">
    <${ViewHeader} eyebrow="Library" title="Subscriptions" description="Choose a collection or feed to browse its articles." actions=${html`<${Subscribe} api=${api} reload=${load} report=${report}/>`}/><${Notice} value=${message}/>
    <nav class="collection-grid" aria-label="Article collections">
      <${Link} class="collection-card" href="/articles?filter=unread"><span class="collection-icon">◉</span><span><strong>Unread</strong><small>Articles waiting for you</small></span><b>${unread}</b><//>
      <${Link} class="collection-card" href="/articles?filter=all"><span class="collection-icon">▤</span><span><strong>All articles</strong><small>Your complete reading history</small></span><span class="arrow">→</span><//>
      <${Link} class="collection-card" href="/articles?filter=starred"><span class="collection-icon">★</span><span><strong>Saved</strong><small>Articles kept for later</small></span><span class="arrow">→</span><//>
    </nav>
    <div class="section-heading"><div><p class="eyebrow">Sources</p><h2>Your feeds</h2></div><span>${feeds?.length || 0} subscriptions</span></div>
    ${feeds === undefined ? html`<div class="loading-list">Loading subscriptions…</div>` : !feeds.length ? html`<div class="empty-state"><span>◎</span><h2>Your library is empty</h2><p>Add an RSS feed or a website with a feed to begin.</p></div>` : groups.map(group => {
      const values = feeds.filter(feed => feed.folder === group); if (!values.length) return null;
      return html`<section class="feed-group" key=${group || 'root'}>${group && html`<h3>${group}</h3>`}<div class="feed-list">${values.map(feed => html`<div class="feed-row" key=${feed.id}><${Link} class="feed-main" href=${`/articles?filter=unread&feed=${feed.id}`}><span class="feed-avatar">${feed.title.slice(0, 1).toUpperCase()}</span><span class="feed-copy"><strong>${feed.title}</strong><small>${feed.error ? `${feed.error} Retrying automatically.` : feed.url}</small></span><span class=${`unread-badge ${feed.unread ? '' : 'is-zero'}`}>${feed.unread}</span><//><${ManageFeed} feed=${feed} api=${api} reload=${load}/></div>`)}</div></section>`;
    })}
  </section><//>`;
}

function FilterTabs({ filter, feed }) {
  return html`<nav class="filter-tabs" aria-label="Article filter">${[['unread', 'Unread'], ['all', 'All'], ['starred', 'Saved']].map(([key, label]) => html`<${Link} href=${`/articles?filter=${key}${feed ? `&feed=${feed}` : ''}`} class=${filter === key ? 'active' : ''}>${label}<//>`)}</nav>`;
}

function ArticlesView({ auth }) {
  const params = new URLSearchParams(location.search), filter = ['all', 'starred'].includes(params.get('filter')) ? params.get('filter') : 'unread', feed = Number(params.get('feed')) || 0;
  const api = useCallback((path, options = {}) => request(path, { ...options, csrf: auth.csrf }), [auth.csrf]);
  const [feeds, setFeeds] = useState([]), [items, setItems] = useState(undefined), [cursor, setCursor] = useState(0), [message, setMessage] = useState(null);
  const selected = feeds.find(value => value.id === feed), heading = selected?.title || (filter === 'starred' ? 'Saved articles' : filter === 'all' ? 'All articles' : 'Unread articles');
  const loadItems = useCallback(async append => {
    try { const rows = await api(`/items?filter=${filter}&feed=${feed}${append && cursor ? `&before=${cursor}` : ''}`); setItems(old => append ? [...(old || []), ...rows] : rows); setCursor(rows.at(-1)?.id || 0); }
    catch (error) { setMessage({ text: error.message, error: true }); }
  }, [api, filter, feed, cursor]);
  useEffect(() => { setTitle(heading); api('/subscriptions').then(setFeeds); setCursor(0); loadItems(false); }, [filter, feed]);
  useEffect(() => { if (selected) setTitle(selected.title); }, [selected?.title]);
  const markAll = async () => { await api('/mark-read', { method: 'POST', body: { feed } }); await loadItems(false); setMessage({ text: 'Marked all current articles as read.', error: false }); };
  const returnTo = location.pathname + location.search;
  return html`<${Shell} user=${auth.user} csrf=${auth.csrf}><section class="view articles-view">
    <${ViewHeader} eyebrow="Reading queue" title=${heading} description=${selected ? `Articles from ${selected.title}` : 'Browse one focused list, then open an article to read.'} back=${{ href: '/', label: 'Subscriptions' }} actions=${html`<button onClick=${() => loadItems(false)}>Refresh</button>`}/><${Notice} value=${message}/>
    <div class="list-controls"><${FilterTabs} filter=${filter} feed=${feed}/><button class="quiet-button" onClick=${markAll}>Mark all read</button></div>
    <section class="article-list" aria-label="Articles">${items === undefined ? html`<div class="loading-list">Loading articles…</div>` : !items.length ? html`<div class="empty-state"><span>✓</span><h2>${filter === 'unread' ? 'You’re all caught up' : 'No articles here'}</h2><p>Choose another collection or return to your subscriptions.</p></div>` : items.map(item => html`<${Link} class=${`article-row ${item.read ? 'is-read' : ''}`} href=${`/article/${item.id}?return=${encodeURIComponent(returnTo)}`} key=${item.id}><span class="article-row-main"><small>${item.feed_title}${item.author ? ` · ${item.author}` : ''}</small><strong>${Boolean(item.starred) && html`<span class="saved-star">★</span>`}${item.title}</strong></span><time>${shortDate(item.published_at)}</time><span class="row-arrow">→</span><//>`)}</section>
    ${items?.length >= 50 && html`<div class="load-more"><button onClick=${() => loadItems(true)}>Load more</button></div>`}
  </section><//>`;
}

function ArticleView({ auth, id }) {
  const api = useCallback((path, options = {}) => request(path, { ...options, csrf: auth.csrf }), [auth.csrf]);
  const [item, setItem] = useState(undefined), [error, setError] = useState('');
  const candidate = new URLSearchParams(location.search).get('return') || '';
  const back = candidate.startsWith('/articles') ? candidate : '/articles?filter=unread';
  const load = useCallback(async () => {
    try { const value = await api('/items/' + id); setItem(value); setTitle(value.title); if (!value.read) { await api('/items/' + id, { method: 'PATCH', body: { read: true } }); setItem({ ...value, read: 1 }); } }
    catch (reason) { setError(reason.message); }
  }, [api, id]);
  useEffect(() => { setTitle('Article'); load(); }, [id]);
  const update = async patch => { await api(`/items/${id}`, { method: 'PATCH', body: patch }); setItem(await api('/items/' + id)); };
  return html`<${Shell} user=${auth.user} csrf=${auth.csrf}><section class="reading-view">
    <div class="reading-toolbar"><${Link} class="back-link" href=${back}>← Back to articles<//>${item && html`<div class="article-actions"><button aria-label=${item.starred ? 'Remove from saved' : 'Save article'} onClick=${() => update({ starred: !item.starred })}>${item.starred ? '★ Saved' : '☆ Save'}</button><button onClick=${() => update({ read: false })}>Mark unread</button>${item.url && html`<a class="button" href=${item.url} target="_blank" rel="noopener noreferrer">Open original ↗</a>`}</div>`}</div>
    ${error ? html`<div class="alert error" role="alert">${error}</div>` : item === undefined ? html`<div class="loading-list">Loading article…</div>` : html`<article class="article"><header><p class="eyebrow">From your subscriptions</p><h1>${item.title}</h1><p class="article-meta">${[item.author, new Date(item.published_at * 1000).toLocaleString()].filter(Boolean).join(' · ')}</p></header><div class="article-content" dangerouslySetInnerHTML=${{ __html: item.content }}/></article>`}
  </section><//>`;
}

function Settings({ auth }) {
  const api = useCallback((path, options = {}) => request(path, { ...options, csrf: auth.csrf }), [auth.csrf]);
  const [credential, setCredential] = useState(undefined), [created, setCreated] = useState(null), [error, setError] = useState('');
  const load = () => api('/client-credential').then(value => setCredential(value.credential)).catch(e => setError(e.message));
  useEffect(() => { setTitle('Client settings'); load(); }, []);
  const create = async () => { setError(''); try { const value = await api('/client-credential', { method: 'POST', body: {} }); setCreated(value); await load(); } catch (e) { setError(e.message); } };
  const revoke = async () => { await api('/client-credential', { method: 'DELETE' }); setCreated(null); await load(); };
  return html`<${Shell} user=${auth.user} csrf=${auth.csrf}><section class="view settings"><${ViewHeader} eyebrow="Reader clients" title="Fever API" description="Connect a compatible RSS client without sharing your my.lsong.org password." back=${{ href: '/', label: 'Subscriptions' }}/>${error && html`<p class="alert error">${error}</p>`}${credential === undefined ? html`<p>Loading…</p>` : credential ? html`<div class="credential"><p><strong>Active client access</strong><br/>Username: <code>${credential.username}</code><br/>Created: ${new Date(credential.created_at * 1000).toLocaleString()}${credential.last_used_at && html`<br/>Last used: ${new Date(credential.last_used_at * 1000).toLocaleString()}`}</p><button onClick=${create}>Rotate credentials</button> <button onClick=${revoke}>Revoke access</button></div>` : html`<button class="button-primary" onClick=${create}>Create client credentials</button>`}${created && html`<div class="credential-result" role="status"><h2>Save these now</h2><p>The password is shown once. Rotating again invalidates it immediately.</p><label>Server URL<input readonly value=${created.endpoint}/></label><label>Username<input readonly value=${created.username}/></label><label>Password<input readonly value=${created.password}/></label></div>`}<p class="muted">In your client, choose Fever and enter the server URL, username, and password above. JSON API version 3 is supported.</p></section><//>`;
}

function App() {
  const route = useRoute();
  const [auth, setAuth] = useState(undefined), [error, setError] = useState('');
  useEffect(() => { request('/me').then(setAuth).catch(e => e.message.includes('Sign in') ? setAuth(null) : setError(e.message)); }, []);
  if (error) return html`<p class="alert error boot-error">${error}</p>`;
  if (auth === undefined) return html`<p class="boot">Opening Reader…</p>`;
  if (!auth) return html`<${Landing}/>`;
  const path = route.split('?')[0];
  if (path === '/settings') return html`<${Settings} auth=${auth}/>`;
  if (path === '/articles') return html`<${ArticlesView} auth=${auth}/>`;
  const article = path.match(/^\/article\/(\d+)$/);
  if (article) return html`<${ArticleView} auth=${auth} id=${Number(article[1])}/>`;
  return html`<${FeedsView} auth=${auth}/>`;
}

render(html`<${App}/>`, document.querySelector('#app'));
