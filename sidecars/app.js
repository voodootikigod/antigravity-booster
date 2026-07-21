const runStatus = document.getElementById('runStatus');
const poolStatus = document.getElementById('poolStatus');
const ticketsGrid = document.getElementById('ticketsGrid');
const eventsLog = document.getElementById('eventsLog');

let state = {
  tickets: new Map(),
  pools: null,
  done: false
};

// Polling interval for events.jsonl
let offset = 0;

async function pollEvents() {
  try {
    const res = await fetch('http://localhost:3333/events?offset=' + offset);
    if (res.ok) {
      const data = await res.json();
      if (data.lines && data.lines.length > 0) {
        data.lines.forEach(line => {
          try {
            const evt = JSON.parse(line);
            processEvent(evt);
          } catch (e) {
            console.error('Invalid event line', line);
          }
        });
        offset = data.newOffset;
        render();
      }
    }
  } catch (err) {
    console.warn('Failed to fetch events. Is agb server running?', err);
  }
  
  if (!state.done) {
    setTimeout(pollEvents, 500);
  }
}

function processEvent(evt) {
  addEventLog(evt);
  
  if (evt.type === 'pool') {
    state.pools = evt.pools;
  } else if (evt.type === 'report') {
    state.done = true;
    runStatus.innerHTML = '<span class="pulse done"></span> Run Complete';
  } else if (evt.ticket) {
    if (!state.tickets.has(evt.ticket)) {
      state.tickets.set(evt.ticket, { id: evt.ticket, phase: 'pending' });
    }
    const t = state.tickets.get(evt.ticket);
    
    if (evt.type === 'phase') {
      if (evt.to) t.phase = evt.to;
      if (evt.detail) t.detail = evt.detail;
      if (evt.model) t.model = evt.model;
      if (evt.strikes !== undefined) t.strikes = evt.strikes;
    } else if (evt.type === 'strike') {
      if (evt.model) t.model = evt.model;
      t.error = evt.error;
      if (evt.strikes !== undefined) t.strikes = evt.strikes;
    }
  }
}

function escapeHtml(unsafe) {
  return (unsafe || '').toString()
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function addEventLog(evt) {
  const el = document.createElement('div');
  el.className = `event-item type-${evt.type}`;
  
  let body = '';
  if (evt.type === 'phase') body = `[${escapeHtml(evt.ticket)}] Phase changed to <b>${escapeHtml(evt.to)}</b> ${evt.detail ? '- ' + escapeHtml(evt.detail) : ''}`;
  else if (evt.type === 'strike') body = `[${escapeHtml(evt.ticket)}] <span style="color:var(--danger)">Strike!</span> ${evt.error ? escapeHtml(evt.error.split('\n')[0]) : ''}`;
  else if (evt.type === 'pool') body = `Pools updated`;
  else if (evt.type === 'report') body = `Run finished.`;
  
  el.innerHTML = `
    <div class="event-time">${escapeHtml(new Date(evt.ts).toLocaleTimeString())}</div>
    <div class="event-body">${body}</div>
  `;
  
  eventsLog.prepend(el);
  if (eventsLog.children.length > 50) {
    eventsLog.lastChild.remove();
  }
}

function render() {
  // Render pools
  if (state.pools && state.pools.inFlight) {
    poolStatus.innerHTML = Object.entries(state.pools.inFlight).map(([p, n]) => `
      <div class="pool-badge">
        <span class="pool-name">${escapeHtml(p)}</span>
        <span class="pool-val">${escapeHtml(n)} / ${escapeHtml(state.pools.caps[p])}</span>
      </div>
    `).join('');
  }
  
  // Render tickets
  ticketsGrid.innerHTML = Array.from(state.tickets.values()).map(t => `
    <div class="ticket-card">
      <div class="ticket-header">
        <div class="ticket-id">${escapeHtml(t.id)}</div>
        <div class="ticket-phase phase-${escapeHtml(t.phase)}">${escapeHtml(t.phase)}</div>
      </div>
      <div class="ticket-model">${escapeHtml(t.model || 'Waiting for model...')}</div>
      ${t.strikes ? `<div class="ticket-model" style="color:var(--danger)">Strikes: ${escapeHtml(t.strikes)}</div>` : ''}
      <div class="ticket-detail">${escapeHtml(t.error ? t.error.split('\n')[0] : (t.detail || ''))}</div>
    </div>
  `).join('');
}

// Start polling
pollEvents();
