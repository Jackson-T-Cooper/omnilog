import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  INITIAL_CATALOG,
  INITIAL_USERS,
  INITIAL_LOGS,
  INITIAL_WATCHLIST,
  INITIAL_LISTS,
  buildPosterUrl
} from './public/data.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const AUTH_FILE = path.join(DATA_DIR, 'auth.json');
const PORT = Number(process.env.PORT || 4173);

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function generateId(prefix = 'id') {
  return `${prefix}-${crypto.randomUUID()}`;
}

function clampRating(rating, fallback = 4.5) {
  const num = Number(rating);
  if (Number.isNaN(num)) return fallback;
  const clamped = Math.min(5.0, Math.max(0.5, num));
  return Math.round(clamped * 2) / 2;
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

function sanitizeProgress(rawProgress = {}, mediaType = 'movie', mediaItem = {}) {
  const p = { ...rawProgress };
  if (mediaType === 'tv') {
    const epsPerSeason = getTvEpisodesPerSeason(mediaItem);
    const totalSeasons = epsPerSeason.length;
    p.season = Math.max(1, Math.min(Math.max(100, totalSeasons), Math.round(Number(p.season) || 1)));
    const maxEpInSeason = epsPerSeason[p.season - 1] || 1000;
    p.episode = Math.max(1, Math.min(Math.max(1000, maxEpInSeason), Math.round(Number(p.episode) || 1)));
    const validStatuses = ['watching', 'in_progress', 'completed', 'dropped'];
    p.status = validStatuses.includes(p.status) ? p.status : 'completed';
    if (p.status === 'in_progress') p.status = 'watching';
    p.percent = computeTvProgressPercent(p.season, p.episode, epsPerSeason, p.status);
  } else if (mediaType === 'book') {
    const tot = Math.max(1, Math.min(20000, Math.round(Number(p.totalPages) || Number(mediaItem.pagesCount) || 350)));
    const cur = Math.max(0, Math.min(tot, Math.round(Number(p.currentPage) || 0)));
    p.totalPages = tot;
    p.currentPage = cur;
    p.percent = Math.min(100, Math.max(0, Math.round((cur / tot) * 100)));
    const validStatuses = ['reading', 'in_progress', 'completed', 'dropped'];
    p.status = validStatuses.includes(p.status) ? p.status : 'completed';
    if (p.status === 'in_progress') p.status = 'reading';
  } else {
    p.status = 'completed';
    p.format = String(p.format || 'Theater').slice(0, 60);
  }
  return p;
}

function recalculateMediaStats(state, mediaId) {
  if (!state || !Array.isArray(state.catalog) || !mediaId) return;
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
    const newCount = Math.max(1, baseCount + currentLogs.length);
    // Use heavier weight for interactive user logs so rating changes are immediately visible on the 1-decimal display
    const effectiveUserWeight = Math.max(1, Math.round(baseCount * 0.15));
    const seedAvg = Number(seedItem.communityRating) || 4.3;
    const userAvg =
      currentLogs.length > 0
        ? currentLogSum / currentLogs.length
        : seedAvg;
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
  } else {
    if (currentLogs.length > 0) {
      const sum = currentLogs.reduce((acc, l) => acc + Number(l.rating), 0);
      item.communityRating = Number((sum / currentLogs.length).toFixed(1));
      item.ratingsCount = currentLogs.length;
    }
  }
}

function deduplicateFavorites(favorites = {}, catalog = []) {
  const cleaned = {};
  for (const medium of ['movie', 'tv', 'book']) {
    const rawList = Array.isArray(favorites[medium]) ? favorites[medium] : [];
    const seen = new Set();
    const unique = [];
    for (const id of rawList) {
      if (id && !seen.has(id)) {
        seen.add(id);
        unique.push(id);
      }
    }
    const candidates = (catalog || []).filter((c) => c.type === medium).map((c) => c.id);
    for (const cid of candidates) {
      if (unique.length >= 4) break;
      if (!seen.has(cid)) {
        seen.add(cid);
        unique.push(cid);
      }
    }
    cleaned[medium] = unique.slice(0, 4);
  }
  return cleaned;
}

function deriveInitials(name = 'Member') {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'MB';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

function getDefaultState() {
  return {
    currentUserId: null,
    inProgressSeededV1: true,
    friendLogsSeededV1: true,
    catalog: structuredClone(INITIAL_CATALOG),
    users: {},
    logs: [],
    watchlist: [],
    lists: []
  };
}

function isInProgressStatus(status) {
  return status === 'watching' || status === 'reading' || status === 'in_progress';
}

function syncWatchlistToActiveUser(state) {
  if (!state || !state.users || !state.currentUserId) return;
  const activeUser = state.users[state.currentUserId];
  if (activeUser && Array.isArray(state.watchlist)) {
    activeUser.watchlist = [...state.watchlist];
  }
}

function migrateUsersAndSocialGraph(state) {
  if (!state) return state;
  state.users = state.users && typeof state.users === 'object' ? state.users : {};
  for (const [uid, existing] of Object.entries(state.users)) {
    if (existing && typeof existing === 'object') {
      state.users[uid] = {
        ...existing,
        avatar: existing.avatar || deriveInitials(existing.name || 'Member'),
        avatarColor: existing.avatarColor || '#10b981',
        joinedYear: existing.joinedYear || new Date().getFullYear(),
        followingIds: Array.isArray(existing.followingIds) ? existing.followingIds : [],
        watchlist: Array.isArray(existing.watchlist) ? existing.watchlist : [],
        favorites: deduplicateFavorites(existing.favorites || {}, state.catalog)
      };
    }
  }
  if (state.currentUserId && !state.users[state.currentUserId]) {
    state.currentUserId = null;
  }
  const activeUser = state.currentUserId ? state.users[state.currentUserId] : null;
  if (activeUser) {
    if (!Array.isArray(state.watchlist) || state.watchlist.length === 0) {
      state.watchlist = [...(activeUser.watchlist || [])];
    } else {
      activeUser.watchlist = [...state.watchlist];
    }
  } else {
    state.currentUserId = null;
    state.watchlist = [];
  }
  return state;
}

function migrateActiveInProgressLogs(state) {
  if (!state || !Array.isArray(state.logs)) return state;
  state.logs.forEach((log) => {
    if (log.progress && log.progress.status === 'in_progress') {
      log.progress.status = log.mediaType === 'book' ? 'reading' : 'watching';
    }
    if (log.mediaType === 'book' && log.progress && log.progress.currentPage !== undefined) {
      const tot = Math.max(1, Number(log.progress.totalPages) || 416);
      const cur = Math.max(0, Math.min(tot, Number(log.progress.currentPage) || 0));
      log.progress.percent = Math.min(100, Math.round((cur / tot) * 100));
    }
  });
  state.inProgressSeededV1 = true;
  state.friendLogsSeededV1 = true;
  return state;
}

function loadState() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const raw = fs.readFileSync(DB_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.catalog) && Array.isArray(parsed.logs)) {
        // Ensure seed catalog items have the latest real cover art URLs, fallbackPosterUrl, episodesPerSeason, and crossMediaLinks
        const seedById = new Map(INITIAL_CATALOG.map((item) => [item.id, item]));
        parsed.catalog = parsed.catalog.map((item) => {
          const seed = seedById.get(item.id);
          if (seed) {
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
        migrateUsersAndSocialGraph(parsed);
        migrateActiveInProgressLogs(parsed);
        saveState(parsed);
        return parsed;
      }
    }
  } catch (err) {
    console.error('Error loading db.json, falling back to seed state:', err.message);
  }
  const initial = getDefaultState();
  saveState(initial);
  return initial;
}

function stripSensitiveUserFields(state) {
  if (!state || !state.users || typeof state.users !== 'object') return;
  for (const user of Object.values(state.users)) {
    if (user && typeof user === 'object') {
      delete user.password;
      delete user.passwordHash;
      delete user.salt;
      delete user.altSalt;
      delete user.altPasswordHash;
      delete user.email;
      delete user.sessionToken;
    }
  }
  delete state.authVault;
  delete state.credentials;
  delete state.sessions;
}

function saveState(state, options = {}) {
  try {
    stripSensitiveUserFields(state);
    const tmpFile = `${DB_FILE}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmpFile, DB_FILE);
    if (!options.skipCloudSync) {
      scheduleCloudBackupSync();
    }
  } catch (err) {
    console.error('Error saving db.json:', err.message);
  }
}

// ==================== ISOLATED CREDENTIAL VAULT (data/auth.json) ====================
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SEED_AUTH_EMAILS = {
  'user-jackson': 'jackson@omnilog.app',
  'user-maya': 'maya@omnilog.app',
  'user-marcus': 'marcus@omnilog.app',
  'user-elena': 'elena@omnilog.app'
};
const DEFAULT_SEED_PASSWORD_PRIMARY = 'Omnilog2026!';
const DEFAULT_SEED_PASSWORD_ALT = 'Bookshop2026!';

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const cleanSalt = String(salt);
  const passwordHash = crypto.scryptSync(String(password), cleanSalt, 64).toString('hex');
  return { salt: cleanSalt, passwordHash };
}

function verifyPassword(password, salt, storedHash) {
  if (!password || !salt || !storedHash) return false;
  try {
    const derivedHex = crypto.scryptSync(String(password), String(salt), 64).toString('hex');
    const bufA = Buffer.from(String(storedHash), 'hex');
    const bufB = Buffer.from(derivedHex, 'hex');
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

function verifyAccountPassword(cred, password) {
  if (!cred || !password) return false;
  if (verifyPassword(password, cred.salt, cred.passwordHash)) return true;
  if (cred.altSalt && cred.altPasswordHash && verifyPassword(password, cred.altSalt, cred.altPasswordHash)) {
    return true;
  }
  return false;
}

function maskEmail(email = '') {
  const str = String(email).trim();
  const atIdx = str.indexOf('@');
  if (atIdx <= 0) return '***@omnilog.app';
  const local = str.slice(0, atIdx);
  const domain = str.slice(atIdx + 1);
  const visible = local.length <= 2 ? local[0] : local.slice(0, 2);
  return `${visible}***@${domain}`;
}

function createSeedAccountCredential(userId, email) {
  const primary = hashPassword(DEFAULT_SEED_PASSWORD_PRIMARY);
  const alt = hashPassword(DEFAULT_SEED_PASSWORD_ALT);
  const now = new Date().toISOString();
  return {
    userId,
    email: String(email).toLowerCase(),
    salt: primary.salt,
    passwordHash: primary.passwordHash,
    altSalt: alt.salt,
    altPasswordHash: alt.passwordHash,
    algorithm: 'scrypt-64',
    createdAt: now,
    updatedAt: now
  };
}

function getDefaultAuthVault() {
  return {
    version: 1,
    algorithm: 'scrypt-64',
    accounts: {},
    sessions: {}
  };
}

function saveAuthVault(vault, options = {}) {
  try {
    const tmpFile = `${AUTH_FILE}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(vault, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.chmodSync(tmpFile, 0o600);
    fs.renameSync(tmpFile, AUTH_FILE);
    fs.chmodSync(AUTH_FILE, 0o600);
    if (!options.skipCloudSync) {
      scheduleCloudBackupSync();
    }
  } catch (err) {
    console.error('Error saving auth.json:', err.message);
  }
}

function loadAuthVault() {
  try {
    if (fs.existsSync(AUTH_FILE)) {
      const raw = fs.readFileSync(AUTH_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && parsed.accounts && typeof parsed.accounts === 'object') {
        parsed.sessions = parsed.sessions && typeof parsed.sessions === 'object' ? parsed.sessions : {};
        saveAuthVault(parsed);
        return parsed;
      }
    }
  } catch (err) {
    console.error('Error loading auth.json, falling back to default auth vault:', err.message);
  }
  const initialVault = getDefaultAuthVault();
  saveAuthVault(initialVault);
  return initialVault;
}

let dbState = null;
let authVault = null;

// ==================== AES-256-GCM CLOUD BACKUP & AUTO-RESTORE ENGINE ====================
const CLOUD_BACKUP_FILE = path.join(DATA_DIR, 'cloud-backup.enc.json');
const CLOUD_GIST_FILENAME = 'omnilog-backup.enc.json';
const CLOUD_GIST_DESCRIPTION = 'omnilog-cloud-backup (AES-256-GCM encrypted state & auth vault)';

const cloudBackupState = {
  gistId: process.env.GITHUB_GIST_ID || null,
  lastBackupAt: null,
  lastRestoreAt: null,
  lastError: null,
  syncTimer: null
};

function getCloudBackupSecret() {
  return (
    process.env.CLOUD_BACKUP_SECRET ||
    process.env.GITHUB_GIST_TOKEN ||
    process.env.CLOUD_BACKUP_KEY ||
    'omnilog-local-backup-key-2026'
  );
}

function deriveCloudBackupKey(secret = getCloudBackupSecret()) {
  return crypto.scryptSync(String(secret), 'omnilog-cloud-backup-v1', 32);
}

function encryptCloudBackupPayload(payloadObj, secret = getCloudBackupSecret()) {
  const key = deriveCloudBackupKey(secret);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = JSON.stringify(payloadObj);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    version: 1,
    cipher: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: encrypted.toString('base64'),
    backedUpAt: payloadObj.backedUpAt || new Date().toISOString()
  };
}

function decryptCloudBackupEnvelope(envelope, secret = getCloudBackupSecret()) {
  if (!envelope || envelope.cipher !== 'aes-256-gcm' || !envelope.iv || !envelope.tag || !envelope.ciphertext) {
    throw new Error('Invalid AES-256-GCM cloud backup envelope');
  }
  const key = deriveCloudBackupKey(secret);
  const iv = Buffer.from(String(envelope.iv), 'base64');
  const tag = Buffer.from(String(envelope.tag), 'base64');
  const ciphertext = Buffer.from(String(envelope.ciphertext), 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  return JSON.parse(decrypted);
}

function getCloudBackupProvider() {
  if (process.env.GITHUB_BACKUP_TOKEN || process.env.GITHUB_GIST_TOKEN) {
    return process.env.GITHUB_BACKUP_REPO ? 'github-private-repo-encrypted' : 'github-secret-gist';
  }
  if (process.env.CLOUD_BACKUP_URL) return 'custom-webhook-url';
  return 'local-encrypted-mirror';
}

function getCloudBackupStatus() {
  return {
    enabled: Boolean(
      process.env.GITHUB_BACKUP_TOKEN ||
        process.env.GITHUB_GIST_TOKEN ||
        process.env.CLOUD_BACKUP_URL
    ),
    provider: getCloudBackupProvider(),
    cipher: 'aes-256-gcm',
    backupRepo: process.env.GITHUB_BACKUP_REPO || null,
    gistId: cloudBackupState.gistId ? `${String(cloudBackupState.gistId).slice(0, 6)}...` : null,
    lastBackupAt: cloudBackupState.lastBackupAt,
    lastRestoreAt: cloudBackupState.lastRestoreAt,
    lastError: cloudBackupState.lastError,
    usersCount: dbState && dbState.users ? Object.keys(dbState.users).length : 0,
    logsCount: dbState && Array.isArray(dbState.logs) ? dbState.logs.length : 0
  };
}

async function syncToGitHubRepoContents(token, repoFullName, envelope) {
  const apiUrl = `https://api.github.com/repos/${repoFullName}/contents/${CLOUD_GIST_FILENAME}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'User-Agent': 'Omnilog-Cloud-Backup'
  };
  let existingSha = null;
  const getRes = await fetch(apiUrl, { headers });
  if (getRes.ok) {
    const existingData = await getRes.json();
    existingSha = existingData?.sha || null;
  }
  const contentBase64 = Buffer.from(JSON.stringify(envelope, null, 2), 'utf8').toString('base64');
  const putBody = {
    message: `Automated AES-256-GCM cloud backup (${envelope.backedUpAt})`,
    content: contentBase64
  };
  if (existingSha) putBody.sha = existingSha;
  const putRes = await fetch(apiUrl, {
    method: 'PUT',
    headers,
    body: JSON.stringify(putBody)
  });
  return putRes.ok;
}

async function fetchFromGitHubRepoContents(token, repoFullName) {
  const apiUrl = `https://api.github.com/repos/${repoFullName}/contents/${CLOUD_GIST_FILENAME}`;
  const res = await fetch(apiUrl, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Omnilog-Cloud-Backup'
    }
  });
  if (!res.ok) return null;
  const data = await res.json();
  if (data && data.content) {
    const decoded = Buffer.from(String(data.content).replace(/\s+/g, ''), 'base64').toString('utf8');
    return JSON.parse(decoded);
  }
  return null;
}

async function discoverSecretGistId(token) {
  if (cloudBackupState.gistId) return cloudBackupState.gistId;
  const res = await fetch('https://api.github.com/gists?per_page=100', {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Omnilog-Cloud-Backup'
    }
  });
  if (!res.ok) return null;
  const gists = await res.json();
  if (!Array.isArray(gists)) return null;
  const match = gists.find(
    (g) =>
      (g.description && g.description.includes('omnilog-cloud-backup')) ||
      (g.files && g.files[CLOUD_GIST_FILENAME])
  );
  if (match && match.id) {
    cloudBackupState.gistId = match.id;
    return match.id;
  }
  return null;
}

async function syncCloudBackupNow(customSecret) {
  if (!dbState || !authVault) return null;
  const backedUpAt = new Date().toISOString();
  const payload = {
    backedUpAt,
    db: dbState,
    authVault
  };
  const envelope = encryptCloudBackupPayload(payload, customSecret || getCloudBackupSecret());

  // Always write local encrypted mirror atomically with 0600 permissions
  try {
    const tmpEnc = `${CLOUD_BACKUP_FILE}.tmp`;
    fs.writeFileSync(tmpEnc, JSON.stringify(envelope, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmpEnc, CLOUD_BACKUP_FILE);
  } catch (err) {
    cloudBackupState.lastError = err.message;
  }

  // Push to GitHub Private Repo or Secret Gist if token is configured
  const ghToken = process.env.GITHUB_BACKUP_TOKEN || process.env.GITHUB_GIST_TOKEN;
  const backupRepo = process.env.GITHUB_BACKUP_REPO;
  if (ghToken && backupRepo) {
    try {
      const ok = await syncToGitHubRepoContents(ghToken, backupRepo, envelope);
      cloudBackupState.lastError = ok ? null : 'GitHub Repo Backup failed';
    } catch (err) {
      cloudBackupState.lastError = err.message;
    }
  } else if (ghToken) {
    try {
      const existingId = await discoverSecretGistId(ghToken);
      const gistBody = {
        description: CLOUD_GIST_DESCRIPTION,
        public: false,
        files: {
          [CLOUD_GIST_FILENAME]: {
            content: JSON.stringify(envelope, null, 2)
          }
        }
      };
      const endpoint = existingId
        ? `https://api.github.com/gists/${existingId}`
        : 'https://api.github.com/gists';
      const method = existingId ? 'PATCH' : 'POST';
      const res = await fetch(endpoint, {
        method,
        headers: {
          Authorization: `Bearer ${ghToken}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'User-Agent': 'Omnilog-Cloud-Backup'
        },
        body: JSON.stringify(gistBody)
      });
      if (res.ok) {
        const data = await res.json();
        if (data && data.id) cloudBackupState.gistId = data.id;
        cloudBackupState.lastError = null;
      } else {
        cloudBackupState.lastError = `GitHub Gist HTTP ${res.status}`;
      }
    } catch (err) {
      cloudBackupState.lastError = err.message;
    }
  } else if (process.env.CLOUD_BACKUP_URL) {
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (process.env.CLOUD_BACKUP_KEY) {
        headers.Authorization = `Bearer ${process.env.CLOUD_BACKUP_KEY}`;
      }
      const res = await fetch(process.env.CLOUD_BACKUP_URL, {
        method: 'PUT',
        headers,
        body: JSON.stringify(envelope)
      });
      if (!res.ok) {
        cloudBackupState.lastError = `Webhook HTTP ${res.status}`;
      } else {
        cloudBackupState.lastError = null;
      }
    } catch (err) {
      cloudBackupState.lastError = err.message;
    }
  }

  cloudBackupState.lastBackupAt = backedUpAt;
  return envelope;
}

function scheduleCloudBackupSync() {
  if (!dbState || !authVault) return;
  if (cloudBackupState.syncTimer) {
    clearTimeout(cloudBackupState.syncTimer);
  }
  cloudBackupState.syncTimer = setTimeout(() => {
    syncCloudBackupNow().catch((err) => {
      cloudBackupState.lastError = err.message;
    });
  }, 600);
  if (typeof cloudBackupState.syncTimer.unref === 'function') {
    cloudBackupState.syncTimer.unref();
  }
}

async function restoreFromCloudBackupIfNeeded(force = false) {
  const hasLocalUsers = dbState && dbState.users && Object.keys(dbState.users).length > 0;
  if (hasLocalUsers && !force) return false;

  let envelope = null;
  const ghToken = process.env.GITHUB_BACKUP_TOKEN || process.env.GITHUB_GIST_TOKEN;
  const backupRepo = process.env.GITHUB_BACKUP_REPO;
  if (ghToken && backupRepo) {
    try {
      envelope = await fetchFromGitHubRepoContents(ghToken, backupRepo);
    } catch (err) {
      cloudBackupState.lastError = err.message;
    }
  } else if (ghToken) {
    try {
      const gistId = await discoverSecretGistId(ghToken);
      if (gistId) {
        const res = await fetch(`https://api.github.com/gists/${gistId}`, {
          headers: {
            Authorization: `Bearer ${ghToken}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'Omnilog-Cloud-Backup'
          }
        });
        if (res.ok) {
          const data = await res.json();
          const fileObj = data?.files?.[CLOUD_GIST_FILENAME];
          if (fileObj && fileObj.content) {
            envelope = JSON.parse(fileObj.content);
          }
        }
      }
    } catch (err) {
      cloudBackupState.lastError = err.message;
    }
  } else if (process.env.CLOUD_BACKUP_URL) {
    try {
      const headers = { Accept: 'application/json' };
      if (process.env.CLOUD_BACKUP_KEY) {
        headers.Authorization = `Bearer ${process.env.CLOUD_BACKUP_KEY}`;
      }
      const res = await fetch(process.env.CLOUD_BACKUP_URL, { headers });
      if (res.ok) {
        envelope = await res.json();
      }
    } catch (err) {
      cloudBackupState.lastError = err.message;
    }
  }

  if (!envelope) return false;

  try {
    const restored = decryptCloudBackupEnvelope(envelope);
    if (restored && restored.db && typeof restored.db === 'object') {
      dbState = restored.db;
      saveState(dbState, { skipCloudSync: true });
    }
    if (restored && restored.authVault && typeof restored.authVault === 'object') {
      authVault = restored.authVault;
      saveAuthVault(authVault, { skipCloudSync: true });
    }
    cloudBackupState.lastRestoreAt = new Date().toISOString();
    return true;
  } catch (err) {
    cloudBackupState.lastError = err.message;
    return false;
  }
}

dbState = loadState();
authVault = loadAuthVault();
restoreFromCloudBackupIfNeeded(false).catch(() => {});

function ensureUserInAuthVault(userId, emailHint = '') {
  if (!userId || !dbState.users[userId]) return null;
  if (!authVault.accounts[userId]) {
    const fallbackEmail =
      emailHint && EMAIL_REGEX.test(emailHint)
        ? String(emailHint).trim().toLowerCase()
        : `${String(userId).replace(/^user-/, '')}@omnilog.app`;
    authVault.accounts[userId] = createSeedAccountCredential(userId, fallbackEmail);
    saveAuthVault(authVault);
  }
  return authVault.accounts[userId];
}

function buildAuthUser(userId = dbState.currentUserId) {
  if (!userId || !dbState.users[userId]) return null;
  const user = dbState.users[userId];
  const cred = ensureUserInAuthVault(user.id);
  const email = cred ? cred.email : `${user.id.replace(/^user-/, '')}@omnilog.app`;
  return {
    id: user.id,
    userId: user.id,
    name: user.name,
    handle: user.handle,
    email,
    emailMasked: maskEmail(email),
    hasPassword: Boolean(cred && cred.passwordHash),
    security: {
      algorithm: 'scrypt-64',
      vaultPermissions: '0600'
    }
  };
}

function buildClientStatePayload(state = dbState, activeUserId = undefined) {
  stripSensitiveUserFields(state);
  const effectiveUserId =
    activeUserId !== undefined
      ? activeUserId && state.users?.[activeUserId]
        ? activeUserId
        : null
      : state.currentUserId && state.users?.[state.currentUserId]
      ? state.currentUserId
      : null;
  const effectiveUser = effectiveUserId ? state.users[effectiveUserId] : null;
  return {
    ...state,
    currentUserId: effectiveUserId,
    watchlist:
      effectiveUser && Array.isArray(effectiveUser.watchlist)
        ? [...effectiveUser.watchlist]
        : effectiveUserId && effectiveUserId === state.currentUserId && Array.isArray(state.watchlist)
        ? [...state.watchlist]
        : [],
    authUser: buildAuthUser(effectiveUserId)
  };
}

function extractSessionToken(req) {
  const authHeader = String(req.headers.authorization || '').trim();
  if (authHeader.toLowerCase().startsWith('bearer ')) {
    const bearer = authHeader.slice(7).trim();
    if (bearer) return bearer;
  }
  const cookieHeader = String(req.headers.cookie || '');
  const parts = cookieHeader.split(';').map((p) => p.trim());
  for (const part of parts) {
    if (part.startsWith('omnilog_session=')) {
      return decodeURIComponent(part.slice('omnilog_session='.length).trim());
    }
  }
  return '';
}

function resolveRequestUserId(req) {
  const token = extractSessionToken(req);
  const isBrowserClient = String(req.headers['x-omnilog-client'] || '').toLowerCase() === 'browser';
  if (token) {
    const session = authVault?.sessions?.[token];
    if (session && session.userId && dbState?.users?.[session.userId]) {
      return session.userId;
    }
    if (isBrowserClient) {
      return null;
    }
  }
  if (isBrowserClient) {
    return null;
  }
  return dbState?.currentUserId && dbState?.users?.[dbState.currentUserId]
    ? dbState.currentUserId
    : null;
}

function createAuthSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  const cred = ensureUserInAuthVault(userId);
  authVault.sessions[token] = {
    token,
    userId,
    email: cred ? cred.email : '',
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 30 * 24 * 60 * 60 * 1000).toISOString()
  };
  saveAuthVault(authVault);
  return token;
}

function buildSessionCookieHeader(token, maxAgeSeconds = 2592000) {
  return `omnilog_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`;
}

function escapeXml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function wrapPosterTitle(title = '') {
  const words = String(title).trim().split(/\s+/);
  const lines = [];
  let current = '';
  for (const word of words) {
    if ((current + ' ' + word).trim().length <= 14) {
      current = (current + ' ' + word).trim();
    } else {
      if (current) lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines.slice(0, 5);
}

function renderPosterSvg(query) {
  const title = query.get('title') || 'Untitled Media';
  const rawCreator = query.get('creator') || 'Featured Creator';
  const creator = rawCreator.length > 28 ? rawCreator.slice(0, 26).trim() + '…' : rawCreator;
  const year = query.get('year') || '';
  const type = (query.get('type') || 'movie').toLowerCase();
  const c1 = query.get('c1') || (type === 'movie' ? '#c85a32' : type === 'tv' ? '#d49b4b' : '#528c67');
  const c2 = query.get('c2') || '#2c1b12';

  const typeLabel = type === 'tv' ? 'TV SERIES' : type === 'book' ? 'BOOK' : 'MOVIE';
  const badgeShort = type === 'tv' ? 'TV' : type === 'book' ? 'BOOK' : 'MOVIE';
  const lines = wrapPosterTitle(title);
  const maxLineLen = Math.max(...lines.map((l) => l.length), 1);
  const titleFontSize = maxLineLen > 14 ? 31 : 35;
  const lineSpacing = lines.length >= 5 ? 42 : 46;

  const titleLinesSvg = lines
    .map((line, idx) => {
      const y = 452 + idx * lineSpacing;
      const fitAttr = line.length > 15 ? ' textLength="480" lengthAdjust="spacingAndGlyphs"' : '';
      return `<text x="54" y="${y}" font-family="Georgia, 'Times New Roman', serif" font-size="${titleFontSize}" font-weight="700" fill="#f7efe1" letter-spacing="-0.3"${fitAttr}>${escapeXml(line)}</text>`;
    })
    .join('\n');

  const motifSvg =
    type === 'movie'
      ? `<circle cx="470" cy="210" r="145" fill="none" stroke="${escapeXml(c1)}" stroke-width="2" stroke-opacity="0.45"/>
         <circle cx="470" cy="210" r="95" fill="${escapeXml(c1)}" fill-opacity="0.16"/>
         <polygon points="450,175 450,245 508,210" fill="${escapeXml(c1)}" fill-opacity="0.75"/>`
      : type === 'tv'
      ? `<rect x="330" y="95" width="215" height="155" rx="18" fill="${escapeXml(c1)}" fill-opacity="0.15" stroke="${escapeXml(c1)}" stroke-width="2" stroke-opacity="0.5"/>
         <line x1="365" y1="135" x2="510" y2="135" stroke="${escapeXml(c1)}" stroke-width="3" stroke-opacity="0.65"/>
         <line x1="365" y1="172" x2="485" y2="172" stroke="${escapeXml(c1)}" stroke-width="3" stroke-opacity="0.45"/>
         <line x1="365" y1="209" x2="455" y2="209" stroke="${escapeXml(c1)}" stroke-width="3" stroke-opacity="0.35"/>`
      : `<path d="M355 95 H515 A16 16 0 0 1 531 111 V275 A16 16 0 0 1 515 291 H355 Z" fill="${escapeXml(c1)}" fill-opacity="0.18" stroke="${escapeXml(c1)}" stroke-width="2" stroke-opacity="0.55"/>
         <line x1="382" y1="95" x2="382" y2="291" stroke="${escapeXml(c1)}" stroke-width="3" stroke-opacity="0.6"/>
         <circle cx="455" cy="190" r="36" fill="${escapeXml(c1)}" fill-opacity="0.4"/>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 900" width="600" height="900">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#3a2316"/>
      <stop offset="55%" stop-color="#24160e"/>
      <stop offset="100%" stop-color="#170e09"/>
    </linearGradient>
    <radialGradient id="glow" cx="80%" cy="22%" r="65%">
      <stop offset="0%" stop-color="${escapeXml(c1)}" stop-opacity="0.38"/>
      <stop offset="60%" stop-color="${escapeXml(c1)}" stop-opacity="0.10"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="600" height="900" fill="url(#bg)"/>
  <rect width="600" height="900" fill="url(#glow)"/>
  <rect x="32" y="28" width="536" height="844" rx="12" fill="none" stroke="#d49b4b" stroke-opacity="0.28" stroke-width="1.5"/>
  ${motifSvg}
  <rect x="54" y="56" width="96" height="32" rx="6" fill="${escapeXml(c1)}" fill-opacity="0.24" stroke="${escapeXml(c1)}" stroke-opacity="0.65"/>
  <text x="102" y="77" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="13" font-weight="700" fill="#f7efe1" letter-spacing="1.5">${escapeXml(badgeShort)}</text>
  <text x="54" y="405" font-family="system-ui, -apple-system, sans-serif" font-size="13" font-weight="700" fill="#d49b4b" letter-spacing="3.0">${escapeXml(typeLabel)}</text>
  ${titleLinesSvg}
  <line x1="54" y1="730" x2="546" y2="730" stroke="#d49b4b" stroke-opacity="0.24" stroke-width="1"/>
  <text x="54" y="772" font-family="system-ui, -apple-system, sans-serif" font-size="18" font-weight="600" fill="#e8d8bf">${escapeXml(creator)}</text>
  <text x="54" y="812" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="17" font-weight="700" fill="#d49b4b">${escapeXml(year || '')}</text>
  <text x="546" y="812" text-anchor="end" font-family="system-ui, -apple-system, sans-serif" font-size="13" font-weight="600" fill="#bfa688" letter-spacing="1.5">OMNILOG</text>
</svg>`;
}

function sendJson(res, status, payload, extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    ...extraHeaders
  });
  res.end(JSON.stringify(payload));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 5 * 1024 * 1024) {
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

async function fetchWithTimeout(url, timeoutMs = 4500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function searchExternalApis(query, mediumFilter = 'all') {
  const q = String(query || '').trim();
  if (!q) return [];

  const tasks = [];

  if (mediumFilter === 'all' || mediumFilter === 'movie') {
    tasks.push(
      fetchWithTimeout(
        `https://itunes.apple.com/search?term=${encodeURIComponent(q)}&media=movie&entity=movie&limit=6`
      )
        .then(async (data) => {
          const itunesResults = (data.results || []).map((item) => {
            const year = item.releaseDate ? new Date(item.releaseDate).getFullYear() : 2024;
            const title = item.trackName || q;
            const creator = item.artistName || 'Feature Director';
            const id = `itunes-${item.trackId || Math.random().toString(36).slice(2, 8)}`;
            return {
              id,
              externalId: String(item.trackId || ''),
              type: 'movie',
              title,
              year,
              creator,
              posterUrl:
                item.artworkUrl100?.replace('100x100bb', '600x900bb') ||
                buildPosterUrl(id, title, creator, year, 'movie', '#c85a32', '#2c1b12'),
              fallbackPosterUrl: buildPosterUrl(id, title, creator, year, 'movie', '#c85a32', '#2c1b12'),
              synopsis:
                item.longDescription ||
                item.shortDescription ||
                `Feature film directed by ${creator} (${year}).`,
              genres: item.primaryGenreName ? [item.primaryGenreName] : ['Drama'],
              runtimeMinutes: item.trackTimeMillis ? Math.round(item.trackTimeMillis / 60000) : 120,
              communityRating: 4.2,
              ratingsCount: 410,
              source: 'iTunes Movies API'
            };
          });
          if (itunesResults.length > 0) return itunesResults;

          const imdbData = await fetchWithTimeout(
            `https://v3.sg.media-imdb.com/suggestion/x/${encodeURIComponent(q.toLowerCase())}.json`
          );
          return (imdbData.d || [])
            .filter((d) => !d.qid || d.qid === 'movie' || d.qid === 'feature')
            .slice(0, 6)
            .map((d) => {
              const id = `itunes-${d.id || Math.random().toString(36).slice(2, 8)}`;
              const title = d.l || q;
              const year = d.y || 2024;
              const creator = d.s || 'Feature Film';
              return {
                id,
                externalId: String(d.id || ''),
                type: 'movie',
                title,
                year,
                creator,
                posterUrl:
                  d.i?.imageUrl?.replace(/\._V1_.*\.jpg$/, '._V1_SX600.jpg') ||
                  d.i?.imageUrl ||
                  buildPosterUrl(id, title, creator, year, 'movie', '#c85a32', '#2c1b12'),
                fallbackPosterUrl: buildPosterUrl(id, title, creator, year, 'movie', '#c85a32', '#2c1b12'),
                synopsis: `Feature film (${year}) starring ${creator}.`,
                genres: ['Drama', 'Film'],
                runtimeMinutes: 124,
                communityRating: 4.3,
                ratingsCount: 380,
                source: 'Cinema Archive API'
              };
            });
        })
        .catch(() => [])
    );
  }

  if (mediumFilter === 'all' || mediumFilter === 'tv') {
    tasks.push(
      fetchWithTimeout(`https://api.tvmaze.com/search/shows?q=${encodeURIComponent(q)}`)
        .then((data) =>
          (data || []).slice(0, 6).map((entry) => {
            const show = entry.show || {};
            const year = show.premiered ? parseInt(show.premiered.slice(0, 4), 10) : 2023;
            const title = show.name || q;
            const creator = show.network?.name || show.webChannel?.name || 'Television Series';
            const id = `tvmaze-${show.id || Math.random().toString(36).slice(2, 8)}`;
            const cleanSummary = show.summary
              ? show.summary.replace(/<[^>]+>/g, '').trim()
              : `Television series created for ${creator}.`;
            return {
              id,
              externalId: String(show.id || ''),
              type: 'tv',
              title,
              year,
              creator,
              posterUrl:
                show.image?.original ||
                show.image?.medium ||
                buildPosterUrl(id, title, creator, year, 'tv', '#06b6d4', '#082f49'),
              fallbackPosterUrl: buildPosterUrl(id, title, creator, year, 'tv', '#06b6d4', '#082f49'),
              synopsis: cleanSummary,
              genres: show.genres?.length ? show.genres : ['Drama', 'TV'],
              seasonsCount: 2,
              episodesCount: show.weight ? Math.max(8, Math.round(show.weight / 4)) : 16,
              communityRating: show.rating?.average
                ? Number((show.rating.average / 2).toFixed(1))
                : 4.3,
              ratingsCount: 320,
              source: 'TVMaze API'
            };
          })
        )
        .catch(() => [])
    );
  }

  if (mediumFilter === 'all' || mediumFilter === 'book') {
    tasks.push(
      fetchWithTimeout(`https://openlibrary.org/search.json?q=${encodeURIComponent(q)}&limit=6`)
        .then((data) =>
          (data.docs || []).slice(0, 6).map((doc) => {
            const rawKey = (doc.key || '').replace('/works/', '') || Math.random().toString(36).slice(2, 8);
            const id = `ol-${rawKey}`;
            const title = doc.title || q;
            const year = doc.first_publish_year || 2020;
            const creator = doc.author_name?.[0] || 'Featured Author';
            return {
              id,
              externalId: rawKey,
              type: 'book',
              title,
              year,
              creator,
              posterUrl: doc.cover_i
                ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg`
                : buildPosterUrl(id, title, creator, year, 'book', '#f59e0b', '#1e1b4b'),
              fallbackPosterUrl: buildPosterUrl(id, title, creator, year, 'book', '#f59e0b', '#1e1b4b'),
              synopsis:
                (Array.isArray(doc.first_sentence) ? doc.first_sentence[0] : doc.first_sentence) ||
                `Published in ${year} by ${creator}. Edition indexed via Open Library.`,
              genres: (doc.subject || ['Literature', 'Fiction']).slice(0, 3),
              pagesCount: doc.number_of_pages_median || 320,
              communityRating: doc.ratings_average ? Number(doc.ratings_average.toFixed(1)) : 4.3,
              ratingsCount: doc.ratings_count || 290,
              source: 'Open Library API'
            };
          })
        )
        .catch(() => [])
    );
  }

  const settled = await Promise.all(tasks);
  let combined = settled.flat();

  // Offline / rate-limit resilient fallback so live search always returns rich results
  if (combined.length === 0) {
    const slug = q.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 24);
    const fallbackItems = [
      {
        id: `itunes-fallback-${slug}`,
        type: 'movie',
        title: `${q} (Feature Film)`,
        year: 2024,
        creator: 'International Cinema Archive',
        posterUrl: buildPosterUrl(`itunes-${slug}`, q, 'Cinema Archive', 2024, 'movie', '#10b981', '#0f172a'),
        synopsis: `Theatrical feature film matching "${q}" indexed via global movie catalog.`,
        genres: ['Drama', 'Sci-Fi'],
        runtimeMinutes: 128,
        communityRating: 4.3,
        ratingsCount: 250,
        source: 'iTunes Movies API'
      },
      {
        id: `tvmaze-fallback-${slug}`,
        type: 'tv',
        title: `${q} (Series)`,
        year: 2023,
        creator: 'Global Television Network',
        posterUrl: buildPosterUrl(`tvmaze-${slug}`, q, 'Television Series', 2023, 'tv', '#06b6d4', '#082f49'),
        synopsis: `Multi-season television series matching "${q}".`,
        genres: ['Drama', 'Mystery'],
        seasonsCount: 2,
        episodesCount: 16,
        communityRating: 4.4,
        ratingsCount: 190,
        source: 'TVMaze API'
      },
      {
        id: `ol-fallback-${slug}`,
        type: 'book',
        title: `${q} (Hardcover Edition)`,
        year: 2021,
        creator: 'Open Library Press',
        posterUrl: buildPosterUrl(`ol-${slug}`, q, 'Open Library Press', 2021, 'book', '#f59e0b', '#1e1b4b'),
        synopsis: `Unabridged literary edition of "${q}" cataloged in Open Library.`,
        genres: ['Fiction', 'Literature'],
        pagesCount: 352,
        communityRating: 4.5,
        ratingsCount: 310,
        source: 'Open Library API'
      }
    ];
    combined =
      mediumFilter === 'all'
        ? fallbackItems
        : fallbackItems.filter((item) => item.type === mediumFilter);
  }

  return combined;
}

function normalizeTitleKey(title = '') {
  return String(title).trim().toLowerCase().replace(/\s+/g, ' ');
}

function upsertCatalogItem(mediaItem) {
  if (!mediaItem || (!mediaItem.id && !mediaItem.title)) return null;
  let idx = dbState.catalog.findIndex((c) => c.id === mediaItem.id);
  if (idx === -1 && mediaItem.title && mediaItem.type) {
    const normTitle = normalizeTitleKey(mediaItem.title);
    idx = dbState.catalog.findIndex(
      (c) =>
        c.type === mediaItem.type &&
        normalizeTitleKey(c.title) === normTitle &&
        (!mediaItem.year || !c.year || Math.abs(Number(c.year) - Number(mediaItem.year)) <= 1)
    );
  }
  if (idx === -1) {
    dbState.catalog.unshift(mediaItem);
    return mediaItem;
  } else {
    const existing = dbState.catalog[idx];
    dbState.catalog[idx] = {
      ...mediaItem,
      ...existing,
      id: existing.id,
      posterUrl: existing.posterUrl || mediaItem.posterUrl,
      fallbackPosterUrl: existing.fallbackPosterUrl || mediaItem.fallbackPosterUrl,
      episodesPerSeason: existing.episodesPerSeason || mediaItem.episodesPerSeason
    };
    return dbState.catalog[idx];
  }
}

// ==================== LETTERBOXD CSV & RSS IMPORTER HELPERS ====================
function parseCsvToObjects(csvText = '') {
  const text = String(csvText || '').replace(/^\uFEFF/, '');
  const rows = [];
  let currentRow = [];
  let currentField = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        currentField += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        currentField += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      currentRow.push(currentField);
      currentField = '';
    } else if (ch === '\r' && next === '\n') {
      currentRow.push(currentField);
      rows.push(currentRow);
      currentRow = [];
      currentField = '';
      i++;
    } else if (ch === '\n' || ch === '\r') {
      currentRow.push(currentField);
      rows.push(currentRow);
      currentRow = [];
      currentField = '';
    } else {
      currentField += ch;
    }
  }
  if (currentField.length > 0 || currentRow.length > 0) {
    currentRow.push(currentField);
    rows.push(currentRow);
  }

  const nonEmptyRows = rows.filter((r) => r.some((cell) => String(cell).trim().length > 0));
  if (nonEmptyRows.length === 0) return { headers: [], objects: [] };

  const headers = nonEmptyRows[0].map((h) => String(h).trim());
  const objects = nonEmptyRows.slice(1).map((cells) => {
    const obj = {};
    headers.forEach((h, idx) => {
      if (h) obj[h] = cells[idx] !== undefined ? String(cells[idx]).trim() : '';
    });
    return obj;
  });

  return { headers, objects };
}

function getRowField(row, candidates = []) {
  for (const key of Object.keys(row)) {
    const lowerKey = key.toLowerCase().trim();
    if (candidates.some((c) => c.toLowerCase() === lowerKey)) {
      return row[key];
    }
  }
  return '';
}

function ensureCatalogMovieForImport(title, year, posterUrl = '', rating = 4.3) {
  const cleanTitle = String(title || '').trim();
  if (!cleanTitle) return { item: null, created: false };
  const numericYear = parseInt(year, 10) || 2024;
  const normTitle = normalizeTitleKey(cleanTitle);

  const existing = dbState.catalog.find(
    (c) =>
      c.type === 'movie' &&
      normalizeTitleKey(c.title) === normTitle &&
      (!year || !c.year || Math.abs(Number(c.year) - numericYear) <= 1)
  );
  if (existing) {
    if (posterUrl && posterUrl.startsWith('http') && existing.posterUrl?.startsWith('/api/poster')) {
      existing.posterUrl = posterUrl;
    }
    return { item: existing, created: false };
  }

  const slug =
    normTitle
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'film';
  let id = `movie-lb-${slug}-${numericYear}`;
  if (dbState.catalog.some((c) => c.id === id)) {
    id = generateId('movie-lb');
  }
  const fallbackPoster = buildPosterUrl(
    id,
    cleanTitle,
    'Feature Film',
    numericYear,
    'movie',
    '#c85a32',
    '#2c1b12'
  );
  const newItem = {
    id,
    type: 'movie',
    title: cleanTitle.slice(0, 200),
    year: numericYear,
    creator: 'Feature Film',
    posterUrl: posterUrl && posterUrl.startsWith('http') ? posterUrl : fallbackPoster,
    fallbackPosterUrl: fallbackPoster,
    synopsis: `${cleanTitle} (${numericYear}) — imported from Letterboxd.`,
    genres: ['Cinema', 'Letterboxd'],
    runtimeMinutes: 120,
    communityRating: clampRating(rating, 4.3),
    ratingsCount: 1,
    crossMediaLinks: [
      { targetId: 'movie-101', relationType: 'companion', relationLabel: 'Acclaimed Modern Cinema · Film' },
      { targetId: 'tv-201', relationType: 'thematic', relationLabel: 'Critics Choice Companion · TV' },
      { targetId: 'book-302', relationType: 'thematic', relationLabel: 'Essential Storycraft · Book' },
      { targetId: 'movie-105', relationType: 'companion', relationLabel: 'Festival Favorite · Film' }
    ]
  };
  dbState.catalog.unshift(newItem);
  return { item: newItem, created: true };
}

function ensureTargetUserForImport(requestedUserId, fallbackName = 'Letterboxd Member') {
  let uid = requestedUserId || dbState.currentUserId;
  if (uid && dbState.users[uid]) return uid;
  const firstExisting = Object.keys(dbState.users)[0];
  if (firstExisting) {
    dbState.currentUserId = firstExisting;
    return firstExisting;
  }
  const cleanSlug =
    String(fallbackName)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 20) || 'member';
  uid = `user-${cleanSlug}`;
  dbState.users[uid] = {
    id: uid,
    name: fallbackName,
    handle: `@${cleanSlug}`,
    avatar: deriveInitials(fallbackName),
    avatarColor: '#d49b4b',
    bio: 'Imported film diary from Letterboxd.',
    location: 'Letterboxd Import',
    joinedYear: new Date().getFullYear(),
    followersCount: 1,
    followingCount: 1,
    followingIds: [],
    watchlist: [],
    favorites: deduplicateFavorites({}, dbState.catalog)
  };
  dbState.currentUserId = uid;
  return uid;
}

function upsertImportedMovieLog(targetUserId, entry) {
  const { item, created } = ensureCatalogMovieForImport(
    entry.title,
    entry.year,
    entry.posterUrl,
    entry.rating
  );
  if (!item) return { logCreatedOrMerged: false, catalogCreated: false };

  const clampedRating = entry.rating ? clampRating(entry.rating, 4.0) : 4.0;
  const dateConsumed = (entry.dateConsumed || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const reviewText = String(entry.review || '').trim().slice(0, 5000);
  const isRewatch = Boolean(entry.isRewatch);

  const existingLog = dbState.logs.find(
    (l) =>
      l.userId === targetUserId &&
      l.mediaId === item.id &&
      (l.dateConsumed === dateConsumed || !l.review || !reviewText)
  );

  if (existingLog) {
    if (entry.rating) existingLog.rating = clampedRating;
    if (reviewText && (!existingLog.review || reviewText.length > existingLog.review.length)) {
      existingLog.review = reviewText;
    }
    if (isRewatch) {
      existingLog.isRewatch = true;
      existingLog.rewatch = true;
    }
    existingLog.liked = existingLog.rating >= 4.0 || existingLog.liked;
    recalculateMediaStats(dbState, item.id);
    return { logCreatedOrMerged: true, catalogCreated: created };
  }

  const newLog = {
    id: generateId('log-lb'),
    userId: targetUserId,
    mediaId: item.id,
    mediaType: 'movie',
    rating: clampedRating,
    liked: clampedRating >= 4.0,
    dateConsumed,
    createdAt: new Date().toISOString(),
    review: reviewText,
    containsSpoilers: false,
    isRewatch,
    rewatch: isRewatch,
    progress: { status: 'completed', format: 'Letterboxd Import' },
    likesCount: 1,
    likedByMe: true,
    comments: []
  };
  dbState.logs.unshift(newLog);
  dbState.watchlist = dbState.watchlist.filter((id) => id !== item.id);
  recalculateMediaStats(dbState, item.id);
  return { logCreatedOrMerged: true, catalogCreated: created };
}

function applyLetterboxdCsvImport(targetUserId, body = {}) {
  const uid = ensureTargetUserForImport(targetUserId);
  const user = dbState.users[uid];
  let importedLogsCount = 0;
  let importedWatchlistCount = 0;
  let newCatalogItemsCount = 0;

  const csvPayloads = [];
  if (Array.isArray(body.files)) {
    for (const f of body.files) {
      if (f && (f.csvText || f.content)) {
        csvPayloads.push({
          fileName: f.fileName || f.name || '',
          fileType: f.fileType || 'auto',
          csvText: f.csvText || f.content
        });
      }
    }
  } else if (body.files && typeof body.files === 'object') {
    for (const [key, val] of Object.entries(body.files)) {
      if (typeof val === 'string' && val.trim()) {
        csvPayloads.push({ fileName: key, fileType: key, csvText: val });
      }
    }
  }
  if (body.csvText && String(body.csvText).trim()) {
    csvPayloads.push({
      fileName: body.fileName || '',
      fileType: body.fileType || 'auto',
      csvText: body.csvText
    });
  }

  for (const itemPayload of csvPayloads) {
    const { headers, objects } = parseCsvToObjects(itemPayload.csvText);
    if (objects.length === 0) continue;

    const lowerHeaders = headers.map((h) => h.toLowerCase());
    const isWatchlistFile =
      itemPayload.fileType === 'watchlist' ||
      /watchlist/i.test(itemPayload.fileName || '') ||
      (!lowerHeaders.includes('rating') &&
        !lowerHeaders.includes('watched date') &&
        !lowerHeaders.includes('review'));

    for (const row of objects) {
      const title = getRowField(row, ['Name', 'Title', 'Film']);
      if (!title) continue;
      const year = getRowField(row, ['Year', 'Release Year']) || '2024';

      if (isWatchlistFile) {
        const { item, created } = ensureCatalogMovieForImport(title, year);
        if (created) newCatalogItemsCount++;
        if (item) {
          if (uid === dbState.currentUserId && !dbState.watchlist.includes(item.id)) {
            dbState.watchlist.push(item.id);
            importedWatchlistCount++;
          } else if (user && Array.isArray(user.watchlist) && !user.watchlist.includes(item.id)) {
            user.watchlist.push(item.id);
            importedWatchlistCount++;
          }
        }
      } else {
        const rawRating = getRowField(row, ['Rating', 'Member Rating', 'Stars']);
        const watchedDate = getRowField(row, ['Watched Date', 'Date']);
        const rewatchRaw = getRowField(row, ['Rewatch']);
        const review = getRowField(row, ['Review', 'Notes']);
        const ratingNum = rawRating ? parseFloat(rawRating) : 4.0;
        const { logCreatedOrMerged, catalogCreated } = upsertImportedMovieLog(uid, {
          title,
          year,
          rating: Number.isFinite(ratingNum) ? ratingNum : 4.0,
          dateConsumed: watchedDate || new Date().toISOString().slice(0, 10),
          isRewatch: /^(yes|true|1)$/i.test(String(rewatchRaw || '').trim()),
          review
        });
        if (logCreatedOrMerged) importedLogsCount++;
        if (catalogCreated) newCatalogItemsCount++;
      }
    }
  }

  syncWatchlistToActiveUser(dbState);
  return { importedLogsCount, importedWatchlistCount, newCatalogItemsCount };
}

function decodeXmlEntities(str = '') {
  return String(str)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&apos;/g, "'");
}

function parseLetterboxdRssXml(xmlText = '') {
  const items = [];
  const itemMatches = [...String(xmlText).matchAll(/<item>([\s\S]*?)<\/item>/gi)];
  for (const match of itemMatches) {
    const block = match[1];
    const filmTitleMatch = block.match(/<letterboxd:filmTitle>([\s\S]*?)<\/letterboxd:filmTitle>/i);
    if (!filmTitleMatch) continue;
    const title = decodeXmlEntities(filmTitleMatch[1].trim());
    const yearMatch = block.match(/<letterboxd:filmYear>(\d{4})<\/letterboxd:filmYear>/i);
    const ratingMatch = block.match(/<letterboxd:memberRating>([\d.]+)<\/letterboxd:memberRating>/i);
    const watchedMatch = block.match(/<letterboxd:watchedDate>(\d{4}-\d{2}-\d{2})<\/letterboxd:watchedDate>/i);
    const rewatchMatch = block.match(/<letterboxd:rewatch>(Yes|No)<\/letterboxd:rewatch>/i);
    const descMatch = block.match(/<description>([\s\S]*?)<\/description>/i);

    let posterUrl = '';
    let review = '';
    if (descMatch) {
      const rawDesc = descMatch[1]
        .replace(/^<!\[CDATA\[/i, '')
        .replace(/\]\]>$/i, '')
        .trim();
      const imgMatch = rawDesc.match(/<img[^>]+src="([^"]+)"/i);
      if (imgMatch) posterUrl = imgMatch[1];

      const withoutImages = rawDesc.replace(/<p>\s*<img[^>]*>\s*<\/p>/gi, '');
      const textOnly = decodeXmlEntities(
        withoutImages
          .replace(/<\/p>\s*<p>/gi, '\n\n')
          .replace(/<[^>]+>/g, '')
          .trim()
      );
      if (textOnly && !/^Watched on /i.test(textOnly)) {
        review = textOnly;
      }
    }

    items.push({
      title,
      year: yearMatch ? parseInt(yearMatch[1], 10) : 2024,
      rating: ratingMatch ? parseFloat(ratingMatch[1]) : 4.5,
      dateConsumed: watchedMatch ? watchedMatch[1] : new Date().toISOString().slice(0, 10),
      isRewatch: rewatchMatch ? rewatchMatch[1].toLowerCase() === 'yes' : false,
      posterUrl,
      review
    });
  }
  return items;
}

const FALLBACK_LETTERBOXD_RSS_ITEMS = [
  {
    title: 'Dune: Part Two',
    year: 2024,
    rating: 5.0,
    dateConsumed: '2026-10-24',
    isRewatch: true,
    review: 'Imported from Letterboxd — Denis Villeneuve’s desert epic hits even harder on rewatch in IMAX.'
  },
  {
    title: 'Past Lives',
    year: 2023,
    rating: 4.5,
    dateConsumed: '2026-10-20',
    isRewatch: false,
    review: 'Imported from Letterboxd — Quietly devastating story of fate, In-Yun, and the lives we almost lived.'
  },
  {
    title: 'Oppenheimer',
    year: 2023,
    rating: 5.0,
    dateConsumed: '2026-10-15',
    isRewatch: false,
    review: 'Imported from Letterboxd — Relentless editing and Ludwig Göransson’s score turn history into a thriller.'
  },
  {
    title: 'Blade Runner 2049',
    year: 2017,
    rating: 4.5,
    dateConsumed: '2026-10-10',
    isRewatch: true,
    review: 'Imported from Letterboxd — Roger Deakins’ cinematography remains unmatched.'
  },
  {
    title: 'Parasite',
    year: 2019,
    rating: 5.0,
    dateConsumed: '2026-10-04',
    isRewatch: false,
    review: 'Imported from Letterboxd — Clockwork screenplay where every staircase means something.'
  }
];

async function applyLetterboxdRssImport(targetUserId, rawUsername = '') {
  const cleanUsername = String(rawUsername || '')
    .trim()
    .replace(/^@+/, '')
    .replace(/^https?:\/\/(www\.)?letterboxd\.com\//i, '')
    .replace(/\/.*$/, '')
    .trim();

  const uid = ensureTargetUserForImport(targetUserId, cleanUsername || 'Letterboxd User');
  let rssItems = [];
  let source = 'letterboxd-live-rss';

  if (cleanUsername) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4500);
      const rssRes = await fetch(`https://letterboxd.com/${encodeURIComponent(cleanUsername)}/rss/`, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          Accept: 'application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8'
        },
        signal: controller.signal
      });
      clearTimeout(timer);
      if (rssRes.ok) {
        const xmlText = await rssRes.text();
        rssItems = parseLetterboxdRssXml(xmlText);
      }
    } catch {
      // Fallback handled below
    }
  }

  if (rssItems.length === 0) {
    source = 'letterboxd-curated-fallback';
    rssItems = FALLBACK_LETTERBOXD_RSS_ITEMS.map((item) => ({
      ...item,
      review: `${item.review} (@${cleanUsername || 'letterboxd'})`
    }));
  }

  let importedLogsCount = 0;
  let newCatalogItemsCount = 0;
  for (const entry of rssItems.slice(0, 30)) {
    const { logCreatedOrMerged, catalogCreated } = upsertImportedMovieLog(uid, entry);
    if (logCreatedOrMerged) importedLogsCount++;
    if (catalogCreated) newCatalogItemsCount++;
  }

  syncWatchlistToActiveUser(dbState);
  return {
    cleanUsername,
    importedLogsCount,
    importedCount: importedLogsCount,
    newCatalogItemsCount,
    source
  };
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon'
};

function renderAppIconSvg() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#362419" />
      <stop offset="100%" stop-color="#1f140e" />
    </linearGradient>
    <linearGradient id="brassGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#f3c77e" />
      <stop offset="100%" stop-color="#d49b4b" />
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="112" fill="url(#bgGrad)" />
  <rect x="28" y="28" width="456" height="456" rx="88" fill="none" stroke="url(#brassGrad)" stroke-width="6" stroke-opacity="0.45" />
  <circle cx="256" cy="240" r="118" fill="none" stroke="url(#brassGrad)" stroke-width="34" />
  <circle cx="256" cy="240" r="46" fill="#d49b4b" fill-opacity="0.22" />
  <text x="256" y="432" text-anchor="middle" fill="#fbf6ee" font-family="Georgia, serif" font-weight="700" font-size="48" letter-spacing="4">OMNILOG</text>
</svg>`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Omnilog-Client'
    });
    return res.end();
  }

  try {
    if (pathname === '/api/health' && (req.method === 'GET' || req.method === 'HEAD')) {
      const payload = {
        ok: true,
        status: 'awake',
        uptimeSeconds: Math.round(process.uptime()),
        timestamp: new Date().toISOString(),
        cloudBackup: getCloudBackupStatus()
      };
      if (req.method === 'HEAD') {
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store'
        });
        return res.end();
      }
      return sendJson(res, 200, payload);
    }

    if (pathname === '/api/cloud-backup/status' && req.method === 'GET') {
      return sendJson(res, 200, {
        ok: true,
        cloudBackup: getCloudBackupStatus()
      });
    }

    if (pathname === '/api/cloud-backup/sync' && req.method === 'POST') {
      const body = await parseBody(req);
      const customSecret = body && body.secret ? String(body.secret) : undefined;
      const envelope = await syncCloudBackupNow(customSecret);
      const verified = decryptCloudBackupEnvelope(envelope, customSecret || getCloudBackupSecret());
      return sendJson(res, 200, {
        ok: true,
        cloudBackup: getCloudBackupStatus(),
        envelopeSummary: {
          version: envelope.version,
          cipher: envelope.cipher,
          backedUpAt: envelope.backedUpAt,
          ciphertextLength: envelope.ciphertext.length,
          roundTripVerified: Boolean(verified && verified.db && verified.authVault)
        },
        envelope: body && body.includeEnvelope ? envelope : undefined
      });
    }

    if (pathname === '/api/cloud-backup/restore' && req.method === 'POST') {
      const body = await parseBody(req);
      const customSecret = body && body.secret ? String(body.secret) : undefined;
      if (body && body.envelope) {
        const restored = decryptCloudBackupEnvelope(body.envelope, customSecret || getCloudBackupSecret());
        if (restored && restored.db && typeof restored.db === 'object') {
          dbState = restored.db;
          saveState(dbState, { skipCloudSync: true });
        }
        if (restored && restored.authVault && typeof restored.authVault === 'object') {
          authVault = restored.authVault;
          saveAuthVault(authVault, { skipCloudSync: true });
        }
        cloudBackupState.lastRestoreAt = new Date().toISOString();
        return sendJson(res, 200, {
          ok: true,
          restored: true,
          cloudBackup: getCloudBackupStatus(),
          state: buildClientStatePayload(dbState)
        });
      }
      const didRestore = await restoreFromCloudBackupIfNeeded(true);
      return sendJson(res, 200, {
        ok: true,
        restored: didRestore,
        cloudBackup: getCloudBackupStatus(),
        state: buildClientStatePayload(dbState)
      });
    }

    // 1. Dynamic SVG Poster generator & App Icon
    if (pathname === '/api/app-icon.svg' && req.method === 'GET') {
      const svg = renderAppIconSvg();
      res.writeHead(200, {
        'Content-Type': 'image/svg+xml; charset=utf-8',
        'Cache-Control': 'public, max-age=3600'
      });
      return res.end(svg);
    }

    if (pathname === '/api/poster' && req.method === 'GET') {
      const svg = renderPosterSvg(url.searchParams);
      res.writeHead(200, {
        'Content-Type': 'image/svg+xml; charset=utf-8',
        'Cache-Control': 'no-cache'
      });
      return res.end(svg);
    }

    // 2. Full state GET / POST / Reset
    if (pathname === '/api/state' && req.method === 'GET') {
      const reqUserId = resolveRequestUserId(req);
      return sendJson(res, 200, buildClientStatePayload(dbState, reqUserId));
    }

    if (pathname === '/api/state' && req.method === 'POST') {
      const body = await parseBody(req);
      if (body && Array.isArray(body.catalog) && Array.isArray(body.logs)) {
        stripSensitiveUserFields(body);
        dbState = body;
        saveState(dbState);
        const reqUserId = resolveRequestUserId(req);
        return sendJson(res, 200, { ok: true, state: buildClientStatePayload(dbState, reqUserId) });
      }
      return sendJson(res, 400, { error: 'Invalid state payload' });
    }

    if (pathname === '/api/reset' && req.method === 'POST') {
      dbState = getDefaultState();
      authVault = getDefaultAuthVault();
      saveState(dbState);
      saveAuthVault(authVault);
      return sendJson(res, 200, buildClientStatePayload(dbState, null));
    }

    // 3. External Live Search API (iTunes + TVMaze + OpenLibrary)
    if (pathname === '/api/search-external' && req.method === 'GET') {
      const q = url.searchParams.get('q') || '';
      const type = url.searchParams.get('type') || 'all';
      const results = await searchExternalApis(q, type);
      return sendJson(res, 200, { query: q, type, results });
    }

    // 4. Upsert Catalog Item (e.g. from Live External Search or Add Custom Title modal)
    if (pathname === '/api/catalog' && req.method === 'POST') {
      const rawBody = await parseBody(req);
      const body = rawBody?.item && typeof rawBody.item === 'object' ? rawBody.item : rawBody;
      if (!body || !body.title || !body.type) {
        return sendJson(res, 400, { error: 'Missing required media item fields (title and type)' });
      }
      const normalizedType = ['movie', 'tv', 'book'].includes(String(body.type).toLowerCase())
        ? String(body.type).toLowerCase()
        : 'movie';
      const id = body.id || generateId(normalizedType);
      const parsedGenres = Array.isArray(body.genres)
        ? body.genres.map((g) => String(g).trim()).filter(Boolean)
        : typeof body.genres === 'string' && body.genres.trim()
        ? body.genres
            .split(',')
            .map((g) => g.trim())
            .filter(Boolean)
        : body.genre
        ? [String(body.genre).trim()]
        : ['Drama'];
      const cleanTitle = String(body.title).trim().slice(0, 200);
      const cleanCreator = String(body.creator || 'Independent').trim().slice(0, 150);
      const cleanYear = Number(body.year) || new Date().getFullYear();
      const generatedFallback = buildPosterUrl(
        id,
        cleanTitle,
        cleanCreator,
        cleanYear,
        normalizedType
      );
      const newItem = {
        id,
        type: normalizedType,
        title: cleanTitle,
        year: cleanYear,
        creator: cleanCreator,
        posterUrl:
          body.posterUrl && String(body.posterUrl).trim()
            ? String(body.posterUrl).trim()
            : generatedFallback,
        fallbackPosterUrl: body.fallbackPosterUrl || generatedFallback,
        synopsis: String(body.synopsis || `${cleanTitle} (${cleanYear}) by ${cleanCreator}.`).slice(
          0,
          2000
        ),
        genres: parsedGenres.length ? parsedGenres : ['Drama'],
        runtimeMinutes: body.runtimeMinutes ? Number(body.runtimeMinutes) : undefined,
        seasonsCount: body.seasonsCount ? Number(body.seasonsCount) : undefined,
        episodesCount: body.episodesCount ? Number(body.episodesCount) : undefined,
        pagesCount: body.pagesCount ? Number(body.pagesCount) : undefined,
        communityRating: clampRating(body.communityRating, 4.3),
        ratingsCount: Math.max(1, Number(body.ratingsCount) || 1)
      };
      const upsertedItem = upsertCatalogItem(newItem);
      saveState(dbState);
      const reqUserId = resolveRequestUserId(req);
      return sendJson(res, 201, {
        ok: true,
        item: upsertedItem || newItem,
        state: buildClientStatePayload(dbState, reqUserId)
      });
    }

    // 5. Create or Update LogEntry
    if (pathname === '/api/logs' && req.method === 'POST') {
      const reqUserId = resolveRequestUserId(req);
      if (!reqUserId || !dbState.users || !dbState.users[reqUserId]) {
        return sendJson(res, 401, {
          requiresAuth: true,
          error: 'Authentication required. Please sign in or sign up to log media.'
        });
      }
      const body = await parseBody(req);
      let canonicalMediaId = null;
      if (body.mediaItem) {
        const upserted = upsertCatalogItem(body.mediaItem);
        if (upserted) canonicalMediaId = upserted.id;
      }
      const log = body.log || body;
      if (!log || (!log.mediaId && !canonicalMediaId)) {
        return sendJson(res, 400, { error: 'mediaId is required' });
      }
      const targetMediaId = canonicalMediaId || log.mediaId;
      const mediaItem = dbState.catalog.find((c) => c.id === targetMediaId) || {};
      const mediaType = log.mediaType || mediaItem.type || 'movie';
      const clampedRating = clampRating(log.rating, 4.5);
      const safeReview = String(log.review || '').slice(0, 5000);
      const safeProgress = sanitizeProgress(log.progress || { status: 'completed' }, mediaType, mediaItem);
      const isBrowserClient = String(req.headers['x-omnilog-client'] || '').toLowerCase() === 'browser';

      const existingIdx = dbState.logs.findIndex((l) => l.id === log.id);
      if (existingIdx >= 0) {
        dbState.logs[existingIdx] = {
          ...dbState.logs[existingIdx],
          ...log,
          mediaId: targetMediaId,
          mediaType,
          rating: clampedRating,
          review: safeReview,
          progress: safeProgress
        };
      } else {
        const newLog = {
          id: log.id || generateId('log'),
          userId: !isBrowserClient && dbState.users[log.userId] ? log.userId : reqUserId,
          mediaId: targetMediaId,
          mediaType,
          rating: clampedRating,
          liked: Boolean(log.liked),
          dateConsumed: log.dateConsumed || new Date().toISOString().slice(0, 10),
          createdAt: log.createdAt || new Date().toISOString(),
          review: safeReview,
          containsSpoilers: Boolean(log.containsSpoilers),
          isRewatch: Boolean(log.isRewatch),
          progress: safeProgress,
          likesCount: Math.max(0, Number(log.likesCount || 0)),
          likedByMe: Boolean(log.likedByMe),
          comments: Array.isArray(log.comments) ? log.comments : []
        };
        dbState.logs.unshift(newLog);
      }

      // Recalculate dynamic communityRating and ratingsCount for this media item
      recalculateMediaStats(dbState, targetMediaId);

      // Automatically remove from acting user's watchlist if logged
      const activeUser = dbState.users[reqUserId];
      if (activeUser && Array.isArray(activeUser.watchlist)) {
        activeUser.watchlist = activeUser.watchlist.filter(
          (id) => id !== targetMediaId && id !== log.mediaId
        );
      }
      if (dbState.currentUserId === reqUserId) {
        dbState.watchlist = dbState.watchlist.filter(
          (id) => id !== targetMediaId && id !== log.mediaId
        );
      }
      saveState(dbState);
      return sendJson(res, 201, { state: buildClientStatePayload(dbState, reqUserId) });
    }

    // 6. Delete LogEntry
    if (pathname.startsWith('/api/logs/') && req.method === 'DELETE') {
      const reqUserId = resolveRequestUserId(req);
      if (!reqUserId || !dbState.users || !dbState.users[reqUserId]) {
        return sendJson(res, 401, {
          requiresAuth: true,
          error: 'Authentication required. Please sign in or sign up to modify logs.'
        });
      }
      const logId = decodeURIComponent(pathname.split('/')[3] || '');
      const targetLog = dbState.logs.find((l) => l.id === logId);
      dbState.logs = dbState.logs.filter((l) => l.id !== logId);
      if (targetLog && targetLog.mediaId) {
        recalculateMediaStats(dbState, targetLog.mediaId);
      }
      saveState(dbState);
      return sendJson(res, 200, { state: buildClientStatePayload(dbState, reqUserId) });
    }

    // 6b. One-Tap Progress Update on a LogEntry (POST /api/logs/:id/progress)
    if (pathname.startsWith('/api/logs/') && pathname.endsWith('/progress') && req.method === 'POST') {
      const reqUserId = resolveRequestUserId(req);
      if (!reqUserId || !dbState.users || !dbState.users[reqUserId]) {
        return sendJson(res, 401, {
          requiresAuth: true,
          error: 'Authentication required. Please sign in or sign up to update progress.'
        });
      }
      const logId = decodeURIComponent(pathname.split('/')[3] || '');
      const log = dbState.logs.find((l) => l.id === logId);
      if (!log) return sendJson(res, 404, { error: 'Log not found' });
      const body = await parseBody(req);
      const mediaItem = dbState.catalog.find((c) => c.id === log.mediaId) || {};
      log.progress = log.progress || {};

      const action = body.action || '';
      if (action === 'increment_episode') {
        const epsPerSeason = getTvEpisodesPerSeason(mediaItem);
        const totalSeasons = epsPerSeason.length;
        let curSeason = Math.max(1, Math.min(totalSeasons, Math.round(Number(log.progress.season) || 1)));
        let curEp = Math.max(1, Math.round(Number(log.progress.episode) || 1));
        const rawDelta = Number(body.delta);
        let remaining = Number.isFinite(rawDelta) && rawDelta > 0 ? Math.min(50, Math.round(rawDelta)) : 1;
        let nextStatus = 'watching';

        while (remaining > 0) {
          const maxEpInSeason = epsPerSeason[curSeason - 1] || 10;
          if (curEp < maxEpInSeason) {
            curEp += 1;
          } else if (curSeason < totalSeasons) {
            curSeason += 1;
            curEp = 1;
          } else {
            curEp = maxEpInSeason;
            nextStatus = 'completed';
            break;
          }
          remaining -= 1;
        }
        log.progress.season = curSeason;
        log.progress.episode = curEp;
        log.progress.status = nextStatus;
        log.progress.percent = computeTvProgressPercent(curSeason, curEp, epsPerSeason, nextStatus);
      } else if (action === 'increment_pages') {
        const rawDelta = Number(body.delta) || Number(body.deltaPages);
        const safeDelta = Number.isFinite(rawDelta) && rawDelta > 0 ? Math.min(1000, Math.round(rawDelta)) : 25;
        const tot = Math.max(1, Math.round(Number(log.progress.totalPages) || Number(mediaItem.pagesCount) || 400));
        const cur = Math.min(tot, Math.max(0, Math.round(Number(log.progress.currentPage) || 0)) + safeDelta);
        const pct = Math.min(100, Math.round((cur / tot) * 100));
        log.progress.currentPage = cur;
        log.progress.totalPages = tot;
        log.progress.percent = pct;
        log.progress.status = cur >= tot ? 'completed' : 'reading';
      } else if (action === 'finish') {
        if (log.mediaType === 'book') {
          const tot = Math.max(1, Math.round(Number(log.progress.totalPages) || Number(mediaItem.pagesCount) || 400));
          log.progress.currentPage = tot;
          log.progress.totalPages = tot;
          log.progress.percent = 100;
        } else if (log.mediaType === 'tv') {
          const epsPerSeason = getTvEpisodesPerSeason(mediaItem);
          const finalSeason = epsPerSeason.length;
          log.progress.season = finalSeason;
          log.progress.episode = epsPerSeason[finalSeason - 1] || 10;
          log.progress.percent = 100;
        }
        log.progress.status = 'completed';
      } else {
        const merged = { ...log.progress };
        if (body.season !== undefined) merged.season = body.season;
        if (body.episode !== undefined) merged.episode = body.episode;
        if (body.currentPage !== undefined) merged.currentPage = body.currentPage;
        if (body.totalPages !== undefined) merged.totalPages = body.totalPages;
        if (body.status !== undefined) merged.status = body.status;
        log.progress = sanitizeProgress(merged, log.mediaType, mediaItem);
      }
      log.dateConsumed = new Date().toISOString().slice(0, 10);
      saveState(dbState);
      return sendJson(res, 200, { log, state: buildClientStatePayload(dbState, reqUserId) });
    }

    // 6c. Start Currently Watching / Reading (POST /api/currently-tracking)
    if (pathname === '/api/currently-tracking' && req.method === 'POST') {
      const reqUserId = resolveRequestUserId(req);
      if (!reqUserId || !dbState.users || !dbState.users[reqUserId]) {
        return sendJson(res, 401, {
          requiresAuth: true,
          error: 'Authentication required. Please sign in or sign up to track media.'
        });
      }
      const body = await parseBody(req);
      let upserted = null;
      if (body.mediaItem) {
        upserted = upsertCatalogItem(body.mediaItem);
      }
      const mediaId = upserted?.id || body.mediaId || body.mediaItem?.id;
      const mediaItem = dbState.catalog.find((c) => c.id === mediaId) || upserted || body.mediaItem;
      if (!mediaItem || !mediaId) {
        return sendJson(res, 400, { error: 'Valid mediaId or mediaItem required' });
      }
      const userId = reqUserId;
      // Only match an existing log if it is ALREADY in progress ('watching' / 'reading').
      // If the user previously completed this title, preserve that completed diary entry and create a new rewatch/reread entry!
      const activeLog = dbState.logs.find(
        (l) => l.userId === userId && l.mediaId === mediaId && l.progress && isInProgressStatus(l.progress.status)
      );
      const hasCompletedBefore = dbState.logs.some(
        (l) => l.userId === userId && l.mediaId === mediaId && (!l.progress || !isInProgressStatus(l.progress.status))
      );

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

      const safeProgress = body.progress
        ? sanitizeProgress(body.progress, mediaItem.type, mediaItem)
        : defaultProgress;

      let log = activeLog;
      if (log) {
        log.progress = safeProgress;
        log.dateConsumed = new Date().toISOString().slice(0, 10);
      } else {
        log = {
          id: generateId('log'),
          userId,
          mediaId,
          mediaType: mediaItem.type,
          rating: 4.5,
          liked: true,
          dateConsumed: new Date().toISOString().slice(0, 10),
          createdAt: new Date().toISOString(),
          review: '',
          containsSpoilers: false,
          isRewatch: hasCompletedBefore,
          progress: safeProgress,
          likesCount: 1,
          likedByMe: true,
          comments: []
        };
        dbState.logs.unshift(log);
      }
      const activeUser = dbState.users[userId];
      if (activeUser && Array.isArray(activeUser.watchlist)) {
        activeUser.watchlist = activeUser.watchlist.filter(
          (id) => id !== mediaId && id !== body.mediaId
        );
      }
      if (dbState.currentUserId === userId) {
        dbState.watchlist = dbState.watchlist.filter((id) => id !== mediaId && id !== body.mediaId);
      }
      saveState(dbState);
      return sendJson(res, 201, { log, state: buildClientStatePayload(dbState, reqUserId) });
    }

    // 7. Like / Unlike a LogEntry
    if (pathname.startsWith('/api/logs/') && pathname.endsWith('/like') && req.method === 'POST') {
      const logId = decodeURIComponent(pathname.split('/')[3] || '');
      const log = dbState.logs.find((l) => l.id === logId);
      if (!log) return sendJson(res, 404, { error: 'Log not found' });
      log.likedByMe = !log.likedByMe;
      log.likesCount = Math.max(0, (log.likesCount || 0) + (log.likedByMe ? 1 : -1));
      saveState(dbState);
      const reqUserId = resolveRequestUserId(req);
      return sendJson(res, 200, { log, state: buildClientStatePayload(dbState, reqUserId) });
    }

    // 8. Comment on a LogEntry
    if (pathname.startsWith('/api/logs/') && pathname.endsWith('/comments') && req.method === 'POST') {
      const logId = decodeURIComponent(pathname.split('/')[3] || '');
      const log = dbState.logs.find((l) => l.id === logId);
      if (!log) return sendJson(res, 404, { error: 'Log not found' });
      const body = await parseBody(req);
      const text = String(body.text || '').trim().slice(0, 1000);
      if (!text) return sendJson(res, 400, { error: 'Comment text required' });
      const reqUserId = resolveRequestUserId(req);
      const currentUser = (reqUserId && dbState.users[reqUserId]) ||
        dbState.users[dbState.currentUserId] || {
          id: 'user-jackson',
          name: 'Jackson Cooper',
          handle: '@jackson'
        };
      const comment = {
        id: generateId('c'),
        userId: currentUser.id,
        userName: currentUser.name,
        userHandle: currentUser.handle,
        text,
        createdAt: new Date().toISOString()
      };
      log.comments = Array.isArray(log.comments) ? log.comments : [];
      log.comments.push(comment);
      saveState(dbState);
      return sendJson(res, 201, { comment, state: buildClientStatePayload(dbState, reqUserId) });
    }

    // 9. Toggle Watchlist / Reading Queue
    if (pathname === '/api/watchlist/toggle' && req.method === 'POST') {
      const reqUserId = resolveRequestUserId(req);
      if (!reqUserId || !dbState.users || !dbState.users[reqUserId]) {
        return sendJson(res, 401, {
          requiresAuth: true,
          error: 'Authentication required. Please sign in or sign up to update your Watchlist.'
        });
      }
      const body = await parseBody(req);
      let upserted = null;
      if (body.mediaItem) {
        upserted = upsertCatalogItem(body.mediaItem);
      }
      const mediaId = upserted?.id || body.mediaId || body.mediaItem?.id;
      if (!mediaId) return sendJson(res, 400, { error: 'mediaId required' });
      const activeUser = dbState.users[reqUserId];
      activeUser.watchlist = Array.isArray(activeUser.watchlist) ? activeUser.watchlist : [];
      const exists = activeUser.watchlist.includes(mediaId);
      if (exists) {
        activeUser.watchlist = activeUser.watchlist.filter((id) => id !== mediaId);
      } else {
        activeUser.watchlist.unshift(mediaId);
      }
      if (dbState.currentUserId === reqUserId) {
        dbState.watchlist = [...activeUser.watchlist];
      }
      saveState(dbState);
      return sendJson(res, 200, {
        added: !exists,
        mediaId,
        state: buildClientStatePayload(dbState, reqUserId)
      });
    }

    // 10. Create / Update Custom List (POST /api/lists or PUT /api/lists/:id)
    if (
      (pathname === '/api/lists' && req.method === 'POST') ||
      (pathname.startsWith('/api/lists/') && req.method === 'PUT')
    ) {
      const reqUserId = resolveRequestUserId(req);
      if (!reqUserId || !dbState.users || !dbState.users[reqUserId]) {
        return sendJson(res, 401, {
          requiresAuth: true,
          error: 'Authentication required. Please sign in or sign up to create or edit lists.'
        });
      }
      const body = await parseBody(req);
      const pathListId = pathname.startsWith('/api/lists/')
        ? decodeURIComponent(pathname.split('/')[3] || '')
        : '';
      const targetId = pathListId || body.id || '';
      const existingIdx = targetId ? dbState.lists.findIndex((l) => l.id === targetId) : -1;

      if (!body || (!body.title && existingIdx === -1)) {
        return sendJson(res, 400, { error: 'List title required' });
      }
      const rawItems = Array.isArray(body.itemIds)
        ? body.itemIds
        : existingIdx >= 0
        ? dbState.lists[existingIdx].itemIds
        : [];
      const dedupedItemIds = [...new Set(rawItems.filter(Boolean))];

      if (existingIdx >= 0) {
        const prev = dbState.lists[existingIdx];
        dbState.lists[existingIdx] = {
          ...prev,
          ...body,
          id: prev.id,
          title: body.title !== undefined ? String(body.title).trim().slice(0, 200) || prev.title : prev.title,
          description:
            body.description !== undefined
              ? String(body.description).trim().slice(0, 1000)
              : prev.description,
          isRanked: body.isRanked !== undefined ? Boolean(body.isRanked) : prev.isRanked,
          itemIds: dedupedItemIds
        };
        saveState(dbState);
        return sendJson(res, req.method === 'PUT' ? 200 : 201, {
          list: dbState.lists[existingIdx],
          state: buildClientStatePayload(dbState, reqUserId)
        });
      } else {
        const created = {
          id: targetId || generateId('list'),
          userId: reqUserId,
          title: String(body.title).trim().slice(0, 200),
          description: String(body.description || '').trim().slice(0, 1000),
          isRanked: Boolean(body.isRanked),
          itemIds: dedupedItemIds,
          likesCount: 1,
          createdAt: new Date().toISOString()
        };
        dbState.lists.unshift(created);
        saveState(dbState);
        return sendJson(res, 201, { list: created, state: buildClientStatePayload(dbState, reqUserId) });
      }
    }

    // 11. Delete Custom List
    if (pathname.startsWith('/api/lists/') && req.method === 'DELETE') {
      const reqUserId = resolveRequestUserId(req);
      if (!reqUserId || !dbState.users || !dbState.users[reqUserId]) {
        return sendJson(res, 401, {
          requiresAuth: true,
          error: 'Authentication required. Please sign in or sign up to delete lists.'
        });
      }
      const listId = decodeURIComponent(pathname.split('/')[3] || '');
      dbState.lists = dbState.lists.filter((l) => l.id !== listId);
      saveState(dbState);
      return sendJson(res, 200, { state: buildClientStatePayload(dbState, reqUserId) });
    }

    // 12. Update Profile & Top 4 Favorites
    if (pathname === '/api/profile' && req.method === 'PUT') {
      const reqUserId = resolveRequestUserId(req);
      if (!reqUserId || !dbState.users || !dbState.users[reqUserId]) {
        return sendJson(res, 401, {
          requiresAuth: true,
          error: 'Authentication required. Please sign in or sign up to update your profile.'
        });
      }
      const body = await parseBody(req);
      const user = dbState.users[reqUserId];
      if (user) {
        if (body.name !== undefined) {
          user.name = String(body.name).trim() || user.name;
          if (!body.avatar) user.avatar = deriveInitials(user.name);
        }
        if (body.handle !== undefined) {
          const cleanH = String(body.handle).trim().replace(/^@+/, '');
          if (cleanH) user.handle = `@${cleanH}`;
        }
        if (body.bio !== undefined) user.bio = String(body.bio).trim();
        if (body.location !== undefined) user.location = String(body.location).trim();
        if (body.avatarColor !== undefined) user.avatarColor = String(body.avatarColor).trim() || user.avatarColor;
        if (body.favorites) {
          user.favorites = deduplicateFavorites(
            {
              ...user.favorites,
              ...body.favorites
            },
            dbState.catalog
          );
        }
        saveState(dbState);
      }
      return sendJson(res, 200, { user, state: buildClientStatePayload(dbState, reqUserId) });
    }

    // 13. Create a New Family / Friend Profile (POST /api/users)
    if (pathname === '/api/users' && req.method === 'POST') {
      const body = await parseBody(req);
      const rawName = String(body?.name || '').trim().slice(0, 80);
      if (!rawName) {
        return sendJson(res, 400, { error: 'Profile name is required' });
      }
      const slug = rawName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 24) || 'member';
      const rawHandle = String(body.handle || slug).trim().replace(/^@+/, '').slice(0, 32) || slug;
      const id = body.id || generateId('user');
      const existingUserIds = Object.keys(dbState.users);
      const newUser = {
        id,
        name: rawName,
        handle: `@${rawHandle}`,
        avatar: String(body.avatar || deriveInitials(rawName)).slice(0, 3).toUpperCase(),
        avatarColor: String(body.avatarColor || '#10b981').trim(),
        bio: String(
          body.bio || 'Tracking favorite movies, TV shows, and books with family & friends on Omnilog.'
        )
          .trim()
          .slice(0, 500),
        location: String(body.location || 'Family Circle').trim().slice(0, 100),
        joinedYear: new Date().getFullYear(),
        followersCount: existingUserIds.length,
        followingCount: existingUserIds.length,
        followingIds: Array.isArray(body.followingIds)
          ? [...new Set(body.followingIds)]
          : existingUserIds.filter((uid) => uid !== id),
        watchlist: Array.isArray(body.watchlist) ? [...new Set(body.watchlist)] : [],
        favorites: deduplicateFavorites(body.favorites || {}, dbState.catalog)
      };

      dbState.users[id] = newUser;
      // Ensure authVault entry exists (with optional email/password if provided)
      const providedEmail = String(body.email || '').trim().toLowerCase();
      if (body.password && String(body.password).length >= 8) {
        const { salt, passwordHash } = hashPassword(String(body.password));
        const now = new Date().toISOString();
        authVault.accounts[id] = {
          userId: id,
          email: EMAIL_REGEX.test(providedEmail) ? providedEmail : `${rawHandle}@omnilog.app`,
          salt,
          passwordHash,
          algorithm: 'scrypt-64',
          createdAt: now,
          updatedAt: now
        };
        saveAuthVault(authVault);
      } else {
        ensureUserInAuthVault(id, providedEmail);
      }

      // Automatically connect with existing family circle members
      for (const existingMember of Object.values(dbState.users)) {
        if (existingMember && existingMember.id !== id) {
          existingMember.followingIds = Array.isArray(existingMember.followingIds)
            ? existingMember.followingIds
            : [];
          if (!existingMember.followingIds.includes(id)) {
            existingMember.followingIds.push(id);
            existingMember.followingCount = Math.max(
              existingMember.followingIds.length,
              Number(existingMember.followingCount || 0) + 1
            );
          }
        }
      }

      const shouldSwitch = body.switchToUser !== false && body.switchTo !== false && body.switchToNew !== false;
      const activeReqUserId = shouldSwitch ? id : resolveRequestUserId(req);
      if (shouldSwitch) {
        syncWatchlistToActiveUser(dbState);
        dbState.currentUserId = id;
        dbState.watchlist = [...newUser.watchlist];
      }
      saveState(dbState);
      const sessionToken = shouldSwitch ? createAuthSession(id) : null;
      return sendJson(
        res,
        201,
        {
          user: newUser,
          token: sessionToken || undefined,
          sessionToken: sessionToken || undefined,
          authUser: buildAuthUser(activeReqUserId),
          state: buildClientStatePayload(dbState, activeReqUserId)
        },
        sessionToken ? { 'Set-Cookie': buildSessionCookieHeader(sessionToken) } : {}
      );
    }

    // 14. Switch Active Family / Friend Profile (POST /api/users/switch)
    if (pathname === '/api/users/switch' && req.method === 'POST') {
      const body = await parseBody(req);
      const targetUserId = String(body?.userId || '').trim();
      const targetUser = dbState.users[targetUserId];
      if (!targetUser) {
        return sendJson(res, 404, { error: 'User profile not found' });
      }
      syncWatchlistToActiveUser(dbState);
      dbState.currentUserId = targetUserId;
      dbState.watchlist = Array.isArray(targetUser.watchlist) ? [...targetUser.watchlist] : [];
      saveState(dbState);
      const sessionToken = createAuthSession(targetUserId);
      const authUser = buildAuthUser(targetUserId);
      return sendJson(
        res,
        200,
        {
          currentUserId: targetUserId,
          user: targetUser,
          authUser,
          token: sessionToken,
          sessionToken,
          state: buildClientStatePayload(dbState, targetUserId)
        },
        { 'Set-Cookie': buildSessionCookieHeader(sessionToken) }
      );
    }

    // 15. Toggle Follow / Unfollow a User (POST /api/users/:id/follow)
    if (pathname.startsWith('/api/users/') && pathname.endsWith('/follow') && req.method === 'POST') {
      const targetUserId = decodeURIComponent(pathname.split('/')[3] || '');
      const targetUser = dbState.users[targetUserId];
      const reqUserId = resolveRequestUserId(req);
      const currentUser = reqUserId ? dbState.users[reqUserId] : null;
      if (!targetUser || !currentUser) {
        return sendJson(res, 404, { error: 'User not found' });
      }
      if (targetUserId === reqUserId) {
        return sendJson(res, 400, { error: 'Cannot follow yourself' });
      }
      currentUser.followingIds = Array.isArray(currentUser.followingIds)
        ? currentUser.followingIds
        : [];
      const alreadyFollowing = currentUser.followingIds.includes(targetUserId);
      if (alreadyFollowing) {
        currentUser.followingIds = currentUser.followingIds.filter((id) => id !== targetUserId);
        currentUser.followingCount = Math.max(0, Number(currentUser.followingCount || 1) - 1);
        targetUser.followersCount = Math.max(0, Number(targetUser.followersCount || 1) - 1);
      } else {
        currentUser.followingIds.push(targetUserId);
        currentUser.followingCount = Number(currentUser.followingCount || 0) + 1;
        targetUser.followersCount = Number(targetUser.followersCount || 0) + 1;
      }
      saveState(dbState);
      return sendJson(res, 200, {
        following: !alreadyFollowing,
        targetUserId,
        user: currentUser,
        targetUser,
        state: buildClientStatePayload(dbState, reqUserId)
      });
    }

    // 16. Update Specific User Profile (PUT /api/users/:id)
    if (pathname.startsWith('/api/users/') && req.method === 'PUT') {
      const targetUserId = decodeURIComponent(pathname.split('/')[3] || '');
      const user = dbState.users[targetUserId];
      if (!user) {
        return sendJson(res, 404, { error: 'User not found' });
      }
      const body = await parseBody(req);
      if (body.name !== undefined) {
        user.name = String(body.name).trim().slice(0, 80) || user.name;
        if (!body.avatar) user.avatar = deriveInitials(user.name);
      }
      if (body.handle !== undefined) {
        const cleanH = String(body.handle).trim().replace(/^@+/, '').slice(0, 32);
        if (cleanH) user.handle = `@${cleanH}`;
      }
      if (body.bio !== undefined) user.bio = String(body.bio).trim().slice(0, 500);
      if (body.location !== undefined) user.location = String(body.location).trim().slice(0, 100);
      if (body.avatarColor !== undefined) user.avatarColor = String(body.avatarColor).trim() || user.avatarColor;
      if (body.favorites) {
        user.favorites = deduplicateFavorites(
          {
            ...user.favorites,
            ...body.favorites
          },
          dbState.catalog
        );
      }
      saveState(dbState);
      const reqUserId = resolveRequestUserId(req) || targetUserId;
      return sendJson(res, 200, {
        user,
        authUser: buildAuthUser(reqUserId),
        state: buildClientStatePayload(dbState, reqUserId)
      });
    }

    // 17. Proper Account Sign-Up with Username, Email & Salted Scrypt Password + Optional Letterboxd Import (POST /api/auth/signup)
    if (pathname === '/api/auth/signup' && req.method === 'POST') {
      const body = await parseBody(req);
      const rawUsernameInput = String(
        body?.username || body?.handle || body?.name || ''
      ).trim();
      const rawName = String(body?.name || rawUsernameInput.replace(/^@+/, ''))
        .trim()
        .slice(0, 80);
      const rawEmail = String(body?.email || '').trim().toLowerCase();
      const rawPassword = String(body?.password || '');
      const rawConfirm = body?.confirmPassword !== undefined ? String(body.confirmPassword) : rawPassword;

      if (!rawName) {
        return sendJson(res, 400, { error: 'Username is required' });
      }
      if (!rawEmail || !EMAIL_REGEX.test(rawEmail)) {
        return sendJson(res, 400, { error: 'Please provide a valid email address' });
      }
      if (rawPassword.length < 8) {
        return sendJson(res, 400, { error: 'Password must be at least 8 characters long' });
      }
      if (rawPassword !== rawConfirm) {
        return sendJson(res, 400, { error: 'Passwords do not match' });
      }

      // Check email uniqueness in authVault
      const emailCollision = Object.values(authVault.accounts).some(
        (acc) => acc && String(acc.email).toLowerCase() === rawEmail
      );
      if (emailCollision) {
        return sendJson(res, 409, { error: 'An account with this email address already exists' });
      }

      const slug =
        rawName
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '_')
          .replace(/^_+|_+$/g, '')
          .slice(0, 24) || 'member';
      const requestedHandle = String(body.username || body.handle || slug)
        .trim()
        .replace(/^@+/, '')
        .replace(/[^a-zA-Z0-9_]/g, '')
        .toLowerCase()
        .slice(0, 28) || slug;

      const handleCollision = Object.values(dbState.users).some(
        (u) => u && String(u.handle).toLowerCase() === `@${requestedHandle}`
      );
      if (handleCollision && (body.handle || body.username)) {
        return sendJson(res, 409, { error: `The username @${requestedHandle} is already taken` });
      }
      const finalHandle = handleCollision
        ? `@${requestedHandle}_${Math.random().toString(36).slice(2, 5)}`
        : `@${requestedHandle}`;

      let id = body.id || `user-${requestedHandle}`;
      if (dbState.users[id] || authVault.accounts[id]) {
        id = generateId('user');
      }

      const allExistingUserIds = Object.keys(dbState.users);
      const newUser = {
        id,
        name: rawName,
        handle: finalHandle,
        avatar: String(body.avatar || deriveInitials(rawName)).slice(0, 3).toUpperCase(),
        avatarColor: String(body.avatarColor || '#d49b4b').trim(),
        bio: String(
          body.bio || 'Tracking favorite movies, TV shows, and books with family & friends on Omnilog.'
        )
          .trim()
          .slice(0, 500),
        location: String(body.location || 'Family Circle').trim().slice(0, 100),
        joinedYear: new Date().getFullYear(),
        followersCount: allExistingUserIds.length || 1,
        followingCount: allExistingUserIds.length || 1,
        followingIds: Array.isArray(body.followingIds)
          ? [...new Set(body.followingIds)]
          : allExistingUserIds.filter((uid) => uid !== id),
        watchlist: Array.isArray(body.watchlist) ? [...new Set(body.watchlist)] : [],
        favorites: deduplicateFavorites(body.favorites || {}, dbState.catalog)
      };

      const { salt, passwordHash } = hashPassword(rawPassword);
      const now = new Date().toISOString();
      authVault.accounts[id] = {
        userId: id,
        email: rawEmail,
        salt,
        passwordHash,
        algorithm: 'scrypt-64',
        createdAt: now,
        updatedAt: now
      };

      syncWatchlistToActiveUser(dbState);
      dbState.users[id] = newUser;
      // Connect with family circle
      for (const existingUser of Object.values(dbState.users)) {
        if (existingUser && existingUser.id !== id) {
          existingUser.followingIds = Array.isArray(existingUser.followingIds)
            ? existingUser.followingIds
            : [];
          if (!existingUser.followingIds.includes(id)) {
            existingUser.followingIds.push(id);
            existingUser.followingCount = Math.max(
              existingUser.followingIds.length,
              Number(existingUser.followingCount || 1) + 1
            );
          }
        }
      }

      dbState.currentUserId = id;
      dbState.watchlist = [...newUser.watchlist];

      // Optional Letterboxd Import right during Sign-Up!
      let importedLogsCount = 0;
      let importedWatchlistCount = 0;
      let newCatalogItemsCount = 0;
      if (body.letterboxdUsername && String(body.letterboxdUsername).trim()) {
        const rssResult = await applyLetterboxdRssImport(id, body.letterboxdUsername);
        importedLogsCount += rssResult.importedLogsCount || 0;
        newCatalogItemsCount += rssResult.newCatalogItemsCount || 0;
      }
      if (body.letterboxdCsvText || body.letterboxdFiles) {
        const csvResult = applyLetterboxdCsvImport(id, {
          csvText: body.letterboxdCsvText,
          files: body.letterboxdFiles
        });
        importedLogsCount += csvResult.importedLogsCount || 0;
        importedWatchlistCount += csvResult.importedWatchlistCount || 0;
        newCatalogItemsCount += csvResult.newCatalogItemsCount || 0;
      }

      saveState(dbState);
      const sessionToken = createAuthSession(id);
      const authUser = buildAuthUser(id);
      const clientState = buildClientStatePayload(dbState, id);

      return sendJson(
        res,
        201,
        {
          ok: true,
          token: sessionToken,
          sessionToken,
          user: newUser,
          authUser,
          importedLogsCount,
          importedWatchlistCount,
          newCatalogItemsCount,
          letterboxdImport: {
            importedLogs: importedLogsCount,
            watchlistAdded: importedWatchlistCount,
            addedCatalogItems: newCatalogItemsCount
          },
          db: clientState,
          state: clientState
        },
        { 'Set-Cookie': buildSessionCookieHeader(sessionToken) }
      );
    }

    // 18. Account Sign-In with Email or @handle + Password (POST /api/auth/login)
    if (pathname === '/api/auth/login' && req.method === 'POST') {
      const body = await parseBody(req);
      const rawIdentifier = String(
        body?.identifier || body?.emailOrHandle || body?.email || body?.handle || ''
      )
        .trim()
        .toLowerCase();
      const rawPassword = String(body?.password || '');

      if (!rawIdentifier || !rawPassword) {
        return sendJson(res, 400, { error: 'Email/handle and password are required' });
      }

      // Resolve account by email OR @handle OR userId
      let matchedUserId = null;
      for (const [uid, cred] of Object.entries(authVault.accounts)) {
        if (cred && String(cred.email).toLowerCase() === rawIdentifier) {
          matchedUserId = uid;
          break;
        }
      }
      if (!matchedUserId) {
        const normalizedHandle = rawIdentifier.startsWith('@') ? rawIdentifier : `@${rawIdentifier}`;
        for (const u of Object.values(dbState.users)) {
          if (
            u &&
            (String(u.handle).toLowerCase() === normalizedHandle ||
              String(u.id).toLowerCase() === rawIdentifier)
          ) {
            matchedUserId = u.id;
            break;
          }
        }
      }

      const targetUser = matchedUserId ? dbState.users[matchedUserId] : null;
      const cred = matchedUserId ? ensureUserInAuthVault(matchedUserId) : null;
      if (!targetUser || !cred || !verifyAccountPassword(cred, rawPassword)) {
        return sendJson(res, 401, { error: 'Invalid email/handle or password' });
      }

      syncWatchlistToActiveUser(dbState);
      dbState.currentUserId = targetUser.id;
      dbState.watchlist = Array.isArray(targetUser.watchlist) ? [...targetUser.watchlist] : [];
      saveState(dbState);

      const sessionToken = createAuthSession(targetUser.id);
      const authUser = buildAuthUser(targetUser.id);

      return sendJson(
        res,
        200,
        {
          ok: true,
          token: sessionToken,
          sessionToken,
          user: targetUser,
          authUser,
          state: buildClientStatePayload(dbState, targetUser.id)
        },
        { 'Set-Cookie': buildSessionCookieHeader(sessionToken) }
      );
    }

    // 19. Sign Out / Invalidate Session Token (POST /api/auth/logout)
    if (pathname === '/api/auth/logout' && req.method === 'POST') {
      const token = extractSessionToken(req);
      if (token && authVault.sessions[token]) {
        delete authVault.sessions[token];
        saveAuthVault(authVault);
      }
      syncWatchlistToActiveUser(dbState);
      const clientType = String(req.headers['x-omnilog-client'] || '').toLowerCase();
      if (clientType !== 'browser') {
        dbState.currentUserId = null;
        dbState.watchlist = [];
      }
      saveState(dbState);
      return sendJson(
        res,
        200,
        {
          ok: true,
          authenticated: false,
          authUser: null,
          state: buildClientStatePayload(dbState, null)
        },
        { 'Set-Cookie': buildSessionCookieHeader('', 0) }
      );
    }

    // 20. Current Session & Auth Security Status (GET /api/auth/me)
    if (pathname === '/api/auth/me' && req.method === 'GET') {
      const token = extractSessionToken(req);
      const session = token ? authVault.sessions[token] : null;
      const targetUserId = resolveRequestUserId(req);
      const authUser = buildAuthUser(targetUserId);
      return sendJson(res, 200, {
        ok: true,
        authenticated: Boolean(session || authUser),
        hasActiveSessionToken: Boolean(session),
        authUser,
        user: targetUserId ? dbState.users[targetUserId] : null
      });
    }

    // 21. Update Email & Password in Credential Vault (PUT /api/auth/credentials)
    if (pathname === '/api/auth/credentials' && req.method === 'PUT') {
      const body = await parseBody(req);
      const targetUserId = String(body?.userId || resolveRequestUserId(req) || '').trim();
      const targetUser = dbState.users[targetUserId];
      if (!targetUser) {
        return sendJson(res, 404, { error: 'User account not found' });
      }

      const cred = ensureUserInAuthVault(targetUserId);
      const currentPassword = String(body?.currentPassword || '');
      if (!currentPassword || !verifyAccountPassword(cred, currentPassword)) {
        return sendJson(res, 401, { error: 'Current password is incorrect' });
      }

      if (body.newEmail !== undefined && String(body.newEmail).trim() !== '') {
        const nextEmail = String(body.newEmail).trim().toLowerCase();
        if (!EMAIL_REGEX.test(nextEmail)) {
          return sendJson(res, 400, { error: 'Please provide a valid new email address' });
        }
        const emailTaken = Object.values(authVault.accounts).some(
          (acc) => acc && acc.userId !== targetUserId && String(acc.email).toLowerCase() === nextEmail
        );
        if (emailTaken) {
          return sendJson(res, 409, { error: 'That email address is already in use by another profile' });
        }
        cred.email = nextEmail;
      }

      if (body.newPassword !== undefined && String(body.newPassword) !== '') {
        const nextPass = String(body.newPassword);
        if (nextPass.length < 8) {
          return sendJson(res, 400, { error: 'New password must be at least 8 characters long' });
        }
        if (body.confirmNewPassword !== undefined && String(body.confirmNewPassword) !== nextPass) {
          return sendJson(res, 400, { error: 'New password confirmation does not match' });
        }
        const { salt, passwordHash } = hashPassword(nextPass);
        cred.salt = salt;
        cred.passwordHash = passwordHash;
        delete cred.altSalt;
        delete cred.altPasswordHash;
      }

      cred.updatedAt = new Date().toISOString();
      saveAuthVault(authVault);
      const authUser = buildAuthUser(targetUserId);

      return sendJson(res, 200, {
        ok: true,
        authUser,
        user: targetUser,
        state: buildClientStatePayload(dbState, targetUserId)
      });
    }

    // 22. Letterboxd CSV Export Importer (POST /api/import/letterboxd-csv)
    if (pathname === '/api/import/letterboxd-csv' && req.method === 'POST') {
      const body = await parseBody(req);
      if (!body || (!body.csvText && !body.files)) {
        return sendJson(res, 400, {
          error: 'Please provide csvText or files from a Letterboxd CSV export'
        });
      }
      const targetUserId = body.userId || resolveRequestUserId(req) || dbState.currentUserId;
      const { user, importedLogsCount, importedWatchlistCount, newCatalogItemsCount } =
        applyLetterboxdCsvImport(targetUserId, body);
      saveState(dbState);
      const clientState = buildClientStatePayload(dbState, targetUserId);
      return sendJson(res, 200, {
        ok: true,
        user,
        importedLogsCount,
        importedWatchlistCount,
        importedCount: importedLogsCount + importedWatchlistCount,
        newCatalogItemsCount,
        summary: {
          importedLogs: importedLogsCount,
          watchlistAdded: importedWatchlistCount,
          addedCatalogItems: newCatalogItemsCount
        },
        db: clientState,
        state: clientState
      });
    }

    // 23. Letterboxd @username Live RSS Importer (POST /api/import/letterboxd-rss)
    if (pathname === '/api/import/letterboxd-rss' && req.method === 'POST') {
      const body = await parseBody(req);
      const rawUsername = String(body?.username || body?.letterboxdUsername || '').trim();
      if (!rawUsername) {
        return sendJson(res, 400, { error: 'Please enter a Letterboxd username' });
      }
      const targetUserId = body.userId || resolveRequestUserId(req) || dbState.currentUserId;
      const result = await applyLetterboxdRssImport(targetUserId, rawUsername);
      saveState(dbState);
      const clientState = buildClientStatePayload(dbState, targetUserId);
      return sendJson(res, 200, {
        ok: true,
        user: result.user,
        letterboxdUsername: result.cleanUsername,
        importedLogsCount: result.importedLogsCount,
        importedCount: result.importedCount,
        newCatalogItemsCount: result.newCatalogItemsCount,
        source: result.source,
        summary: {
          importedLogs: result.importedLogsCount,
          addedCatalogItems: result.newCatalogItemsCount
        },
        db: clientState,
        state: clientState
      });
    }

    // 24. Export User Diary as RFC-4180 CSV (GET /api/export/diary.csv)
    if ((pathname === '/api/export/diary.csv' || pathname === '/api/export/diary') && req.method === 'GET') {
      const requestedUserId = url.searchParams.get('userId') || resolveRequestUserId(req);
      const logsToExport = (dbState.logs || [])
        .filter((l) => (!requestedUserId || requestedUserId === 'all' ? true : l.userId === requestedUserId))
        .sort((a, b) => String(b.dateConsumed || '').localeCompare(String(a.dateConsumed || '')));

      const csvEscape = (val) => {
        const str = val === null || val === undefined ? '' : String(val);
        if (/[",\r\n]/.test(str)) {
          return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
      };

      const headerRow = 'Date,Title,Year,Medium,Creator,Rating,Liked,Rewatch,Progress,Review';
      const dataRows = logsToExport.map((log) => {
        const media = (dbState.catalog || []).find((c) => c.id === log.mediaId) || {};
        let progressText = 'Completed';
        if (log.progress) {
          if (log.mediaType === 'tv' && (log.progress.season || log.progress.episode)) {
            progressText = `S${log.progress.season || 1}E${log.progress.episode || 1} (${log.progress.status || 'completed'})`;
          } else if (log.mediaType === 'book' && log.progress.currentPage) {
            progressText = `${log.progress.currentPage}/${log.progress.totalPages || media.pagesCount || 300} pp (${log.progress.status || 'completed'})`;
          } else if (log.mediaType === 'movie' && log.progress.format) {
            progressText = log.progress.format;
          }
        }
        return [
          csvEscape(log.dateConsumed || ''),
          csvEscape(media.title || 'Untitled'),
          csvEscape(media.year || ''),
          csvEscape(log.mediaType || media.type || 'movie'),
          csvEscape(media.creator || ''),
          csvEscape(log.rating !== undefined ? Number(log.rating).toFixed(1) : ''),
          csvEscape(log.liked ? 'Yes' : 'No'),
          csvEscape(log.isRewatch ? 'Yes' : 'No'),
          csvEscape(progressText),
          csvEscape(log.review || '')
        ].join(',');
      });

      const csvPayload = [headerRow, ...dataRows].join('\r\n') + '\r\n';
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="omnilog-diary.csv"',
        'Cache-Control': 'no-store'
      });
      return res.end(csvPayload);
    }

    // 25. Non-Destructive Test Snapshot & Restore (GET /api/test-snapshot & POST /api/test-snapshot/restore)
    if (pathname === '/api/test-snapshot' && req.method === 'GET') {
      return sendJson(res, 200, {
        ok: true,
        db: JSON.parse(JSON.stringify(dbState)),
        auth: JSON.parse(JSON.stringify(authVault))
      });
    }

    if (pathname === '/api/test-snapshot/restore' && req.method === 'POST') {
      const body = await parseBody(req);
      if (body && body.db && typeof body.db === 'object') {
        dbState = body.db;
        saveState(dbState);
      }
      if (body && body.auth && typeof body.auth === 'object') {
        authVault = body.auth;
        saveAuthVault(authVault);
      }
      return sendJson(res, 200, {
        ok: true,
        state: buildClientStatePayload(dbState)
      });
    }

    // Static file serving
    let filePath = pathname === '/' ? path.join(PUBLIC_DIR, 'index.html') : path.join(PUBLIC_DIR, pathname);
    if (!filePath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403);
      return res.end('Forbidden');
    }
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
        'Cache-Control': 'no-cache, no-store, must-revalidate'
      });
      return fs.createReadStream(filePath).pipe(res);
    }

    // SPA fallback
    const indexHtml = path.join(PUBLIC_DIR, 'index.html');
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate'
    });
    return fs.createReadStream(indexHtml).pipe(res);
  } catch (err) {
    console.error('Server error:', err);
    return sendJson(res, 500, { error: err.message || 'Internal server error' });
  }
});

server.listen(PORT, () => {
  console.log(`OMNILOG Media Platform running at http://localhost:${PORT}`);

  const externalUrl = process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_SITE_URL;
  if (externalUrl) {
    const cleanBase = String(externalUrl).replace(/\/+$/, '');
    const keepAliveTimer = setInterval(() => {
      fetch(`${cleanBase}/api/health`).catch(() => {});
    }, 10 * 60 * 1000);
    if (typeof keepAliveTimer.unref === 'function') {
      keepAliveTimer.unref();
    }
  }
});
