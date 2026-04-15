// --- State ---
let restaurants = [];
let votingStatus = {};
let cuisines = [];
let authState = { authEnabled: false, user: null };
let voterName = '';

// Filter/sort state
let currentSort = 'rating-desc';
let currentCuisineFilter = '';
let currentRatingFilter = 0;
let currentOpenFilter = true;

// --- Init ---
document.addEventListener('DOMContentLoaded', async () => {
  // Check auth state first
  await checkAuth();

  // Tab navigation
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');

      if (btn.dataset.tab === 'results') loadResults();
      if (btn.dataset.tab === 'history') loadHistory();
      if (btn.dataset.tab === 'admin') loadAdminList();
    });
  });

  // Filter/sort listeners
  document.getElementById('filter-cuisine').addEventListener('change', (e) => {
    currentCuisineFilter = e.target.value;
    renderRestaurants();
  });
  document.getElementById('filter-rating').addEventListener('change', (e) => {
    currentRatingFilter = parseFloat(e.target.value);
    renderRestaurants();
  });
  document.getElementById('filter-open').addEventListener('change', (e) => {
    currentOpenFilter = e.target.checked;
    renderRestaurants();
  });
  document.getElementById('sort-by').addEventListener('change', (e) => {
    currentSort = e.target.value;
    renderRestaurants();
  });

  // Refresh button
  document.getElementById('refresh-btn').addEventListener('click', refreshRestaurants);

  // Add restaurant form
  document.getElementById('add-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('add-name').value.trim();
    const cuisine = document.getElementById('add-cuisine').value.trim();
    if (!name) return;
    const res = await fetch('/api/restaurants', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, cuisine }),
    });
    if (res.status === 403) return alert('Alleen beheerders mogen restaurants toevoegen');
    document.getElementById('add-name').value = '';
    document.getElementById('add-cuisine').value = '';
    await loadRestaurants();
    loadCuisines();
    loadAdminList();
  });

  // Finalize button
  document.getElementById('finalize-btn').addEventListener('click', async () => {
    if (!confirm('Weet je zeker dat je de stemming wilt afsluiten en een winnaar wilt kiezen?')) return;
    const res = await fetch('/api/voting/finalize', { method: 'POST' });
    const data = await res.json();
    if (res.status === 403) return alert('Alleen beheerders mogen de stemming afsluiten');
    if (data.winner) {
      alert(`Winnaar: ${data.winner.restaurant_name}!`);
      loadResults();
    } else {
      alert(data.error || 'Er is iets misgegaan');
    }
  });

  // Login form
  document.getElementById('login-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('login-name').value.trim();
    const pin = document.getElementById('login-pin').value;
    const errorEl = document.getElementById('login-error');
    errorEl.textContent = '';

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, pin }),
      });
      const data = await res.json();
      if (!res.ok) {
        errorEl.textContent = data.error;
        return;
      }
      await checkAuth();
      loadVotingStatus();
    } catch (err) {
      errorEl.textContent = 'Inloggen mislukt. Probeer het opnieuw.';
    }
  });

  // Name input (for when auth is disabled)
  const voterInput = document.getElementById('voter-name');
  if (voterInput) {
    voterInput.addEventListener('input', (e) => {
      voterName = e.target.value.trim();
      localStorage.setItem('lunchVoterName', voterName);
      renderRestaurants();
    });
  }

  // Load data
  loadRestaurants();
  loadVotingStatus();
  loadCuisines();

  // Auto-refresh every 30s
  setInterval(loadVotingStatus, 30000);
});

// --- Auth ---
async function checkAuth() {
  try {
    const res = await fetch('/api/auth/me');
    authState = await res.json();
  } catch (err) {
    authState = { authEnabled: false, user: null };
  }
  renderAuthUI();
}

function renderAuthUI() {
  const voteHeader = document.querySelector('.vote-header');
  const loginBanner = document.getElementById('login-banner');

  if (authState.authEnabled) {
    if (authState.user) {
      voterName = authState.user.name;
      voteHeader.innerHTML = `
        <div class="voter-input">
          <span class="user-badge">Ingelogd als <strong>${authState.user.name}</strong>${authState.user.isAdmin ? ' <span class="admin-tag">beheerder</span>' : ''}</span>
          <a href="/auth/logout" class="btn-logout">Uitloggen</a>
        </div>
        <div id="week-info" class="week-info"></div>
      `;
      if (loginBanner) loginBanner.style.display = 'none';

      const adminBtn = document.querySelector('[data-tab="admin"]');
      if (adminBtn) adminBtn.style.display = authState.user.isAdmin ? '' : 'none';
    } else {
      if (loginBanner) loginBanner.style.display = 'block';
      voteHeader.style.display = 'none';

      const adminBtn = document.querySelector('[data-tab="admin"]');
      if (adminBtn) adminBtn.style.display = 'none';
    }
  } else {
    voterName = localStorage.getItem('lunchVoterName') || '';
    const voterInput = document.getElementById('voter-name');
    if (voterInput) voterInput.value = voterName;
  }
}

// --- Data loading ---
async function loadRestaurants() {
  try {
    const res = await fetch('/api/restaurants');
    restaurants = await res.json();
    renderRestaurants();
  } catch (err) {
    document.getElementById('restaurant-list').innerHTML =
      '<div class="empty-state"><h3>Restaurants konden niet worden geladen</h3><p>Ga naar het tabblad "Beheer" om restaurants op te halen of toe te voegen.</p></div>';
  }
}

async function loadCuisines() {
  try {
    const res = await fetch('/api/cuisines');
    cuisines = await res.json();
    const select = document.getElementById('filter-cuisine');
    select.innerHTML = '<option value="">Alle keukens</option>' +
      cuisines.map(c => `<option value="${c}">${c}</option>`).join('');
  } catch (err) {
    console.error('Keukens laden mislukt:', err);
  }
}

async function loadVotingStatus() {
  try {
    const res = await fetch('/api/voting/status');
    votingStatus = await res.json();
    renderStatus();
    renderRestaurants();
  } catch (err) {
    console.error('Stemstatus laden mislukt:', err);
  }
}

async function loadResults() {
  await loadVotingStatus();
  const container = document.getElementById('results-container');
  const winnerSection = document.getElementById('winner-section');
  const finalizeSection = document.getElementById('finalize-section');

  const existingWinner = votingStatus.pastWinners?.find(w => w.week_key === votingStatus.weekKey);
  if (existingWinner) {
    winnerSection.style.display = 'block';
    finalizeSection.style.display = 'none';
    document.getElementById('winner-display').innerHTML = `
      <h3>Winnaar deze week</h3>
      <div class="winner-name">${existingWinner.restaurant_name}</div>
      <p style="margin-top:.5rem;opacity:.8">${existingWinner.vote_count} stem${existingWinner.vote_count > 1 ? 'men' : ''} - Week ${existingWinner.week_key}</p>
      <p style="margin-top:1rem">
        <a href="https://www.thuisbezorgd.nl/bestellen/eten/1812" target="_blank"
           style="color:white;text-decoration:underline;font-size:1.1rem">
          Bestellen op Thuisbezorgd
        </a>
      </p>
    `;
  } else {
    winnerSection.style.display = 'none';
    finalizeSection.style.display = votingStatus.tallies?.length > 0 ? 'block' : 'none';
  }

  if (!votingStatus.tallies || votingStatus.tallies.length === 0) {
    container.innerHTML = '<div class="empty-state"><h3>Nog geen stemmen deze week</h3><p>Wees de eerste die stemt!</p></div>';
    return;
  }

  let html = '';
  for (const t of votingStatus.tallies) {
    const pct = Math.round((t.vote_count / votingStatus.totalVotes) * 100);
    html += `
      <div class="result-bar">
        <div class="bar-name">${t.restaurant_name}</div>
        <div class="bar-track">
          <div class="bar-fill" style="width:${Math.max(pct, 8)}%">${t.vote_count} stem${t.vote_count > 1 ? 'men' : ''} (${pct}%)</div>
        </div>
      </div>
    `;
  }

  if (votingStatus.votes?.length > 0) {
    const uniqueVoters = [...new Set(votingStatus.votes.map(v => v.voter_name))];
    html += '<div class="voters-list">Stemmers: ';
    html += uniqueVoters.map(v => `<span>${v}</span>`).join('');
    html += '</div>';
  }

  container.innerHTML = html;
}

async function loadHistory() {
  try {
    const res = await fetch('/api/history');
    const history = await res.json();
    const container = document.getElementById('history-list');

    if (history.length === 0) {
      container.innerHTML = '<div class="empty-state"><h3>Nog geen geschiedenis</h3><p>Winnaars verschijnen hier na elke donderdagstemming.</p></div>';
      return;
    }

    container.innerHTML = history.map(h => `
      <div class="history-item">
        <div>
          <div class="winner-name">${h.restaurant_name}</div>
          <div class="week">${h.week_key} - ${new Date(h.decided_at).toLocaleDateString('nl-NL')}</div>
        </div>
        <div class="votes-info">${h.vote_count} stem${h.vote_count > 1 ? 'men' : ''}</div>
      </div>
    `).join('');
  } catch (err) {
    document.getElementById('history-list').innerHTML = '<div class="loading">Geschiedenis laden mislukt</div>';
  }
}

function loadAdminList() {
  const container = document.getElementById('admin-restaurant-list');
  if (restaurants.length === 0) {
    container.innerHTML = '<div class="empty-state"><h3>Geen restaurants</h3><p>Ophalen van Thuisbezorgd of handmatig toevoegen.</p></div>';
    return;
  }

  container.innerHTML = restaurants.map(r => `
    <div class="admin-item">
      <div>
        <span class="info">${r.name}</span>
        <span class="cuisine-tag">${r.cuisine || ''}</span>
      </div>
      <button class="btn-danger" onclick="deleteRestaurant('${r.id}')">Verwijderen</button>
    </div>
  `).join('');
}

// --- Actions ---
async function refreshRestaurants() {
  const statusEl = document.getElementById('refresh-status');
  const btn = document.getElementById('refresh-btn');
  btn.disabled = true;
  statusEl.textContent = 'Restaurants ophalen van Thuisbezorgd...';
  statusEl.style.color = 'var(--text-light)';

  try {
    const res = await fetch('/api/restaurants/refresh', { method: 'POST' });
    const data = await res.json();
    if (res.ok) {
      statusEl.textContent = data.message;
      statusEl.style.color = 'var(--success)';
      await loadRestaurants();
      loadCuisines();
      loadAdminList();
    } else {
      statusEl.textContent = data.error + (data.hint ? ` ${data.hint}` : '');
      statusEl.style.color = 'var(--danger)';
    }
  } catch (err) {
    statusEl.textContent = 'Netwerkfout. Probeer het opnieuw.';
    statusEl.style.color = 'var(--danger)';
  }
  btn.disabled = false;
}

async function castVote(restaurantId) {
  if (authState.authEnabled && !authState.user) {
    alert('Log eerst in om te stemmen.');
    return;
  }
  if (!authState.authEnabled && !voterName) {
    alert('Vul eerst je naam in!');
    document.getElementById('voter-name').focus();
    return;
  }

  try {
    const res = await fetch('/api/voting/vote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ voterName, restaurantId }),
    });
    if (res.status === 401) {
      alert('Je sessie is verlopen. Log opnieuw in.');
      await checkAuth();
      return;
    }
    await loadVotingStatus();
  } catch (err) {
    alert('Stem uitbrengen mislukt. Probeer het opnieuw.');
  }
}

async function deleteRestaurant(id) {
  if (!confirm('Dit restaurant verwijderen?')) return;
  const res = await fetch(`/api/restaurants/${id}`, { method: 'DELETE' });
  if (res.status === 403) return alert('Alleen beheerders mogen restaurants verwijderen');
  await loadRestaurants();
  loadCuisines();
  loadAdminList();
}

// --- Rendering ---
function renderStatus() {
  const el = document.getElementById('voting-status');
  const weekEl = document.getElementById('week-info');

  el.className = 'status-badge';

  if (votingStatus.votingOpen) {
    el.textContent = 'Stemmen open';
    el.classList.add('open');
  } else if (votingStatus.resultsReady) {
    el.textContent = 'Resultaten klaar!';
    el.classList.add('closed');
  } else {
    el.textContent = 'Stemmen opent maandag';
    el.classList.add('closed');
  }

  if (weekEl) {
    weekEl.textContent = `Week: ${votingStatus.weekKey || '...'} | ${votingStatus.totalVoters || 0} stemmers, ${votingStatus.totalVotes || 0} stemmen`;
  }
}

function renderRestaurants() {
  const container = document.getElementById('restaurant-list');
  const countEl = document.getElementById('restaurant-count');

  if (restaurants.length === 0) {
    container.innerHTML = `
      <div class="empty-state" style="grid-column:1/-1">
        <h3>Nog geen restaurants</h3>
        <p>Ga naar het tabblad "Beheer" om restaurants op te halen van Thuisbezorgd of handmatig toe te voegen.</p>
      </div>
    `;
    if (countEl) countEl.textContent = '';
    return;
  }

  // Find current user's votes
  const myVotes = votingStatus.votes?.filter(v => v.voter_name === voterName.toLowerCase()) || [];
  const myVotedIds = new Set(myVotes.map(v => v.restaurant_id));
  const currentVoteEl = document.getElementById('current-vote');
  const currentVoteNameEl = document.getElementById('current-vote-name');

  if (currentVoteEl && currentVoteNameEl) {
    if (myVotes.length > 0) {
      currentVoteEl.style.display = 'flex';
      currentVoteNameEl.textContent = myVotes.map(v => v.restaurant_name).join(', ');
    } else {
      currentVoteEl.style.display = 'none';
    }
  }

  // Build vote count map
  const voteCounts = {};
  if (votingStatus.tallies) {
    for (const t of votingStatus.tallies) {
      voteCounts[t.restaurant_id] = t.vote_count;
    }
  }

  // Filter
  let filtered = restaurants.filter(r => {
    if (currentCuisineFilter && !(r.cuisine || '').split(',').map(c => c.trim()).includes(currentCuisineFilter)) return false;
    if (currentRatingFilter > 0 && (r.rating || 0) < currentRatingFilter) return false;
    if (currentOpenFilter && !r.is_open) return false;
    return true;
  });

  // Sort
  const [sortField, sortDir] = currentSort.split('-');
  const dir = sortDir === 'asc' ? 1 : -1;
  filtered.sort((a, b) => {
    if (sortField === 'name') return dir * a.name.localeCompare(b.name, 'nl');
    if (sortField === 'rating') return dir * ((a.rating || 0) - (b.rating || 0));
    if (sortField === 'votes') return dir * ((voteCounts[a.id] || 0) - (voteCounts[b.id] || 0));
    return 0;
  });

  if (countEl) {
    countEl.textContent = filtered.length === restaurants.length
      ? `${filtered.length} restaurants`
      : `${filtered.length} van ${restaurants.length} restaurants`;
  }

  container.innerHTML = filtered.map((r, index) => {
    const isVoted = myVotedIds.has(r.id);
    const voteCount = voteCounts[r.id] || 0;
    const recentWins = votingStatus.winCounts?.[r.id] || 0;
    const initial = r.name.charAt(0).toUpperCase();

    return `
      <div class="restaurant-card ${isVoted ? 'voted' : ''}" onclick="castVote('${r.id}')" style="--i:${index}">
        <div class="card-header">
          ${r.logo_url
            ? `<img src="${r.logo_url}" alt="" class="card-logo" onerror="this.outerHTML='<div class=\\'card-logo-placeholder\\'>${initial}</div>'">`
            : `<div class="card-logo-placeholder">${initial}</div>`}
          <div class="card-title">
            <div class="name">${r.name}</div>
            <div class="cuisine">${r.cuisine || 'Restaurant'}</div>
          </div>
          ${r.slug ? `<a href="https://www.thuisbezorgd.nl/menu/${r.slug}" target="_blank" rel="noopener" class="card-link" onclick="event.stopPropagation()" title="Bekijk op Thuisbezorgd">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
          </a>` : ''}
        </div>
        <div class="card-meta">
          ${r.rating ? `<span class="star">★</span> <span class="rating">${typeof r.rating === 'number' ? r.rating.toFixed(1) : r.rating}</span>` : ''}
          ${r.rating_count ? `<span class="rating-count">(${r.rating_count})</span>` : ''}
          ${!r.is_open ? '<span class="closed-badge">Gesloten</span>' : ''}
        </div>
        <div class="card-footer">
          ${voteCount > 0 ? `<span class="vote-count">${voteCount} stem${voteCount > 1 ? 'men' : ''}</span>` : '<span></span>'}
          ${recentWins > 0 ? `<span class="recent-winner">${recentWins}x gewonnen</span>` : ''}
        </div>
      </div>
    `;
  }).join('');
}
