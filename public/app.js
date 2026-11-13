const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const names = {amazon:'Amazon',ebay:'eBay',shopify:'Shopify'};
const labels = {inventory:'Inventory',orders:'Orders',listings:'Listings',sync:'Sync activity',performance:'Performance',connections:'Connections',security:'Security'};
let state, page='inventory', filter='all', query='', toastTimer, securityEvents=null, securityError='', securityLoading=false;
const money = cents => new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(cents/100);
const date = value => new Intl.DateTimeFormat(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date(value));
const logo = name => `<span class="channel-logo ${name}" title="${names[name]}" aria-label="${names[name]}">${name[0]}</span>`;
const badge = (label,tone='') => `<span class="badge ${tone}"><span class="badge-dot" aria-hidden="true"></span>${esc(label)}</span>`;
const button = (label,action,extra='',kind='') => `<button class="button ${kind}" data-action="${action}" ${extra}>${label}</button>`;
const empty = (title,description,actions='') => `<div class="empty"><span class="empty-symbol" aria-hidden="true">▦</span><h2>${title}</h2><p>${description}</p><div class="actions">${actions}</div></div>`;
const heading = (title,subtitle,actions='') => `<div class="page-heading"><div><p class="eyebrow">YOUR SELLER WORKSPACE</p><h1>${title}</h1><p class="subtitle">${subtitle}</p></div><div class="actions">${actions}</div></div>`;
const summary = entries => `<div class="summary">${entries.map(([label,value,note='',warning=false])=>`<div class="summary-item"><span class="label">${label}</span><strong class="${warning?'warning-number':''}">${value}</strong>${note?`<small>${note}</small>`:''}</div>`).join('')}</div>`;
const toolbar = (tabs,placeholder='Search products or SKU…') => `<div class="toolbar"><div class="tabs">${tabs.map(([key,label,count])=>`<button class="tab ${filter===key?'active':''}" data-action="filter" data-filter="${key}" aria-pressed="${filter===key}">${label}${count!==undefined?`<small>${count}</small>`:''}</button>`).join('')}</div><label class="search"><span aria-hidden="true">⌕</span><input id="search" type="search" aria-label="Search this view" placeholder="${placeholder}" value="${esc(query)}"></label></div>`;
function table(headers,rows,foot='') {
  return `<div class="table-scroll"><table><thead><tr>${headers.map(h=>`<th scope="col"${h[0]==='#'?' class="num"':''}>${h[0]==='#'?h.slice(1):h}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>${foot?`<div class="table-footer">${foot}</div>`:''}`;
}
function toast(message) { clearTimeout(toastTimer); $('#toast').textContent=message; $('#toast').hidden=false; toastTimer=setTimeout(()=>$('#toast').hidden=true,5000); }
function showError(message) { $('#error').textContent=message; $('#error').hidden=false; }
async function loadSecurity() {
  if(state?.mode!=='owner-preview'||securityLoading)return;
  securityLoading=true;securityError='';if(page==='security')render();
  try{const response=await fetch('/api/security');if(response.status===401){location.assign('/login?expired=1');return;}const data=await response.json();if(!response.ok)throw new Error(data.error||'Could not load security activity.');securityEvents=data.events;}
  catch(error){securityError=error.message;}
  finally{securityLoading=false;if(page==='security')render();}
}
function security() {
  if(state.mode!=='owner-preview')return heading('Security activity','Sign-in activity is available in the hosted owner workspace.');
  const eventLabels={'login.success':'Credentials verified','login.failed':'Incorrect credentials','login.invalid':'Sign-in form rejected','login.rejected':'Sign-in request rejected','login.blocked':'Sign-in delayed','login.lockout':'Sign-in temporarily locked','session.created':'Signed in','logout.success':'Signed out','request.blocked':'Requests limited'};
  const reasons={credentials_verified:'Owner credentials accepted',invalid_credentials:'Username or password did not match',invalid_challenge:'Expired or previously used sign-in form',invalid_origin:'Request came from another site',source_lockout:'Repeated failures from one source',account_lockout:'Repeated failures for the owner account',backoff:'Wait before the next attempt',owner_login:'A new session was created',owner_request:'The owner signed out',requests:'Request limit reached',actions:'Action limit reached',health:'Health-check limit reached'};
  const rows=(securityEvents||[]).map(event=>`<tr><td>${date(event.created_at)}</td><td>${esc(eventLabels[event.event]||event.event)}</td><td>${esc(reasons[event.reason]||event.reason)}</td></tr>`);
  return heading('Security activity','Review sign-ins, sign-outs, and temporary access limits.',button(securityLoading?'Refreshing…':'Refresh','refresh-security',securityLoading?'disabled':''))
    +'<p class="help-line">Sign-in limits persist across server restarts. Activity is kept for 30 days; this view shows the latest 100 events. Passwords and tokens are never included.</p>'
    +(securityError?`<p class="form-error" role="alert">${esc(securityError)}</p>`:'')
    +(securityEvents===null?'<p class="loading" role="status">Loading security activity…</p>':`<section class="table-section" aria-label="Security activity">${rows.length?table(['Time','Event','Details'],rows):empty('No security activity yet','Sign-in and sign-out events will appear here.')}</section>`);
}
function closeEditor() { $('#editor').hidden=true; $('#editor').innerHTML=''; }
function openEditor(title,body) {
  $('#editor').innerHTML=`<div class="editor-heading"><h2>${esc(title)}</h2>${button('Close','close-editor','','small')}</div>${body}`;
  $('#editor').hidden=false; $('#editor').scrollIntoView({behavior:'instant',block:'nearest'});
  $('#editor input, #editor select, #editor textarea')?.focus();
}
function inventory() {
  const s=state.summary;
  const visible=state.products.filter(p=>(filter!=='low'||p.available<=5)&&`${p.sku} ${p.title} ${p.category}`.toLowerCase().includes(query.toLowerCase()));
  const rows=visible.map((p,index)=>`<tr>
    <td><div class="product-cell"><span class="product-glyph tone-${index%4}" aria-hidden="true">${['◧','∪','▱','▤'][index%4]}</span><div><div class="product-name">${esc(p.title)}</div><div class="sku">${esc(p.sku)}</div></div></div></td>
    <td><div class="channel-stack">${p.listings.map(l=>logo(l.channel)).join('')||'<span class="muted">Unmapped</span>'}</div></td>
    <td class="num">${p.on_hand}</td><td class="num muted">${p.reserved}</td><td class="num muted">${p.buffer}</td><td class="num"><strong>${p.available}</strong></td>
    <td>${p.available===0?badge('Out of stock','error'):p.available<=5?badge('Low stock','warn'):badge('In stock')}</td>
    <td>${button('Manage ↗','manage-product',`data-id="${p.id}"`,'small text')}</td></tr>`);
  return heading('Inventory','One stock ledger. Every product, every channel.',`${button('Export CSV','export')}${button('<span class="plus" aria-hidden="true">+</span> Add product','add-product','','primary')}`)
    +summary([['Products',s.skus,'unique SKUs'],['Available to sell',s.available,'units'],['Reserved',s.reserved,'for open orders'],['Low stock',s.lowStock,'≤ 5 available',true]])
    +`<section class="table-section" aria-label="Product inventory">${toolbar([['all','All products',s.skus],['low','Low stock',s.lowStock]])}${state.products.length?rows.length?table(['Product','Mapped channels','#On hand','#Reserved','#Buffer','#Available','Stock status',''],rows,`<span>${visible.length} of ${state.products.length} products</span><span>Quantities shared across mapped channels</span>`):empty('No matching products','Try a different search or switch to all products.'):empty('Your catalog starts here','Add your first product, or load a sample catalog to explore stock updates and order reservations.',`${button('Load sample catalog','load-demo')}${button('Add a product','add-product','','primary')}`)}</section>`
    +'<p class="help-line"><span aria-hidden="true">ⓘ</span><span><strong>Available = on hand − reserved − safety buffer.</strong> Marketplace mappings do not connect accounts.</span></p>';
}
function orders() {
  const all=state.orders, visible=all.filter(o=>(filter==='all'||o.status===filter)&&`${o.external_id} ${o.channel} ${o.lines.map(l=>l.sku).join(' ')}`.toLowerCase().includes(query.toLowerCase()));
  const rows=visible.map(o=>`<tr><td><strong>${esc(o.external_id)}</strong><span class="detail-note">${date(o.created_at)}</span></td><td><div class="pill-row">${logo(o.channel)}${names[o.channel]}</div></td><td>${o.lines.map(l=>`${esc(l.sku)} × ${l.quantity}`).join('<br>')}</td><td class="num">${money(o.total_cents)}</td><td>${badge(o.status==='reserved'?'Reserved':o.status==='shipped'?'Shipped':'Cancelled',o.status==='cancelled'?'neutral':'')}</td><td>${o.status==='reserved'?`<div class="actions">${button('Mark shipped','ship-order',`data-id="${o.id}"`,'small')}${button('Cancel','cancel-order',`data-id="${o.id}"`,'small danger')}</div>`:'<span class="muted">Complete</span>'}</td></tr>`);
  return heading('Orders','Reserve shared stock once, even when an order arrives twice.',button('Record an order','add-order','','primary'))
    +summary([['Open orders',state.summary.openOrders],['Units reserved',state.summary.reserved],['Shipped value',money(state.summary.shippedValue),'local records'],['Recorded orders',all.length,'latest 250 shown']])
    +`<section class="table-section" aria-label="Orders">${toolbar([['all','All orders'],['reserved','Open'],['shipped','Shipped'],['cancelled','Cancelled']],'Search order reference or SKU…')}${rows.length?table(['Order reference','Channel','Items','#Order value','Status','Actions'],rows):empty('No orders in this view','Record an order to reserve stock. This local workbench does not import live marketplace orders.',button('Record an order','add-order','','primary'))}</section>`
    +'<p class="help-line"><span aria-hidden="true">ⓘ</span><span>Shipping consumes on-hand stock and clears the reservation. Cancelling releases it. Both actions affect local records only.</span></p>';
}
function listings() {
  const all=state.products.flatMap(p=>p.listings.map(l=>({...l,p}))), visible=all.filter(l=>(filter==='all'||l.channel===filter)&&`${l.title} ${l.p.sku} ${l.external_id}`.toLowerCase().includes(query.toLowerCase()));
  const rows=visible.map(l=>`<tr><td><div class="product-name">${esc(l.title)}</div><div class="sku">${esc(l.p.sku)}</div></td><td><div class="pill-row">${logo(l.channel)}${names[l.channel]}</div></td><td><code>${esc(l.external_id)}</code></td><td>${l.checks.length?badge(`${l.checks.length} checks to review`,'warn'):badge('Starter checks passed')}</td><td>${button('Review draft','edit-listing',`data-id="${l.p.id}" data-channel="${l.channel}"`,'small text')}</td></tr>`);
  return heading('Listings','Marketplace drafts and content checks, linked to your master SKUs.',button('Map a listing','map-listing','','primary'))
    +`<section class="table-section" aria-label="Listing drafts">${toolbar([['all','All listings',all.length],['amazon','Amazon'],['ebay','eBay'],['shopify','Shopify']],'Search listing title or SKU…')}${rows.length?table(['Listing / SKU','Channel','Marketplace identifier','Content review',''],rows):empty('No mapped listings','Map an existing marketplace identifier to a product. Mapping and draft edits stay local.',button('Map a listing','map-listing','','primary'))}</section>`
    +'<div class="quiet-panel"><h3>Content checks are a starting point</h3><p class="context-text">These are basic title, description, and availability checks. They do not measure search rank or predict sales. Channel, category, and locale rules need validation before live publishing.</p></div>';
}
function sync() {
  const visible=state.jobs.filter(j=>(filter==='all'||filter==='pending'&&['queued','failed'].includes(j.status)||j.status===filter)&&`${j.sku} ${j.channel}`.toLowerCase().includes(query.toLowerCase()));
  const status=j=>badge({queued:'Queued',simulated:'Simulated',failed:'Failed',superseded:'Superseded'}[j.status],j.status==='failed'?'error':j.status==='queued'?'warn':j.status==='superseded'?'neutral':'');
  const rows=visible.map(j=>`<tr><td><strong>${esc(j.sku)}</strong><span class="detail-note">Stock version ${j.version}</span></td><td><div class="pill-row">${logo(j.channel)}${names[j.channel]}</div></td><td class="num">${j.quantity}</td><td>${status(j)}<span class="detail-note">${esc(j.detail)}</span></td><td>${date(j.updated_at)}</td></tr>`);
  return heading('Sync activity','Follow every queued quantity update. Test failures before going live.',`${button('Simulate eBay outage','fail-sync')}${button('Run local simulation','run-sync','','primary')}`)
    +`<section class="table-section" aria-label="Sync jobs">${toolbar([['all','All jobs'],['pending','Pending',state.summary.pendingJobs],['simulated','Simulated'],['failed','Failed']],'Search SKU or channel…')}${rows.length?table(['Product SKU','Channel','#Target quantity','Outcome','Updated'],rows):empty('No sync jobs in this view','Map a listing or adjust stock to queue an absolute quantity update. Local simulation never contacts a marketplace.')}</section>`
    +'<p class="help-line"><span aria-hidden="true">ⓘ</span><span>New stock versions replace older pending jobs. Simulated failures can be retried with Run local simulation.</span></p>'
    +'<h2 class="audit-title">Inventory ledger</h2>'
    +`<section class="table-section" aria-label="Inventory ledger">${state.movements.length?table(['SKU','Event','#Change','Reason','#On hand','#Reserved'],state.movements.map(m=>`<tr><td><strong>${esc(m.sku)}</strong></td><td>${esc(m.kind)}<span class="detail-note">${date(m.created_at)}</span></td><td class="num">${m.delta>0?'+':''}${m.delta}</td><td>${esc(m.reason)}</td><td class="num">${m.on_hand}</td><td class="num">${m.reserved}</td></tr>`)):empty('No stock movements yet','Opening stock, adjustments, reservations, releases, and shipments will appear here.')}</section>`;
}
function performance() {
  const rows=Object.entries(names).map(([key,name])=>{
    const orders=state.orders.filter(o=>o.channel===key), shipped=orders.filter(o=>o.status==='shipped');
    return `<tr><td><div class="pill-row">${logo(key)}${name}</div></td><td class="num">${orders.length}</td><td class="num">${shipped.length}</td><td class="num">${money(shipped.reduce((sum,o)=>sum+o.total_cents,0))}</td><td>${badge('Analytics not imported','neutral')}</td></tr>`;
  });
  return heading('Performance','An honest view of what this workspace can measure.')
    +`<section class="table-section metrics-table" aria-label="Local order performance">${table(['Channel','#Recorded orders','#Shipped orders','#Shipped value','Live data'],rows,'<span>Based on local records, up to the latest 250 orders. USD master prices.</span>')}</section>`
    +'<div class="quiet-panel"><h2>Live listing analytics are not available yet</h2><p class="context-text">Impressions, visits, conversion rates, advertising spend, and search rankings need authorized marketplace data. This prototype does not estimate or invent them. Shipped value is the value of local order records, not net revenue or profit.</p></div>';
}
function connections() {
  const rows=state.channels.map(c=>{
    const status=c.connected?badge('API verified'):c.status==='reconnect'?badge('Reconnect required','warn'):c.authorized?badge('Authorized · check failed','warn'):badge('Not connected','neutral');
    const missing=!c.connected&&!c.configured?'<p class="connection-message">Sign-in is awaiting setup by the platform owner.</p>':'';
    const metadata=c.connected?`<p class="connection-message">${esc(c.accountLabel)} · ${esc(c.metadata.check)}${c.checkedAt?` · Checked ${date(c.checkedAt)}`:''}</p>`:'';
    const options=c.authorized?`${button('Check connection','check-connection',`data-channel="${c.id}"`)}${button('Disconnect locally','disconnect-connection',`data-channel="${c.id}"`,'danger')}`:`${button(`Connect ${names[c.id]}`,'connect-account',`data-channel="${c.id}"`,'primary')}`;
    return `<article class="connection-entry"><div class="connection-heading"><div class="pill-row">${logo(c.id)}<h2>${names[c.id]}</h2><span class="muted">${esc(c.environment)}</span></div>${status}</div>${metadata}${missing}${c.lastError?`<p class="form-error" role="status">${esc(c.lastError)}</p>`:''}<p class="context-text">${c.id==='shopify'?'Enter your store address, then sign in and approve access on Shopify.':`Continue to ${names[c.id]} to sign in and approve access. Your marketplace password stays with ${names[c.id]}.`}</p><div class="form-actions">${options}</div><details class="callback-details"><summary>Platform owner setup</summary>${c.missing.length?`<p class="form-note">Configure <code>${esc(c.missing.join(', '))}</code> on the server. Sellers do not need these credentials.</p>`:''}<dl><dt>Registered callback / accepted URL</dt><dd><code>${esc(c.callbackUrl)}</code></dd>${c.loginUrl?`<dt>Amazon login URI</dt><dd><code>${esc(c.loginUrl)}</code></dd>`:''}<dt>Inventory updates</dt><dd>Simulation only, even after authorization</dd></dl><div class="form-actions">${button('Developer connection options','connect-developer',`data-channel="${c.id}" aria-label="${names[c.id]} developer connection options"`,'small')}</div></details></article>`;
  }).join('');
  return heading('Connections','Sign in on the marketplace. Passwords never pass through this workspace.',`<a class="button" href="/connection-setup" target="_blank" rel="noopener">Connection setup guide ↗</a>`)
    +`<section class="connection-list" aria-label="Marketplace connections">${rows}</section>`
    +`<div class="quiet-panel"><h3>${state.mode==='owner-preview'?'A private owner preview':'Your connection stays on this computer'}</h3><p class="context-text">${state.mode==='owner-preview'?'Tokens are encrypted in persistent hosted storage. This preview has one shared owner workspace, not separate seller accounts.':'Tokens are encrypted in the local database.'} Disconnect removes the saved credentials here; remove the app’s permissions on the marketplace to revoke access there. This version supports one account per channel.</p></div>`;
}
function connectAccount(name,developer=false) {
  const c=state.channels.find(c=>c.id===name),missing=c.missing.length?(developer?`<p class="form-note">Browser sign-in needs <code>${esc(c.missing.join(', '))}</code> in <code>commerce-hub/.env</code>, followed by a restart.${name==='amazon'?' The private-app method only needs the LWA client ID and secret configured.':''} <a href="/connection-setup" target="_blank" rel="noopener">Open setup guide</a>.</p>`:'<p class="form-note">Sign-in is awaiting setup by the platform owner. You do not need to supply API keys.</p>'):'';
  const domain=name==='shopify'?'<label>Store domain<input name="shop" required autocomplete="off" placeholder="your-store.myshopify.com" maxlength="253"></label>':'';
  const ownStore=name==='shopify'&&developer?'<label>Connection method<select name="method" aria-label="Connection method"><option value="oauth">Sign in on Shopify (OAuth)</option><option value="private">Own organization: client credentials</option></select></label><p class="form-note">Client credentials only work when this app and the installed store belong to the same Shopify organization.</p>':'';
  const amazon=name==='amazon'&&developer?'<label>Connection method<select name="method" aria-label="Connection method"><option value="oauth">Sign in on Amazon (public SP-API app)</option><option value="private">Private app: self-authorized refresh token</option></select></label><div id="amazon-private-fields" hidden><div class="form-grid"><label>Seller ID<input name="sellerId" autocomplete="off" maxlength="120"></label><label>Self-authorized refresh token<input name="refreshToken" type="password" autocomplete="off" maxlength="16000"></label></div><p class="form-note">The app’s LWA client ID and secret must be configured in .env. The refresh token will be sent to Amazon and stored encrypted here.</p></div>':'';
  openEditor(`Connect ${names[name]}`,`${missing}<form data-form="connection" data-channel="${name}" ${developer?'data-developer="true"':''}><div class="form-grid">${domain}${ownStore}${amazon}</div><p class="form-note">Continue to ${names[name]}’s official sign-in and permission screen. You do not enter a marketplace password or API keys here.</p><p class="form-note">Authorization is followed by a read-only API check. Product imports, publishing, and stock updates are not enabled.</p><div class="form-actions"><button class="button primary" type="submit">${name==='shopify'?'Continue with Shopify':'Continue securely'}</button>${button('Cancel','close-editor')}</div></form>`);
}
function callbackMessage() {
  const params=new URLSearchParams(location.hash.split('?')[1]||'');
  if(!params.has('result'))return;
  const channel=names[params.get('channel')]||'Marketplace';
  if(params.get('result')==='connected')toast(`${channel} connected and verified. Inventory sync remains simulated.`);
  else if(params.get('result')==='authorized')toast(`${channel} authorized. Review the connection check before continuing.`);
  else showError(params.get('reason')||'Authorization did not complete. Try connecting again.');
  history.replaceState(null,'','#connections');
}
function render() {
  const key=location.hash.slice(1).split('?')[0]; page=labels[key]?key:'inventory';
  document.title=`Commerce Hub · ${labels[page]}`; $('#breadcrumb').textContent=labels[page];
  $('#workspace-mode').textContent=state.mode==='owner-preview'?'Protected owner preview':'Local development';
  $('#mode-label').textContent=state.mode==='owner-preview'?'Owner preview':'Local workspace';
  $('#sign-out-form').hidden=state.mode!=='owner-preview';
  $('#security-nav').hidden=state.mode!=='owner-preview';
  for(const link of document.querySelectorAll('[data-page]')) { if(link.dataset.page===page) link.setAttribute('aria-current','page'); else link.removeAttribute('aria-current'); }
  $('#nav-count').textContent=state.summary.skus; $('#sync-count').textContent=state.summary.pendingJobs;
  for(const c of state.channels){const dot=document.querySelector(`[data-connection-dot="${c.id}"]`);if(dot){dot.classList.toggle('connected',c.connected);dot.title=c.connected?'API verified':c.authorized?'Authorized; check required':'Not connected';}}
  $('#page').innerHTML=({inventory,orders,listings,sync,performance,connections,security})[page]();
}
async function mutate(url,input={},form=null) {
  $('#error').hidden=true; const controls=[...(form||document).querySelectorAll('button')]; controls.forEach(b=>b.disabled=true);
  try {
    const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json','x-csrf-token':state.csrf},body:JSON.stringify(input)});
    if(response.status===401){location.assign('/login?expired=1');return null;}
    const result=await response.json(); if(!response.ok) throw new Error(result.error || 'The action could not be completed.');
    state=result.state; render(); if(form) closeEditor(); return result.result;
  } catch(error) {
    if(form) { let el=form.querySelector('.form-error'); if(!el) {el=document.createElement('p');el.className='form-error';el.setAttribute('role','alert');form.append(el);} el.textContent=error.message; }
    else showError(error.message);
    return null;
  } finally { controls.forEach(b=>b.disabled=false); }
}
function addProduct() {
  openEditor('Add a product',`<form data-form="product"><div class="form-grid">
    <label>Product title<input name="title" required maxlength="180" placeholder="e.g. Stoneware coffee mug, sand"></label>
    <label>Master SKU<input name="sku" required maxlength="64" pattern="[A-Za-z0-9][A-Za-z0-9._-]*" placeholder="e.g. MUG-SAND-01"></label>
    <label>On-hand quantity<input name="onHand" type="number" required min="0" max="10000000" step="1" value="0"></label>
    <label>Safety buffer<input name="buffer" type="number" required min="0" max="10000000" step="1" value="0"></label>
    <label>Master price (USD)<input name="price" type="number" required min="0" max="100000" step="0.01" placeholder="0.00"></label>
    <label>Category<input name="category" maxlength="80" value="General" required></label></div>
    <p class="form-note">Add a marketplace mapping after saving. Amazon FBA stock is not part of this shared warehouse.</p><div class="form-actions"><button class="button primary" type="submit">Save product</button>${button('Cancel','close-editor')}</div></form>`);
}
function manageProduct(id) {
  const p=state.products.find(p=>p.id===id); if(!p) return;
  openEditor(p.title,`<p class="form-note">${esc(p.sku)} · ${p.on_hand} on hand · ${p.reserved} reserved · ${p.buffer} safety buffer · <strong>${p.available} available</strong></p>
    <form data-form="adjust" data-id="${p.id}"><div class="form-grid"><label>Adjustment (+ received, − removed)<input name="delta" type="number" required min="-10000000" max="10000000" step="1" placeholder="e.g. 12 or -2"></label><label>Reason<input name="reason" required maxlength="240" placeholder="e.g. Received supplier delivery"></label></div><div class="form-actions"><button class="button primary" type="submit">Apply stock adjustment</button></div></form>
    <div class="editor-section"><h3>Marketplace mappings</h3><p class="form-note">Each identifier must refer to this exact variant. Mapping does not establish a live connection.</p>${Object.keys(names).map(name=>{const l=p.listings.find(l=>l.channel===name);return `<div class="mapping-row"><div class="pill-row">${logo(name)}${names[name]}</div><code>${l?esc(l.external_id):'Not mapped'}</code>${button(l?'Edit mapping':'Map listing','map-product',`data-id="${p.id}" data-channel="${name}"`,'small')}</div>`;}).join('')}</div>`);
}
function mapListing(id,channel='amazon') {
  if(!state.products.length) return addProduct();
  const p=state.products.find(p=>p.id===id)||state.products[0], existing=p.listings.find(l=>l.channel===channel);
  openEditor('Map a marketplace listing',`<form data-form="mapping"><div class="form-grid"><label>Master product<select name="productId">${state.products.map(p2=>`<option value="${p2.id}" ${p.id===p2.id?'selected':''}>${esc(p2.sku)} · ${esc(p2.title)}</option>`).join('')}</select></label><label>Channel<select name="channel">${Object.entries(names).map(([key,name])=>`<option value="${key}" ${key===channel?'selected':''}>${name}</option>`).join('')}</select></label><label class="full">Marketplace variant / offer identifier<input name="externalId" maxlength="120" required value="${esc(existing?.external_id||'')}" placeholder="Identifier for the exact sellable variant"></label></div><p class="form-note">This is a local mapping. It queues quantities for simulation and does not verify ownership of a marketplace listing.</p><div class="form-actions"><button class="button primary" type="submit">Save mapping</button>${button('Cancel','close-editor')}</div></form>`);
}
function addOrder() {
  if(!state.products.length) {toast('Add a product and marketplace mapping first.');return addProduct();}
  openEditor('Record an order',`<form data-form="order"><div class="form-grid"><label>Channel<select name="channel">${Object.entries(names).map(([key,name])=>`<option value="${key}">${name}</option>`).join('')}</select></label><label>Marketplace order reference<input name="externalId" required maxlength="120" placeholder="Unique order reference"></label></div><div id="order-lines">${orderLine()}</div><div class="form-actions">${button('+ Add another item','add-line','','small')}</div><p class="form-note">Uses USD master prices for local records. Units are reserved immediately. Repeating the same reference and items does not reserve stock twice. Every product must be mapped to the selected channel.</p><div class="form-actions"><button class="button primary" type="submit">Reserve stock & record order</button>${button('Cancel','close-editor')}</div></form>`);
}
function orderLine() {
  return `<div class="order-line"><label>Product SKU<select name="sku">${state.products.map(p=>`<option value="${esc(p.sku)}">${esc(p.sku)} · ${p.available} available</option>`).join('')}</select></label><label>Quantity<input name="quantity" type="number" required min="1" max="10000000" step="1" value="1"></label>${button('Remove','remove-line','','small text')}</div>`;
}
function editListing(id,name) {
  const p=state.products.find(p=>p.id===id), l=p?.listings.find(l=>l.channel===name);if(!l) return;
  openEditor(`${names[name]} listing draft`, `<p class="form-note">${esc(p.sku)} · ${esc(l.external_id)}</p>${l.checks.length?`<ul class="check-list">${l.checks.map(c=>`<li>${esc(c)}</li>`).join('')}</ul>`:''}<form data-form="listing" data-id="${id}" data-channel="${name}"><div class="form-grid"><label class="full">Listing title<input name="title" required maxlength="255" value="${esc(l.title)}"></label><label class="full">Product description<textarea name="description" maxlength="5000">${esc(l.description)}</textarea></label></div><p class="form-note">Save updates this local draft only. Marketplace publishing and keyword research are not connected.</p><div class="form-actions"><button class="button primary" type="submit">Save local draft</button>${button('Cancel','close-editor')}</div></form>`);
}
function exportCsv() {
  const csvCell=value=>`"${String(value).replace(/^[=+@\-\t\r]/,"'$&").replaceAll('"','""')}"`;
  const rows=[['SKU','Title','On hand','Reserved','Buffer','Available','Price USD'],...state.products.map(p=>[p.sku,p.title,p.on_hand,p.reserved,p.buffer,p.available,(p.price_cents/100).toFixed(2)])];
  const url=URL.createObjectURL(new Blob([rows.map(row=>row.map(csvCell).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'}));
  const a=document.createElement('a');a.href=url;a.download='commerce-hub-inventory.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('Inventory exported.');
}
document.addEventListener('click',async event=>{
  const target=event.target.closest('[data-action]');if(!target) return;
  const {action,id,channel}=target.dataset;
  if(action==='refresh-security')await loadSecurity();
  if(action==='filter') {filter=target.dataset.filter;render();}
  if(action==='close-editor') closeEditor();
  if(action==='add-product') addProduct();
  if(action==='manage-product') manageProduct(id);
  if(action==='map-product'||action==='map-listing') mapListing(id,channel);
  if(action==='add-order') addOrder();
  if(action==='add-line') $('#order-lines').insertAdjacentHTML('beforeend',orderLine());
  if(action==='remove-line') {const lines=document.querySelectorAll('.order-line');if(lines.length>1)target.closest('.order-line').remove();else toast('An order needs at least one item.');}
  if(action==='edit-listing') editListing(id,channel);
  if(action==='export') exportCsv();
  if(action==='connect-account') {
    if(channel==='shopify')connectAccount(channel);
    else if(!state.channels.find(c=>c.id===channel)?.configured) {
      const entry=event.target.closest('.connection-entry');
      let message=entry.querySelector('[data-connection-error]');
      if(!message){message=document.createElement('p');message.className='form-error';message.dataset.connectionError='';message.setAttribute('role','alert');entry.querySelector('.form-actions').after(message);}
      message.textContent=`${names[channel]} sign-in is not configured by the platform owner yet. ${state.mode==='owner-preview'?'Add the developer app credentials in Heroku Settings → Config Vars, then register the callback URL shown below.':'Complete the developer app setup shown below.'} Once enabled, Connect ${names[channel]} opens its official login page directly.`;
      entry.querySelector('.callback-details').open=true;
      message.scrollIntoView({block:'nearest'});
    }
    else {const result=await mutate(`/api/connections/${channel}/start`);if(result?.authorizationUrl)location.assign(result.authorizationUrl);}
  }
  if(action==='connect-developer')connectAccount(channel,true);
  if(action==='check-connection') {if(await mutate(`/api/connections/${channel}/check`))toast(`${names[channel]} read-only API check passed.`);else{try{state=await(await fetch('/api/state')).json();render();}catch{}}}
  if(action==='disconnect-connection')openEditor(`Disconnect ${names[channel]} locally`,`<form data-form="disconnect" data-channel="${channel}"><p class="context-text">Remove the saved access and refresh tokens from this computer? Your catalog and orders stay intact.</p><p class="form-note">To revoke the grant on ${names[channel]}, also remove this app in your marketplace account settings.</p><div class="form-actions"><button class="button danger" type="submit">Remove local connection</button>${button('Keep connected','close-editor')}</div></form>`);
  if(action==='load-demo') {if(await mutate('/api/demo'))toast('Sample catalog loaded. No marketplace updates were sent.');}
  if(action==='run-sync'||action==='fail-sync') {const result=await mutate('/api/sync/simulate',{failChannel:action==='fail-sync'?'ebay':null});if(result)toast(`${result.succeeded} simulated, ${result.failed} failed. No marketplace requests sent.`);}
  if(action==='ship-order'||action==='cancel-order') {
    const o=state.orders.find(o=>o.id===id),status=action==='ship-order'?'shipped':'cancelled';
    openEditor(status==='shipped'?'Confirm local shipment':'Cancel local order',`<form data-form="transition" data-id="${id}" data-status="${status}"><p class="context-text">${status==='shipped'?'Consume physical stock and release reservations for':'Release reserved units for'} <strong>${esc(o.external_id)}</strong>?</p><p class="form-note">This changes the local record only. No notification or fulfillment update is sent to the marketplace.</p><div class="form-actions"><button class="button ${status==='shipped'?'primary':'danger'}" type="submit">${status==='shipped'?'Confirm shipped':'Confirm cancellation'}</button>${button('Keep open','close-editor')}</div></form>`);
  }
});
document.addEventListener('input',event=>{
  if(event.target.id==='search') {
    const cursor=event.target.selectionStart;query=event.target.value;render();$('#search').focus();$('#search').setSelectionRange(cursor,cursor);
  }
});
document.addEventListener('change',event=>{
  if(event.target.closest('[data-form="connection"]')&&event.target.name==='method') {
    const fields=$('#amazon-private-fields');if(fields){fields.hidden=event.target.value!=='private';for(const input of fields.querySelectorAll('input'))input.required=!fields.hidden;}
  }
  const form=event.target.closest('[data-form="mapping"]');
  if(form&&['productId','channel'].includes(event.target.name)) {
    const p=state.products.find(p=>p.id===form.elements.productId.value),l=p?.listings.find(l=>l.channel===form.elements.channel.value);
    form.elements.externalId.value=l?.external_id||'';
  }
});
document.addEventListener('submit',async event=>{
  const form=event.target.closest('[data-form]');if(!form)return;event.preventDefault();if(!form.reportValidity())return;
  form.querySelector('.form-error')?.remove();const data=Object.fromEntries(new FormData(form));let result;
  if(form.dataset.form==='connection') {
    const name=form.dataset.channel,method=data.method==='private'?'private':'start';
    if(!form.dataset.developer&&!state.channels.find(c=>c.id===name)?.configured){const error=document.createElement('p');error.className='form-error';error.setAttribute('role','alert');error.textContent=`${names[name]} sign-in is awaiting setup by the platform owner. You do not need API keys.`;form.append(error);return;}
    result=await mutate(`/api/connections/${name}/${method}`,{shop:data.shop,sellerId:data.sellerId,refreshToken:data.refreshToken},form);
    if(result?.authorizationUrl)location.assign(result.authorizationUrl);
    else if(result)toast(result.verified?'Account connected. Read-only check passed.':'Authorization saved. Review the connection check.');
    return;
  }
  if(form.dataset.form==='disconnect') {result=await mutate(`/api/connections/${form.dataset.channel}/disconnect`,{},form);if(result)toast('Local credentials removed. Revoke app permissions on the marketplace if needed.');return;}
  if(form.dataset.form==='product') result=await mutate('/api/products',{title:data.title,sku:data.sku,onHand:Number(data.onHand),buffer:Number(data.buffer),priceCents:Math.round(Number(data.price)*100),category:data.category},form);
  if(form.dataset.form==='adjust') result=await mutate(`/api/products/${form.dataset.id}/adjust`,{delta:Number(data.delta),reason:data.reason},form);
  if(form.dataset.form==='mapping') result=await mutate(`/api/products/${data.productId}/map`,{channel:data.channel,externalId:data.externalId},form);
  if(form.dataset.form==='order') result=await mutate('/api/orders',{channel:data.channel,externalId:data.externalId,lines:[...form.querySelectorAll('.order-line')].map(row=>({sku:row.querySelector('[name="sku"]').value,quantity:Number(row.querySelector('[name="quantity"]').value)}))},form);
  if(form.dataset.form==='listing') result=await mutate(`/api/products/${form.dataset.id}/listing`,{channel:form.dataset.channel,title:data.title,description:data.description},form);
  if(form.dataset.form==='transition') result=await mutate('/api/orders/transition',{id:form.dataset.id,status:form.dataset.status},form);
  if(result!==null&&result!==undefined)toast(result.duplicate?'Order already recorded. No stock reserved twice.':'Saved to your local workspace.');
});
window.addEventListener('hashchange',()=>{filter='all';query='';closeEditor();if(state){render();callbackMessage();if(page==='security')loadSecurity();}});
document.addEventListener('keydown',event=>{if(event.key==='Escape')closeEditor();});
try { const response=await fetch('/api/state');if(response.status===401)location.replace('/login?expired=1');if(!response.ok)throw new Error('Could not load workspace.');state=await response.json();render();callbackMessage();if(page==='security')loadSecurity(); }
catch(error) { $('#page').innerHTML=empty('Your workspace could not be loaded','Check that the local server is running, then reload this page.');showError(error.message); }

