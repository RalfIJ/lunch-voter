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

const VALID_TABS = ['vote', 'results', 'history', 'stats', 'admin'];

function getTabFromHash() {
  const raw = (location.hash || '').replace(/^#/, '');
  return VALID_TABS.includes(raw) ? raw : null;
}

function activateTab(tabName) {
  if (!tabName) return;
  const btn = document.querySelector(`.nav-btn[data-tab="${tabName}"]`);
  const pane = document.getElementById(`tab-${tabName}`);
  if (!btn || !pane) return;

  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  pane.classList.add('active');

  if (tabName === 'results') loadResults();
  if (tabName === 'history') loadHistory();
  if (tabName === 'stats') loadStats();
  if (tabName === 'admin') loadAdminList();
}

// --- Init ---
document.addEventListener('DOMContentLoaded', async () => {
  // Check auth state first
  await checkAuth();

  // Tab navigation
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      activateTab(btn.dataset.tab);
      if (history.replaceState) {
        history.replaceState(null, '', `#${btn.dataset.tab}`);
      } else {
        location.hash = btn.dataset.tab;
      }
    });
  });

  // Restore tab from hash on load + react to hash changes (back/forward)
  activateTab(getTabFromHash());
  window.addEventListener('hashchange', () => activateTab(getTabFromHash()));

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

  // Teams test button
  const teamsBtn = document.getElementById('teams-test-btn');
  if (teamsBtn) teamsBtn.addEventListener('click', sendTeamsTest);

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
      const pic = authState.user.picture
        ? `<img src="${authState.user.picture}" alt="" class="user-avatar" referrerpolicy="no-referrer">`
        : '';
      voteHeader.innerHTML = `
        <div class="voter-input">
          ${pic}
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

let historyData = [];
let expandedWeekKey = null;
let detailCache = {};

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function formatAvg(avg) {
  if (avg == null) return null;
  return (Math.round(avg * 10) / 10).toFixed(1);
}

function renderStarsReadonly(rating) {
  const r = Math.round(rating);
  let html = '<span class="stars-readonly" aria-label="' + r + ' van 10">';
  for (let i = 1; i <= 10; i++) {
    html += `<span class="star ${i <= r ? 'filled' : ''}">${i <= r ? '★' : '☆'}</span>`;
  }
  html += '</span>';
  return html;
}

function identityQuery() {
  if (!authState.authEnabled && voterName) {
    return '?voterName=' + encodeURIComponent(voterName);
  }
  return '';
}

async function loadHistory() {
  try {
    const res = await fetch('/api/history' + identityQuery());
    historyData = await res.json();
    const container = document.getElementById('history-list');

    if (historyData.length === 0) {
      container.innerHTML = '<div class="empty-state"><h3>Nog geen geschiedenis</h3><p>Winnaars verschijnen hier na elke donderdagstemming.</p></div>';
      return;
    }

    renderHistoryList();
  } catch (err) {
    document.getElementById('history-list').innerHTML = '<div class="loading">Geschiedenis laden mislukt</div>';
  }
}

function renderHistoryList() {
  const container = document.getElementById('history-list');
  const prevExpanded = expandedWeekKey;
  container.innerHTML = historyData.map(h => {
    const avgStr = formatAvg(h.avg_rating);
    const expanded = expandedWeekKey === h.week_key;
    const ratingSummary = avgStr
      ? `<span class="history-rating"><span class="history-rating-star">★</span> ${avgStr}<span class="history-rating-max">/10</span> <span class="history-rating-count">(${h.rating_count})</span></span>`
      : '<span class="history-rating history-rating-empty">Nog geen beoordelingen</span>';
    const myRatingBadge = h.my_rating != null
      ? `<span class="my-rating-badge">Jij: ${h.my_rating}/10</span>`
      : '';

    return `
      <div class="history-item ${expanded ? 'expanded' : ''}" data-week="${escapeHtml(h.week_key)}">
        <div class="history-summary" onclick="toggleHistoryItem('${escapeHtml(h.week_key)}')">
          <div class="history-main">
            <div class="winner-name">${escapeHtml(h.restaurant_name)}</div>
            <div class="week">${escapeHtml(h.week_key)} &middot; ${new Date(h.decided_at).toLocaleDateString('nl-NL')} &middot; ${h.vote_count} stem${h.vote_count > 1 ? 'men' : ''}</div>
          </div>
          <div class="history-meta">
            ${ratingSummary}
            ${myRatingBadge}
            <span class="history-toggle">${expanded ? '▲' : '▼'}</span>
          </div>
        </div>
        ${expanded ? `<div class="history-detail" id="history-detail-${escapeHtml(h.week_key)}"><div class="loading">Beoordelingen laden...</div></div>` : ''}
      </div>
    `;
  }).join('');

  // If a row was expanded, repaint its detail from cache so refreshes don't
  // revert it to the "laden..." placeholder.
  if (prevExpanded && detailCache[prevExpanded]) {
    renderRatingDetail(prevExpanded);
  }
}

async function toggleHistoryItem(weekKey) {
  if (expandedWeekKey === weekKey) {
    expandedWeekKey = null;
    renderHistoryList();
    return;
  }
  expandedWeekKey = weekKey;
  renderHistoryList();
  await loadRatingDetail(weekKey);
}

async function loadRatingDetail(weekKey) {
  try {
    const res = await fetch(`/api/ratings/${encodeURIComponent(weekKey)}` + identityQuery());
    const data = await res.json();
    detailCache[weekKey] = data;
    renderRatingDetail(weekKey);
  } catch (err) {
    const el = document.getElementById(`history-detail-${weekKey}`);
    if (el) el.innerHTML = '<div class="loading">Beoordelingen laden mislukt</div>';
  }
}

function renderRatingDetail(weekKey) {
  const el = document.getElementById(`history-detail-${weekKey}`);
  if (!el) return;
  const data = detailCache[weekKey];
  if (!data) return;

  const canRate = !authState.authEnabled || !!authState.user;
  const mine = data.mine;
  const myRating = mine ? mine.rating : null;
  const myComment = mine ? (mine.comment || '') : '';

  const others = data.ratings.filter(r => !r.is_mine);

  let html = '';

  // Aggregate
  if (data.count > 0) {
    html += `
      <div class="rating-aggregate">
        <div class="agg-big">${formatAvg(data.avg)}<span class="agg-max">/10</span></div>
        ${renderStarsReadonly(data.avg)}
        <div class="agg-count">${data.count} beoordeling${data.count === 1 ? '' : 'en'}</div>
      </div>
    `;
  }

  // Rating widget
  if (canRate) {
    html += `
      <div class="rating-widget-wrap">
        <div class="rating-widget-label">${mine ? 'Jouw beoordeling' : 'Laat je beoordeling achter'}</div>
        <div class="rating-widget" data-week="${escapeHtml(weekKey)}" data-rating="${myRating != null ? myRating : ''}">
          <button type="button" class="rating-zero ${myRating === 0 ? 'active' : ''}" onclick="setRating('${escapeHtml(weekKey)}', 0)" title="0 — slecht">0</button>
          <div class="rating-stars">
            ${[1,2,3,4,5,6,7,8,9,10].map(n =>
              `<button type="button" class="rating-star ${myRating != null && n <= myRating ? 'active' : ''}" data-value="${n}" onclick="setRating('${escapeHtml(weekKey)}', ${n})">${myRating != null && n <= myRating ? '★' : '☆'}</button>`
            ).join('')}
          </div>
          <span class="rating-score">${myRating != null ? myRating : '—'}<span class="rating-score-max">/10</span></span>
        </div>
        <textarea class="rating-comment" id="rating-comment-${escapeHtml(weekKey)}" placeholder="Hoe was het? (optioneel)" maxlength="1000">${escapeHtml(myComment)}</textarea>
        <div class="rating-actions">
          <button type="button" class="btn-primary rating-save" onclick="saveRating('${escapeHtml(weekKey)}')">Opslaan</button>
          ${mine ? `<button type="button" class="btn-secondary rating-remove" onclick="removeRating('${escapeHtml(weekKey)}')">Verwijder mijn beoordeling</button>` : ''}
          <span class="rating-status" id="rating-status-${escapeHtml(weekKey)}"></span>
        </div>
      </div>
    `;
  } else {
    html += `
      <div class="rating-login-hint">
        <a href="/auth/login">Log in</a> om deze lunch te beoordelen.
      </div>
    `;
  }

  // Others' ratings + comments
  if (others.length > 0 || (mine && mine.comment)) {
    html += '<div class="ratings-list">';
    if (mine && mine.comment) {
      html += renderRatingItem({ ...mine, voter_name: mine.voter_name || 'Jij', is_mine: 1 });
    }
    for (const r of others) {
      html += renderRatingItem(r);
    }
    html += '</div>';
  }

  el.innerHTML = html;
}

function renderRatingItem(r) {
  const comment = r.comment ? `<div class="rating-item-comment">${escapeHtml(r.comment)}</div>` : '';
  return `
    <div class="rating-item ${r.is_mine ? 'is-mine' : ''}">
      <div class="rating-item-head">
        <span class="rating-item-name">${escapeHtml(r.voter_name)}${r.is_mine ? ' <span class="you-tag">jij</span>' : ''}</span>
        <span class="rating-item-score">${r.rating}/10</span>
      </div>
      ${renderStarsReadonly(r.rating)}
      ${comment}
    </div>
  `;
}

function setRating(weekKey, value) {
  const data = detailCache[weekKey];
  if (!data) return;
  // Preserve any text the user typed before re-rendering
  const typed = document.getElementById(`rating-comment-${weekKey}`)?.value;
  const existingComment = typed != null ? typed : (data.mine?.comment || '');
  data.mine = {
    ...(data.mine || {}),
    rating: value,
    comment: existingComment,
    voter_name: data.mine?.voter_name || (authState.user?.name || voterName),
    is_mine: 1,
  };
  renderRatingDetail(weekKey);
}

async function saveRating(weekKey) {
  if (authState.authEnabled && !authState.user) {
    window.location.href = '/auth/login';
    return;
  }
  const data = detailCache[weekKey];
  const rating = data?.mine?.rating;
  if (rating == null) {
    setStatus(weekKey, 'Kies eerst een score', true);
    return;
  }
  const comment = document.getElementById(`rating-comment-${weekKey}`)?.value || '';

  setStatus(weekKey, 'Opslaan...', false);
  try {
    const res = await fetch('/api/ratings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ weekKey, rating, comment, voterName }),
    });
    const json = await res.json();
    if (!res.ok) {
      setStatus(weekKey, json.error || 'Opslaan mislukt', true);
      return;
    }
    setStatus(weekKey, 'Opgeslagen!', false);
    await loadRatingDetail(weekKey);
    // Refresh list to update aggregates and my_rating badge
    await loadHistory();
  } catch (err) {
    setStatus(weekKey, 'Netwerkfout. Probeer opnieuw.', true);
  }
}

async function removeRating(weekKey) {
  if (!confirm('Jouw beoordeling verwijderen?')) return;
  try {
    const res = await fetch(`/api/ratings/${encodeURIComponent(weekKey)}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ voterName }),
    });
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      setStatus(weekKey, json.error || 'Verwijderen mislukt', true);
      return;
    }
    await loadRatingDetail(weekKey);
    await loadHistory();
  } catch (err) {
    setStatus(weekKey, 'Netwerkfout. Probeer opnieuw.', true);
  }
}

function setStatus(weekKey, msg, isError) {
  const el = document.getElementById(`rating-status-${weekKey}`);
  if (!el) return;
  el.textContent = msg;
  el.style.color = isError ? 'var(--danger)' : 'var(--success)';
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

async function loadStats() {
  const container = document.getElementById('stats-container');
  try {
    const res = await fetch('/api/stats');
    const stats = await res.json();
    let html = '';

    // Fun facts banner
    if (stats.funFacts.length > 0) {
      html += '<div class="stats-facts">';
      html += stats.funFacts.map(f => `<div class="fact-item">${f}</div>`).join('');
      html += '</div>';
    }

    // Summary cards
    html += '<div class="stats-summary">';
    html += `<div class="stat-card"><div class="stat-value">${stats.totalWeeks}</div><div class="stat-label">Weken gestemd</div></div>`;
    html += `<div class="stat-card"><div class="stat-value">${stats.totalVoters}</div><div class="stat-label">Unieke stemmers</div></div>`;
    html += `<div class="stat-card"><div class="stat-value">${stats.avgVoters}</div><div class="stat-label">Gem. stemmers/week</div></div>`;
    html += `<div class="stat-card"><div class="stat-value">${stats.avgVotesPerVoter}</div><div class="stat-label">Gem. stemmen/persoon</div></div>`;
    html += '</div>';

    // Top winners chart
    if (stats.topWinners.length > 0) {
      const maxWins = stats.topWinners[0].wins;
      html += '<div class="stats-section"><h3>Meest gewonnen restaurants</h3>';
      html += stats.topWinners.map(w => {
        const pct = Math.round((w.wins / maxWins) * 100);
        return `<div class="stat-bar">
          <div class="stat-bar-name">${w.restaurant_name}</div>
          <div class="stat-bar-track"><div class="stat-bar-fill" style="width:${pct}%">${w.wins}x</div></div>
        </div>`;
      }).join('');
      html += '</div>';
    }

    // Top voters chart
    if (stats.topVoters.length > 0) {
      const maxWeeks = stats.topVoters[0].weeks_active;
      html += '<div class="stats-section"><h3>Actiefste stemmers</h3>';
      html += stats.topVoters.map(v => {
        const pct = Math.max(Math.round((v.weeks_active / maxWeeks) * 100), 10);
        return `<div class="stat-bar">
          <div class="stat-bar-name">${v.voter_name}</div>
          <div class="stat-bar-track"><div class="stat-bar-fill voter-fill" style="width:${pct}%">${v.weeks_active} ${v.weeks_active === 1 ? 'week' : 'weken'} · ${v.total_votes} stemmen</div></div>
        </div>`;
      }).join('');
      html += '</div>';
    }

    // Win streak
    if (stats.bestStreak.count > 1) {
      html += `<div class="stats-section"><h3>Langste winstreak</h3>
        <div class="streak-card">${stats.bestStreak.name} — ${stats.bestStreak.count} weken op rij</div>
      </div>`;
    }

    if (!stats.topWinners.length && !stats.topVoters.length) {
      html = '<div class="empty-state"><h3>Nog geen statistieken</h3><p>Statistieken verschijnen na de eerste weken stemmen.</p></div>';
    }

    container.innerHTML = html;
  } catch (err) {
    container.innerHTML = '<div class="loading">Statistieken laden mislukt</div>';
  }
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
  if (!votingStatus.votingOpen) {
    alert(votingStatus.resultsReady
      ? 'Stemmen is gesloten voor deze week. Opent weer maandag om 09:00.'
      : 'Stemmen is gesloten. Opent maandag om 09:00.');
    return;
  }
  if (authState.authEnabled && !authState.user) {
    window.location.href = '/auth/login';
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
    if (res.status === 403) {
      const data = await res.json().catch(() => ({}));
      alert(data.error || 'Stemmen is niet toegestaan.');
      await loadVotingStatus();
      return;
    }
    await loadVotingStatus();
  } catch (err) {
    alert('Stem uitbrengen mislukt. Probeer het opnieuw.');
  }
}

async function sendTeamsTest() {
  const statusEl = document.getElementById('refresh-status');
  const btn = document.getElementById('teams-test-btn');
  btn.disabled = true;
  statusEl.textContent = 'Testbericht versturen naar Teams...';
  statusEl.style.color = 'var(--text-light)';

  try {
    const res = await fetch('/api/teams/test', { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      statusEl.textContent = data.message || 'Testbericht verstuurd';
      statusEl.style.color = 'var(--success)';
    } else if (res.status === 403) {
      statusEl.textContent = 'Alleen beheerders mogen Teams testen';
      statusEl.style.color = 'var(--danger)';
    } else {
      statusEl.textContent = data.error || 'Versturen mislukt';
      statusEl.style.color = 'var(--danger)';
    }
  } catch (err) {
    statusEl.textContent = 'Netwerkfout. Probeer het opnieuw.';
    statusEl.style.color = 'var(--danger)';
  }
  btn.disabled = false;
}

async function deleteRestaurant(id) {
  if (!confirm('Dit restaurant verwijderen?')) return;
  const res = await fetch(`/api/restaurants/${id}`, { method: 'DELETE' });
  if (res.status === 403) return alert('Alleen beheerders mogen restaurants verwijderen');
  await loadRestaurants();
  loadCuisines();
  loadAdminList();
}

// --- Countdown ---
let countdownInterval = null;

function getNextDeadline() {
  // Deadline is always Thursday 10:00 of the current week
  const now = new Date();
  const day = now.getDay(); // 0=Sun, 4=Thu
  const d = new Date(now);
  d.setDate(now.getDate() + (4 - day));
  d.setHours(10, 0, 0, 0);
  // If we're past Thursday 10:00, next deadline is next week's Thursday
  if (d <= now) d.setDate(d.getDate() + 7);
  return d;
}

function getNextOpen() {
  // Next opening is Monday 09:00
  const now = new Date();
  const day = now.getDay();
  const d = new Date(now);
  // Days until next Monday
  const daysUntilMon = day === 0 ? 1 : (8 - day);
  d.setDate(now.getDate() + daysUntilMon);
  d.setHours(9, 0, 0, 0);
  return d;
}

function formatCountdown(ms) {
  if (ms <= 0) return '0:00:00';
  const totalSec = Math.floor(ms / 1000);
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  if (days > 0) return `${days}d ${hours}u ${String(mins).padStart(2, '0')}m`;
  return `${hours}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function startCountdown() {
  if (countdownInterval) clearInterval(countdownInterval);
  countdownInterval = setInterval(updateCountdown, 1000);
  updateCountdown();
}

function updateCountdown() {
  const el = document.getElementById('countdown');
  if (!el) return;
  const now = new Date();

  if (votingStatus.votingOpen) {
    const deadline = getNextDeadline();
    const remaining = deadline - now;
    el.textContent = `Sluit over ${formatCountdown(remaining)}`;
    el.style.display = 'block';
  } else if (votingStatus.resultsReady) {
    el.style.display = 'none';
  } else {
    const nextOpen = getNextOpen();
    const remaining = nextOpen - now;
    el.textContent = `Opent over ${formatCountdown(remaining)}`;
    el.style.display = 'block';
  }
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

  startCountdown();
}

function renderRestaurants() {
  const container = document.getElementById('restaurant-list');
  const countEl = document.getElementById('restaurant-count');

  // Lock the grid when voting is closed so cards look and feel inert.
  container.classList.toggle('locked', !votingStatus.votingOpen);

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
          ${r.rating ? `
            <span class="card-rating card-rating-tb" title="Thuisbezorgd beoordeling">
              <span class="rating-source">TB</span>
              <span class="star">★</span>
              <span class="rating">${typeof r.rating === 'number' ? r.rating.toFixed(1) : r.rating}<span class="rating-max">/5</span></span>
              ${r.rating_count ? `<span class="rating-count">(${r.rating_count})</span>` : ''}
            </span>` : ''}
          ${r.our_rating_count > 0 ? `
            <span class="card-rating card-rating-ours" title="Onze lunch-beoordelingen">
              <span class="rating-source">Onze</span>
              <span class="star">★</span>
              <span class="rating">${(Math.round(r.our_avg_rating * 10) / 10).toFixed(1)}<span class="rating-max">/10</span></span>
              <span class="rating-count">(${r.our_rating_count})</span>
            </span>` : ''}
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
