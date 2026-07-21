const runStatus = document.getElementById('runStatus');
const poolStatus = document.getElementById('poolStatus');
const ticketsGrid = document.getElementById('ticketsGrid');
const eventsLog = document.getElementById('eventsLog');
const repoPathEl = document.getElementById('repoPath');

let state = {
  tickets: new Map(),
  pools: null,
  done: false,
  runId: null
};

// Polling interval for events.jsonl
let offset = 0;

async function pollEvents() {
  try {
    const res = await fetch(`/events?offset=${offset}`);
    if (res.ok) {
      const data = await res.json();
      
      if (data.repo && repoPathEl.innerText !== data.repo) {
        repoPathEl.innerText = data.repo;
      }
      
      // Reset state if we detect a new run ID or truncation
      if ((data.runId && state.runId !== data.runId) || data.reset) {
        state.tickets.clear();
        state.pools = null;
        state.done = false;
        state.runId = data.runId;
        eventsLog.innerHTML = '';
        runStatus.innerHTML = '<span class="pulse"></span>Waiting for activity...';
        runStatus.className = 'status-badge status-running';
        console.log('Resetting dashboard for new run:', data.runId);
        offset = 0;
        // Re-fetch with 0 offset immediately
        if (data.newOffset > 0) {
           return setTimeout(pollEvents, 0);
        }
      }

      if (typeof data.newOffset === 'number') {
        offset = data.newOffset;
      }
      
      if (data.lines && data.lines.length > 0) {
        data.lines.forEach(line => {
          try {
            const evt = JSON.parse(line);
            processEvent(evt);
          } catch (e) {
            console.error('Invalid event line', line);
          }
        });
        render();
      }
      
      if (data.warning) {
        runStatus.innerHTML = `<span class="pulse" style="background-color: var(--color-status-failed)"></span>${data.warning}`;
        runStatus.className = 'status-badge status-failed';
      } else if (runStatus.innerHTML.includes('Dropped oversized line')) {
        runStatus.innerHTML = '<span class="pulse"></span>Running...';
        runStatus.className = 'status-badge status-running';
      }
    } else {
      if (res.status === 401 || res.status === 403) {
        runStatus.innerHTML = '<span class="pulse" style="background-color: var(--color-status-failed)"></span>Dashboard token is stale — restart the panel from the new URL';
        runStatus.className = 'status-badge status-failed';
      } else {
        runStatus.innerHTML = '<span class="pulse" style="background-color: var(--color-status-failed)"></span>Network error or server unavailable';
        runStatus.className = 'status-badge status-failed';
      }
    }
  } catch (err) {
    console.warn('Failed to fetch events. Is agb server running?', err);
  }
  
  // Keep polling, but slow down when done
  setTimeout(pollEvents, state.done ? 2000 : 500);
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
      t.error = evt.error ? String(evt.error) : undefined;
      if (evt.strikes !== undefined) t.strikes = evt.strikes;
    }
  }
}

function escapeHtml(unsafe) {
  if (unsafe == null || unsafe === '') return '';
  return String(unsafe)
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
  else if (evt.type === 'strike') body = `[${escapeHtml(evt.ticket)}] <span style="color:var(--danger)">Strike!</span> ${evt.error ? escapeHtml(String(evt.error).split('\n')[0]) : ''}`;
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
  try {
    // Render pools
    if (state.pools && state.pools.inFlight) {
      poolStatus.innerHTML = Object.entries(state.pools.inFlight).map(([p, n]) => `
        <div class="pool-badge">
          <span class="pool-name">${escapeHtml(p)}</span>
          <span class="pool-val">${escapeHtml(n)} / ${escapeHtml(state.pools.caps?.[p] ?? '?')}</span>
        </div>
      `).join('');
    }
    
    // Render tickets
    ticketsGrid.innerHTML = Array.from(state.tickets.values()).map(t => {
      let html = `
        <div class="ticket-card">
          <div class="ticket-header">
            <div class="ticket-id">${escapeHtml(t.id)}</div>
            <div class="ticket-phase phase-${escapeHtml(t.phase)}">${escapeHtml(t.phase)}</div>
          </div>
          <div class="ticket-model">${escapeHtml(t.model || 'Waiting for model...')}</div>
          ${t.strikes ? `<div class="ticket-model" style="color:var(--danger)">Strikes: ${escapeHtml(t.strikes)}</div>` : ''}
      `;
      if (t.error) {
        const errorMsg = String(t.error).split('\n')[0];
        const details = escapeHtml(`${t.model || ''} - ${errorMsg}`);
        html += `<div class="ticket-detail">${details}</div>`;
      } else if (t.detail) {
        html += `<div class="ticket-detail">${escapeHtml(t.detail)}</div>`;
      }
      html += `</div>`;
      return html;
    }).join('');
  } catch (e) {
    console.error("Render failed", e);
  }
}

// Start polling
pollEvents();
