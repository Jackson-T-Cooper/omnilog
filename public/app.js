import {
  INITIAL_CATALOG,
  INITIAL_USERS,
  INITIAL_LOGS,
  INITIAL_WATCHLIST,
  INITIAL_LISTS,
  buildPosterUrl
} from './data.js';

const STORAGE_KEY = 'omnilog_state_auth_gated_v2';

let state = {
  currentUserId: null,
  inProgressSeededV1: true,
  friendLogsSeededV1: true,
  catalog: structuredClone(INITIAL_CATALOG),
  users: structuredClone(INITIAL_USERS),
  logs: structuredClone(INITIAL_LOGS),
  watchlist: structuredClone(INITIAL_WATCHLIST),
  lists: structuredClone(INITIAL_LISTS)
};

export function isUserSignedIn() {
  return Boolean(
    !uiState.isSignedOut &&
      state.currentUserId &&
      state.users &&
      state.users[state.currentUserId]
  );
}

function requireAuthForAction(
  reasonMessage = 'Please sign in or sign up first to log Movies, TV Shows, and Books!'
) {
  if (isUserSignedIn()) return true;
  document.getElementById('logDialog')?.close();
  document.getElementById('detailDialog')?.close();
  document.getElementById('listDialog')?.close();
  document.getElementById('favoritePickerDialog')?.close();
  const targetMode = Object.keys(state.users || {}).length > 0 ? 'login' : 'signup';
  openUserModal(targetMode);
  setAuthModalFeedback(reasonMessage, false);
  showToast(reasonMessage);
  return false;
}

function deriveClientInitials(name = 'Member') {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'MB';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

function syncClientWatchlistToActiveUser() {
  const activeUser = state.users?.[state.currentUserId];
  if (activeUser && Array.isArray(state.watchlist)) {
    activeUser.watchlist = [...state.watchlist];
  }
}

function generateClientId(prefix = 'id') {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function clampClientRating(rating, fallback = 4.5) {
  const num = Number(rating);
  if (Number.isNaN(num)) return fallback;
  const clamped = Math.min(5.0, Math.max(0.5, num));
  return Math.round(clamped * 2) / 2;
}

let uiState = {
  activeView: 'explore',
  viewingUserId: null,
  isSignedOut: true,
  signupStep: 1,
  exploreType: 'all',
  exploreGenre: 'all',
  exploreSort: 'popular',
  exploreQuery: '',
  externalResults: [],
  feedType: 'all',
  feedScope: 'all',
  diaryType: 'all',
  diarySort: 'newest',
  diaryLikedOnly: false,
  diaryQuery: '',
  watchlistType: 'all',
  watchlistSort: 'added',
  revealedSpoilers: new Set()
};

export function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function formatStars(rating) {
  const num = Number(rating) || 0;
  const full = Math.floor(num);
  const half = num % 1 >= 0.5 ? '½' : '';
  return '★'.repeat(full) + half || 'Unrated';
}

function getMediumLabel(type) {
  if (type === 'tv') return 'TV Show';
  if (type === 'book') return 'Book';
  return 'Movie';
}

function getBadgeClass(type) {
  if (type === 'tv') return 'badge-tv';
  if (type === 'book') return 'badge-book';
  return 'badge-movie';
}

function findMedia(mediaId) {
  return (
    state.catalog.find((m) => m.id === mediaId) ||
    uiState.externalResults.find((m) => m.id === mediaId) ||
    null
  );
}

function normalizeTitleKey(title = '') {
  return String(title).trim().toLowerCase().replace(/\s+/g, ' ');
}

function findOrMergeCatalogItem(mediaItemOrId) {
  if (!mediaItemOrId) return null;
  const mediaItem = typeof mediaItemOrId === 'string' ? findMedia(mediaItemOrId) : mediaItemOrId;
  if (!mediaItem) return null;

  let existing = state.catalog.find((c) => c.id === mediaItem.id);
  if (!existing && mediaItem.title && mediaItem.type) {
    const normTitle = normalizeTitleKey(mediaItem.title);
    existing = state.catalog.find(
      (c) =>
        c.type === mediaItem.type &&
        normalizeTitleKey(c.title) === normTitle &&
        (!mediaItem.year || !c.year || Math.abs(Number(c.year) - Number(mediaItem.year)) <= 1)
    );
  }
  if (existing) {
    return existing;
  }
  state.catalog.unshift(mediaItem);
  return mediaItem;
}

function getTvEpisodesPerSeason(mediaItem = {}) {
  if (Array.isArray(mediaItem.episodesPerSeason) && mediaItem.episodesPerSeason.length > 0) {
    return mediaItem.episodesPerSeason.map((n) => Math.max(1, Math.round(Number(n) || 10)));
  }
  const seasons = Math.max(1, Math.round(Number(mediaItem.seasonsCount) || 1));
  const totalEps = Math.max(seasons, Math.round(Number(mediaItem.episodesCount) || seasons * 10));
  const perSeason = Math.max(1, Math.round(totalEps / seasons));
  return Array.from({ length: seasons }, () => perSeason);
}

function computeTvProgressPercent(season, episode, epsPerSeason, status) {
  if (status === 'completed') return 100;
  const s = Math.max(1, Math.round(Number(season) || 1));
  const e = Math.max(1, Math.round(Number(episode) || 1));
  const maxEpInSeason = epsPerSeason[s - 1] || epsPerSeason[epsPerSeason.length - 1] || 10;
  return Math.min(100, Math.max(1, Math.round((e / maxEpInSeason) * 100)));
}

function recalculateClientMediaStats(mediaId) {
  if (!mediaId) return;
  const item = state.catalog.find((c) => c.id === mediaId);
  if (!item) return;

  const seedItem = INITIAL_CATALOG.find((s) => s.id === mediaId);
  const seedLogs = INITIAL_LOGS.filter((l) => l.mediaId === mediaId && Number(l.rating) > 0);
  const currentLogs = (state.logs || []).filter((l) => l.mediaId === mediaId && Number(l.rating) > 0);

  if (seedItem) {
    const seedLogSum = seedLogs.reduce((acc, l) => acc + Number(l.rating), 0);
    const baseCount = Math.max(0, (Number(seedItem.ratingsCount) || 100) - seedLogs.length);
    const baseWeightedSum =
      (Number(seedItem.communityRating) || 4.3) * (Number(seedItem.ratingsCount) || 100) - seedLogSum;

    const currentLogSum = currentLogs.reduce((acc, l) => acc + Number(l.rating), 0);
    const effectiveUserWeight = Math.max(1, Math.round(baseCount * 0.15));
    const deltaLogs = currentLogs.length - seedLogs.length;

    if (currentLogs.length === seedLogs.length && Math.abs(currentLogSum - seedLogSum) < 0.001) {
      item.communityRating = seedItem.communityRating;
      item.ratingsCount = seedItem.ratingsCount;
    } else if (currentLogs.length > 0) {
      const blended =
        (baseWeightedSum + currentLogSum * effectiveUserWeight) /
        (baseCount + currentLogs.length * effectiveUserWeight);
      item.communityRating = Number(Math.min(5.0, Math.max(0.5, blended)).toFixed(1));
      item.ratingsCount = Math.max(1, (Number(seedItem.ratingsCount) || 100) + deltaLogs);
    } else {
      item.communityRating = seedItem.communityRating;
      item.ratingsCount = Math.max(1, baseCount);
    }
  } else if (currentLogs.length > 0) {
    const sum = currentLogs.reduce((acc, l) => acc + Number(l.rating), 0);
    item.communityRating = Number((sum / currentLogs.length).toFixed(1));
    item.ratingsCount = currentLogs.length;
  }
}

function showToast(message) {
  const region = document.getElementById('toastRegion');
  if (!region) return;
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  region.appendChild(toast);
  setTimeout(() => {
    toast.remove();
  }, 3200);
}

function saveLocalState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (err) {
    console.warn('localStorage write error:', err);
  }
}

function getPosterFallbackUrl(media) {
  if (!media) return '';
  return (
    media.fallbackPosterUrl ||
    buildPosterUrl(media.id, media.title, media.creator, media.year, media.type)
  );
}

function isInProgressStatus(status) {
  return status === 'watching' || status === 'reading' || status === 'in_progress';
}

function upgradeCatalogPosters(catalog) {
  if (!Array.isArray(catalog)) return catalog;
  return catalog.map((item) => {
    const seed = INITIAL_CATALOG.find((s) => s.id === item.id);
    if (seed && seed.posterUrl) {
      return {
        ...item,
        posterUrl: seed.posterUrl,
        fallbackPosterUrl: seed.fallbackPosterUrl,
        pagesCount: seed.pagesCount || item.pagesCount,
        seasonsCount: seed.seasonsCount || item.seasonsCount,
        episodesCount: seed.episodesCount || item.episodesCount,
        episodesPerSeason: seed.episodesPerSeason || item.episodesPerSeason,
        crossMediaLinks: seed.crossMediaLinks || item.crossMediaLinks
      };
    }
    return item;
  });
}

export function getCrossMediaRecommendations(item, catalog = state.catalog) {
  if (!item) return [];
  const pool = Array.isArray(catalog) && catalog.length > 0 ? catalog : INITIAL_CATALOG;
  const resolved = [];
  const seenIds = new Set([item.id]);

  // 1. Resolve curated crossMediaLinks first
  const explicitLinks = Array.isArray(item.crossMediaLinks)
    ? item.crossMediaLinks
    : INITIAL_CATALOG.find((s) => s.id === item.id)?.crossMediaLinks || [];

  for (const link of explicitLinks) {
    if (!link || !link.targetId || seenIds.has(link.targetId)) continue;
    const target =
      pool.find((c) => c.id === link.targetId) ||
      INITIAL_CATALOG.find((c) => c.id === link.targetId);
    if (target) {
      seenIds.add(target.id);
      const isAdaptation = Boolean(link.isAdaptation || link.relationType === 'adaptation');
      const relationType = link.relationType || (isAdaptation ? 'adaptation' : 'companion');
      const relationLabel =
        link.relationLabel ||
        link.relation ||
        (isAdaptation ? 'Adaptation / Source Material' : `Related ${getMediumLabel(target.type)}`);
      resolved.push({
        target,
        targetId: target.id,
        relationType,
        relationLabel,
        relation: relationLabel,
        isAdaptation
      });
    }
  }

  // 2. Dynamic cross-media fallback for live-imported items or partial lists
  if (resolved.length < 4) {
    const itemGenres = new Set((item.genres || []).map((g) => String(g).toLowerCase()));
    const scored = pool
      .filter((c) => c && c.id && !seenIds.has(c.id))
      .map((candidate) => {
        const sharedGenres = (candidate.genres || []).filter((g) =>
          itemGenres.has(String(g).toLowerCase())
        );
        const crossMediumBonus = candidate.type !== item.type ? 10 : 0;
        const score =
          crossMediumBonus +
          sharedGenres.length * 3 +
          (Number(candidate.communityRating) || 4.0);
        const sharedLabel = sharedGenres[0] ? `${sharedGenres[0]} ` : '';
        const medSuffix =
          candidate.type === 'book' ? 'Book' : candidate.type === 'tv' ? 'TV' : 'Film';
        return {
          candidate,
          score,
          relationType: candidate.type !== item.type ? 'companion' : 'thematic',
          relationLabel: `Shared ${sharedLabel}Pick · ${medSuffix}`
        };
      })
      .sort((a, b) => b.score - a.score);

    for (const entry of scored) {
      if (resolved.length >= 4) break;
      seenIds.add(entry.candidate.id);
      resolved.push({
        target: entry.candidate,
        targetId: entry.candidate.id,
        relationType: entry.relationType,
        relationLabel: entry.relationLabel,
        relation: entry.relationLabel,
        isAdaptation: false
      });
    }
  }

  return resolved.slice(0, 4);
}

function upgradeUsersAndSocialGraph(currentState = state) {
  if (!currentState) return currentState;
  currentState.users =
    currentState.users && typeof currentState.users === 'object' ? currentState.users : {};
  for (const [uid, existing] of Object.entries(currentState.users)) {
    if (!existing) continue;
    currentState.users[uid] = {
      ...existing,
      id: existing.id || uid,
      avatar: existing.avatar || deriveClientInitials(existing.name || 'Member'),
      avatarColor: existing.avatarColor || '#10b981',
      joinedYear: existing.joinedYear || new Date().getFullYear(),
      followingIds: Array.isArray(existing.followingIds) ? existing.followingIds : [],
      watchlist: Array.isArray(existing.watchlist) ? existing.watchlist : [],
      favorites:
        existing.favorites &&
        Array.isArray(existing.favorites.movie) &&
        existing.favorites.movie.length > 0
          ? existing.favorites
          : {
              movie: ['movie-101', 'movie-102', 'movie-104', 'movie-108'],
              tv: ['tv-201', 'tv-202', 'tv-204', 'tv-207'],
              book: ['book-301', 'book-302', 'book-305', 'book-308']
            }
    };
  }
  if (currentState.currentUserId && !currentState.users[currentState.currentUserId]) {
    currentState.currentUserId = null;
  }
  const activeUser = currentState.currentUserId
    ? currentState.users[currentState.currentUserId]
    : null;
  if (activeUser) {
    uiState.isSignedOut = false;
    if (!Array.isArray(currentState.watchlist) || currentState.watchlist.length === 0) {
      currentState.watchlist = [...(activeUser.watchlist || [])];
    } else {
      activeUser.watchlist = [...currentState.watchlist];
    }
  } else {
    currentState.currentUserId = null;
    currentState.watchlist = [];
    uiState.isSignedOut = true;
  }
  return currentState;
}

function upgradeInProgressLogs(currentState = state) {
  if (!currentState || !Array.isArray(currentState.logs)) return currentState;

  currentState.logs.forEach((log) => {
    if (log.progress && log.progress.status === 'in_progress') {
      log.progress.status = log.mediaType === 'book' ? 'reading' : 'watching';
    }
    if (log.mediaType === 'book' && log.progress && log.progress.currentPage !== undefined) {
      const tot = Math.max(1, Number(log.progress.totalPages) || 416);
      const cur = Math.max(0, Math.min(tot, Number(log.progress.currentPage) || 0));
      log.progress.percent = Math.min(100, Math.round((cur / tot) * 100));
    }
  });

  currentState.inProgressSeededV1 = true;
  currentState.friendLogsSeededV1 = true;
  return currentState;
}

async function syncWithServer() {
  try {
    localStorage.removeItem('omnilog_state_v1');
    localStorage.removeItem('omnilog_state_clean_v1');
  } catch {
    // ignore storage access issues
  }
  try {
    const res = await fetch('/api/state');
    if (res.ok) {
      const serverState = await res.json();
      if (serverState && Array.isArray(serverState.catalog)) {
        serverState.catalog = upgradeCatalogPosters(serverState.catalog);
        upgradeUsersAndSocialGraph(serverState);
        upgradeInProgressLogs(serverState);
        state = serverState;
        if (!state.currentUserId || !state.users?.[state.currentUserId]) {
          state.currentUserId = null;
          uiState.isSignedOut = true;
          try {
            localStorage.removeItem('omnilog_session_token');
          } catch {
            // ignore
          }
        } else {
          uiState.isSignedOut = false;
        }
        saveLocalState();
        renderAll();
        return;
      }
    }
  } catch {
    // Fallback to localStorage if offline
  }

  try {
    const cached = localStorage.getItem(STORAGE_KEY);
    if (cached) {
      const parsed = JSON.parse(cached);
      if (parsed && Array.isArray(parsed.catalog)) {
        parsed.catalog = upgradeCatalogPosters(parsed.catalog);
        upgradeUsersAndSocialGraph(parsed);
        upgradeInProgressLogs(parsed);
        state = parsed;
        saveLocalState();
      }
    }
  } catch {
    // keep default seed
  }
  renderAll();
}

// ==================== MANDATORY MWG LIGHT-DISMISS FALLBACK ====================
function initDialogLightDismissFallbacks() {
  const dialogs = document.querySelectorAll('dialog');
  dialogs.forEach((dialog) => {
    // Fallback for browsers without closedby support (MWG light-dismiss-a-dialog)
    if (!('closedBy' in HTMLDialogElement.prototype)) {
      dialog.addEventListener('click', (event) => {
        if (event.target !== dialog) return;
        const rect = dialog.getBoundingClientRect();
        const isDialogContent =
          rect.top <= event.clientY &&
          event.clientY <= rect.top + rect.height &&
          rect.left <= event.clientX &&
          event.clientX <= rect.left + rect.width;

        if (isDialogContent) return;
        dialog.close();
      });
    }
  });
}

// ==================== MWG CARD RENDERER (`<article class="card">`) ====================
function renderMediaCard(item, options = {}) {
  const inWatchlist = state.watchlist.includes(item.id);
  const myLog = state.logs.find(
    (l) => l.userId === state.currentUserId && l.mediaId === item.id
  );
  const fallbackUrl =
    item.fallbackPosterUrl ||
    buildPosterUrl(item.id, item.title, item.creator, item.year, item.type);

  const metaRuntimeOrPages =
    item.type === 'movie' && item.runtimeMinutes
      ? `${item.runtimeMinutes}m`
      : item.type === 'tv' && item.seasonsCount
      ? `${item.seasonsCount} Season${item.seasonsCount > 1 ? 's' : ''}`
      : item.type === 'book' && item.pagesCount
      ? `${item.pagesCount} pages`
      : '';

  const hasDirectAdaptation = (item.crossMediaLinks || []).some(
    (l) => l.isAdaptation || l.relationType === 'adaptation'
  );
  const adaptationPillHtml = hasDirectAdaptation
    ? `<span class="genre-tag adaptation-pill" title="Has Cross-Media Adaptation / Source Material">⇄ Adaptation</span>`
    : '';
  const genreTagsHtml =
    (item.genres || [])
      .slice(0, hasDirectAdaptation ? 1 : 2)
      .map((g) => `<span class="genre-tag">${escapeHtml(g)}</span>`)
      .join('') + adaptationPillHtml;

  const loggedPillHtml = myLog
    ? `<span class="user-logged-pill" title="You logged this">${formatStars(myLog.rating)} ${myLog.liked ? '♥' : ''}</span>`
    : '';

  const rankBadgeHtml =
    options.rank !== undefined
      ? `<span class="medium-badge badge-book">#${Number(options.rank)}</span>`
      : '';

  // Strictly follows MWG `card`:
  // <article class="card"> with 4 direct region children:
  // 1. <img> (Media)
  // 2. <header> with <h3><a class="card-link"> (Header)
  // 3. <div> (Content)
  // 4. <footer> (Footer with independent buttons)
  return `
    <article class="card" data-media-id="${escapeHtml(item.id)}" data-media-type="${escapeHtml(item.type)}">
      <img
        src="${escapeHtml(item.posterUrl)}"
        alt="${escapeHtml(item.title)} poster"
        width="300"
        height="450"
        loading="lazy"
        onerror="this.onerror=null;this.src='${escapeHtml(fallbackUrl)}';"
      />
      <header>
        <div class="card-meta-top">
          <span>
            ${rankBadgeHtml}
            <span class="medium-badge ${getBadgeClass(item.type)}">${escapeHtml(getMediumLabel(item.type))}</span>
          </span>
          <span>${escapeHtml(item.year || '')}</span>
        </div>
        <h3>
          <a href="#detail-${escapeHtml(item.id)}" class="card-link" data-open-detail="${escapeHtml(item.id)}">
            ${escapeHtml(item.title)}
          </a>
        </h3>
      </header>
      <div>
        <p class="card-creator">${escapeHtml(item.creator)}${metaRuntimeOrPages ? ` · ${escapeHtml(metaRuntimeOrPages)}` : ''}</p>
        <div class="genre-row">${genreTagsHtml}</div>
        <div class="card-rating-row">
          <span class="community-star" title="Community Rating">★ ${Number(item.communityRating || 4.2).toFixed(1)}</span>
          ${loggedPillHtml}
        </div>
      </div>
      <footer>
        <button type="button" class="btn btn-primary btn-sm" data-quick-log="${escapeHtml(item.id)}">
          ${myLog ? 'Log Again' : '+ Log'}
        </button>
        <button type="button" class="btn ${inWatchlist ? 'btn-secondary' : 'btn-ghost'} btn-sm" data-toggle-watchlist="${escapeHtml(item.id)}">
          ${inWatchlist ? '✓ In Watchlist' : '+ Watchlist'}
        </button>
      </footer>
    </article>
  `;
}

// ==================== RENDER ALL VIEWS ====================
function renderCurrentlyCard(log, options = {}) {
  const item = findMedia(log.mediaId);
  if (!item) return '';
  const fallbackUrl = getPosterFallbackUrl(item);
  const readOnly = Boolean(options.readOnly);

  let progressBadgeText = '';
  let progressPct = 50;
  let bumpAction = '';
  let bumpLabel = '';

  if (item.type === 'tv') {
    const epsPerSeason = getTvEpisodesPerSeason(item);
    const season = Math.max(1, Number(log.progress?.season) || 1);
    const episode = Math.max(1, Number(log.progress?.episode) || 1);
    const maxEpInSeason = epsPerSeason[season - 1] || epsPerSeason[epsPerSeason.length - 1] || 10;
    progressPct =
      log.progress?.percent !== undefined
        ? Number(log.progress.percent)
        : computeTvProgressPercent(season, episode, epsPerSeason, log.progress?.status);
    progressBadgeText = `Watching · S${season} · E${episode}/${maxEpInSeason}`;
    bumpAction = 'increment_episode';
    bumpLabel = '+1 Ep';
  } else {
    const cur = Number(log.progress?.currentPage) || 1;
    const tot = Number(log.progress?.totalPages) || Number(item.pagesCount) || 400;
    progressPct =
      log.progress?.percent !== undefined
        ? Number(log.progress.percent)
        : Math.min(100, Math.round((cur / tot) * 100));
    progressBadgeText = `Reading · ${cur} / ${tot} pp (${progressPct}%)`;
    bumpAction = 'increment_pages';
    bumpLabel = '+25 pp';
  }

  const inWatchlist = state.watchlist.includes(item.id);
  const footerButtonsHtml = readOnly
    ? `
        <button type="button" class="btn btn-primary btn-sm" data-quick-log="${escapeHtml(item.id)}">
          + Log
        </button>
        <button type="button" class="btn btn-secondary btn-sm" data-toggle-watchlist="${escapeHtml(item.id)}">
          ${inWatchlist ? '✓ In List' : '+ Watchlist'}
        </button>
        <button type="button" class="btn btn-ghost btn-sm" data-open-detail="${escapeHtml(item.id)}">
          Details
        </button>
      `
    : `
        <button type="button" class="btn btn-primary btn-sm" data-bump-progress="${escapeHtml(log.id)}" data-bump-action="${bumpAction}">
          ${bumpLabel}
        </button>
        <button type="button" class="btn btn-secondary btn-sm" data-finish-progress="${escapeHtml(log.id)}">
          ✓ Finish
        </button>
        <button type="button" class="btn btn-ghost btn-sm" data-edit-log="${escapeHtml(log.id)}">
          Edit
        </button>
      `;

  // Strictly follows MWG `card`:
  // <article class="card currently-card"> with 4 direct region children:
  // 1. <img> (Media)
  // 2. <header> with <h3><a class="card-link"> (Header)
  // 3. <div> (Content with native <progress>)
  // 4. <footer> (Footer with independent buttons)
  return `
    <article class="card currently-card" data-log-id="${escapeHtml(log.id)}" data-media-id="${escapeHtml(item.id)}" data-media-type="${escapeHtml(item.type)}">
      <img
        src="${escapeHtml(item.posterUrl)}"
        alt="${escapeHtml(item.title)} poster"
        width="300"
        height="450"
        loading="lazy"
        onerror="this.onerror=null;this.src='${escapeHtml(fallbackUrl)}';"
      />
      <header>
        <div class="card-meta-top">
          <span class="medium-badge ${getBadgeClass(item.type)}">${escapeHtml(getMediumLabel(item.type))}</span>
          <span>${escapeHtml(item.year || '')}</span>
        </div>
        <h3>
          <a href="#detail-${escapeHtml(item.id)}" class="card-link" data-open-detail="${escapeHtml(item.id)}">
            ${escapeHtml(item.title)}
          </a>
        </h3>
      </header>
      <div>
        <p class="card-creator">${escapeHtml(item.creator)}</p>
        <div class="currently-progress-box">
          <div class="currently-progress-meta">
            <span>${escapeHtml(progressBadgeText)}</span>
            <span>${progressPct}%</span>
          </div>
          <progress max="100" value="${progressPct}">${progressPct}%</progress>
        </div>
      </div>
      <footer>
        ${footerButtonsHtml}
      </footer>
    </article>
  `;
}

function renderCurrentlyWatchingShelf() {
  const exploreGrid = document.getElementById('currentlyTrackingGrid');
  const exploreCountLabel = document.getElementById('currentlyTrackingCountLabel');
  const profileGrid = document.getElementById('profileCurrentlyGrid');

  const allActiveLogs = state.logs.filter(
    (l) =>
      l.userId === state.currentUserId &&
      l.progress &&
      isInProgressStatus(l.progress.status) &&
      (l.mediaType === 'tv' || l.mediaType === 'book')
  );

  if (exploreGrid) {
    const filteredForExplore = allActiveLogs.filter((l) =>
      uiState.exploreType === 'all' ? true : l.mediaType === uiState.exploreType
    );

    if (exploreCountLabel) {
      exploreCountLabel.textContent = `${filteredForExplore.length} active title${filteredForExplore.length === 1 ? '' : 's'} in progress — use +1 Ep or +25 pp to update instantly`;
    }

    if (filteredForExplore.length === 0) {
      exploreGrid.innerHTML = `
        <div class="stat-breakdown-card" style="grid-column: 1 / -1; text-align: center;">
          <h3>Nothing in progress right now</h3>
          <p class="section-sub">Open any TV show or book and click "Start Watching" or "Start Reading" to keep track of it here.</p>
        </div>
      `;
    } else {
      exploreGrid.innerHTML = filteredForExplore.map((log) => renderCurrentlyCard(log)).join('');
    }
  }

  if (profileGrid) {
    const profileUserId =
      uiState.viewingUserId && state.users[uiState.viewingUserId]
        ? uiState.viewingUserId
        : state.currentUserId;
    const isOwnProfile = profileUserId === state.currentUserId;
    const profileActiveLogs = state.logs.filter(
      (l) =>
        l.userId === profileUserId &&
        l.progress &&
        isInProgressStatus(l.progress.status) &&
        (l.mediaType === 'tv' || l.mediaType === 'book')
    );

    if (profileActiveLogs.length === 0) {
      profileGrid.innerHTML = `
        <div class="stat-breakdown-card" style="grid-column: 1 / -1; text-align: center;">
          <h3>Nothing in progress right now</h3>
          <p class="section-sub">${isOwnProfile ? 'Start watching a show or reading a book from Explore to track your progress here.' : 'No shows or books in progress right now.'}</p>
        </div>
      `;
    } else {
      profileGrid.innerHTML = profileActiveLogs
        .map((log) => renderCurrentlyCard(log, { readOnly: !isOwnProfile }))
        .join('');
    }
  }
}

function renderHeaderUserControls() {
  const container = document.getElementById('headerUserControls');
  if (!container) return;
  const activeUser = state.currentUserId ? state.users?.[state.currentUserId] : null;

  if (uiState.isSignedOut || !activeUser) {
    const defaultAuthMode = Object.keys(state.users || {}).length === 0 ? 'create' : 'login';
    container.innerHTML = `
      <button
        type="button"
        class="btn btn-secondary btn-sm header-account-pill"
        id="openAuthModalBtn"
        data-open-user-modal="${defaultAuthMode}"
        title="Sign in or create account"
      >
        Sign in
      </button>
    `;
    return;
  }

  const firstName = (activeUser.name || 'Account').split(' ')[0];
  container.innerHTML = `
    <button
      type="button"
      class="header-account-pill"
      id="openEditProfileBtn"
      data-open-user-modal="edit"
      title="Edit profile (${escapeHtml(activeUser.name)})"
    >
      <span
        class="avatar-circle avatar-sm"
        id="headerUserBadge"
        style="background:${escapeHtml(activeUser.avatarColor || '#10b981')}"
      >
        ${escapeHtml(activeUser.avatar || 'JC')}
      </span>
      <span class="header-user-name" id="headerUserName">${escapeHtml(firstName)}</span>
    </button>
  `;
}

function renderFriendsDirectory() {
  const feedDir = document.getElementById('feedFriendsDirectory');
  const profileDir = document.getElementById('profileFriendsDirectory');
  if (!feedDir && !profileDir) return;

  const currentUser = state.users[state.currentUserId] || {};
  const followingSet = new Set(Array.isArray(currentUser.followingIds) ? currentUser.followingIds : []);
  const viewedUserId =
    uiState.viewingUserId && state.users[uiState.viewingUserId]
      ? uiState.viewingUserId
      : state.currentUserId;

  const usersList = Object.values(state.users);
  const cardsHtml =
    usersList.length === 0
      ? `
        <div class="stat-breakdown-card" style="grid-column: 1 / -1; text-align: center;">
          <h3>No members yet</h3>
          <p class="section-sub">Create your account to start logging what you watch and read with friends.</p>
          <div style="margin-top:0.75rem;display:flex;gap:0.5rem;justify-content:center;flex-wrap:wrap;">
            <button type="button" class="btn btn-primary btn-sm" data-open-user-modal="create">Create account</button>
            <button type="button" class="btn btn-secondary btn-sm" data-open-user-modal="login">Sign in</button>
          </div>
        </div>
      `
      : usersList
          .map((u) => {
            const userLogsCount = state.logs.filter((l) => l.userId === u.id).length;
            const isMe = u.id === state.currentUserId;
            const isViewed = u.id === viewedUserId && uiState.activeView === 'profile';
            const isFollowing = followingSet.has(u.id);

            return `
        <div class="friend-member-card ${isViewed ? 'is-viewed-member' : ''}" data-member-card="${escapeHtml(u.id)}">
          <button
            type="button"
            class="friend-member-main"
            data-view-user="${escapeHtml(u.id)}"
            title="View ${escapeHtml(u.name)}'s Profile"
          >
            <span class="avatar-circle" style="background:${escapeHtml(u.avatarColor || '#10b981')}">${escapeHtml(u.avatar || 'MB')}</span>
            <span class="friend-member-info">
              <strong>${escapeHtml(u.name)} ${isMe ? '<span class="you-badge">YOU</span>' : ''}</strong>
              <span class="section-sub">${escapeHtml(u.handle)} · ${userLogsCount} log${userLogsCount === 1 ? '' : 's'}</span>
            </span>
          </button>
          <div class="friend-member-actions">
            ${
              isMe
                ? `<button type="button" class="btn btn-ghost btn-sm" data-open-user-modal="edit">Edit</button>`
                : `<button type="button" class="btn ${isFollowing ? 'btn-secondary' : 'btn-ghost'} btn-sm" data-toggle-follow="${escapeHtml(u.id)}">
                     ${isFollowing ? 'Following' : 'Follow'}
                   </button>`
            }
            <button type="button" class="btn btn-ghost btn-sm" data-view-user="${escapeHtml(u.id)}">
              Profile
            </button>
          </div>
        </div>
      `;
          })
          .join('');

  const stripHtml = `
    <div class="family-friends-header">
      <div>
        <p class="eyebrow">People (${usersList.length})</p>
        <p class="section-sub">See what everyone is watching and reading.</p>
      </div>
      <button type="button" class="btn btn-secondary btn-sm" data-open-user-modal="create">
        Add person
      </button>
    </div>
    <div class="family-friends-grid">
      ${cardsHtml}
    </div>
  `;

  if (feedDir) feedDir.innerHTML = stripHtml;
  if (profileDir) profileDir.innerHTML = stripHtml;
}

function renderAll() {
  renderHeaderUserControls();
  renderNavCounts();
  renderHeroQuickStats();
  renderCurrentlyWatchingShelf();
  renderExploreCatalog();
  renderExternalResults();
  renderFriendsDirectory();
  renderActivityFeed();
  renderDiary();
  renderWatchlist();
  renderLists();
  renderProfile();
}

function renderNavCounts() {
  const myLogs = state.logs.filter((l) => l.userId === state.currentUserId);
  const diaryCountEl = document.getElementById('navDiaryCount');
  const watchlistCountEl = document.getElementById('navWatchlistCount');
  if (diaryCountEl) diaryCountEl.textContent = String(myLogs.length);
  if (watchlistCountEl) watchlistCountEl.textContent = String(state.watchlist.length);
}

function renderHeroQuickStats() {
  const container = document.getElementById('heroQuickStats');
  if (!container) return;
  const myLogs = state.logs.filter((l) => l.userId === state.currentUserId);
  const moviesCount = myLogs.filter((l) => l.mediaType === 'movie').length;
  const tvCount = myLogs.filter((l) => l.mediaType === 'tv').length;
  const booksCount = myLogs.filter((l) => l.mediaType === 'book').length;

  container.innerHTML = `
    <div class="mini-stat">
      <strong>${moviesCount}</strong>
      <span>Movies</span>
    </div>
    <div class="mini-stat">
      <strong>${tvCount}</strong>
      <span>TV Shows</span>
    </div>
    <div class="mini-stat">
      <strong>${booksCount}</strong>
      <span>Books</span>
    </div>
    <div class="mini-stat">
      <strong>${state.watchlist.length}</strong>
      <span>Watchlist</span>
    </div>
  `;
}

function renderExploreCatalog() {
  const grid = document.getElementById('catalogGrid');
  const countLabel = document.getElementById('catalogCountLabel');
  if (!grid) return;

  const q = uiState.exploreQuery.trim().toLowerCase();
  let items = state.catalog.filter((item) => {
    if (uiState.exploreType !== 'all' && item.type !== uiState.exploreType) return false;
    if (
      uiState.exploreGenre !== 'all' &&
      !(item.genres || []).some((g) => g.toLowerCase() === uiState.exploreGenre.toLowerCase())
    ) {
      return false;
    }
    if (q) {
      const hay = `${item.title} ${item.creator} ${item.year} ${(item.genres || []).join(' ')}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  if (uiState.exploreSort === 'rating') {
    items.sort((a, b) => (b.communityRating || 0) - (a.communityRating || 0));
  } else if (uiState.exploreSort === 'newest') {
    items.sort((a, b) => (b.year || 0) - (a.year || 0));
  } else if (uiState.exploreSort === 'oldest') {
    items.sort((a, b) => (a.year || 0) - (b.year || 0));
  } else if (uiState.exploreSort === 'title') {
    items.sort((a, b) => a.title.localeCompare(b.title));
  } else {
    items.sort((a, b) => (b.ratingsCount || 0) - (a.ratingsCount || 0));
  }

  if (countLabel) {
    countLabel.textContent = `Showing ${items.length} title${items.length === 1 ? '' : 's'} across Movies, TV Shows, and Books`;
  }

  if (items.length === 0) {
    grid.innerHTML = `
      <div class="stat-breakdown-card" style="grid-column: 1 / -1; text-align: center;">
        <h3>No matching titles in local catalog</h3>
        <p class="section-sub">Click "Search More Online" above to search iTunes Movies, TVMaze, and Open Library live!</p>
      </div>
    `;
    return;
  }

  grid.innerHTML = items.map((item) => renderMediaCard(item)).join('');
}

function renderExternalResults() {
  const panel = document.getElementById('externalResultsPanel');
  const grid = document.getElementById('externalCardsGrid');
  if (!panel || !grid) return;

  if (!uiState.externalResults || uiState.externalResults.length === 0) {
    panel.classList.add('hidden');
    grid.innerHTML = '';
    return;
  }

  panel.classList.remove('hidden');
  grid.innerHTML = uiState.externalResults.map((item) => renderMediaCard(item)).join('');
}

function formatProgressBadge(log) {
  if (!log.progress) return '';
  if (log.mediaType === 'tv' && (log.progress.season || log.progress.episode)) {
    const s = log.progress.season || 1;
    const e = log.progress.episode || 1;
    const statusText = isInProgressStatus(log.progress.status) ? 'Watching' : 'Completed';
    return `<span class="progress-pill">S${s} · E${e} (${escapeHtml(statusText)})</span>`;
  }
  if (log.mediaType === 'book' && log.progress.currentPage) {
    const cur = Number(log.progress.currentPage) || 0;
    const tot = Number(log.progress.totalPages) || cur || 1;
    const pct = Math.min(100, Math.round((cur / tot) * 100));
    const statusSuffix = isInProgressStatus(log.progress.status) ? ' · Reading' : '';
    return `<span class="progress-pill">p. ${cur}/${tot} (${pct}%${statusSuffix})</span>`;
  }
  if (log.mediaType === 'movie' && log.progress.format) {
    return `<span class="progress-pill">${escapeHtml(log.progress.format)}</span>`;
  }
  return '';
}

function renderActivityFeed() {
  const container = document.getElementById('activityFeedContainer');
  if (!container) return;

  const activeUser = state.users[state.currentUserId] || {};
  const followingSet = new Set([
    state.currentUserId,
    ...(Array.isArray(activeUser.followingIds) ? activeUser.followingIds : [])
  ]);

  const filtered = state.logs.filter((log) => {
    if (uiState.feedType !== 'all' && log.mediaType !== uiState.feedType) return false;
    if (uiState.feedScope === 'following' && !followingSet.has(log.userId)) return false;
    return true;
  });

  if (filtered.length === 0) {
    container.innerHTML = `
      <div class="stat-breakdown-card" style="text-align: center;">
        <h3>Quiet in here so far</h3>
        <p class="section-sub">When you or your friends log a film, show, or book, your notes and ratings will show up here.</p>
        <div style="margin-top:0.75rem;display:flex;gap:0.5rem;justify-content:center;flex-wrap:wrap;">
          <button type="button" class="btn btn-primary btn-sm" data-open-user-modal="create">Create account</button>
          <button type="button" class="btn btn-secondary btn-sm" data-open-user-modal="login">Sign in</button>
        </div>
      </div>
    `;
    return;
  }

  container.innerHTML = filtered
    .map((log) => {
      const user = state.users[log.userId] || {
        id: log.userId,
        name: 'Member',
        handle: '@member',
        avatar: 'MB',
        avatarColor: '#10b981'
      };
      const media = findMedia(log.mediaId) || {
        id: log.mediaId,
        title: 'Logged Title',
        year: 2024,
        type: log.mediaType || 'movie',
        posterUrl: buildPosterUrl(log.mediaId, 'Logged Title', '', 2024, log.mediaType || 'movie')
      };

      const actionVerb = log.isRewatch
        ? log.mediaType === 'book'
          ? 'reread'
          : 'rewatched'
        : log.mediaType === 'book'
        ? 'read'
        : 'watched';

      const isSpoilerHidden = log.containsSpoilers && !uiState.revealedSpoilers.has(log.id);
      const reviewSectionHtml = log.review
        ? isSpoilerHidden
          ? `
            <div class="spoiler-shield">
              <span>⚠️ This review contains spoilers for <strong>${escapeHtml(media.title)}</strong>.</span>
              <button type="button" class="btn btn-secondary btn-sm" data-reveal-spoiler="${escapeHtml(log.id)}">
                Reveal Spoiler
              </button>
            </div>
          `
          : `<p class="feed-review-text">${escapeHtml(log.review)}</p>`
        : '';

      const comments = Array.isArray(log.comments) ? log.comments : [];
      const commentsHtml = comments
        .map(
          (c) => `
          <div class="comment-item">
            <a href="#user-${escapeHtml(c.userId || '')}" class="user-profile-link" data-view-user="${escapeHtml(c.userId || '')}">
              <strong>${escapeHtml(c.userName || c.userHandle)}</strong>
            </a>
            <span class="section-sub">(${escapeHtml(c.userHandle || '')})</span>:
            ${escapeHtml(c.text)}
          </div>
        `
        )
        .join('');

      return `
        <article class="feed-card" data-log-id="${escapeHtml(log.id)}">
          <img
            src="${escapeHtml(media.posterUrl)}"
            alt="${escapeHtml(media.title)} poster"
            class="feed-poster"
            width="92"
            height="138"
            data-open-detail="${escapeHtml(media.id)}"
            onerror="this.onerror=null;this.src='${escapeHtml(getPosterFallbackUrl(media))}';"
          />
          <div>
            <div class="feed-header">
              <button
                type="button"
                class="user-chip user-chip-btn"
                data-view-user="${escapeHtml(log.userId)}"
                title="View ${escapeHtml(user.name)}'s Profile"
              >
                <span class="avatar-circle" style="background:${escapeHtml(user.avatarColor || '#10b981')}">${escapeHtml(user.avatar || 'U')}</span>
                <div style="text-align:left;">
                  <strong>${escapeHtml(user.name)}</strong>
                  <span class="section-sub">${escapeHtml(user.handle)} · ${escapeHtml(actionVerb)}</span>
                </div>
              </button>
              <span class="section-sub">${escapeHtml(log.dateConsumed)}</span>
            </div>

            <div class="feed-title-line">
              <span class="medium-badge ${getBadgeClass(media.type)}">${escapeHtml(getMediumLabel(media.type))}</span>
              <h3>
                <a href="#detail-${escapeHtml(media.id)}" class="card-link" data-open-detail="${escapeHtml(media.id)}" style="color:var(--text-primary);text-decoration:none;">
                  ${escapeHtml(media.title)} (${escapeHtml(media.year || '')})
                </a>
              </h3>
              <span class="star-display" title="${Number(log.rating).toFixed(1)} out of 5 stars">${formatStars(log.rating)} (${Number(log.rating).toFixed(1)})</span>
              ${log.liked ? '<span style="color:var(--heart-rose)" title="Liked">♥</span>' : ''}
              ${log.isRewatch ? '<span class="genre-tag" title="Rewatch / Reread">↻ Revisit</span>' : ''}
              ${formatProgressBadge(log)}
            </div>

            ${reviewSectionHtml}

            <div class="feed-actions-bar">
              <button type="button" class="btn ${log.likedByMe ? 'btn-secondary' : 'btn-ghost'} btn-sm" data-like-log="${escapeHtml(log.id)}">
                ♥ ${Number(log.likesCount || 0)} Like${Number(log.likesCount || 0) === 1 ? '' : 's'}
              </button>
              <span class="section-sub">💬 ${comments.length} Comment${comments.length === 1 ? '' : 's'}</span>
              ${
                log.userId === state.currentUserId
                  ? `<button type="button" class="btn btn-ghost btn-sm" data-edit-log="${escapeHtml(log.id)}">Edit</button>
                     <button type="button" class="btn btn-ghost btn-sm" data-delete-log="${escapeHtml(log.id)}">Delete</button>`
                  : ''
              }
            </div>

            <div class="comments-box">
              <div class="comments-list">${commentsHtml}</div>
              <form class="comment-form" data-comment-form="${escapeHtml(log.id)}">
                <input
                  type="text"
                  name="commentText"
                  placeholder="Add a comment on this review..."
                  aria-label="Add a comment"
                  required
                />
                <button type="submit" class="btn btn-secondary btn-sm">Post</button>
              </form>
            </div>
          </div>
        </article>
      `;
    })
    .join('');
}

function renderDiary() {
  const container = document.getElementById('diaryContainer');
  if (!container) return;

  const q = (uiState.diaryQuery || '').trim().toLowerCase();
  const myLogs = state.logs
    .filter((l) => l.userId === state.currentUserId)
    .filter((l) => (uiState.diaryType === 'all' ? true : l.mediaType === uiState.diaryType))
    .filter((l) => (uiState.diaryLikedOnly ? Boolean(l.liked) : true))
    .filter((l) => {
      if (!q) return true;
      const media = findMedia(l.mediaId) || {};
      const hay = `${media.title || ''} ${media.creator || ''} ${l.review || ''} ${l.dateConsumed || ''}`.toLowerCase();
      return hay.includes(q);
    })
    .sort((a, b) => {
      if (uiState.diarySort === 'oldest') {
        return String(a.dateConsumed || '').localeCompare(String(b.dateConsumed || ''));
      }
      if (uiState.diarySort === 'rating') {
        return (Number(b.rating) || 0) - (Number(a.rating) || 0);
      }
      if (uiState.diarySort === 'title') {
        const mediaA = findMedia(a.mediaId) || {};
        const mediaB = findMedia(b.mediaId) || {};
        return String(mediaA.title || '').localeCompare(String(mediaB.title || ''));
      }
      return String(b.dateConsumed || '').localeCompare(String(a.dateConsumed || ''));
    });

  if (myLogs.length === 0) {
    container.innerHTML = `
      <div style="padding: 2rem; text-align: center;">
        <h3>Your diary is empty</h3>
        <p class="section-sub">Use "+ Log" in the top bar whenever you finish watching or reading something.</p>
      </div>
    `;
    return;
  }

  const rowsHtml = myLogs
    .map((log) => {
      const media = findMedia(log.mediaId) || {
        id: log.mediaId,
        title: 'Logged Media',
        year: 2024,
        type: log.mediaType,
        posterUrl: buildPosterUrl(log.mediaId, 'Logged Media', '', 2024, log.mediaType)
      };

      return `
        <tr data-diary-row="${escapeHtml(log.id)}">
          <td><strong>${escapeHtml(log.dateConsumed)}</strong></td>
          <td>
            <div class="diary-poster-cell">
              <img src="${escapeHtml(media.posterUrl)}" alt="${escapeHtml(media.title)}" class="diary-thumb" width="38" height="57" onerror="this.onerror=null;this.src='${escapeHtml(getPosterFallbackUrl(media))}';" />
              <div>
                <strong>
                  <a href="#detail-${escapeHtml(media.id)}" data-open-detail="${escapeHtml(media.id)}" style="color:var(--text-primary);text-decoration:none;">
                    ${escapeHtml(media.title)}
                  </a>
                </strong>
                <div class="section-sub">${escapeHtml(media.creator || '')} · ${escapeHtml(media.year || '')}</div>
              </div>
            </div>
          </td>
          <td><span class="medium-badge ${getBadgeClass(log.mediaType)}">${escapeHtml(getMediumLabel(log.mediaType))}</span></td>
          <td><span class="star-display">${formatStars(log.rating)}</span> <span class="section-sub">(${Number(log.rating).toFixed(1)})</span></td>
          <td>${formatProgressBadge(log) || '<span class="section-sub">Completed</span>'}</td>
          <td>
            ${log.liked ? '<span style="color:var(--heart-rose)" title="Liked">♥</span> ' : ''}
            ${log.isRewatch ? '<span title="Rewatch / Reread">↻</span> ' : ''}
            ${log.review ? '<span title="Has Review">📝</span>' : ''}
          </td>
          <td>
            <button type="button" class="btn btn-ghost btn-sm" data-edit-log="${escapeHtml(log.id)}">Edit</button>
            <button type="button" class="btn btn-ghost btn-sm" data-delete-log="${escapeHtml(log.id)}">Delete</button>
          </td>
        </tr>
      `;
    })
    .join('');

  container.innerHTML = `
    <table class="diary-table">
      <thead>
        <tr>
          <th>Date</th>
          <th>Title</th>
          <th>Medium</th>
          <th>Rating</th>
          <th>Progress / Format</th>
          <th>Flags</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        ${rowsHtml}
      </tbody>
    </table>
  `;
}

function renderWatchlist() {
  const grid = document.getElementById('watchlistGrid');
  if (!grid) return;

  const items = state.watchlist
    .map((id) => findMedia(id))
    .filter(Boolean)
    .filter((item) => (uiState.watchlistType === 'all' ? true : item.type === uiState.watchlistType));

  if (uiState.watchlistSort === 'rating') {
    items.sort((a, b) => (Number(b.communityRating) || 0) - (Number(a.communityRating) || 0));
  } else if (uiState.watchlistSort === 'year') {
    items.sort((a, b) => (Number(b.year) || 0) - (Number(a.year) || 0));
  } else if (uiState.watchlistSort === 'title') {
    items.sort((a, b) => String(a.title || '').localeCompare(String(b.title || '')));
  }

  if (items.length === 0) {
    grid.innerHTML = `
      <div class="stat-breakdown-card" style="grid-column: 1 / -1; text-align: center;">
        <h3>Nothing saved to your watchlist yet</h3>
        <p class="section-sub">Browse Explore and click "+ Watchlist" on any film, show, or book you want to save for later.</p>
      </div>
    `;
    return;
  }

  grid.innerHTML = items.map((item) => renderMediaCard(item)).join('');
}

function renderLists() {
  const container = document.getElementById('listsContainer');
  if (!container) return;

  if (!Array.isArray(state.lists) || state.lists.length === 0) {
    container.innerHTML = `
      <div class="stat-breakdown-card" style="text-align: center;">
        <h3>No lists yet</h3>
        <p class="section-sub">Put together a ranked or casual list of favorites by clicking "+ New List" above.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = state.lists
    .map((list) => {
      const user = state.users[list.userId] || { name: 'Member', handle: '@member' };
      const listItems = (list.itemIds || []).map((id) => findMedia(id)).filter(Boolean);

      const cardsHtml = listItems
        .map((item, idx) => renderMediaCard(item, { rank: list.isRanked ? idx + 1 : undefined }))
        .join('');

      return `
        <section class="custom-list-block" data-list-id="${escapeHtml(list.id)}">
          <div class="list-header-row">
            <div>
              <p class="eyebrow">${list.isRanked ? 'RANKED COLLECTION' : 'CURATED COLLECTION'} · BY <a href="#user-${escapeHtml(list.userId)}" class="user-profile-link" data-view-user="${escapeHtml(list.userId)}">${escapeHtml(user.handle)}</a></p>
              <h2>${escapeHtml(list.title)}</h2>
              <p class="section-sub">${escapeHtml(list.description)}</p>
            </div>
            <div style="display:flex;gap:0.5rem;align-items:center;">
              <span class="genre-tag">${listItems.length} Titles</span>
              ${
                list.userId === state.currentUserId
                  ? `<button type="button" class="btn btn-secondary btn-sm" data-edit-list="${escapeHtml(list.id)}">Edit List</button>
                     <button type="button" class="btn btn-ghost btn-sm" data-delete-list="${escapeHtml(list.id)}">Delete List</button>`
                  : ''
              }
            </div>
          </div>
          <div class="cards-grid">
            ${cardsHtml}
          </div>
        </section>
      `;
    })
    .join('');
}

function renderProfile() {
  const bannerEl = document.getElementById('viewingFriendBanner');
  const headerEl = document.getElementById('profileHeaderCard');
  const milestonesEl = document.getElementById('profileMilestonesGrid');
  const statsEl = document.getElementById('profileStatsGrid');
  const favsEl = document.getElementById('profileFavoritesContainer');
  const histEl = document.getElementById('profileHistogramCard');
  const recentEl = document.getElementById('profileRecentLogsCard');
  const curHeadingEl = document.getElementById('profileCurrentlyHeading');
  const curSubEl = document.getElementById('profileCurrentlySub');
  const favHeadingEl = document.getElementById('profileFavoritesHeading');
  const favSubEl = document.getElementById('profileFavoritesSub');
  if (!headerEl || !statsEl || !favsEl || !histEl || !recentEl) return;

  const targetUserId =
    uiState.viewingUserId && state.users[uiState.viewingUserId]
      ? uiState.viewingUserId
      : state.currentUserId;
  const isOwnProfile = targetUserId === state.currentUserId;
  const user =
    (targetUserId && state.users[targetUserId]) ||
    (state.currentUserId && state.users[state.currentUserId]) ||
    null;

  if (!user || (isOwnProfile && uiState.isSignedOut && !state.users[state.currentUserId])) {
    if (bannerEl) {
      bannerEl.classList.add('hidden');
      bannerEl.innerHTML = '';
    }
    if (milestonesEl) {
      milestonesEl.innerHTML = '';
    }
    if (curHeadingEl) curHeadingEl.textContent = 'Currently Watching & Reading';
    if (curSubEl) {
      curSubEl.textContent =
        'Sign up or sign in to track your active TV shows and books with one-tap progress controls.';
    }
    if (favHeadingEl) favHeadingEl.textContent = 'Top 4 Favorites';
    if (favSubEl) {
      favSubEl.textContent =
        'Create your account to customize your Top 4 Favorite Movies, TV Shows, and Books.';
    }

    headerEl.innerHTML = `
      <div class="profile-identity">
        <div class="profile-avatar-lg" style="background:var(--accent-gold)">O</div>
        <div>
          <h1 id="profileHeading" style="margin-bottom:0.15rem;">Your shelf awaits</h1>
          <p class="section-sub">Sign in or create an account to start your personal diary</p>
          <p style="margin:0.45rem 0 0;max-width:620px;color:var(--text-secondary);">
            Keep track of the films, shows, and books you love, pick your Top 4 favorites in each medium, and share notes with friends.
          </p>
          <div style="display:flex;gap:0.5rem;flex-wrap:wrap;margin-top:0.75rem;">
            <button type="button" class="btn btn-primary btn-sm" data-open-user-modal="create">
              Create account
            </button>
            <button type="button" class="btn btn-secondary btn-sm" data-open-user-modal="login">
              Sign in
            </button>
            <button type="button" class="btn btn-ghost btn-sm" data-open-user-modal="letterboxd">
              Import from Letterboxd
            </button>
          </div>
        </div>
      </div>
      <div class="profile-counters">
        <div class="counter-box"><strong>0</strong><span>Logged</span></div>
        <div class="counter-box"><strong>0</strong><span>Lists</span></div>
        <div class="counter-box"><strong>0</strong><span>Followers</span></div>
        <div class="counter-box"><strong>0</strong><span>Following</span></div>
      </div>
    `;

    statsEl.innerHTML = `
      <div class="stat-breakdown-card">
        <span class="medium-badge badge-movie">MOVIES</span>
        <h3 style="margin-top:0.5rem;">0 Films Watched</h3>
        <p class="section-sub">Sign in to track your cinema ratings &amp; formats</p>
      </div>
      <div class="stat-breakdown-card">
        <span class="medium-badge badge-tv">TV SHOWS</span>
        <h3 style="margin-top:0.5rem;">0 Series Logged</h3>
        <p class="section-sub">Sign in to track seasons &amp; episodes</p>
      </div>
      <div class="stat-breakdown-card">
        <span class="medium-badge badge-book">BOOKS</span>
        <h3 style="margin-top:0.5rem;">0 Books Read</h3>
        <p class="section-sub">Sign in to track page progress &amp; reviews</p>
      </div>
    `;

    favsEl.innerHTML = `
      <div class="stat-breakdown-card" style="grid-column: 1 / -1; text-align: center;">
        <h3>Create Your Account to Pick Your Top 4 Favorites</h3>
        <p class="section-sub">Showcase your Top 4 all-time Movies, TV Shows, and Books on your profile once you sign up.</p>
      </div>
    `;

    const emptyBuckets = [0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0];
    histEl.innerHTML = `
      <p class="eyebrow">RATING SPREAD</p>
      <h3>Half-Star Rating Distribution (0.5★ – 5.0★)</h3>
      <div class="histogram-bars">
        ${emptyBuckets
          .map(
            (b) => `
          <div class="hist-col" title="${b}★: 0 logs">
            <span class="hist-label">0</span>
            <div class="hist-bar" style="height:8%"></div>
            <span class="hist-label">${b}★</span>
          </div>
        `
          )
          .join('')}
      </div>
    `;

    recentEl.innerHTML = `
      <p class="eyebrow">RECENT DIARY SNAPSHOT</p>
      <h3>Latest Logged Activity</h3>
      <p class="section-sub" style="margin-top:0.75rem;">No logged reviews yet. Create your account to log your first title!</p>
    `;
    return;
  }

  const currentUser = state.users[state.currentUserId] || {};
  const isFollowing = Array.isArray(currentUser.followingIds)
    ? currentUser.followingIds.includes(user.id)
    : false;
  const firstName = (user.name || 'Member').split(' ')[0];

  if (bannerEl) {
    if (isOwnProfile) {
      bannerEl.classList.add('hidden');
      bannerEl.innerHTML = '';
    } else {
      bannerEl.classList.remove('hidden');
      bannerEl.innerHTML = `
        <div class="viewing-friend-info">
          <span class="medium-badge badge-book">FRIEND / FAMILY PROFILE</span>
          <span>Viewing <strong>${escapeHtml(user.name)}</strong> (${escapeHtml(user.handle)})</span>
        </div>
        <div class="viewing-friend-actions">
          <button type="button" class="btn btn-secondary btn-sm" data-view-user="${escapeHtml(state.currentUserId)}">
            ← Back to My Profile (${escapeHtml((currentUser.name || 'Me').split(' ')[0])})
          </button>
          <button type="button" class="btn ${isFollowing ? 'btn-secondary' : 'btn-primary'} btn-sm" data-toggle-follow="${escapeHtml(user.id)}">
            ${isFollowing ? '✓ Following' : '+ Follow'}
          </button>
          <button type="button" class="btn btn-ghost btn-sm" data-switch-user="${escapeHtml(user.id)}">
            Switch to ${escapeHtml(firstName)}’s Account
          </button>
        </div>
      `;
    }
  }

  if (curHeadingEl) {
    curHeadingEl.textContent = isOwnProfile
      ? 'Currently Watching & Reading'
      : `${firstName}’s Currently Watching & Reading`;
  }
  if (curSubEl) {
    curSubEl.textContent = isOwnProfile
      ? 'Your active TV shows and books with one-tap progress controls.'
      : `Active TV shows and books ${firstName} is currently tracking.`;
  }
  if (favHeadingEl) {
    favHeadingEl.textContent = isOwnProfile ? 'Top 4 Favorites' : `${firstName}’s Top 4 Favorites`;
  }
  if (favSubEl) {
    favSubEl.textContent = isOwnProfile
      ? 'Click any poster below to edit your Top 4 Movies, TV Shows, or Books.'
      : `Click any poster below to inspect ${firstName}’s all-time favorite Movies, TV Shows, and Books.`;
  }

  const myLogs = state.logs.filter((l) => l.userId === user.id);
  const movieLogs = myLogs.filter((l) => l.mediaType === 'movie');
  const tvLogs = myLogs.filter((l) => l.mediaType === 'tv');
  const bookLogs = myLogs.filter((l) => l.mediaType === 'book');

  const avgRating = (arr) =>
    arr.length
      ? (arr.reduce((sum, l) => sum + (Number(l.rating) || 0), 0) / arr.length).toFixed(2)
      : '—';

  const totalPagesRead = bookLogs.reduce((sum, l) => {
    const media = findMedia(l.mediaId);
    return sum + (Number(l.progress?.currentPage) || Number(media?.pagesCount) || 320);
  }, 0);

  const totalEpisodesWatched = tvLogs.reduce((sum, l) => {
    const season = Math.max(1, Number(l.progress?.season) || 1);
    const ep = Math.max(1, Number(l.progress?.episode) || 1);
    return sum + (season - 1) * 8 + ep;
  }, 0);

  const genreCounts = {};
  myLogs.forEach((l) => {
    const media = findMedia(l.mediaId);
    (media?.genres || []).forEach((g) => {
      if (g && g !== 'Imported' && g !== 'Letterboxd') {
        genreCounts[g] = (genreCounts[g] || 0) + 1;
      }
    });
  });
  const topGenres = Object.entries(genreCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([g]) => g);

  if (milestonesEl) {
    milestonesEl.innerHTML = `
      <div class="milestone-pill-card">
        <span class="eyebrow">FILMS WATCHED</span>
        <strong>${movieLogs.length}</strong>
        <span class="section-sub">${(movieLogs.length * 2.1).toFixed(1)} hrs</span>
      </div>
      <div class="milestone-pill-card">
        <span class="eyebrow">EPISODES LOGGED</span>
        <strong>${totalEpisodesWatched}</strong>
        <span class="section-sub">${tvLogs.length} series</span>
      </div>
      <div class="milestone-pill-card">
        <span class="eyebrow">PAGES READ</span>
        <strong>${totalPagesRead.toLocaleString()}</strong>
        <span class="section-sub">${bookLogs.length} books</span>
      </div>
      <div class="milestone-pill-card">
        <span class="eyebrow">AVERAGE RATING</span>
        <strong>★ ${avgRating(myLogs)}</strong>
        <span class="section-sub">${myLogs.length} entries</span>
      </div>
      <div class="milestone-pill-card">
        <span class="eyebrow">FAVORITE GENRES</span>
        <strong>${topGenres.length ? escapeHtml(topGenres.join(' · ')) : 'Eclectic'}</strong>
        <span class="section-sub">Most logged</span>
      </div>
    `;
  }

  const activeEmailDisplay =
    isOwnProfile && state.authUser && state.authUser.id === user.id && state.authUser.email
      ? ` · ${escapeHtml(state.authUser.email)}`
      : '';

  const profileActionButtonsHtml = isOwnProfile
    ? `
      <div style="display:flex;gap:0.5rem;flex-wrap:wrap;margin-top:0.65rem;">
        <button type="button" class="btn btn-secondary btn-sm" data-open-user-modal="edit">
          Edit profile
        </button>
        <button type="button" class="btn btn-secondary btn-sm" data-open-user-modal="letterboxd">
          Import from Letterboxd
        </button>
        <button type="button" class="btn btn-ghost btn-sm" id="profileExportDiaryCsvBtn" data-export-diary-csv="${escapeHtml(user.id)}">
          Export CSV
        </button>
        <button type="button" class="btn btn-ghost btn-sm" data-open-user-modal="create">
          New account
        </button>
        <button type="button" class="btn btn-ghost btn-sm" data-open-user-modal="login">
          Switch account
        </button>
      </div>
    `
    : `
      <div style="display:flex;gap:0.5rem;flex-wrap:wrap;margin-top:0.65rem;">
        <button type="button" class="btn ${isFollowing ? 'btn-secondary' : 'btn-primary'} btn-sm" data-toggle-follow="${escapeHtml(user.id)}">
          ${isFollowing ? '✓ Following' : '+ Follow'}
        </button>
        <button type="button" class="btn btn-secondary btn-sm" data-switch-user="${escapeHtml(user.id)}">
          Switch to ${escapeHtml(firstName)}’s Profile
        </button>
        <button type="button" class="btn btn-ghost btn-sm" data-view-user="${escapeHtml(state.currentUserId)}">
          ← My Profile
        </button>
      </div>
    `;

  headerEl.innerHTML = `
    <div class="profile-identity">
      <div class="profile-avatar-lg" style="background:${escapeHtml(user.avatarColor || '#10b981')}">${escapeHtml(user.avatar || 'JC')}</div>
      <div>
        <h1 id="profileHeading" style="margin-bottom:0.15rem;">${escapeHtml(user.name)}</h1>
        <p class="section-sub">${escapeHtml(user.handle)} · ${escapeHtml(user.location || 'Austin, TX')}${activeEmailDisplay}</p>
        <p style="margin:0.45rem 0 0;max-width:620px;color:var(--text-secondary);">${escapeHtml(user.bio)}</p>
        ${profileActionButtonsHtml}
      </div>
    </div>
    <div class="profile-counters">
      <div class="counter-box">
        <strong>${myLogs.length}</strong>
        <span>Total Logged</span>
      </div>
      <div class="counter-box">
        <strong>${state.lists.filter((l) => l.userId === user.id).length}</strong>
        <span>Lists</span>
      </div>
      <div class="counter-box">
        <strong>${user.followersCount ?? 1}</strong>
        <span>Followers</span>
      </div>
      <div class="counter-box">
        <strong>${user.followingCount ?? (user.followingIds?.length || 1)}</strong>
        <span>Following</span>
      </div>
    </div>
  `;

  statsEl.innerHTML = `
    <div class="stat-breakdown-card">
      <span class="medium-badge badge-movie">MOVIES</span>
      <h3 style="margin-top:0.5rem;">${movieLogs.length} Films Watched</h3>
      <p class="section-sub">Avg Rating: ★ ${avgRating(movieLogs)} · Est. ${(movieLogs.length * 2.3).toFixed(1)} hrs in cinema</p>
    </div>
    <div class="stat-breakdown-card">
      <span class="medium-badge badge-tv">TV SHOWS</span>
      <h3 style="margin-top:0.5rem;">${tvLogs.length} Series Logged</h3>
      <p class="section-sub">Avg Rating: ★ ${avgRating(tvLogs)} · Season &amp; Episode tracking active</p>
    </div>
    <div class="stat-breakdown-card">
      <span class="medium-badge badge-book">BOOKS</span>
      <h3 style="margin-top:0.5rem;">${bookLogs.length} Books Read</h3>
      <p class="section-sub">Avg Rating: ★ ${avgRating(bookLogs)} · ${totalPagesRead.toLocaleString()} pages tracked</p>
    </div>
  `;

  // Top 4 Favorites per Medium
  const mediums = [
    { key: 'movie', label: 'Top 4 Favorite Movies', badge: 'badge-movie' },
    { key: 'tv', label: 'Top 4 Favorite TV Shows', badge: 'badge-tv' },
    { key: 'book', label: 'Top 4 Favorite Books', badge: 'badge-book' }
  ];

  favsEl.innerHTML = mediums
    .map(({ key, label, badge }) => {
      const favIds = user.favorites?.[key] || [];
      const fallbackCandidates = state.catalog.filter((c) => c.type === key);
      const slotsHtml = [0, 1, 2, 3]
        .map((slotIdx) => {
          const item = findMedia(favIds[slotIdx]) || fallbackCandidates[slotIdx] || fallbackCandidates[0];
          if (!item) return '';
          if (isOwnProfile) {
            return `
              <button
                type="button"
                class="fav-slot-btn"
                data-open-fav-picker="${key}"
                data-fav-slot="${slotIdx}"
                title="Click to change #${slotIdx + 1} favorite (${escapeHtml(item.title)})"
              >
                <span class="fav-slot-rank">#${slotIdx + 1}</span>
                <img src="${escapeHtml(item.posterUrl)}" alt="${escapeHtml(item.title)}" width="120" height="180" onerror="this.onerror=null;this.src='${escapeHtml(getPosterFallbackUrl(item))}';" />
              </button>
            `;
          }
          return `
            <button
              type="button"
              class="fav-slot-btn"
              data-open-detail="${escapeHtml(item.id)}"
              title="View details for #${slotIdx + 1} favorite (${escapeHtml(item.title)})"
            >
              <span class="fav-slot-rank">#${slotIdx + 1}</span>
              <img src="${escapeHtml(item.posterUrl)}" alt="${escapeHtml(item.title)}" width="120" height="180" onerror="this.onerror=null;this.src='${escapeHtml(getPosterFallbackUrl(item))}';" />
            </button>
          `;
        })
        .join('');

      return `
        <div class="fav-column-card">
          <div style="display:flex;align-items:center;justify-content:space-between;">
            <span class="medium-badge ${badge}">${escapeHtml(label)}</span>
            <span class="section-sub">${isOwnProfile ? 'Click poster to swap' : 'Click poster for details'}</span>
          </div>
          <div class="fav-slots-grid">
            ${slotsHtml}
          </div>
        </div>
      `;
    })
    .join('');

  // Rating Distribution Histogram (0.5 to 5.0)
  const buckets = [0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0];
  const counts = buckets.map(
    (b) => myLogs.filter((l) => Math.abs((Number(l.rating) || 0) - b) < 0.01).length
  );
  const maxCount = Math.max(1, ...counts);

  histEl.innerHTML = `
    <p class="eyebrow">RATING SPREAD</p>
    <h3>Half-Star Rating Distribution (0.5★ – 5.0★)</h3>
    <div class="histogram-bars">
      ${buckets
        .map((b, i) => {
          const hPct = Math.max(8, Math.round((counts[i] / maxCount) * 100));
          return `
            <div class="hist-col" title="${b}★: ${counts[i]} logs">
              <span class="hist-label">${counts[i]}</span>
              <div class="hist-bar" style="height:${hPct}%"></div>
              <span class="hist-label">${b}★</span>
            </div>
          `;
        })
        .join('')}
    </div>
  `;

  recentEl.innerHTML = `
    <p class="eyebrow">RECENT DIARY SNAPSHOT</p>
    <h3>${isOwnProfile ? 'Latest Logged Activity' : `${escapeHtml(firstName)}’s Latest Activity`}</h3>
    <div style="display:flex;flex-direction:column;gap:0.65rem;margin-top:0.85rem;">
      ${
        myLogs.length === 0
          ? `<p class="section-sub">No logged reviews yet for ${escapeHtml(user.name)}.</p>`
          : myLogs
              .slice(0, 4)
              .map((l) => {
                const m = findMedia(l.mediaId);
                return `
                  <div style="display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--border-subtle);padding-bottom:0.45rem;">
                    <div>
                      <span class="medium-badge ${getBadgeClass(l.mediaType)}">${escapeHtml(getMediumLabel(l.mediaType))}</span>
                      <a href="#detail-${escapeHtml(l.mediaId)}" data-open-detail="${escapeHtml(l.mediaId)}" style="color:var(--text-primary);text-decoration:none;margin-left:0.4rem;">
                        <strong>${escapeHtml(m?.title || l.mediaId)}</strong>
                      </a>
                    </div>
                    <span class="star-display">${formatStars(l.rating)}</span>
                  </div>
                `;
              })
              .join('')
      }
    </div>
  `;
}

// ==================== DIALOG CONTROLLERS (MANDATORY .showModal()) ====================
function populateLogModal(selectedMediaId = null, existingLog = null) {
  const selectEl = document.getElementById('logMediaSelect');
  const editIdEl = document.getElementById('logEditId');
  const ratingInput = document.getElementById('logRatingInput');
  const dateInput = document.getElementById('logDateInput');
  const likedInput = document.getElementById('logLikedInput');
  const rewatchInput = document.getElementById('logRewatchInput');
  const spoilerInput = document.getElementById('logSpoilerInput');
  const reviewInput = document.getElementById('logReviewInput');
  const titleEl = document.getElementById('logDialogTitle');

  // Ensure external item is in catalog (deduplicated by title+type+year) if user clicked "+ Log" on an external search card
  if (selectedMediaId) {
    const merged = findOrMergeCatalogItem(selectedMediaId);
    if (merged) {
      selectedMediaId = merged.id;
    }
  }

  selectEl.innerHTML = state.catalog
    .map(
      (item) =>
        `<option value="${escapeHtml(item.id)}">[${escapeHtml(getMediumLabel(item.type).toUpperCase())}] ${escapeHtml(item.title)} (${escapeHtml(item.year || '')})</option>`
    )
    .join('');

  if (existingLog) {
    titleEl.textContent = 'Edit Diary Entry & Review';
    editIdEl.value = existingLog.id;
    selectEl.value = existingLog.mediaId;
    setHalfStarRating(existingLog.rating || 4.5);
    dateInput.value = existingLog.dateConsumed || new Date().toISOString().slice(0, 10);
    likedInput.checked = Boolean(existingLog.liked);
    rewatchInput.checked = Boolean(existingLog.isRewatch);
    spoilerInput.checked = Boolean(existingLog.containsSpoilers);
    reviewInput.value = existingLog.review || '';

    if (existingLog.progress) {
      updateLogModalMediaPreview(true);
      if (existingLog.progress.season) {
        document.getElementById('logTvSeason').value = existingLog.progress.season;
      }
      if (existingLog.progress.episode) {
        document.getElementById('logTvEpisode').value = existingLog.progress.episode;
      }
      if (existingLog.progress.status && existingLog.mediaType === 'tv') {
        document.getElementById('logTvStatus').value = existingLog.progress.status;
      }
      if (existingLog.progress.currentPage) {
        document.getElementById('logBookCurrentPage').value = existingLog.progress.currentPage;
      }
      if (existingLog.progress.totalPages) {
        document.getElementById('logBookTotalPages').value = existingLog.progress.totalPages;
      }
      if (existingLog.mediaType === 'book') {
        updateBookProgressIndicator();
      }
      if (existingLog.progress.status && existingLog.mediaType === 'book') {
        document.getElementById('logBookStatus').value = existingLog.progress.status;
      }
      if (existingLog.progress.format && existingLog.mediaType === 'movie') {
        document.getElementById('logMovieFormat').value = existingLog.progress.format;
      }
    } else {
      updateLogModalMediaPreview(false);
    }
  } else {
    titleEl.textContent = 'Log a Movie, TV Show, or Book';
    editIdEl.value = '';
    if (selectedMediaId) {
      selectEl.value = selectedMediaId;
    }
    setHalfStarRating(Number(ratingInput.value) || 4.5);
    dateInput.value = new Date().toISOString().slice(0, 10);
    likedInput.checked = true;
    rewatchInput.checked = false;
    spoilerInput.checked = false;
    reviewInput.value = '';
    updateLogModalMediaPreview(false);
  }
}

function updateLogModalMediaPreview(preserveProgressValues = false) {
  const selectEl = document.getElementById('logMediaSelect');
  const previewEl = document.getElementById('logMediaPreview');
  const tvGroup = document.getElementById('tvProgressGroup');
  const bookGroup = document.getElementById('bookProgressGroup');
  const movieGroup = document.getElementById('movieProgressGroup');
  const rewatchLabel = document.getElementById('rewatchLabelText');

  const item = findMedia(selectEl.value) || state.catalog[0];
  if (!item) return;

  previewEl.innerHTML = `
    <img src="${escapeHtml(item.posterUrl)}" alt="${escapeHtml(item.title)}" width="44" height="66" onerror="this.onerror=null;this.src='${escapeHtml(getPosterFallbackUrl(item))}';" />
    <div>
      <span class="medium-badge ${getBadgeClass(item.type)}">${escapeHtml(getMediumLabel(item.type))}</span>
      <strong style="display:block;margin-top:0.2rem;">${escapeHtml(item.title)} (${escapeHtml(item.year || '')})</strong>
      <span class="section-sub">${escapeHtml(item.creator)}</span>
    </div>
  `;

  tvGroup.classList.toggle('hidden', item.type !== 'tv');
  bookGroup.classList.toggle('hidden', item.type !== 'book');
  movieGroup.classList.toggle('hidden', item.type !== 'movie');

  if (item.type === 'book') {
    rewatchLabel.textContent = '↻ Reread';
    if (!preserveProgressValues) {
      const pages = item.pagesCount || 350;
      document.getElementById('logBookCurrentPage').value = pages;
      document.getElementById('logBookTotalPages').value = pages;
    }
    updateBookProgressIndicator();
  } else {
    rewatchLabel.textContent = '↻ Rewatch';
  }
}

function updateBookProgressIndicator() {
  const curEl = document.getElementById('logBookCurrentPage');
  const totEl = document.getElementById('logBookTotalPages');
  const progEl = document.getElementById('bookReadingProgress');
  const pctLabel = document.getElementById('bookProgressPctLabel');
  if (!curEl || !totEl || !progEl) return;
  const cur = Math.max(0, Number(curEl.value) || 0);
  const tot = Math.max(1, Number(totEl.value) || 1);
  const pct = Math.min(100, Math.round((cur / tot) * 100));
  progEl.value = pct;
  progEl.textContent = `${pct}%`;
  if (pctLabel) pctLabel.textContent = `${pct}%`;
}

function renderHalfStarTrack(currentRating) {
  const track = document.getElementById('starVisualTrack');
  if (!track) return;
  const steps = [0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0];
  track.innerHTML = steps
    .map(
      (val) => `
      <button
        type="button"
        class="half-star-btn ${val <= currentRating ? 'is-active' : ''}"
        data-set-rating="${val}"
        aria-label="Rate ${val} stars"
      >
        ${val.toFixed(1)}★
      </button>
    `
    )
    .join('');
}

function setHalfStarRating(value) {
  const clamped = Math.max(0.5, Math.min(5.0, Math.round(Number(value) * 2) / 2));
  const input = document.getElementById('logRatingInput');
  const output = document.getElementById('logRatingOutput');
  if (input) {
    input.value = String(clamped);
    const pct = Math.round(((clamped - 0.5) / 4.5) * 100);
    input.style.setProperty('--progress', `${pct}%`);
  }
  if (output) output.textContent = `${formatStars(clamped)} (${clamped.toFixed(1)} / 5.0)`;
  renderHalfStarTrack(clamped);
}

function openLogModal(mediaId = null, existingLog = null) {
  if (
    !requireAuthForAction(
      'Please sign in or sign up first to log a Movie, TV Show, or Book!'
    )
  ) {
    return false;
  }
  populateLogModal(mediaId, existingLog);
  const dialog = document.getElementById('logDialog');
  if (!dialog.open) {
    dialog.showModal();
  }
  return true;
}

function openDetailModal(mediaId) {
  const item = findMedia(mediaId);
  if (!item) return;

  uiState.activeDetailMediaId = item.id;
  const dialog = document.getElementById('detailDialog');
  const container = document.getElementById('detailDialogContent');
  const inWatchlist = state.watchlist.includes(item.id);
  const itemLogs = state.logs.filter((l) => l.mediaId === item.id);
  const myActiveLog = state.logs.find(
    (l) =>
      l.userId === state.currentUserId &&
      l.mediaId === item.id &&
      l.progress &&
      isInProgressStatus(l.progress.status)
  );
  const startTrackingBtnHtml =
    item.type === 'tv' || item.type === 'book'
      ? myActiveLog
        ? `<button type="button" class="btn btn-secondary" data-edit-log="${escapeHtml(myActiveLog.id)}">
             ${item.type === 'tv' ? `Watching (S${myActiveLog.progress.season || 1}·E${myActiveLog.progress.episode || 1})` : `Reading (${myActiveLog.progress.currentPage || 1}/${myActiveLog.progress.totalPages || item.pagesCount || 350} pp)`}
           </button>`
        : `<button type="button" class="btn btn-secondary" data-start-tracking="${escapeHtml(item.id)}">
             ${item.type === 'tv' ? 'Start Watching' : 'Start Reading'}
           </button>`
      : '';

  const specLine =
    item.type === 'movie'
      ? `Director: ${item.creator} · Runtime: ${item.runtimeMinutes || 125} mins`
      : item.type === 'tv'
      ? `Creator: ${item.creator} · ${item.seasonsCount || 1} Seasons (${item.episodesCount || 10} Episodes)`
      : `Author: ${item.creator} · ${item.pagesCount || 320} Pages`;

  const reviewsHtml =
    itemLogs.length === 0
      ? `<p class="section-sub">No community reviews logged yet. Be the first to review ${escapeHtml(item.title)}!</p>`
      : itemLogs
          .map((l) => {
            const u = state.users[l.userId] || { name: 'Member', handle: '@member' };
            const isSpoilerHidden = l.containsSpoilers && !uiState.revealedSpoilers.has(l.id);
            const reviewBodyHtml = isSpoilerHidden
              ? `
                <div class="spoiler-shield">
                  <span>⚠️ This review contains spoilers for <strong>${escapeHtml(item.title)}</strong>.</span>
                  <button type="button" class="btn btn-secondary btn-sm" data-reveal-spoiler="${escapeHtml(l.id)}">
                    Reveal Spoiler
                  </button>
                </div>
              `
              : `<p style="margin:0.4rem 0 0;color:var(--text-secondary);">${escapeHtml(l.review || 'Logged without written review.')}</p>`;
            return `
              <div style="border-top:1px solid var(--border-subtle);padding:0.85rem 0;">
                <div style="display:flex;justify-content:space-between;align-items:center;">
                  <strong>${escapeHtml(u.name)} <span class="section-sub">${escapeHtml(u.handle)}</span></strong>
                  <span class="star-display">${formatStars(l.rating)} (${Number(l.rating).toFixed(1)})</span>
                </div>
                ${reviewBodyHtml}
              </div>
            `;
          })
          .join('');

  const crossMediaPicks = getCrossMediaRecommendations(item, state.catalog);
  const crossMediaCardsHtml = crossMediaPicks
    .map((rec) => {
      const target = rec.target;
      const targetFallback = getPosterFallbackUrl(target);
      return `
        <article
          class="card cross-media-card ${rec.isAdaptation ? 'is-adaptation-card' : ''}"
          data-cross-media-id="${escapeHtml(target.id)}"
          data-relation-type="${escapeHtml(rec.relationType)}"
        >
          <img
            src="${escapeHtml(target.posterUrl)}"
            alt="${escapeHtml(target.title)} poster"
            width="110"
            height="165"
            loading="lazy"
            onerror="this.onerror=null;this.src='${escapeHtml(targetFallback)}';"
          />
          <header>
            <div class="card-meta-top">
              <span class="medium-badge ${getBadgeClass(target.type)}">${escapeHtml(getMediumLabel(target.type))}</span>
              <span class="community-star">★ ${Number(target.communityRating || 4.4).toFixed(1)}</span>
            </div>
            <h3>
              <a href="#detail-${escapeHtml(target.id)}" class="card-link" data-open-detail="${escapeHtml(target.id)}">
                ${escapeHtml(target.title)} (${escapeHtml(target.year || '')})
              </a>
            </h3>
          </header>
          <div>
            <span class="relation-pill ${rec.isAdaptation ? 'relation-pill-adaptation' : ''}">
              ${escapeHtml(rec.relationLabel)}
            </span>
            <p class="card-creator">${escapeHtml(target.creator || '')}</p>
          </div>
        </article>
      `;
    })
    .join('');

  container.innerHTML = `
    <header class="modal-header">
      <div>
        <span class="medium-badge ${getBadgeClass(item.type)}">${escapeHtml(getMediumLabel(item.type))}</span>
        <h2 id="detailDialogTitle" style="margin-top:0.35rem;">${escapeHtml(item.title)} (${escapeHtml(item.year || '')})</h2>
      </div>
      <button type="button" class="btn-icon-close" data-close-dialog="detailDialog" aria-label="Close dialog">&times;</button>
    </header>

    <div class="detail-hero">
      <img src="${escapeHtml(item.posterUrl)}" alt="${escapeHtml(item.title)}" class="detail-poster" width="200" height="300" onerror="this.onerror=null;this.src='${escapeHtml(getPosterFallbackUrl(item))}';" />
      <div>
        <p style="font-weight:700;color:var(--text-secondary);margin-top:0;">${escapeHtml(specLine)}</p>
        <p>${escapeHtml(item.synopsis)}</p>
        <div class="genre-row" style="margin:0.75rem 0;">
          ${(item.genres || []).map((g) => `<span class="genre-tag">${escapeHtml(g)}</span>`).join('')}
        </div>
        <div style="display:flex;align-items:center;gap:1.25rem;margin:1rem 0;padding:0.75rem;background:rgba(11,15,23,0.55);border-radius:var(--radius-sm);">
          <div>
            <strong style="font-size:1.4rem;color:var(--star-gold);">★ ${Number(item.communityRating || 4.4).toFixed(1)}</strong>
            <span class="section-sub" style="display:block;">Community Avg (${Number(item.ratingsCount || 100).toLocaleString()} ratings)</span>
          </div>
        </div>
        <div style="display:flex;gap:0.65rem;flex-wrap:wrap;">
          <button type="button" class="btn btn-primary" data-detail-log="${escapeHtml(item.id)}">
            + Log or Review
          </button>
          ${startTrackingBtnHtml}
          <button type="button" class="btn btn-secondary" data-toggle-watchlist="${escapeHtml(item.id)}">
            ${inWatchlist ? '✓ In Watchlist' : '+ Watchlist'}
          </button>
        </div>
      </div>
    </div>

    <section id="detailCrossMediaSection" class="cross-media-section" aria-label="Cross-Media Adaptations and Related Stacks">
      <div class="cross-media-header">
        <div>
          <p class="eyebrow">CROSS-MEDIA CONNECTIONS · MOVIES, TV &amp; BOOKS</p>
          <h3>Cross-Media Adaptations &amp; Related Stacks</h3>
        </div>
        <span class="section-sub">Click any card to jump across mediums</span>
      </div>
      <div id="detailCrossMediaGrid" class="cross-media-grid">
        ${crossMediaCardsHtml}
      </div>
    </section>

    <div>
      <h3>Community Reviews &amp; Logs (${itemLogs.length})</h3>
      ${reviewsHtml}
    </div>
  `;

  if (!dialog.open) {
    dialog.showModal();
  }
  dialog.scrollTop = 0;
}

function openCreateListModal(existingList = null) {
  if (
    !requireAuthForAction(
      'Please sign in or sign up first to create or edit custom lists!'
    )
  ) {
    return false;
  }
  const picker = document.getElementById('listItemsPicker');
  const editIdEl = document.getElementById('listEditId');
  const titleInput = document.getElementById('listTitleInput');
  const descInput = document.getElementById('listDescInput');
  const rankedInput = document.getElementById('listRankedInput');
  const dialogTitle = document.getElementById('listDialogTitle');
  const submitBtn = document.getElementById('saveListSubmitBtn');
  const selectedIds = new Set(existingList?.itemIds || []);

  if (picker) {
    // MWG Choice Cards: <label class="card choice-card"> with <input type="checkbox"> as direct child
    picker.innerHTML = state.catalog
      .map((item, idx) => {
        const isChecked = existingList ? selectedIds.has(item.id) : idx < 3;
        return `
        <label class="card choice-card">
          <input type="checkbox" class="visually-hidden" name="listMediaItem" value="${escapeHtml(item.id)}" ${isChecked ? 'checked' : ''} />
          <span>
            <span class="medium-badge ${getBadgeClass(item.type)}">${escapeHtml(getMediumLabel(item.type))}</span>
            <strong style="display:block;font-size:0.82rem;margin-top:0.15rem;">${escapeHtml(item.title)}</strong>
          </span>
        </label>
      `;
      })
      .join('');
  }
  if (editIdEl) editIdEl.value = existingList ? existingList.id : '';
  if (titleInput) titleInput.value = existingList ? existingList.title : '';
  if (descInput) descInput.value = existingList ? existingList.description : '';
  if (rankedInput) rankedInput.checked = existingList ? Boolean(existingList.isRanked) : true;
  if (dialogTitle) dialogTitle.textContent = existingList ? 'Edit Custom List' : 'Create List';
  if (submitBtn) submitBtn.textContent = existingList ? 'Save Changes' : 'Create List';

  const dialog = document.getElementById('listDialog');
  if (!dialog.open) {
    dialog.showModal();
  }
  return true;
}

function openFavoritePickerModal(medium, slotIndex) {
  if (
    !requireAuthForAction(
      'Please sign in or sign up first to customize your Top 4 Favorites!'
    )
  ) {
    return false;
  }
  document.getElementById('favPickerMedium').value = medium;
  document.getElementById('favPickerSlotIndex').value = String(slotIndex);
  const select = document.getElementById('favPickerSelect');
  const candidates = state.catalog.filter((c) => c.type === medium);
  const currentFavId = state.users[state.currentUserId]?.favorites?.[medium]?.[slotIndex];

  select.innerHTML = candidates
    .map(
      (c) =>
        `<option value="${escapeHtml(c.id)}" ${c.id === currentFavId ? 'selected' : ''}>${escapeHtml(c.title)} (${escapeHtml(c.year || '')})</option>`
    )
    .join('');

  document.getElementById('favoritePickerDialog').showModal();
  return true;
}

// ==================== ACTIONS & API SYNC ====================
async function handleSaveLog(event) {
  event.preventDefault();
  if (
    !requireAuthForAction(
      'Please sign in or sign up first to log a Movie, TV Show, or Book!'
    )
  ) {
    return false;
  }
  const editId = document.getElementById('logEditId').value;
  const mediaId = document.getElementById('logMediaSelect').value;
  const mediaItem = findMedia(mediaId);
  if (!mediaItem) return;

  const rating = clampClientRating(document.getElementById('logRatingInput').value, 4.5);
  const dateConsumed = document.getElementById('logDateInput').value || new Date().toISOString().slice(0, 10);
  const liked = document.getElementById('logLikedInput').checked;
  const isRewatch = document.getElementById('logRewatchInput').checked;
  const containsSpoilers = document.getElementById('logSpoilerInput').checked;
  const review = document.getElementById('logReviewInput').value.trim().slice(0, 5000);

  let progress = { status: 'completed' };
  if (mediaItem.type === 'tv') {
    progress = {
      season: Math.max(1, Math.min(100, Math.round(Number(document.getElementById('logTvSeason').value) || 1))),
      episode: Math.max(1, Math.min(1000, Math.round(Number(document.getElementById('logTvEpisode').value) || 1))),
      status: document.getElementById('logTvStatus').value || 'completed'
    };
  } else if (mediaItem.type === 'book') {
    const tot = Math.max(1, Math.min(20000, Math.round(Number(document.getElementById('logBookTotalPages').value) || mediaItem.pagesCount || 300)));
    const cur = Math.max(0, Math.min(tot, Math.round(Number(document.getElementById('logBookCurrentPage').value) || tot)));
    progress = {
      currentPage: cur,
      totalPages: tot,
      percent: Math.min(100, Math.round((cur / Math.max(1, tot)) * 100)),
      status: document.getElementById('logBookStatus').value || 'completed'
    };
  } else {
    progress = {
      status: 'completed',
      format: document.getElementById('logMovieFormat').value || 'Theater'
    };
  }

  const logEntry = {
    id: editId || generateClientId('log'),
    userId: state.currentUserId,
    mediaId: mediaItem.id,
    mediaType: mediaItem.type,
    rating,
    liked,
    dateConsumed,
    createdAt: new Date().toISOString(),
    review,
    containsSpoilers,
    isRewatch,
    progress,
    likesCount: editId
      ? state.logs.find((l) => l.id === editId)?.likesCount || 1
      : 1,
    likedByMe: true,
    comments: editId
      ? state.logs.find((l) => l.id === editId)?.comments || []
      : []
  };

  const existingIdx = state.logs.findIndex((l) => l.id === logEntry.id);
  if (existingIdx >= 0) {
    state.logs[existingIdx] = logEntry;
  } else {
    state.logs.unshift(logEntry);
  }
  recalculateClientMediaStats(mediaItem.id);
  state.watchlist = state.watchlist.filter((id) => id !== mediaItem.id);
  syncClientWatchlistToActiveUser();
  saveLocalState();
  renderAll();

  document.getElementById('logDialog').close();
  showToast(`Logged "${mediaItem.title}" (${formatStars(rating)}) to your Diary!`);

  try {
    const res = await fetch('/api/logs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ log: logEntry, mediaItem })
    });
    if (res.status === 401) {
      state.logs = state.logs.filter((l) => l.id !== logEntry.id);
      state.currentUserId = null;
      uiState.isSignedOut = true;
      saveLocalState();
      renderAll();
      requireAuthForAction('Please sign in or sign up first to log media!');
      return;
    }
    if (res.ok) {
      const data = await res.json();
      if (data.state && Array.isArray(data.state.catalog)) {
        state = data.state;
        saveLocalState();
        renderAll();
      }
    }
  } catch {
    // persisted in localStorage
  }
}

async function handleToggleWatchlist(mediaId) {
  if (
    !requireAuthForAction(
      'Please sign in or sign up first to save titles to your Watchlist!'
    )
  ) {
    return false;
  }
  const merged = findOrMergeCatalogItem(mediaId);
  const mediaItem = merged || findMedia(mediaId);
  const targetId = mediaItem ? mediaItem.id : mediaId;

  const exists = state.watchlist.includes(targetId);
  if (exists) {
    state.watchlist = state.watchlist.filter((id) => id !== targetId);
    showToast(`Removed "${mediaItem?.title || 'item'}" from Watchlist`);
  } else {
    state.watchlist.unshift(targetId);
    showToast(`Added "${mediaItem?.title || 'item'}" to Watchlist`);
  }
  syncClientWatchlistToActiveUser();
  saveLocalState();
  renderAll();

  const detailDialog = document.getElementById('detailDialog');
  if (detailDialog?.open) {
    openDetailModal(targetId);
  }

  try {
    await fetch('/api/watchlist/toggle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mediaId: targetId, mediaItem })
    });
  } catch {
    // persisted locally
  }
}

async function handleLikeLog(logId) {
  if (!requireAuthForAction('Please sign in or sign up first to like reviews!')) {
    return false;
  }
  const log = state.logs.find((l) => l.id === logId);
  if (!log) return;
  log.likedByMe = !log.likedByMe;
  log.likesCount = Math.max(0, (log.likesCount || 0) + (log.likedByMe ? 1 : -1));
  saveLocalState();
  renderActivityFeed();

  try {
    await fetch(`/api/logs/${encodeURIComponent(logId)}/like`, { method: 'POST' });
  } catch {
    // persisted locally
  }
}

async function handlePostComment(logId, text) {
  if (!requireAuthForAction('Please sign in or sign up first to comment on reviews!')) {
    return false;
  }
  const log = state.logs.find((l) => l.id === logId);
  if (!log || !text.trim()) return;
  const user = state.users[state.currentUserId];
  if (!user) return;
  const comment = {
    id: generateClientId('c'),
    userId: user.id,
    userName: user.name,
    userHandle: user.handle,
    text: text.trim().slice(0, 1000),
    createdAt: new Date().toISOString()
  };
  log.comments = Array.isArray(log.comments) ? log.comments : [];
  log.comments.push(comment);
  saveLocalState();
  renderActivityFeed();
  showToast('Comment posted!');

  try {
    await fetch(`/api/logs/${encodeURIComponent(logId)}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text.trim() })
    });
  } catch {
    // persisted locally
  }
}

async function handleDeleteLog(logId) {
  if (!requireAuthForAction('Please sign in or sign up first to delete logs!')) {
    return false;
  }
  const targetLog = state.logs.find((l) => l.id === logId);
  state.logs = state.logs.filter((l) => l.id !== logId);
  if (targetLog && targetLog.mediaId) {
    recalculateClientMediaStats(targetLog.mediaId);
  }
  saveLocalState();
  renderAll();
  showToast('Diary entry deleted.');

  try {
    await fetch(`/api/logs/${encodeURIComponent(logId)}`, { method: 'DELETE' });
  } catch {
    // persisted locally
  }
}

async function handleBumpProgress(logId, action) {
  if (
    !requireAuthForAction(
      'Please sign in or sign up first to update your watching or reading progress!'
    )
  ) {
    return false;
  }
  const log = state.logs.find((l) => l.id === logId);
  if (!log) return;
  const item = findMedia(log.mediaId) || {};
  log.progress = log.progress || {};

  if (action === 'increment_episode') {
    const epsPerSeason = getTvEpisodesPerSeason(item);
    const totalSeasons = epsPerSeason.length;
    const curSeason = Math.max(1, Math.min(totalSeasons, Number(log.progress.season) || 1));
    const curEp = Math.max(1, Number(log.progress.episode) || 1);
    const maxEpInSeason = epsPerSeason[curSeason - 1] || 10;

    if (curEp < maxEpInSeason) {
      log.progress.season = curSeason;
      log.progress.episode = curEp + 1;
      log.progress.status = 'watching';
      log.progress.percent = computeTvProgressPercent(curSeason, curEp + 1, epsPerSeason, 'watching');
      showToast(`Updated "${item.title || 'Show'}" to S${curSeason} · E${curEp + 1}/${maxEpInSeason}!`);
    } else if (curSeason < totalSeasons) {
      const nextSeason = curSeason + 1;
      const nextMax = epsPerSeason[nextSeason - 1] || 10;
      log.progress.season = nextSeason;
      log.progress.episode = 1;
      log.progress.status = 'watching';
      log.progress.percent = computeTvProgressPercent(nextSeason, 1, epsPerSeason, 'watching');
      showToast(`Finished Season ${curSeason}! Rolled over "${item.title || 'Show'}" to S${nextSeason} · E1/${nextMax}!`);
    } else {
      log.progress.season = curSeason;
      log.progress.episode = maxEpInSeason;
      log.progress.status = 'completed';
      log.progress.percent = 100;
      showToast(`Finished final episode of "${item.title || 'Show'}" (S${curSeason} · E${maxEpInSeason}) — Marked Completed!`);
    }
  } else if (action === 'increment_pages') {
    const tot = Number(log.progress.totalPages) || Number(item.pagesCount) || 400;
    const cur = Math.min(tot, (Number(log.progress.currentPage) || 0) + 25);
    const pct = Math.min(100, Math.round((cur / tot) * 100));
    log.progress.currentPage = cur;
    log.progress.totalPages = tot;
    log.progress.percent = pct;
    if (cur >= tot) {
      log.progress.status = 'completed';
      showToast(`Finished reading "${item.title || 'Book'}" (${tot}/${tot} pp)!`);
    } else {
      log.progress.status = 'reading';
      showToast(`Updated "${item.title || 'Book'}" to page ${cur} of ${tot} (${pct}%)!`);
    }
  } else if (action === 'finish') {
    if (log.mediaType === 'book') {
      const tot = Number(log.progress.totalPages) || Number(item.pagesCount) || 400;
      log.progress.currentPage = tot;
      log.progress.totalPages = tot;
      log.progress.percent = 100;
    } else if (log.mediaType === 'tv') {
      const epsPerSeason = getTvEpisodesPerSeason(item);
      const finalSeason = epsPerSeason.length;
      log.progress.season = finalSeason;
      log.progress.episode = epsPerSeason[finalSeason - 1] || 10;
      log.progress.percent = 100;
    }
    log.progress.status = 'completed';
    showToast(`Marked "${item.title || 'Title'}" as Completed!`);
  }

  log.dateConsumed = new Date().toISOString().slice(0, 10);
  saveLocalState();
  renderAll();

  try {
    await fetch(`/api/logs/${encodeURIComponent(logId)}/progress`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, delta: action === 'increment_pages' ? 25 : 1 })
    });
  } catch {
    // persisted locally
  }
}

async function handleStartTracking(mediaId) {
  if (
    !requireAuthForAction(
      'Please sign in or sign up first to track shows and books!'
    )
  ) {
    return false;
  }
  const mediaItem = findOrMergeCatalogItem(mediaId);
  if (!mediaItem) return;

  const epsPerSeason = getTvEpisodesPerSeason(mediaItem);
  const defaultProgress =
    mediaItem.type === 'book'
      ? {
          currentPage: 25,
          totalPages: Math.max(1, Number(mediaItem.pagesCount) || 350),
          percent: Math.round((25 / Math.max(1, Number(mediaItem.pagesCount) || 350)) * 100),
          status: 'reading'
        }
      : {
          season: 1,
          episode: 1,
          percent: computeTvProgressPercent(1, 1, epsPerSeason, 'watching'),
          status: 'watching'
        };

  // Only match an existing log if it is ALREADY in progress ('watching' / 'reading').
  // If the user previously completed this title, preserve that completed diary entry and create a new rewatch/reread entry!
  let log = state.logs.find(
    (l) =>
      l.userId === state.currentUserId &&
      l.mediaId === mediaItem.id &&
      l.progress &&
      isInProgressStatus(l.progress.status)
  );
  const hasCompletedBefore = state.logs.some(
    (l) =>
      l.userId === state.currentUserId &&
      l.mediaId === mediaItem.id &&
      (!l.progress || !isInProgressStatus(l.progress.status))
  );

  if (log) {
    log.progress = defaultProgress;
    log.dateConsumed = new Date().toISOString().slice(0, 10);
  } else {
    log = {
      id: generateClientId('log'),
      userId: state.currentUserId,
      mediaId: mediaItem.id,
      mediaType: mediaItem.type,
      rating: 4.5,
      liked: true,
      dateConsumed: new Date().toISOString().slice(0, 10),
      createdAt: new Date().toISOString(),
      review: '',
      containsSpoilers: false,
      isRewatch: hasCompletedBefore,
      progress: defaultProgress,
      likesCount: 1,
      likedByMe: true,
      comments: []
    };
    state.logs.unshift(log);
  }

  state.watchlist = state.watchlist.filter((id) => id !== mediaItem.id);
  syncClientWatchlistToActiveUser();
  saveLocalState();
  renderAll();

  const detailDialog = document.getElementById('detailDialog');
  if (detailDialog?.open) {
    openDetailModal(mediaItem.id);
  }

  showToast(
    mediaItem.type === 'book'
      ? `Added "${mediaItem.title}" to Currently Reading!`
      : `Added "${mediaItem.title}" to Currently Watching!`
  );

  try {
    const res = await fetch('/api/currently-tracking', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mediaId: mediaItem.id, mediaItem, progress: defaultProgress })
    });
    if (res.ok) {
      const data = await res.json();
      if (data.state && Array.isArray(data.state.logs)) {
        state = data.state;
        saveLocalState();
        renderAll();
      }
    }
  } catch {
    // persisted locally
  }
}

async function handleCreateList(event) {
  event.preventDefault();
  if (
    !requireAuthForAction(
      'Please sign in or sign up first to create or edit custom lists!'
    )
  ) {
    return false;
  }
  const editId = document.getElementById('listEditId')?.value || '';
  const title = document.getElementById('listTitleInput').value.trim();
  const description = document.getElementById('listDescInput').value.trim();
  const isRanked = document.getElementById('listRankedInput').checked;
  const checkedBoxes = document.querySelectorAll('input[name="listMediaItem"]:checked');
  const rawItemIds = Array.from(checkedBoxes).map((cb) => cb.value);
  const itemIds = [...new Set(rawItemIds.filter(Boolean))];

  if (!title) return;

  const existingIdx = editId ? state.lists.findIndex((l) => l.id === editId) : -1;
  let savedList;
  if (existingIdx >= 0) {
    savedList = {
      ...state.lists[existingIdx],
      title,
      description: description || state.lists[existingIdx].description,
      isRanked,
      itemIds: itemIds.length ? itemIds : state.lists[existingIdx].itemIds
    };
    state.lists[existingIdx] = savedList;
  } else {
    savedList = {
      id: generateClientId('list'),
      userId: state.currentUserId,
      title,
      description: description || 'Custom cross-media collection.',
      isRanked,
      itemIds: itemIds.length ? itemIds : ['movie-101', 'tv-201', 'book-301'],
      likesCount: 1,
      createdAt: new Date().toISOString()
    };
    state.lists.unshift(savedList);
  }

  saveLocalState();
  renderAll();
  document.getElementById('listDialog').close();
  switchView('lists');
  showToast(existingIdx >= 0 ? `Updated custom list "${title}"!` : `Created custom list "${title}"!`);

  try {
    await fetch(existingIdx >= 0 ? `/api/lists/${encodeURIComponent(editId)}` : '/api/lists', {
      method: existingIdx >= 0 ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(savedList)
    });
  } catch {
    // persisted locally
  }
}

async function handleDeleteList(listId) {
  if (!requireAuthForAction('Please sign in or sign up first to delete lists!')) {
    return false;
  }
  state.lists = state.lists.filter((l) => l.id !== listId);
  saveLocalState();
  renderLists();
  showToast('Custom list deleted.');

  try {
    await fetch(`/api/lists/${encodeURIComponent(listId)}`, { method: 'DELETE' });
  } catch {
    // persisted locally
  }
}

async function handleSaveFavoriteSlot(event) {
  event.preventDefault();
  if (
    !requireAuthForAction(
      'Please sign in or sign up first to customize your Top 4 Favorites!'
    )
  ) {
    return false;
  }
  const medium = document.getElementById('favPickerMedium').value;
  const slotIdx = Number(document.getElementById('favPickerSlotIndex').value) || 0;
  const chosenId = document.getElementById('favPickerSelect').value;

  const user = state.users[state.currentUserId];
  if (user && user.favorites && Array.isArray(user.favorites[medium])) {
    const favArr = user.favorites[medium];
    const existingIdx = favArr.indexOf(chosenId);
    if (existingIdx !== -1 && existingIdx !== slotIdx) {
      // Swap the two slots so all 4 Top Favorites remain unique
      const previousAtTarget = favArr[slotIdx];
      favArr[existingIdx] = previousAtTarget;
    }
    favArr[slotIdx] = chosenId;
    saveLocalState();
    renderProfile();
    document.getElementById('favoritePickerDialog').close();
    showToast('Updated Top 4 Favorite showcase!');

    try {
      await fetch('/api/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ favorites: user.favorites })
      });
    } catch {
      // persisted locally
    }
  }
}

function viewUserProfile(userId) {
  if (!userId || !state.users[userId]) return;
  uiState.viewingUserId = userId;
  renderAll();
  switchView('profile', { preserveViewedUser: true });
}

async function handleSwitchUser(userId) {
  if (!userId || !state.users[userId]) return;
  syncClientWatchlistToActiveUser();
  uiState.isSignedOut = false;
  state.currentUserId = userId;
  uiState.viewingUserId = userId;
  const targetUser = state.users[userId];
  state.watchlist = Array.isArray(targetUser.watchlist) ? [...targetUser.watchlist] : [];
  saveLocalState();
  renderAll();
  showToast(`Switched active profile to ${targetUser.name} (${targetUser.handle})!`);

  try {
    const res = await fetch('/api/users/switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId })
    });
    if (res.ok) {
      const data = await res.json();
      if (data.state && data.state.users) {
        state = data.state;
        upgradeUsersAndSocialGraph();
        uiState.viewingUserId = state.currentUserId;
        saveLocalState();
        renderAll();
      }
    }
  } catch {
    // persisted locally
  }
}

async function handleToggleFollow(targetUserId) {
  if (!targetUserId || targetUserId === state.currentUserId) return;
  const activeUser = state.users[state.currentUserId];
  const targetUser = state.users[targetUserId];
  if (!activeUser || !targetUser) return;

  activeUser.followingIds = Array.isArray(activeUser.followingIds) ? activeUser.followingIds : [];
  const exists = activeUser.followingIds.includes(targetUserId);
  if (exists) {
    activeUser.followingIds = activeUser.followingIds.filter((id) => id !== targetUserId);
    showToast(`Unfollowed ${targetUser.name} (${targetUser.handle})`);
  } else {
    activeUser.followingIds.push(targetUserId);
    showToast(`Now following ${targetUser.name} (${targetUser.handle})!`);
  }
  saveLocalState();
  renderAll();

  try {
    const res = await fetch(`/api/users/${encodeURIComponent(targetUserId)}/follow`, {
      method: 'POST'
    });
    if (res.ok) {
      const data = await res.json();
      if (data.state && data.state.users) {
        state = data.state;
        upgradeUsersAndSocialGraph();
        saveLocalState();
        renderAll();
      }
    }
  } catch {
    // persisted locally
  }
}

function setAuthModalFeedback(message = '', isError = false) {
  const box = document.getElementById('authModalFeedback');
  if (!box) return;
  if (!message) {
    box.textContent = '';
    box.classList.add('hidden');
    box.classList.remove('is-error', 'is-success');
    return;
  }
  box.textContent = message;
  box.classList.remove('hidden');
  box.classList.toggle('is-error', Boolean(isError));
  box.classList.toggle('is-success', !isError);
}

function computePasswordStrength(password = '') {
  const pw = String(password);
  if (!pw) return { score: 0, label: 'At least 8 characters' };
  let score = 0;
  if (pw.length >= 8) score += 50;
  else score += Math.round((pw.length / 8) * 30);
  if (pw.length >= 12) score += 20;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) score += 15;
  if (/[0-9]/.test(pw) || /[^A-Za-z0-9]/.test(pw)) score += 15;
  score = Math.min(100, score);
  const label = pw.length < 8 ? 'At least 8 characters' : 'Ready';
  return { score, label };
}

function updatePasswordStrengthMeter() {
  const pw = document.getElementById('userPasswordInput')?.value || '';
  const bar = document.getElementById('passwordStrengthBar');
  const labelEl = document.getElementById('passwordStrengthLabel');
  const pctEl = document.getElementById('passwordStrengthPct');
  const { score, label } = computePasswordStrength(pw);
  if (bar) {
    bar.value = score;
    bar.textContent = `${score}%`;
  }
  if (labelEl) labelEl.textContent = label;
  if (pctEl) pctEl.textContent = `${score}%`;
}

export function goToSignupStep(stepNumber = 1, options = {}) {
  const step = Math.max(1, Math.min(4, Number(stepNumber) || 1));
  uiState.signupStep = step;
  const stepInput = document.getElementById('signupCurrentStepInput');
  if (stepInput) stepInput.value = String(step);
  if (!options.keepFeedback) {
    setAuthModalFeedback('');
  }

  const counterEl = document.getElementById('signupStepCounter');
  if (counterEl) {
    counterEl.textContent = `Step ${step} of 4`;
  }

  const dotsContainer = document.getElementById('signupStepDots');
  if (dotsContainer) {
    dotsContainer.setAttribute('aria-valuenow', String(step));
  }
  document.querySelectorAll('[data-step-dot]').forEach((dot) => {
    const dotStep = Number(dot.dataset.stepDot) || 1;
    dot.classList.toggle('is-active', dotStep === step);
    dot.classList.toggle('is-complete', dotStep < step);
  });

  document.querySelectorAll('[data-signup-step]').forEach((panel) => {
    const panelStep = Number(panel.dataset.signupStep) || 1;
    const isCurrent = panelStep === step;
    panel.classList.toggle('hidden', !isCurrent);
    if (isCurrent) {
      panel.removeAttribute('hidden');
    } else {
      panel.setAttribute('hidden', '');
    }
  });

  if (!options.skipFocus && typeof document !== 'undefined') {
    const focusMap = {
      1: 'userHandleInput',
      2: 'userEmailInput',
      3: 'userPasswordInput',
      4: 'signupLetterboxdUsernameInput'
    };
    const targetInput = document.getElementById(focusMap[step]);
    if (targetInput && typeof targetInput.focus === 'function') {
      targetInput.focus();
    }
  }
  return step;
}

export function validateAndAdvanceSignupStep(fromStep = uiState.signupStep || 1) {
  const step = Number(fromStep) || 1;
  if (step === 1) {
    const rawHandle = (document.getElementById('userHandleInput')?.value || '')
      .trim()
      .replace(/^@+/, '');
    if (rawHandle.length < 2) {
      setAuthModalFeedback('Please pick a username with at least 2 characters.', true);
      document.getElementById('userHandleInput')?.focus();
      return false;
    }
    goToSignupStep(2);
    return true;
  }

  if (step === 2) {
    const email = (document.getElementById('userEmailInput')?.value || '').trim();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setAuthModalFeedback('Please enter a valid email address.', true);
      document.getElementById('userEmailInput')?.focus();
      return false;
    }
    goToSignupStep(3);
    return true;
  }

  if (step === 3) {
    const pw = document.getElementById('userPasswordInput')?.value || '';
    const confirmPw = document.getElementById('userConfirmPasswordInput')?.value || '';
    if (pw.length < 8) {
      setAuthModalFeedback('Please choose a password with at least 8 characters.', true);
      document.getElementById('userPasswordInput')?.focus();
      return false;
    }
    if (pw !== confirmPw) {
      setAuthModalFeedback('Passwords do not match — please check both fields.', true);
      document.getElementById('userConfirmPasswordInput')?.focus();
      return false;
    }
    goToSignupStep(4);
    return true;
  }

  return true;
}

async function refreshActiveAuthDetails() {
  try {
    const headers = {};
    const savedToken = localStorage.getItem('omnilog_session_token');
    if (savedToken) headers.Authorization = `Bearer ${savedToken}`;
    const res = await fetch('/api/auth/me', { headers });
    if (res.ok) {
      const data = await res.json();
      if (data.authUser) {
        state.authUser = data.authUser;
        const emailLabel = document.getElementById('securityCurrentEmail');
        const newEmailInput = document.getElementById('credNewEmailInput');
        if (emailLabel) {
          emailLabel.textContent = `Signed in as ${data.authUser.email} (${data.authUser.handle})`;
        }
        if (newEmailInput && !newEmailInput.value) {
          newEmailInput.value = data.authUser.email || '';
        }
      }
    }
  } catch {
    // offline fallback
  }
}

function switchAuthModalTab(tab = 'signup', userId = state.currentUserId) {
  setAuthModalFeedback('');
  const normalizedTab = tab === 'create' ? 'signup' : tab;
  const profileForm = document.getElementById('userProfileForm');
  const loginForm = document.getElementById('authLoginForm');
  const letterboxdPanel = document.getElementById('letterboxdImportPanel');
  const signupCredsSection = document.getElementById('signupCredentialsSection');
  const wizardHeader = document.getElementById('signupWizardHeader');
  const step1Intro = document.getElementById('signupStep1Intro');
  const step1Footer = document.getElementById('signupStep1Footer');
  const editOnlyFields = document.getElementById('editOnlyProfileFields');
  const editProfileFooter = document.getElementById('editProfileModalFooter');
  const securitySection = document.getElementById('accountSecuritySection');
  const modeEl = document.getElementById('userFormMode');
  const editIdEl = document.getElementById('userEditId');
  const titleEl = document.getElementById('userDialogTitle');
  const handleLabelEl = document.getElementById('userHandleLabel');
  const submitBtn =
    document.getElementById('saveUserSubmitBtn') || document.getElementById('userSubmitBtn');

  document.querySelectorAll('[data-auth-tab]').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.authTab === normalizedTab);
  });

  const targetUser = state.users[userId] || state.users[state.currentUserId];

  if (normalizedTab === 'letterboxd') {
    profileForm?.classList.add('hidden');
    loginForm?.classList.add('hidden');
    securitySection?.classList.add('hidden');
    letterboxdPanel?.classList.remove('hidden');
    if (titleEl) titleEl.textContent = 'Import from Letterboxd';
    return;
  }

  letterboxdPanel?.classList.add('hidden');

  if (normalizedTab === 'login') {
    profileForm?.classList.add('hidden');
    securitySection?.classList.add('hidden');
    loginForm?.classList.remove('hidden');
    if (titleEl) titleEl.textContent = 'Sign in';
    if (Object.keys(state.users || {}).length === 0) {
      setAuthModalFeedback(
        'No account yet? Switch to "Create account" above to get started.',
        false
      );
    }
    return;
  }

  loginForm?.classList.add('hidden');
  profileForm?.classList.remove('hidden');

  const isEdit = normalizedTab === 'edit' && targetUser;
  if (modeEl) modeEl.value = isEdit ? 'edit' : 'create';
  if (editIdEl) editIdEl.value = isEdit ? targetUser.id : '';

  if (wizardHeader) {
    wizardHeader.classList.toggle('hidden', Boolean(isEdit));
  }
  if (step1Intro) {
    step1Intro.classList.toggle('hidden', Boolean(isEdit));
  }
  if (step1Footer) {
    step1Footer.classList.toggle('hidden', Boolean(isEdit));
  }
  if (signupCredsSection) {
    signupCredsSection.classList.toggle('hidden', Boolean(isEdit));
  }
  if (editOnlyFields) {
    editOnlyFields.classList.toggle('hidden', !isEdit);
  }
  if (editProfileFooter) {
    editProfileFooter.classList.toggle('hidden', !isEdit);
  }
  if (securitySection) {
    securitySection.classList.toggle('hidden', !isEdit);
  }
  if (handleLabelEl) {
    handleLabelEl.textContent = 'Username';
  }

  if (titleEl) {
    titleEl.textContent = isEdit ? 'Edit profile' : 'Create your account';
  }
  if (submitBtn) {
    submitBtn.textContent = isEdit ? 'Save changes' : 'Finish & Create Account';
  }

  const nameInput = document.getElementById('userNameInput');
  const handleInput = document.getElementById('userHandleInput');
  const locationInput = document.getElementById('userLocationInput');
  const colorInput = document.getElementById('userAvatarColorInput');
  const bioInput = document.getElementById('userBioInput');
  const emailInput = document.getElementById('userEmailInput');
  const pwInput = document.getElementById('userPasswordInput');
  const confirmPwInput = document.getElementById('userConfirmPasswordInput');
  const lbSignupUser = document.getElementById('signupLetterboxdUsernameInput');
  const lbSignupCsv = document.getElementById('signupLetterboxdCsvInput');

  if (nameInput) nameInput.value = isEdit ? targetUser.name || '' : '';
  if (handleInput) handleInput.value = isEdit ? targetUser.handle || '' : '';
  if (locationInput) locationInput.value = isEdit ? targetUser.location || '' : '';
  if (colorInput) colorInput.value = isEdit ? targetUser.avatarColor || '#d49b4b' : '#d49b4b';
  if (bioInput) bioInput.value = isEdit ? targetUser.bio || '' : '';
  if (!isEdit) {
    if (emailInput) emailInput.value = '';
    if (pwInput) pwInput.value = '';
    if (confirmPwInput) confirmPwInput.value = '';
    if (lbSignupUser) lbSignupUser.value = '';
    if (lbSignupCsv) lbSignupCsv.value = '';
    updatePasswordStrengthMeter();
    goToSignupStep(1, { skipFocus: true });
  } else {
    const step1Panel = document.getElementById('signupStep1');
    if (step1Panel) {
      step1Panel.classList.remove('hidden');
      step1Panel.removeAttribute('hidden');
    }
    ['signupStep2', 'signupStep3', 'signupStep4'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) {
        el.classList.add('hidden');
        el.setAttribute('hidden', '');
      }
    });
    const emailLabel = document.getElementById('securityCurrentEmail');
    const fallbackEmail =
      state.authUser && state.authUser.id === targetUser.id
        ? state.authUser.email
        : `${targetUser.id.replace(/^user-/, '')}@omnilog.app`;
    if (emailLabel) {
      emailLabel.textContent = `Signed in as ${fallbackEmail} (${targetUser.handle})`;
    }
    const newEmailInput = document.getElementById('credNewEmailInput');
    if (newEmailInput) newEmailInput.value = fallbackEmail;
    refreshActiveAuthDetails();
  }
}

function openUserModal(mode = 'create', userId = state.currentUserId) {
  const dlg = document.getElementById('userDialog');
  if (!dlg) return;

  const targetTab =
    mode === 'edit'
      ? 'edit'
      : mode === 'login'
      ? 'login'
      : mode === 'letterboxd'
      ? 'letterboxd'
      : 'signup';
  switchAuthModalTab(targetTab, userId);

  if (typeof dlg.showModal === 'function' && !dlg.open) {
    dlg.showModal();
  } else {
    dlg.setAttribute('open', '');
  }
}

async function readSelectedCsvFiles(fileInputEl) {
  if (!fileInputEl || !fileInputEl.files || fileInputEl.files.length === 0) return [];
  const results = [];
  for (const file of Array.from(fileInputEl.files)) {
    const csvText = await file.text();
    results.push({ fileName: file.name, csvText });
  }
  return results;
}

async function handleSaveUserProfile(event) {
  event.preventDefault();
  setAuthModalFeedback('');
  const mode = document.getElementById('userFormMode')?.value || 'create';
  const editId = document.getElementById('userEditId')?.value || '';
  const rawNameInput = document.getElementById('userNameInput')?.value.trim() || '';
  const rawHandle = document.getElementById('userHandleInput')?.value.trim() || '';
  const location = document.getElementById('userLocationInput')?.value.trim() || 'Family Circle';
  const avatarColor = document.getElementById('userAvatarColorInput')?.value || '#10b981';
  const bio =
    document.getElementById('userBioInput')?.value.trim() ||
    'Tracking favorite films, series, and books with family & friends on Omnilog.';
  const email = document.getElementById('userEmailInput')?.value.trim() || '';
  const password = document.getElementById('userPasswordInput')?.value || '';
  const confirmPassword = document.getElementById('userConfirmPasswordInput')?.value || '';
  const signupLbUsername =
    document.getElementById('signupLetterboxdUsernameInput')?.value.trim() || '';
  const signupLbCsvInput = document.getElementById('signupLetterboxdCsvInput');

  const name = rawNameInput || rawHandle.replace(/^@+/, '').trim();
  if (!name && !rawHandle) {
    setAuthModalFeedback('Please choose a username.', true);
    return;
  }

  const cleanHandleBase = (rawHandle || name)
    .toLowerCase()
    .replace(/^@+/, '')
    .replace(/[^a-z0-9_]/g, '')
    .slice(0, 24);
  const handle = `@${cleanHandleBase || 'reader'}`;
  const avatar = deriveClientInitials(name);

  if (mode === 'edit' && editId && state.users[editId]) {
    const existing = state.users[editId];
    existing.name = name;
    existing.handle = handle;
    existing.location = location;
    existing.avatarColor = avatarColor;
    existing.avatar = avatar;
    existing.bio = bio;
    saveLocalState();
    renderAll();
    document.getElementById('userDialog')?.close();
    showToast(`Updated profile for ${name}!`);

    try {
      const res = await fetch(`/api/users/${encodeURIComponent(editId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, handle, location, avatarColor, avatar, bio })
      });
      if (res.ok) {
        const data = await res.json();
        if (data.state && data.state.users) {
          state = data.state;
          upgradeUsersAndSocialGraph();
          saveLocalState();
          renderAll();
        }
      }
    } catch {
      // persisted locally
    }
    return;
  }

  const letterboxdFiles = await readSelectedCsvFiles(signupLbCsvInput);

  // If user entered email or password in Sign Up tab, validate & use POST /api/auth/signup
  if (email || password || confirmPassword) {
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setAuthModalFeedback('Please enter a valid email address (e.g., name@omnilog.app).', true);
      return;
    }
    if (password.length < 8) {
      setAuthModalFeedback('Password must be at least 8 characters long.', true);
      return;
    }
    if (confirmPassword && password !== confirmPassword) {
      setAuthModalFeedback('Passwords do not match. Please check both password fields.', true);
      return;
    }

    try {
      const res = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: rawHandle || name,
          name,
          handle,
          email,
          password,
          confirmPassword: confirmPassword || password,
          bio,
          avatar,
          avatarColor,
          location,
          letterboxdUsername: signupLbUsername || undefined,
          letterboxdFiles: letterboxdFiles.length > 0 ? letterboxdFiles : undefined
        })
      });
      const data = await res.json();
      if (!res.ok) {
        setAuthModalFeedback(data.error || 'Could not create account.', true);
        return;
      }
      if (data.sessionToken || data.token) {
        localStorage.setItem('omnilog_session_token', data.sessionToken || data.token);
      }
      uiState.isSignedOut = false;
      if (data.state && data.state.users) {
        state = data.state;
        upgradeUsersAndSocialGraph();
        uiState.viewingUserId = state.currentUserId;
        saveLocalState();
        renderAll();
      }
      document.getElementById('userDialog')?.close();
      switchView('profile', { preserveViewedUser: true });
      const importedTotal = (data.importedLogsCount || 0) + (data.importedWatchlistCount || 0);
      showToast(
        importedTotal > 0
          ? `Signed up @${cleanHandleBase} & imported ${importedTotal} Letterboxd items!`
          : `Signed up @${cleanHandleBase} (${email})!`
      );
      return;
    } catch {
      // Fall through to local profile creation if offline
    }
  }

  // Fallback local/quick family profile creation
  uiState.isSignedOut = false;
  let newId = `user-${cleanHandleBase || Date.now().toString(36)}`;
  if (state.users[newId]) {
    newId = `${newId}-${Math.random().toString(36).slice(2, 5)}`;
  }

  const allExistingUserIds = Object.keys(state.users);
  const newUser = {
    id: newId,
    name,
    handle,
    bio,
    avatar,
    avatarColor,
    location,
    joinedYear: new Date().getFullYear(),
    followingIds: allExistingUserIds.filter((uid) => uid !== newId),
    watchlist: ['movie-101', 'tv-202', 'book-301'],
    favorites: {
      movie: ['movie-101', 'movie-102', 'movie-104', 'movie-108'],
      tv: ['tv-201', 'tv-202', 'tv-204', 'tv-207'],
      book: ['book-301', 'book-302', 'book-305', 'book-308']
    }
  };

  syncClientWatchlistToActiveUser();
  state.users[newId] = newUser;
  Object.values(state.users).forEach((u) => {
    if (u.id !== newId) {
      u.followingIds = Array.isArray(u.followingIds) ? u.followingIds : [];
      if (!u.followingIds.includes(newId)) u.followingIds.push(newId);
    }
  });
  state.currentUserId = newId;
  uiState.viewingUserId = newId;
  state.watchlist = [...newUser.watchlist];

  saveLocalState();
  renderAll();
  document.getElementById('userDialog')?.close();
  switchView('profile', { preserveViewedUser: true });
  showToast(`Created profile for ${name} (${handle}) and switched active account!`);

  try {
    const res = await fetch('/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: newId,
        name,
        handle,
        bio,
        avatar,
        avatarColor,
        location,
        switchToNew: true
      })
    });
    if (res.ok) {
      const data = await res.json();
      if (data.state && data.state.users) {
        state = data.state;
        upgradeUsersAndSocialGraph();
        uiState.viewingUserId = state.currentUserId;
        saveLocalState();
        renderAll();
      }
    }
  } catch {
    // persisted locally
  }
}

async function handleAuthLogin(event) {
  event.preventDefault();
  setAuthModalFeedback('');
  const identifier = document.getElementById('loginIdentifierInput')?.value.trim() || '';
  const password = document.getElementById('loginPasswordInput')?.value || '';

  if (!identifier || !password) {
    setAuthModalFeedback('Please enter your email or @handle and password.', true);
    return;
  }

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier, password })
    });
    const data = await res.json();
    if (!res.ok) {
      setAuthModalFeedback(data.error || 'Invalid email/handle or password.', true);
      return;
    }
    if (data.sessionToken || data.token) {
      localStorage.setItem('omnilog_session_token', data.sessionToken || data.token);
    }
    uiState.isSignedOut = false;
    if (data.state && data.state.users) {
      state = data.state;
      upgradeUsersAndSocialGraph();
      uiState.viewingUserId = state.currentUserId;
      saveLocalState();
      renderAll();
    }
    document.getElementById('loginPasswordInput').value = '';
    document.getElementById('userDialog')?.close();
    showToast(`Signed in as ${data.user?.name || identifier} (${data.authUser?.email || ''})!`);
  } catch {
    setAuthModalFeedback('Unable to reach authentication server.', true);
  }
}

async function handleUpdateCredentials(event) {
  event.preventDefault();
  setAuthModalFeedback('');
  const currentPassword = document.getElementById('credCurrentPasswordInput')?.value || '';
  const newEmail = document.getElementById('credNewEmailInput')?.value.trim() || '';
  const newPassword = document.getElementById('credNewPasswordInput')?.value || '';
  const confirmNewPassword = document.getElementById('credConfirmPasswordInput')?.value || '';

  if (!currentPassword) {
    setAuthModalFeedback('Please enter your current password to verify your identity.', true);
    return;
  }
  if (newPassword && newPassword.length < 8) {
    setAuthModalFeedback('New password must be at least 8 characters long.', true);
    return;
  }
  if (newPassword && confirmNewPassword && newPassword !== confirmNewPassword) {
    setAuthModalFeedback('New password and confirmation do not match.', true);
    return;
  }

  try {
    const headers = { 'Content-Type': 'application/json' };
    const savedToken = localStorage.getItem('omnilog_session_token');
    if (savedToken) headers.Authorization = `Bearer ${savedToken}`;

    const res = await fetch('/api/auth/credentials', {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        userId: state.currentUserId,
        currentPassword,
        newEmail,
        newPassword: newPassword || undefined,
        confirmNewPassword: confirmNewPassword || undefined
      })
    });
    const data = await res.json();
    if (!res.ok) {
      setAuthModalFeedback(data.error || 'Could not update credentials.', true);
      return;
    }
    if (data.state && data.state.users) {
      state = data.state;
      upgradeUsersAndSocialGraph();
      saveLocalState();
      renderAll();
    } else if (data.authUser) {
      state.authUser = data.authUser;
      renderAll();
    }
    document.getElementById('credCurrentPasswordInput').value = '';
    document.getElementById('credNewPasswordInput').value = '';
    document.getElementById('credConfirmPasswordInput').value = '';
    setAuthModalFeedback(
      `Account settings updated for ${data.authUser?.email || 'your account'}.`,
      false
    );
    showToast('Updated your email and password.');
  } catch {
    setAuthModalFeedback('Unable to reach server right now.', true);
  }
}

async function handleAuthLogout() {
  try {
    const headers = {};
    const savedToken = localStorage.getItem('omnilog_session_token');
    if (savedToken) headers.Authorization = `Bearer ${savedToken}`;
    await fetch('/api/auth/logout', { method: 'POST', headers });
  } catch {
    // ignore network error
  }
  localStorage.removeItem('omnilog_session_token');
  syncClientWatchlistToActiveUser();
  state.currentUserId = null;
  state.watchlist = [];
  uiState.viewingUserId = null;
  uiState.isSignedOut = true;
  saveLocalState();
  renderAll();
  document.getElementById('userDialog')?.close();
  showToast('Signed out.');
  switchAuthModalTab('login');
  openUserModal('login');
}

async function handleLetterboxdRssSync() {
  const input = document.getElementById('lbRssUsernameInput');
  const rawUsername = (input?.value || '').trim().replace(/^@/, '');
  const statusBox = document.getElementById('letterboxdImportStatusBox');
  if (!rawUsername) {
    setAuthModalFeedback('Please enter a Letterboxd username to sync.', true);
    input?.focus();
    return;
  }

  const syncBtn = document.getElementById('lbRssSyncBtn');
  if (syncBtn) {
    syncBtn.disabled = true;
    syncBtn.textContent = 'Syncing...';
  }
  if (statusBox) {
    statusBox.classList.remove('hidden');
    statusBox.textContent = `Syncing films for ${rawUsername}...`;
  }

  try {
    const res = await fetch('/api/import/letterboxd-rss', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: state.currentUserId,
        username: rawUsername
      })
    });
    const data = await res.json();
    if (!res.ok) {
      setAuthModalFeedback(data.error || 'Could not sync from Letterboxd.', true);
      if (statusBox) statusBox.textContent = data.error || 'Could not sync from Letterboxd.';
      return;
    }

    const nextState = data.state || data.db;
    if (nextState && nextState.users) {
      state = nextState;
      state.catalog = upgradeCatalogPosters(state.catalog);
      upgradeUsersAndSocialGraph();
      upgradeInProgressLogs();
      saveLocalState();
    }
    if (data.user?.id) {
      uiState.isSignedOut = false;
      uiState.viewingUserId = data.user.id;
    }
    renderAll();

    const summary = data.summary || {};
    const msg = `Synced @${rawUsername} from Letterboxd (${summary.importedLogs || 0} films imported).`;
    setAuthModalFeedback(msg, false);
    if (statusBox) {
      statusBox.classList.remove('hidden');
      statusBox.textContent = msg;
    }
    showToast(msg);
  } catch {
    setAuthModalFeedback('Unable to reach Letterboxd import right now.', true);
  } finally {
    if (syncBtn) {
      syncBtn.disabled = false;
      syncBtn.textContent = 'Sync films';
    }
  }
}

async function handleLetterboxdCsvImport() {
  const fileInput = document.getElementById('lbCsvFileInput');
  const pasteArea = document.getElementById('lbCsvPasteTextarea');
  const statusBox = document.getElementById('letterboxdImportStatusBox');
  const importBtn = document.getElementById('lbCsvImportBtn');

  const files = await readSelectedCsvFiles(fileInput);
  const pastedCsv = (pasteArea?.value || '').trim();

  if (files.length === 0 && !pastedCsv) {
    setAuthModalFeedback('Select a Letterboxd CSV file or paste CSV rows first.', true);
    return;
  }

  if (importBtn) {
    importBtn.disabled = true;
    importBtn.textContent = 'Importing...';
  }
  if (statusBox) {
    statusBox.classList.remove('hidden');
    statusBox.textContent = 'Matching your films...';
  }

  try {
    const payload = {
      userId: state.currentUserId,
      files: files.slice()
    };
    if (pastedCsv) {
      payload.files.push({ fileName: 'pasted.csv', csvText: pastedCsv });
      if (!payload.csvText) payload.csvText = pastedCsv;
    }

    const res = await fetch('/api/import/letterboxd-csv', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) {
      setAuthModalFeedback(data.error || 'Letterboxd CSV import failed.', true);
      if (statusBox) statusBox.textContent = data.error || 'Letterboxd CSV import failed.';
      return;
    }

    const nextState = data.state || data.db;
    if (nextState && nextState.users) {
      state = nextState;
      state.catalog = upgradeCatalogPosters(state.catalog);
      upgradeUsersAndSocialGraph();
      upgradeInProgressLogs();
      saveLocalState();
    }
    if (data.user?.id) {
      uiState.isSignedOut = false;
      uiState.viewingUserId = data.user.id;
    }
    renderAll();

    const summary = data.summary || {};
    const msg = `Imported ${summary.importedLogs || 0} films and ${summary.watchlistAdded || 0} watchlist titles from Letterboxd.`;
    setAuthModalFeedback(msg, false);
    if (statusBox) {
      statusBox.classList.remove('hidden');
      statusBox.textContent = msg;
    }
    if (fileInput) fileInput.value = '';
    if (pasteArea) pasteArea.value = '';
    showToast(msg);
  } catch {
    setAuthModalFeedback('Unable to reach Letterboxd import right now.', true);
  } finally {
    if (importBtn) {
      importBtn.disabled = false;
      importBtn.textContent = 'Import CSV';
    }
  }
}

async function handleExportDiaryCsv(requestedUserId = null) {
  const targetUserId =
    requestedUserId && requestedUserId !== 'true'
      ? requestedUserId
      : uiState.viewingUserId || state.currentUserId;
  try {
    const query = targetUserId ? `?userId=${encodeURIComponent(targetUserId)}` : '';
    const res = await fetch(`/api/export/diary.csv${query}`);
    if (res.ok) {
      const csvText = await res.text();
      const blob = new Blob([csvText], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `omnilog-diary-${targetUserId || 'export'}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      showToast('Exported diary CSV.');
      return;
    }
  } catch {
    // Fallback to client-side CSV generation
  }

  const logsToExport = (state.logs || []).filter((l) =>
    targetUserId ? l.userId === targetUserId : true
  );
  const csvEscape = (val) => {
    const str = val === null || val === undefined ? '' : String(val);
    return /[",\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };
  const header = 'Date,Title,Year,Medium,Creator,Rating,Liked,Rewatch,Progress,Review';
  const rows = logsToExport.map((log) => {
    const media = findMedia(log.mediaId) || {};
    return [
      csvEscape(log.dateConsumed || ''),
      csvEscape(media.title || 'Untitled'),
      csvEscape(media.year || ''),
      csvEscape(log.mediaType || media.type || 'movie'),
      csvEscape(media.creator || ''),
      csvEscape(log.rating !== undefined ? Number(log.rating).toFixed(1) : ''),
      csvEscape(log.liked ? 'Yes' : 'No'),
      csvEscape(log.isRewatch ? 'Yes' : 'No'),
      csvEscape('Completed'),
      csvEscape(log.review || '')
    ].join(',');
  });
  const blob = new Blob([[header, ...rows].join('\r\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'omnilog-diary.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  showToast('Exported diary CSV.');
}

function updateCustomMediaLabels() {
  const type = document.getElementById('customMediaTypeSelect')?.value || 'movie';
  const creatorLabel = document.getElementById('customMediaCreatorLabel');
  const lengthLabel = document.getElementById('customMediaLengthLabel');
  const lengthInput = document.getElementById('customMediaLengthInput');
  if (creatorLabel) {
    creatorLabel.textContent =
      type === 'book' ? 'Author' : type === 'tv' ? 'Creator / Showrunner' : 'Director';
  }
  if (lengthLabel) {
    lengthLabel.textContent =
      type === 'book' ? 'Pages' : type === 'tv' ? 'Seasons' : 'Runtime (minutes)';
  }
  if (lengthInput && !lengthInput.value) {
    lengthInput.placeholder = type === 'book' ? '320' : type === 'tv' ? '2' : '120';
  }
}

export function openCustomMediaModal() {
  const dlg = document.getElementById('customMediaDialog');
  if (!dlg) return;
  updateCustomMediaLabels();
  if (typeof dlg.showModal === 'function' && !dlg.open) {
    dlg.showModal();
  } else {
    dlg.setAttribute('open', '');
  }
}

async function handleSaveCustomMedia(event) {
  event.preventDefault();
  const title = (document.getElementById('customMediaTitleInput')?.value || '').trim();
  const type = document.getElementById('customMediaTypeSelect')?.value || 'movie';
  const year = Number(document.getElementById('customMediaYearInput')?.value) || 2024;
  const creator =
    (document.getElementById('customMediaCreatorInput')?.value || '').trim() || 'Independent';
  const genreStr = (document.getElementById('customMediaGenreInput')?.value || '').trim();
  const lengthVal = Number(document.getElementById('customMediaLengthInput')?.value) || 0;
  const posterUrlInput = (document.getElementById('customMediaPosterInput')?.value || '').trim();
  const synopsis = (document.getElementById('customMediaSynopsisInput')?.value || '').trim();
  const logImmediately = Boolean(
    document.getElementById('customMediaLogImmediatelyInput')?.checked
  );

  if (!title) {
    showToast('Please enter a title.');
    return;
  }

  const genres = genreStr
    ? genreStr
        .split(',')
        .map((g) => g.trim())
        .filter(Boolean)
    : ['Drama'];

  const payload = {
    title,
    type,
    year,
    creator,
    genres,
    posterUrl: posterUrlInput || undefined,
    synopsis: synopsis || `${title} (${year}) by ${creator}.`,
    runtimeMinutes: type === 'movie' ? lengthVal || 120 : undefined,
    seasonsCount: type === 'tv' ? lengthVal || 1 : undefined,
    episodesCount: type === 'tv' ? (lengthVal || 1) * 8 : undefined,
    pagesCount: type === 'book' ? lengthVal || 320 : undefined
  };

  let addedItem = null;
  try {
    const res = await fetch('/api/catalog', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (res.ok) {
      const data = await res.json();
      addedItem = data.item;
      if (data.state && data.state.catalog) {
        state.catalog = upgradeCatalogPosters(data.state.catalog);
      } else if (addedItem) {
        state.catalog.unshift(addedItem);
      }
      saveLocalState();
      renderAll();
    }
  } catch {
    // Offline fallback
  }

  if (!addedItem) {
    const id = generateClientId(type);
    const fallbackPoster = buildPosterUrl(id, title, creator, year, type);
    addedItem = {
      id,
      ...payload,
      posterUrl: posterUrlInput || fallbackPoster,
      fallbackPosterUrl: fallbackPoster,
      communityRating: 4.3,
      ratingsCount: 1
    };
    state.catalog.unshift(addedItem);
    saveLocalState();
    renderAll();
  }

  document.getElementById('customMediaForm')?.reset();
  document.getElementById('customMediaDialog')?.close();
  showToast(`Added "${addedItem.title}" to the catalog.`);

  if (logImmediately && addedItem.id) {
    openLogModal(addedItem.id);
  }
}

async function handleLiveExternalSearch() {
  const input = document.getElementById('catalogSearchInput');
  const query = (input.value || '').trim() || 'Star';
  const statusEl = document.getElementById('externalSearchStatus');
  const panel = document.getElementById('externalResultsPanel');
  if (panel) panel.classList.remove('hidden');
  if (statusEl) statusEl.textContent = `Searching iTunes Movies, TVMaze & Open Library for "${query}"...`;

  try {
    const res = await fetch(
      `/api/search-external?q=${encodeURIComponent(query)}&type=${encodeURIComponent(uiState.exploreType)}`
    );
    const data = await res.json();
    uiState.externalResults = data.results || [];
    if (statusEl) {
      statusEl.textContent = `Found ${uiState.externalResults.length} worldwide matches for "${query}" across Film, TV & Books.`;
    }
    renderExternalResults();
  } catch (err) {
    console.error('External search error:', err);
  }
}

function switchView(viewName, options = {}) {
  if (viewName === 'profile' && !options.preserveViewedUser) {
    uiState.viewingUserId = state.currentUserId;
    renderProfile();
    renderCurrentlyWatchingShelf();
    renderFriendsDirectory();
  }
  uiState.activeView = viewName;
  document.querySelectorAll('.view-section').forEach((sec) => {
    sec.classList.toggle('hidden', sec.id !== `view-${viewName}`);
  });
  document.querySelectorAll('.nav-btn').forEach((btn) => {
    const isActive = btn.dataset.navView === viewName;
    btn.classList.toggle('is-active', isActive);
    btn.classList.toggle('active', isActive);
  });
  document.querySelectorAll('[data-mobile-nav], [data-mobile-tab]').forEach((btn) => {
    const targetView = btn.dataset.mobileNav || btn.dataset.mobileTab || btn.dataset.navView;
    const isActive = targetView === viewName;
    btn.classList.toggle('is-active', isActive);
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-current', isActive ? 'page' : 'false');
  });
}

const switchTab = switchView;

// ==================== EVENT LISTENERS ====================
function bindEvents() {
  initDialogLightDismissFallbacks();

  // Navigation
  document.addEventListener('click', (event) => {
    const mobileLogTrigger = event.target.closest('#mobileBottomLogBtn');
    if (mobileLogTrigger) {
      event.preventDefault();
      openLogModal();
      return;
    }

    const navTrigger = event.target.closest('[data-nav-view], [data-mobile-nav], [data-mobile-tab]');
    if (navTrigger) {
      event.preventDefault();
      const targetView =
        navTrigger.dataset.navView ||
        navTrigger.dataset.mobileNav ||
        navTrigger.dataset.mobileTab;
      if (targetView) {
        switchView(targetView);
      }
      return;
    }

    const viewUserBtn = event.target.closest('[data-view-user]');
    if (viewUserBtn) {
      event.preventDefault();
      viewUserProfile(viewUserBtn.dataset.viewUser);
      return;
    }

    const switchUserBtn = event.target.closest('[data-switch-user]');
    if (switchUserBtn) {
      event.preventDefault();
      handleSwitchUser(switchUserBtn.dataset.switchUser);
      return;
    }

    const followBtn = event.target.closest('[data-toggle-follow]');
    if (followBtn) {
      event.preventDefault();
      handleToggleFollow(followBtn.dataset.toggleFollow);
      return;
    }

    const userModalBtn = event.target.closest('[data-open-user-modal]');
    if (userModalBtn) {
      event.preventDefault();
      openUserModal(
        userModalBtn.dataset.openUserModal,
        userModalBtn.dataset.userId || state.currentUserId
      );
      return;
    }

    const authTabBtn = event.target.closest('[data-auth-tab]');
    if (authTabBtn) {
      event.preventDefault();
      switchAuthModalTab(authTabBtn.dataset.authTab, state.currentUserId);
      return;
    }

    const signupNextBtn = event.target.closest('[data-signup-next]');
    if (signupNextBtn) {
      event.preventDefault();
      validateAndAdvanceSignupStep(uiState.signupStep || 1);
      return;
    }

    const signupBackBtn = event.target.closest('[data-signup-back]');
    if (signupBackBtn) {
      event.preventDefault();
      const targetStep = Number(signupBackBtn.dataset.signupBack) || 1;
      goToSignupStep(targetStep);
      return;
    }

    const skipFinishBtn = event.target.closest('#signupSkipFinishBtn');
    if (skipFinishBtn) {
      event.preventDefault();
      const lbUser = document.getElementById('signupLetterboxdUsernameInput');
      const lbCsv = document.getElementById('signupLetterboxdCsvInput');
      if (lbUser) lbUser.value = '';
      if (lbCsv) lbCsv.value = '';
      handleSaveUserProfile(new Event('submit', { cancelable: true }));
      return;
    }

    const exportCsvBtn = event.target.closest('[data-export-diary-csv]');
    if (exportCsvBtn) {
      event.preventDefault();
      handleExportDiaryCsv(exportCsvBtn.dataset.exportDiaryCsv);
      return;
    }

    const customMediaBtn = event.target.closest('[data-open-custom-media]');
    if (customMediaBtn) {
      event.preventDefault();
      openCustomMediaModal();
      return;
    }

    const pwToggleBtn = event.target.closest('[data-toggle-pw]');
    if (pwToggleBtn) {
      event.preventDefault();
      const inputId = pwToggleBtn.dataset.togglePw;
      const pwInput = document.getElementById(inputId);
      if (pwInput) {
        const isPassword = pwInput.type === 'password';
        pwInput.type = isPassword ? 'text' : 'password';
        pwToggleBtn.textContent = isPassword ? 'Hide' : 'Show';
      }
      return;
    }

    const fillDemoBtn = event.target.closest('[data-fill-demo-login]');
    if (fillDemoBtn) {
      event.preventDefault();
      const email = fillDemoBtn.dataset.fillDemoLogin;
      const idInput = document.getElementById('loginIdentifierInput');
      const pwInput = document.getElementById('loginPasswordInput');
      if (idInput) idInput.value = email;
      if (pwInput) pwInput.value = 'Omnilog2026!';
      setAuthModalFeedback(`Filled demo credentials for ${email} — click "Sign In to Profile"!`, false);
      return;
    }

    const logoutBtn = event.target.closest('[data-auth-logout]');
    if (logoutBtn) {
      event.preventDefault();
      handleAuthLogout();
      return;
    }

    const feedScopeBtn = event.target.closest('[data-feed-scope]');
    if (feedScopeBtn) {
      uiState.feedScope = feedScopeBtn.dataset.feedScope;
      document.querySelectorAll('[data-feed-scope]').forEach((b) =>
        b.classList.toggle('is-active', b.dataset.feedScope === uiState.feedScope)
      );
      renderActivityFeed();
      return;
    }

    const closeBtn = event.target.closest('[data-close-dialog]');
    if (closeBtn) {
      const dlg = document.getElementById(closeBtn.dataset.closeDialog);
      if (dlg) dlg.close();
      return;
    }

    const detailTrigger = event.target.closest('[data-open-detail]');
    if (detailTrigger) {
      event.preventDefault();
      openDetailModal(detailTrigger.dataset.openDetail);
      return;
    }

    const quickLogBtn = event.target.closest('[data-quick-log]');
    if (quickLogBtn) {
      event.preventDefault();
      openLogModal(quickLogBtn.dataset.quickLog);
      return;
    }

    const detailLogBtn = event.target.closest('[data-detail-log]');
    if (detailLogBtn) {
      document.getElementById('detailDialog')?.close();
      openLogModal(detailLogBtn.dataset.detailLog);
      return;
    }

    const watchlistBtn = event.target.closest('[data-toggle-watchlist]');
    if (watchlistBtn) {
      event.preventDefault();
      handleToggleWatchlist(watchlistBtn.dataset.toggleWatchlist);
      return;
    }

    const ratingStepBtn = event.target.closest('[data-set-rating]');
    if (ratingStepBtn) {
      setHalfStarRating(Number(ratingStepBtn.dataset.setRating));
      return;
    }

    const likeLogBtn = event.target.closest('[data-like-log]');
    if (likeLogBtn) {
      handleLikeLog(likeLogBtn.dataset.likeLog);
      return;
    }

    const revealBtn = event.target.closest('[data-reveal-spoiler]');
    if (revealBtn) {
      uiState.revealedSpoilers.add(revealBtn.dataset.revealSpoiler);
      renderActivityFeed();
      const detailDialog = document.getElementById('detailDialog');
      if (detailDialog?.open && uiState.activeDetailMediaId) {
        openDetailModal(uiState.activeDetailMediaId);
      }
      return;
    }

    const editLogBtn = event.target.closest('[data-edit-log]');
    if (editLogBtn) {
      document.getElementById('detailDialog')?.close();
      const log = state.logs.find((l) => l.id === editLogBtn.dataset.editLog);
      if (log) openLogModal(log.mediaId, log);
      return;
    }

    const bumpBtn = event.target.closest('[data-bump-progress]');
    if (bumpBtn) {
      event.preventDefault();
      handleBumpProgress(bumpBtn.dataset.bumpProgress, bumpBtn.dataset.bumpAction);
      return;
    }

    const finishBtn = event.target.closest('[data-finish-progress]');
    if (finishBtn) {
      event.preventDefault();
      handleBumpProgress(finishBtn.dataset.finishProgress, 'finish');
      return;
    }

    const startTrackingBtn = event.target.closest('[data-start-tracking]');
    if (startTrackingBtn) {
      event.preventDefault();
      handleStartTracking(startTrackingBtn.dataset.startTracking);
      return;
    }

    const deleteLogBtn = event.target.closest('[data-delete-log]');
    if (deleteLogBtn) {
      handleDeleteLog(deleteLogBtn.dataset.deleteLog);
      return;
    }

    const deleteListBtn = event.target.closest('[data-delete-list]');
    if (deleteListBtn) {
      handleDeleteList(deleteListBtn.dataset.deleteList);
      return;
    }

    const editListBtn = event.target.closest('[data-edit-list]');
    if (editListBtn) {
      const list = state.lists.find((l) => l.id === editListBtn.dataset.editList);
      if (list) openCreateListModal(list);
      return;
    }

    const favSlotBtn = event.target.closest('[data-open-fav-picker]');
    if (favSlotBtn) {
      openFavoritePickerModal(favSlotBtn.dataset.openFavPicker, favSlotBtn.dataset.favSlot);
      return;
    }

    // Filter tabs
    const exploreTab = event.target.closest('[data-filter-type]');
    if (exploreTab) {
      uiState.exploreType = exploreTab.dataset.filterType;
      document.querySelectorAll('[data-filter-type]').forEach((b) => {
        const active = b.dataset.filterType === uiState.exploreType;
        b.classList.toggle('is-active', active);
        b.setAttribute('aria-selected', String(active));
      });
      renderCurrentlyWatchingShelf();
      renderExploreCatalog();
      return;
    }

    const feedTab = event.target.closest('[data-feed-type]');
    if (feedTab) {
      uiState.feedType = feedTab.dataset.feedType;
      document.querySelectorAll('[data-feed-type]').forEach((b) =>
        b.classList.toggle('is-active', b.dataset.feedType === uiState.feedType)
      );
      renderActivityFeed();
      return;
    }

    const diaryTab = event.target.closest('[data-diary-type]');
    if (diaryTab) {
      uiState.diaryType = diaryTab.dataset.diaryType;
      document.querySelectorAll('[data-diary-type]').forEach((b) =>
        b.classList.toggle('is-active', b.dataset.diaryType === uiState.diaryType)
      );
      renderDiary();
      return;
    }

    const watchlistTab = event.target.closest('[data-watchlist-type]');
    if (watchlistTab) {
      uiState.watchlistType = watchlistTab.dataset.watchlistType;
      document.querySelectorAll('[data-watchlist-type]').forEach((b) =>
        b.classList.toggle('is-active', b.dataset.watchlistType === uiState.watchlistType)
      );
      renderWatchlist();
    }
  });

  // Top & Mobile CTA buttons
  document.getElementById('openLogModalBtn')?.addEventListener('click', () => openLogModal());
  document.getElementById('mobileBottomLogBtn')?.addEventListener('click', () => openLogModal());
  document.getElementById('openCreateListBtn')?.addEventListener('click', () => openCreateListModal());

  // Search & Filter controls
  const searchInput = document.getElementById('catalogSearchInput');
  searchInput?.addEventListener('input', (e) => {
    uiState.exploreQuery = e.target.value;
    renderExploreCatalog();
  });
  searchInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleLiveExternalSearch();
    }
  });

  document.getElementById('liveApiSearchBtn')?.addEventListener('click', handleLiveExternalSearch);
  document.getElementById('clearExternalResultsBtn')?.addEventListener('click', () => {
    uiState.externalResults = [];
    renderExternalResults();
  });

  document.getElementById('genreFilterSelect')?.addEventListener('change', (e) => {
    uiState.exploreGenre = e.target.value;
    renderExploreCatalog();
  });

  document.getElementById('sortFilterSelect')?.addEventListener('change', (e) => {
    uiState.exploreSort = e.target.value;
    renderExploreCatalog();
  });

  document.getElementById('diarySortSelect')?.addEventListener('change', (e) => {
    uiState.diarySort = e.target.value;
    renderDiary();
  });

  document.getElementById('diarySearchInput')?.addEventListener('input', (e) => {
    uiState.diaryQuery = e.target.value;
    renderDiary();
  });

  document.getElementById('diaryLikedFilterBtn')?.addEventListener('click', (e) => {
    uiState.diaryLikedOnly = !uiState.diaryLikedOnly;
    e.currentTarget.classList.toggle('is-active', uiState.diaryLikedOnly);
    e.currentTarget.setAttribute('aria-pressed', String(uiState.diaryLikedOnly));
    renderDiary();
  });

  document.getElementById('watchlistSortSelect')?.addEventListener('change', (e) => {
    uiState.watchlistSort = e.target.value;
    renderWatchlist();
  });

  document.getElementById('customMediaTypeSelect')?.addEventListener('change', updateCustomMediaLabels);
  document.getElementById('customMediaForm')?.addEventListener('submit', handleSaveCustomMedia);

  // Log form controls
  document.getElementById('logMediaSelect')?.addEventListener('change', () => updateLogModalMediaPreview(false));
  const slider = document.getElementById('logRatingInput');
  slider?.addEventListener('input', (e) => {
    setHalfStarRating(Number(e.target.value));
  });
  // MWG brand-consistent-forms dynamic range progress in Webkit fallback
  if (typeof CSS !== 'undefined' && (!CSS.supports('accent-color', '#d49b4b') || !CSS.supports('accent-color'))) {
    slider?.addEventListener('input', (e) => {
      const val = Number(e.target.value) || 4.5;
      const pct = Math.round(((val - 0.5) / 4.5) * 100);
      e.target.style.setProperty('--progress', `${pct}%`);
    });
  }
  document.getElementById('logBookCurrentPage')?.addEventListener('input', updateBookProgressIndicator);
  document.getElementById('logBookTotalPages')?.addEventListener('input', updateBookProgressIndicator);
  document.getElementById('userPasswordInput')?.addEventListener('input', updatePasswordStrengthMeter);
  document.getElementById('logForm')?.addEventListener('submit', handleSaveLog);
  document.getElementById('createListForm')?.addEventListener('submit', handleCreateList);
  document.getElementById('favoritePickerForm')?.addEventListener('submit', handleSaveFavoriteSlot);
  document.getElementById('userProfileForm')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') {
      const mode = document.getElementById('userFormMode')?.value || 'create';
      if (mode === 'create' && (uiState.signupStep || 1) < 4) {
        e.preventDefault();
        validateAndAdvanceSignupStep(uiState.signupStep || 1);
      }
    }
  });
  document.getElementById('userProfileForm')?.addEventListener('submit', handleSaveUserProfile);
  document.getElementById('authLoginForm')?.addEventListener('submit', handleAuthLogin);
  document.getElementById('authCredentialsForm')?.addEventListener('submit', handleUpdateCredentials);
  document.getElementById('lbRssSyncBtn')?.addEventListener('click', handleLetterboxdRssSync);
  document.getElementById('lbRssUsernameInput')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleLetterboxdRssSync();
    }
  });
  document.getElementById('lbCsvImportBtn')?.addEventListener('click', handleLetterboxdCsvImport);

  // Comment form submission in Feed
  document.addEventListener('submit', (event) => {
    const commentForm = event.target.closest('[data-comment-form]');
    if (commentForm) {
      event.preventDefault();
      const logId = commentForm.dataset.commentForm;
      const input = commentForm.querySelector('input[name="commentText"]');
      if (input && input.value.trim()) {
        handlePostComment(logId, input.value);
        input.value = '';
      }
    }
  });
}

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    bindEvents();
    renderAll();
    syncWithServer();
    if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {
        // SW registration optional in local dev
      });
    }
  });
}
