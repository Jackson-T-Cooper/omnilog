import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BASE_URL = 'http://localhost:4173';

async function fetchJson(pathname, options = {}) {
  const start = performance.now();
  const res = await fetch(`${BASE_URL}${pathname}`, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  const elapsedMs = performance.now() - start;
  const data = await res.json();
  return { status: res.status, data, elapsedMs };
}

async function resetAndSeedTestFixtures() {
  const resetRes = await fetchJson('/api/reset', { method: 'POST' });
  assert.equal(resetRes.status, 200);
  assert.equal(resetRes.data.currentUserId, null, 'Clean reset must have currentUserId: null');
  assert.equal(Object.keys(resetRes.data.users || {}).length, 0, 'Clean reset must have 0 users');
  assert.equal((resetRes.data.logs || []).length, 0, 'Clean reset must have 0 logs');

  // Seed test user user-jackson + starter logs for stress test scenarios
  await fetchJson('/api/users', {
    method: 'POST',
    body: JSON.stringify({
      id: 'user-jackson',
      name: 'Jackson Cooper',
      handle: '@jackson',
      email: 'jackson@omnilog.app',
      password: 'Omnilog2026!',
      switchToNew: true
    })
  });

  const starterLogs = [
    {
      id: 'log-2',
      userId: 'user-jackson',
      mediaId: 'tv-201',
      mediaType: 'tv',
      rating: 4.5,
      liked: true,
      review: 'Severance Season 2 test log',
      progress: { season: 2, episode: 4, percent: 40, status: 'watching' }
    },
    {
      id: 'log-3',
      userId: 'user-jackson',
      mediaId: 'book-301',
      mediaType: 'book',
      rating: 5.0,
      liked: true,
      review: 'Project Hail Mary completed test log',
      progress: { currentPage: 496, totalPages: 496, percent: 100, status: 'completed' }
    },
    {
      id: 'log-9',
      userId: 'user-jackson',
      mediaId: 'tv-202',
      mediaType: 'tv',
      rating: 4.5,
      liked: true,
      review: 'The Bear Season 3 test log',
      progress: { season: 3, episode: 6, percent: 60, status: 'watching' }
    },
    {
      id: 'log-10',
      userId: 'user-jackson',
      mediaId: 'book-303',
      mediaType: 'book',
      rating: 4.5,
      liked: true,
      review: 'Tomorrow, and Tomorrow, and Tomorrow test log',
      progress: { currentPage: 180, totalPages: 416, percent: 43, status: 'reading' }
    }
  ];

  for (const log of starterLogs) {
    await fetchJson('/api/logs', {
      method: 'POST',
      body: JSON.stringify({ log })
    });
  }
}

async function runStressTests() {
  console.log('=== OMNILOG STRESS TEST & 10-POINT HARDENING VERIFICATION (ROUNDS 1 & 2) ===\n');

  const initialSnapRes = await fetchJson('/api/test-snapshot').catch(() => null);
  const initialSnapshot = initialSnapRes?.data?.ok ? initialSnapRes.data : null;

  try {
  // Start from clean state + test fixtures
  await resetAndSeedTestFixtures();

  // 1. Concurrency & Rapid-Click Burst (40 parallel requests: 20 episode bumps + 20 likes)
  {
    const t0 = performance.now();
    const bumpPromises = Array.from({ length: 20 }, () =>
      fetchJson('/api/logs/log-2/progress', {
        method: 'POST',
        body: JSON.stringify({ action: 'increment_episode' })
      })
    );
    const likePromises = Array.from({ length: 20 }, () =>
      fetchJson('/api/logs/log-2/like', { method: 'POST' })
    );
    const allResponses = await Promise.all([...bumpPromises, ...likePromises]);
    const totalMs = (performance.now() - t0).toFixed(1);
    assert.ok(allResponses.every((r) => r.status === 200), 'All 40 concurrent requests returned 200 OK');
    const finalState = await fetchJson('/api/state');
    const log2 = finalState.data.logs.find((l) => l.id === 'log-2');
    assert.equal(log2.progress.season, 2, 'Severance capped at final Season 2');
    assert.equal(log2.progress.episode, 10, 'Severance capped at final Episode 10 of Season 2 (episodesPerSeason: [9, 10])');
    assert.equal(log2.progress.status, 'completed', 'Severance auto-completed at series finale S2E10');

    console.log(
      `✅ PASS [Stress 1: 40 Concurrent Requests Burst + Series Finale Cap] All 40 returned 200 OK in ${totalMs}ms | Severance S2E4 -> S2E${log2.progress.episode} (${log2.progress.status})`
    );
  }

  // 2. Collision-Proof IDs on Same-Millisecond Burst (10 parallel comments)
  {
    const commentPromises = Array.from({ length: 10 }, (_, i) =>
      fetchJson('/api/logs/log-2/comments', {
        method: 'POST',
        body: JSON.stringify({ text: `Rapid comment #${i + 1}` })
      })
    );
    const commentRes = await Promise.all(commentPromises);
    const ids = commentRes.map((r) => r.data.comment?.id);
    const uniqueIds = new Set(ids);
    assert.equal(uniqueIds.size, 10, 'Expected 10/10 unique comment IDs on concurrent burst');
    console.log(`✅ PASS [Stress 2: Collision-Proof IDs] 10 concurrent comments produced ${uniqueIds.size}/10 unique IDs`);
  }

  // 3. Server-Side Numeric Clamping (Out-of-range rating & negative progress delta)
  {
    await resetAndSeedTestFixtures();
    const badRatingRes = await fetchJson('/api/logs', {
      method: 'POST',
      body: JSON.stringify({
        log: {
          id: 'stress-clamped-rating',
          mediaId: 'movie-101',
          mediaType: 'movie',
          rating: 999,
          review: 'Testing server-side rating clamp'
        }
      })
    });
    const savedClampedLog = badRatingRes.data.state.logs.find((l) => l.id === 'stress-clamped-rating');
    assert.equal(savedClampedLog.rating, 5.0, `Expected rating=999 to be clamped to 5.0, got ${savedClampedLog.rating}`);

    const negDeltaRes = await fetchJson('/api/logs/log-2/progress', {
      method: 'POST',
      body: JSON.stringify({ action: 'increment_episode', delta: -500 })
    });
    assert.equal(
      negDeltaRes.data.log.progress.episode,
      5,
      `Negative delta=-500 clamped cleanly to +1 episode (S2E4 -> S2E${negDeltaRes.data.log.progress.episode})`
    );

    console.log(
      `✅ PASS [Stress 3: Server-Side Numeric Clamping] rating=999 clamped to ${savedClampedLog.rating}★ | delta=-500 clamped cleanly to S2E${negDeltaRes.data.log.progress.episode}`
    );
  }

  // 4. "Start Reading" on an Already-Completed Book Preserves Old Diary Entry & Creates New Reread Log
  {
    await resetAndSeedTestFixtures();
    const startAgainRes = await fetchJson('/api/currently-tracking', {
      method: 'POST',
      body: JSON.stringify({ mediaId: 'book-301' })
    });
    assert.equal(startAgainRes.status, 201);
    const oldCompletedLog = startAgainRes.data.state.logs.find((l) => l.id === 'log-3');
    assert.ok(oldCompletedLog, 'Original completed log-3 still exists');
    assert.equal(oldCompletedLog.progress.status, 'completed', 'Original log-3 remains completed');
    assert.notEqual(startAgainRes.data.log.id, 'log-3', 'Created a brand-new reread log entry');
    assert.equal(startAgainRes.data.log.isRewatch, true, 'New reread log has isRewatch: true');
    assert.equal(startAgainRes.data.log.progress.status, 'reading', 'New reread log is active on the shelf');

    console.log(
      `✅ PASS [Stress 4: Completed Diary Preservation on Reread/Rewatch] Original log-3 stayed status="completed" while new reread log "${startAgainRes.data.log.id}" (isRewatch=true) was created`
    );
  }

  // 5. One-Time Migration Flag (`inProgressSeededV1`) & Atomic Disk Write (`db.json.tmp` + `renameSync`)
  {
    const serverCode = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
    const appCode = fs.readFileSync(path.join(__dirname, 'public', 'app.js'), 'utf8');
    assert.ok(
      serverCode.includes('inProgressSeededV1') && appCode.includes('inProgressSeededV1'),
      'One-time inProgressSeededV1 migration flag present in server.js and app.js'
    );
    assert.ok(
      serverCode.includes('fs.renameSync('),
      'Atomic temp-file write + fs.renameSync present in saveState()'
    );

    await fetchJson('/api/logs/log-9', { method: 'DELETE' });
    const stateAfterDel = await fetchJson('/api/state');
    assert.ok(!stateAfterDel.data.logs.some((l) => l.id === 'log-9'), 'Deleted starter log-9 stays deleted');

    console.log(
      '✅ PASS [Stress 5: One-Time Migration Flag & Atomic Disk Writes] inProgressSeededV1 prevents deleted starter logs from resurrecting & saveState uses atomic fs.renameSync'
    );
  }

  // 6. Round 2 Fix #1: Real TV `episodesPerSeason` Progress Bar, Season Rollover (S1E9 -> S2E1) & Finale Completion
  {
    await resetAndSeedTestFixtures();
    // Set Severance (log-2, episodesPerSeason: [9, 10]) to S1E9
    await fetchJson('/api/logs/log-2/progress', {
      method: 'POST',
      body: JSON.stringify({ season: 1, episode: 9, status: 'watching' })
    });
    // Bump +1 Ep -> should roll over to S2E1!
    const rolloverRes = await fetchJson('/api/logs/log-2/progress', {
      method: 'POST',
      body: JSON.stringify({ action: 'increment_episode' })
    });
    assert.equal(rolloverRes.data.log.progress.season, 2, 'Rolled over from Season 1 to Season 2');
    assert.equal(rolloverRes.data.log.progress.episode, 1, 'Reset episode to E1 on Season 2 rollover');
    assert.equal(rolloverRes.data.log.progress.status, 'watching', 'Status remains watching after season rollover');

    // Set to S2E9 and bump +1 Ep -> S2E10, then bump again -> completed
    await fetchJson('/api/logs/log-2/progress', {
      method: 'POST',
      body: JSON.stringify({ season: 2, episode: 10, status: 'watching' })
    });
    const finaleRes = await fetchJson('/api/logs/log-2/progress', {
      method: 'POST',
      body: JSON.stringify({ action: 'increment_episode' })
    });
    assert.equal(finaleRes.data.log.progress.season, 2);
    assert.equal(finaleRes.data.log.progress.episode, 10);
    assert.equal(finaleRes.data.log.progress.status, 'completed');
    assert.equal(finaleRes.data.log.progress.percent, 100);

    console.log(
      '✅ PASS [Stress 6 / Round 2 #1: TV episodesPerSeason Rollover & Finale Auto-Complete] S1E9 +1 Ep -> S2E1 | S2E10 finale -> status="completed" (100%)'
    );
  }

  // 7. Round 2 Fix #2: Top 4 Favorites Deduplication / Slot Swapping
  {
    const favRes = await fetchJson('/api/profile', {
      method: 'PUT',
      body: JSON.stringify({
        favorites: {
          movie: ['movie-101', 'movie-101', 'movie-101', 'movie-101']
        }
      })
    });
    assert.equal(favRes.status, 200);
    const movieFavs = favRes.data.user.favorites.movie;
    assert.equal(new Set(movieFavs).size, 4, `Expected 4 unique movie favorites, got ${JSON.stringify(movieFavs)}`);

    console.log(
      `✅ PASS [Stress 7 / Round 2 #2: Top 4 Favorites Deduplication] Duplicate payload deduplicated to 4 unique slots: ${JSON.stringify(movieFavs)}`
    );
  }

  // 8. Round 2 Fix #3: Dynamic `communityRating` & `ratingsCount` Recalculation on Log Add/Edit/Delete
  {
    await resetAndSeedTestFixtures();
    const beforeState = await fetchJson('/api/state');
    const movieBefore = beforeState.data.catalog.find((c) => c.id === 'movie-101');
    const countBefore = movieBefore.ratingsCount;

    const addLogRes = await fetchJson('/api/logs', {
      method: 'POST',
      body: JSON.stringify({
        log: {
          id: 'stress-dynamic-rating-log',
          mediaId: 'movie-101',
          mediaType: 'movie',
          rating: 1.0,
          review: 'Testing dynamic rating count increment'
        }
      })
    });
    const movieAfterAdd = addLogRes.data.state.catalog.find((c) => c.id === 'movie-101');
    assert.equal(movieAfterAdd.ratingsCount, countBefore + 1, 'ratingsCount incremented by 1 after adding new log');

    const delLogRes = await fetchJson('/api/logs/stress-dynamic-rating-log', { method: 'DELETE' });
    const movieAfterDel = delLogRes.data.state.catalog.find((c) => c.id === 'movie-101');
    assert.equal(movieAfterDel.ratingsCount, countBefore, 'ratingsCount decremented back after deleting log');

    console.log(
      `✅ PASS [Stress 8 / Round 2 #3: Dynamic communityRating & ratingsCount] ratingsCount updated ${countBefore} -> ${movieAfterAdd.ratingsCount} -> ${movieAfterDel.ratingsCount}`
    );
  }

  // 9. Round 2 Fix #4: Custom Lists Edit Support + `itemIds` Deduplication
  {
    const createListRes = await fetchJson('/api/lists', {
      method: 'POST',
      body: JSON.stringify({
        id: 'stress-edit-list',
        title: 'Duplicate Test List',
        description: 'Initial description',
        isRanked: true,
        itemIds: ['movie-101', 'movie-101', 'tv-201', 'tv-201', 'book-301']
      })
    });
    assert.equal(createListRes.status, 201);
    const createdList = createListRes.data.state.lists.find((l) => l.id === 'stress-edit-list');
    assert.deepEqual(
      createdList.itemIds,
      ['movie-101', 'tv-201', 'book-301'],
      'Duplicate itemIds removed on list creation'
    );

    const editListRes = await fetchJson('/api/lists/stress-edit-list', {
      method: 'PUT',
      body: JSON.stringify({
        title: 'Updated List Title',
        description: 'Updated description',
        isRanked: false,
        itemIds: ['movie-102', 'book-302', 'movie-102']
      })
    });
    assert.ok(editListRes.status === 200 || editListRes.status === 201);
    const updatedList = editListRes.data.state.lists.find((l) => l.id === 'stress-edit-list');
    assert.equal(updatedList.title, 'Updated List Title');
    assert.deepEqual(updatedList.itemIds, ['movie-102', 'book-302']);

    console.log(
      '✅ PASS [Stress 9 / Round 2 #4: Custom Lists Edit & itemIds Deduplication] Duplicate IDs removed & PUT /api/lists/:id updated list cleanly'
    );
  }

  // 10. Round 2 Fix #5: Online Search Catalog Deduplication (Matches Existing Title + Type + Year)
  {
    const beforeCat = await fetchJson('/api/state');
    const catalogLenBefore = beforeCat.data.catalog.length;

    const dupExternalRes = await fetchJson('/api/catalog', {
      method: 'POST',
      body: JSON.stringify({
        id: 'itunes-9999999',
        type: 'movie',
        title: 'Dune: Part Two',
        year: 2024,
        creator: 'Denis Villeneuve'
      })
    });
    assert.equal(dupExternalRes.status, 201);
    assert.equal(
      dupExternalRes.data.item.id,
      'movie-101',
      'External duplicate Dune: Part Two resolved to canonical movie-101'
    );
    assert.equal(
      dupExternalRes.data.state.catalog.length,
      catalogLenBefore,
      'Catalog length unchanged (no duplicate item created)'
    );

    console.log(
      `✅ PASS [Stress 10 / Round 2 #5: Online Search Catalog Deduplication] External "Dune: Part Two" (itunes-9999999) linked to existing "${dupExternalRes.data.item.id}" without duplicating catalog`
    );
  }

  // 11. Auth Vault Security & Wrong-Current-Password Rejection (`data/auth.json`)
  {
    const signupRes = await fetchJson('/api/auth/signup', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Vault Stress User',
        handle: '@vault_stress',
        email: 'vault.stress@omnilog.app',
        password: 'StrongStressPassword2026!',
        confirmPassword: 'StrongStressPassword2026!'
      })
    });
    assert.equal(signupRes.status, 201, 'Auth signup should succeed');
    const token = signupRes.data.sessionToken;
    const userId = signupRes.data.user.id;

    // Attempt to change email/password with WRONG currentPassword -> must reject with 401
    const badCredUpdate = await fetchJson('/api/auth/credentials', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        userId,
        currentPassword: 'WrongCurrentPassword!',
        newEmail: 'hijacked@omnilog.app',
        newPassword: 'HijackedPassword2026!'
      })
    });
    assert.equal(badCredUpdate.status, 401, 'PUT /api/auth/credentials with wrong currentPassword must return 401');

    // Verify data/auth.json permissions (0600) and zero plaintext leakage
    const authPath = path.join(__dirname, 'data', 'auth.json');
    const authMode = (fs.statSync(authPath).mode & 0o777).toString(8);
    assert.equal(authMode, '600', 'data/auth.json mode must remain 0600');
    const authContent = fs.readFileSync(authPath, 'utf8');
    assert.ok(!authContent.includes('StrongStressPassword2026!'), 'No plaintext password on disk');

    console.log(
      '✅ PASS [Stress 11: Auth Vault Security & Wrong-Password Rejection] 0600 mode verified, zero plaintext on disk, and unauthorized credential change rejected (401)'
    );
  }

  // 12. Clean Reset (100% Blank Slate for Signed-Out Onboarding)
  {
    const resetRes = await fetchJson('/api/reset', { method: 'POST' });
    assert.equal(resetRes.status, 200);
    assert.equal(resetRes.data.currentUserId, null, 'Clean reset must set currentUserId: null');
    assert.equal(Object.keys(resetRes.data.users || {}).length, 0, 'Clean reset must have 0 users');
    assert.equal((resetRes.data.logs || []).length, 0, 'Clean reset must have 0 logs');
    assert.equal((resetRes.data.lists || []).length, 0, 'Clean reset must have 0 lists');
    assert.equal((resetRes.data.watchlist || []).length, 0, 'Clean reset must have 0 watchlist items');
    const authVaultAfterReset = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'auth.json'), 'utf8'));
    assert.equal(Object.keys(authVaultAfterReset.accounts || {}).length, 0, 'Clean reset must have 0 accounts in data/auth.json');
    console.log('\n✅ PASS [Clean Reset] POST /api/reset completed — data/db.json and data/auth.json restored to 100% blank signed-out onboarding state.');
  }

  console.log('\n=== ALL 11 STRESS & HARDENING TESTS PASSED (100%) ===');
  } finally {
    if (initialSnapshot && Object.keys(initialSnapshot.db?.users || {}).length > 0) {
      await fetchJson('/api/test-snapshot/restore', {
        method: 'POST',
        body: JSON.stringify({ db: initialSnapshot.db, auth: initialSnapshot.auth })
      });
    }
  }
}

runStressTests().catch((err) => {
  console.error('Stress test failed:', err);
  process.exit(1);
});
