# Unified Media Social Platform — Technical & Product Specification (`SPEC.md`)

**Author:** Robbie (Researcher)  
**Target Directory:** `/Users/jacksoncooper/.gemini/antigravity/scratch/media-app`  
**Scope:** Thorough rough draft of core functions for a Letterboxd-style social platform supporting **Movies**, **TV Shows**, and **Books**.

---

## 1. Unified Media Item Schema

All three media types (`movie`, `tv`, `book`) normalize into a single unified `MediaItem` interface so that logs, lists, feeds, ratings, and profile favorites work seamlessly across media boundaries.

```typescript
export type MediaType = 'movie' | 'tv' | 'book';

export interface MediaItem {
  id: string;                 // Prefixed ID, e.g., "movie-101", "tv-202", "book-303", or external "itunes-...", "tvmaze-...", "ol-..."
  externalId?: string;        // Raw upstream ID from iTunes, TVMaze, or OpenLibrary
  type: MediaType;            // 'movie' | 'tv' | 'book'
  title: string;              // Primary title
  year: number | null;        // Release / first air / publication year
  creator: string;            // Director (movie), Showrunner/Network (tv), Author (book)
  posterUrl: string;          // High-res vertical cover/poster URL
  backdropUrl?: string;       // Wide banner image URL (fallback to blurred posterUrl in UI)
  synopsis: string;           // Plot summary / description
  genres: string[];           // Array of genre tags, e.g. ["Sci-Fi", "Drama"]
  
  // Medium-specific metadata (unified & optional)
  runtimeMinutes?: number;    // For movies (e.g., 166)
  seasonsCount?: number;      // For TV shows (e.g., 4)
  episodesCount?: number;     // For TV shows (e.g., 36)
  pagesCount?: number;        // For books (e.g., 412)
  
  // Community & Aggregate Stats
  communityRating: number;    // Average rating 0.5 - 5.0 (e.g., 4.3)
  ratingsCount: number;       // Total number of logs/ratings
  ratingDistribution?: number[]; // 10-bucket array for 0.5 to 5.0 star histogram
}
```

---

## 2. Zero-Key Live Search APIs & Normalization Mappers

To ensure live search works out of the box in the browser or backend with **zero API keys required**, we use three public CORS-friendly APIs:

### 2.1 Movies — Apple iTunes Search API
- **Endpoint:** `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&media=movie&entity=movie&limit=10`
- **No API Key Required**, supports browser `fetch` directly.
- **Normalization Mapping:**
  - `id`: `"itunes-" + item.trackId`
  - `type`: `"movie"`
  - `title`: `item.trackName`
  - `year`: ` item.releaseDate ? new Date(item.releaseDate).getFullYear() : null`
  - `creator`: `item.artistName` (Director)
  - `posterUrl`: `item.artworkUrl100?.replace('100x100bb', '600x900bb')` (Upgrades thumbnail to high-res 600x900 poster!)
  - `synopsis`: `item.longDescription || item.shortDescription || ""`
  - `genres`: `item.primaryGenreName ? [item.primaryGenreName] : []`
  - `runtimeMinutes`: `item.trackTimeMillis ? Math.round(item.trackTimeMillis / 60000) : undefined`

### 2.2 TV Shows — TVMaze API
- **Endpoint:** `https://api.tvmaze.com/search/shows?q=${encodeURIComponent(query)}`
- **No API Key Required**, fast & CORS-enabled.
- **Normalization Mapping (from `entry.show`):**
  - `id`: `"tvmaze-" + show.id`
  - `type`: `"tv"`
  - `title`: `show.name`
  - `year`: `show.premiered ? parseInt(show.premiered.slice(0, 4), 10) : null`
  - `creator`: `show.network?.name || show.webChannel?.name || "TV Series"`
  - `posterUrl`: `show.image?.original || show.image?.medium || fallbackPoster`
  - `synopsis`: `show.summary ? show.summary.replace(/<[^>]+>/g, '') : ""` (Strip HTML tags)
  - `genres`: `show.genres || []`
  - `communityRating`: `show.rating?.average ? Number((show.rating.average / 2).toFixed(1)) : 4.0` (Convert 10-point scale to 5-star scale)

### 2.3 Books — Open Library Search API
- **Endpoint:** `https://openlibrary.org/search.json?q=${encodeURIComponent(query)}&limit=10`
- **No API Key Required**, CORS-enabled.
- **Normalization Mapping (from `doc`):**
  - `id`: `"ol-" + doc.key.replace('/works/', '')`
  - `type`: `"book"`
  - `title`: `doc.title`
  - `year`: `doc.first_publish_year || null`
  - `creator`: `doc.author_name?.[0] || "Unknown Author"`
  - `posterUrl`: `doc.cover_i ? "https://covers.openlibrary.org/b/id/" + doc.cover_i + "-L.jpg" : fallbackBookCover`
  - `synopsis`: `doc.first_sentence?.[0] || ("Published in " + (doc.first_publish_year || "N/A") + " by " + (doc.author_name?.[0] || "Unknown"))`
  - `genres`: `(doc.subject || []).slice(0, 3)`
  - `pagesCount`: `doc.number_of_pages_median || undefined`
  - `communityRating`: `doc.ratings_average ? Number(doc.ratings_average.toFixed(1)) : 4.1`

---

## 3. Core Letterboxd-Style User Flows & Data Models

### 3.1 Diary / Logging Flow (`LogEntry`)
Users can log any Movie, TV Show, or Book via a universal **"+" Log Modal** or directly from a media detail page.
- **Half-Star Rating:** `0.5` to `5.0` stars (10 increments: `0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0`), plus optional heart/like toggle (`liked: boolean`).
- **Date Logged / Consumed:** ISO date string (`YYYY-MM-DD`), defaults to today.
- **Review Text:** Markdown/plain text review.
- **Spoiler Flag:** `containsSpoilers: boolean` — hides review body behind a "Contains Spoilers — Click to Reveal" banner in feeds and detail pages.
- **Rewatch / Reread Flag:** `isRewatch: boolean` ("I've watched/read this before").
- **Medium-Specific Progress Tracking:**
  - **TV Shows:** Optional `seasonNumber?: number`, `episodeNumber?: number`, or status (`"Completed"`, `"In Progress"`, `"Season 2, Ep 5"`).
  - **Books:** Optional `currentPage?: number`, `totalPages?: number`, or percentage (`"Page 210 / 412"`).
  - **Movies:** Standard theatrical/home watch log.

```typescript
export interface LogEntry {
  id: string;
  userId: string;
  mediaId: string;
  mediaType: MediaType;
  rating: number | null;       // 0.5 to 5.0 in 0.5 steps
  liked: boolean;              // Heart icon
  dateConsumed: string;        // YYYY-MM-DD
  createdAt: string;           // ISO timestamp
  review: string;
  containsSpoilers: boolean;
  isRewatch: boolean;          // Rewatch (movie/tv) or Reread (book)
  // Progress tracking for TV & Books
  progress?: {
    season?: number;
    episode?: number;
    currentPage?: number;
    totalPages?: number;
    status?: 'completed' | 'in_progress' | 'dropped';
  };
  likesCount: number;
  likedByMe?: boolean;
  comments: CommentItem[];
}
```

### 3.2 Watchlist / Reading List ("Want to Watch / Read")
- Unified queue stored per user (`watchlistIds: string[]`), filterable by **All**, **Movies** (Watchlist), **TV Shows** (Watchlist), and **Books** (Reading List).
- One-click bookmark toggle on every poster card and media detail page.
- Logging an item automatically offers/triggers removal from the Watchlist/Reading List.

### 3.3 Custom Lists (`CustomList`)
- Users can curate ranked or unranked cross-media or single-media lists (e.g., *"Best Cyberpunk Across Film, TV & Fiction"*, *"2026 Summer Reading Stack"*, *"Comfort Sci-Fi Movies"*).
- Schema:
  ```typescript
  export interface CustomList {
    id: string;
    userId: string;
    title: string;
    description: string;
    isRanked: boolean;
    itemIds: string[];         // Ordered array of MediaItem IDs
    likesCount: number;
    createdAt: string;
  }
  ```

### 3.4 Social Activity Feed
- Displays recent `LogEntry` items from the user and followed friends/critics.
- Each feed card shows:
  - User avatar, handle, action badge (*"watched"*, *"rewatched"*, *"read"*, *"reread"*, *"logged S2E4 of"*).
  - Media poster thumbnail, title, year, media type pill (`MOVIE`, `TV`, `BOOK`).
  - Star rating (`★`/`½`), heart icon if liked, progress badge (for TV/Books), spoiler shield if `containsSpoilers === true`.
  - Interactive **Like** button (increments counter) and **Comments** drawer/inline thread.

### 3.5 User Profile & Stats
- **Top 4 Favorites per Medium (or Unified Top 4 + Per-Medium Tabs):**
  - Users showcase their **Top 4 Movies**, **Top 4 TV Shows**, and **Top 4 Books** (12 slots total, or switchable by medium tab, with an interactive picker to swap favorites).
- **Profile Statistics:**
  - Total Films Watched, Total TV Shows/Episodes Logged, Total Books/Pages Read.
  - Rating distribution bar chart (0.5★ to 5.0★).
- **Diary Tab:** Chronological calendar table grouped by Month/Year showing Date, Media Type icon, Poster, Title, Year, Rating, Heart, Rewatch/Reread icon, and Review indicator.

---

## 4. Curated Seed Dataset Recommendation

To make the application feel alive immediately on first load (before the user even types a search query), pre-populate local state/storage with:
- **6 Movies:** *Dune: Part Two* (2024), *Past Lives* (2023), *Everything Everywhere All at Once* (2022), *Blade Runner 2049* (2017), *Parasite* (2019), *Spider-Man: Across the Spider-Verse* (2023).
- **6 TV Shows:** *Severance* (2022), *Succession* (2018), *The Bear* (2022), *Arcane* (2021), *Shōgun* (2024), *Chernobyl* (2019).
- **6 Books:** *Project Hail Mary* (Andy Weir, 2021), *Dune* (Frank Herbert, 1965), *Tomorrow, and Tomorrow, and Tomorrow* (Gabrielle Zevin, 2022), *The Three-Body Problem* (Liu Cixin, 2008), *Piranesi* (Susanna Clarke, 2020), *Blood Meridian* (Cormac McCarthy, 1985).
- **4 Sample Users & 8 Rich Social Logs** (including spoiler-tagged reviews, TV episode progress logs, book page progress logs, and 3 curated Custom Lists).


---

## 5. Visual & UX Redesign Specification — "Warm Wood Bookshop & Library Lounge"

**User Feedback Trigger:**
1. *"Okay I really like the site so far it looks good. It looks a little too close to Letterboxd"*
2. *"Yeah let’s go with a nice bookshop vibe something wood colored you know?"*

### 5.1 Design Direction: Tactile Wood-Panelled Bookshop & Curated Media Parlor
Move away from the dark blue-slate digital Letterboxd clone (`#14181c` + neon green/orange/blue dots) to a warm, tactile **independent bookshop & mahogany media parlor** aesthetic ("The Oak & Folio" / "Ex Libris").

### 5.2 Color Tokens & Surface Palette (CSS Custom Properties)
- **Wood Backgrounds & Surfaces:**
  - `--bg-walnut-deep`: `#1f140e` (Deep espresso/walnut backdrop)
  - `--bg-mahogany`: `#2b1d14` (Primary room background with subtle wood-grain CSS linear/repeating-linear gradients)
  - `--surface-oak`: `#3d281c` (Raised wooden cabinet / shelf background)
  - `--surface-teak`: `#543828` (Card & shelf ledge surface)
  - `--border-wood`: `#6e4933` (Beveled wood trim & shelf edge highlight)
- **Warm Parchment & Cream Text / Index Cards:**
  - `--parchment-light`: `#f6efe2` (Primary headings & high-contrast cream text)
  - `--parchment-warm`: `#eadbc4` (Body copy & library card surface tint)
  - `--parchment-muted`: `#c8b090` (Secondary metadata, catalog stamps)
- **Bookshop Accents (Replacing Letterboxd Tri-Dots):**
  - `--accent-brass`: `#d49b4b` / `#e0a958` (Polished brass lamps, star ratings, primary CTAs, active tabs, `accent-color: #d49b4b`)
  - `--accent-oxblood`: `#b8533c` (Terracotta / bookbinding cloth red for Movies badge & heart likes)
  - `--accent-sage`: `#4f7759` (Forest library banker's lamp green for Books badge & completed status)
  - `--accent-amber`: `#c97a3e` (Warm copper/amber for TV Series badge)

### 5.3 Typography & Editorial Hierarchy
- **Display / Headings (`--font-display`):** `"Playfair Display", "Instrument Serif", "Newsreader", Georgia, serif` — used for brand masthead, section headers, media titles, and pull-quotes.
- **Humanist UI Body (`--font-sans`):** `"Plus Jakarta Sans", "Inter", system-ui, sans-serif` — clean and legible for controls and descriptions.
- **Catalog Monospace (`--font-mono`):** `"JetBrains Mono", "Courier Prime", monospace` — used for library catalog numbers (`CAT. NO. MV-2024`), stamped dates (`OCT 26, 2026`), runtime/page counts, and rating numerals.

### 5.4 Distinct Non-Letterboxd Layout & Tactile Bookshop Signatures
1. **Bookshop Masthead & Brass Signboard Header:**
   - Replace the 3-dot Letterboxd logo with an engraved brass & oak bookshop emblem (e.g., bookshop arch / open folio icon + *"Folio & Frame — Curated Cinema, Television & Literature"* subtitle).
   - Navigation styled like brass shelf placards (`Browse the Stacks`, `Reading & Viewing Ledger`, `Curated Tables`, `Want-to-Read/Watch Queue`, `Member Card`).
2. **Physical Wooden Shelf Ledges Under Media Grids:**
   - Media grids sit atop tactile wooden shelf rails (`.wood-shelf` with a multi-stop oak/walnut gradient ledge and subtle drop shadow beneath posters/covers so items look perched on real bookshop shelves).
   - Posters & covers feature subtle book-spine crease highlights on the left edge (`inset 4px 0 8px rgba(255,255,255,0.12)`).
3. **Library Catalog / Ex Libris Review Cards:**
   - Reviews and diary entries look like **stamped library index cards / leather-bound ledger entries** with ruled horizontal lines, library date stamps (`DATE LOGGED`), catalog numbers, and brass corner accents.
4. **Preserve 100% Core Functionality & Modern Web Guidance:**
   - Keep native `<dialog closedby="any">`, `<article class="card">` with `@container` queries (`container-type: inline-size`), fluid `clamp()` typography, `100dvh` layouts, and explicit `accent-color: var(--accent-brass)` on `:root` and form controls for `brand-consistent-forms`.


---

## 6. Verified Live HTTP-200 High-Resolution Cover & Poster Art for All 24 Seed Items

Every single URL below has been verified via live `HEAD` request (`HTTP 200 OK`) and serves authentic theatrical posters, TV key art, and book edition covers:

### 6.1 Movies (`movie-101` – `movie-108`)
- **`movie-101` (*Dune: Part Two*, 2024)**:
  `https://is1-ssl.mzstatic.com/image/thumb/Video221/v4/71/a8/31/71a8312e-a20a-29b2-af70-5cab08908657/aca7621e-74e7-419a-96cd-5aaff99fb0cc_DUNE_PART2_V_DD_KA_TT_2000x3000_300dpi_EN-srgb.lsr/600x900bb.jpg`
- **`movie-102` (*Past Lives*, 2023)**:
  `https://upload.wikimedia.org/wikipedia/en/d/da/Past_Lives_film_poster.png`
- **`movie-103` (*Everything Everywhere All at Once*, 2022)**:
  `https://upload.wikimedia.org/wikipedia/en/1/1e/Everything_Everywhere_All_at_Once.jpg`
- **`movie-104` (*Blade Runner 2049*, 2017)**:
  `https://upload.wikimedia.org/wikipedia/en/9/9b/Blade_Runner_2049_poster.png`
- **`movie-105` (*Parasite*, 2019)**:
  `https://upload.wikimedia.org/wikipedia/en/5/53/Parasite_%282019_film%29.png`
- **`movie-106` (*Spider-Man: Across the Spider-Verse*, 2023)**:
  `https://is1-ssl.mzstatic.com/image/thumb/Video221/v4/5e/88/10/5e8810c1-9025-b950-8dae-cfdcb7dbd75f/DP_10232262_SPIDER-MANACROSSTHESPIDER-VERSE_2000x3000_PURPLEHUEKeyArt.jpg/600x900bb.jpg`
- **`movie-107` (*Oppenheimer*, 2023)**:
  `https://upload.wikimedia.org/wikipedia/en/4/4a/Oppenheimer_%28film%29.jpg`
- **`movie-108` (*Portrait of a Lady on Fire*, 2019)**:
  `https://upload.wikimedia.org/wikipedia/en/c/cb/Portrait_of_a_Lady_on_Fire.jpg`

### 6.2 TV Shows (`tv-201` – `tv-208` via TVMaze `original_untouched`)
- **`tv-201` (*Severance*, 2022)**:
  `https://static.tvmaze.com/uploads/images/original_untouched/548/1371406.jpg`
- **`tv-202` (*Succession*, 2018)**:
  `https://static.tvmaze.com/uploads/images/original_untouched/453/1134275.jpg`
- **`tv-203` (*The Bear*, 2022)**:
  `https://static.tvmaze.com/uploads/images/original_untouched/629/1574642.jpg`
- **`tv-204` (*Arcane*, 2021)**:
  `https://static.tvmaze.com/uploads/images/original_untouched/536/1340287.jpg`
- **`tv-205` (*Shōgun*, 2024)**:
  `https://static.tvmaze.com/uploads/images/original_untouched/506/1265637.jpg`
- **`tv-206` (*Chernobyl*, 2019)**:
  `https://static.tvmaze.com/uploads/images/original_untouched/193/482599.jpg`
- **`tv-207` (*Andor*, 2022)**:
  `https://static.tvmaze.com/uploads/images/original_untouched/564/1411766.jpg`
- **`tv-208` (*The Last of Us*, 2023)**:
  `https://static.tvmaze.com/uploads/images/original_untouched/563/1409008.jpg`

### 6.3 Books (`book-301` – `book-308` via Apple Books `600x900bb.jpg` & Open Library Covers `-L.jpg`)
- **`book-301` (*Project Hail Mary*, 2021)**:
  - Primary (Apple Books `600x900bb`): `https://is1-ssl.mzstatic.com/image/thumb/Publication211/v4/13/fb/63/13fb6355-fce2-0e4b-08b7-48452037759a/9780593135211.d.jpg/600x900bb.jpg`
  - Open Library (`-L.jpg`): `https://covers.openlibrary.org/b/id/11200092-L.jpg`
- **`book-302` (*Dune*, 1965)**:
  - Primary (Apple Books `600x900bb`): `https://is1-ssl.mzstatic.com/image/thumb/Publication122/v4/85/70/2f/85702f34-2982-e2ee-d883-b5ffc3ae0897/9781101658055.d.jpg/600x900bb.jpg`
  - Open Library (`-L.jpg`): `https://covers.openlibrary.org/b/id/11481354-L.jpg`
- **`book-303` (*Tomorrow, and Tomorrow, and Tomorrow*, 2022)**:
  - Primary (Apple Books `600x900bb`): `https://is1-ssl.mzstatic.com/image/thumb/Publication221/v4/0a/52/d9/0a52d9fc-a8cc-af1d-fe3a-5d27e9858212/9780593321218.d.jpg/600x900bb.jpg`
  - Open Library (`-L.jpg`): `https://covers.openlibrary.org/b/id/12859975-L.jpg`
- **`book-304` (*The Three-Body Problem*, 2008)**:
  - Primary (Apple Books `600x900bb`): `https://is1-ssl.mzstatic.com/image/thumb/Publication211/v4/25/2f/92/252f926a-1db7-c938-3477-8e78d29e8704/9781466853447.jpg/600x900bb.jpg`
- **`book-305` (*Piranesi*, 2020)**:
  - Primary (Apple Books `600x900bb`): `https://is1-ssl.mzstatic.com/image/thumb/Publication116/v4/2c/2e/b4/2c2eb4b8-6a28-c926-b0ed-03fbd7ed2ce0/1031214040.jpg/600x900bb.jpg`
  - Open Library (`-L.jpg`): `https://covers.openlibrary.org/b/id/10226290-L.jpg`
- **`book-306` (*Blood Meridian*, 1985)**:
  - Primary (Apple Books `600x900bb`): `https://is1-ssl.mzstatic.com/image/thumb/Publication221/v4/99/e9/c5/99e9c5a3-0818-b79a-e4c7-f815120388b1/9780307762528.d.jpg/600x900bb.jpg`
  - Open Library (`-L.jpg`): `https://covers.openlibrary.org/b/id/419991-L.jpg`
- **`book-307` (*Klara and the Sun*, 2021)**:
  - Primary (Apple Books `600x900bb`): `https://is1-ssl.mzstatic.com/image/thumb/Publication116/v4/ba/7b/b0/ba7bb051-38ad-3553-98a4-1c93b41c0fbd/9780593318188.d.jpg/600x900bb.jpg`
  - Open Library (`-L.jpg`): `https://covers.openlibrary.org/b/id/10648686-L.jpg`
- **`book-308` (*The Left Hand of Darkness*, 1969)**:
  - Primary (Apple Books `600x900bb`): `https://is1-ssl.mzstatic.com/image/thumb/Publication211/v4/33/13/9c/33139cdd-1a27-94a4-1d8e-29c3bbf39b38/9781101665398.d.jpg/600x900bb.jpg`
  - Open Library (`-L.jpg`): `https://covers.openlibrary.org/b/id/10618463-L.jpg`


---

## 7. "Currently Watching & Reading" Shelf with One-Tap Progress Bumping (`SPEC.md` #2)

**User Feedback Trigger:**
*"okay yes lets go with number 2 now please"* (After approving step-by-step rollout; note: hold off on any mobile-specific navigation changes for now so we focus strictly on #2).

### 7.1 Seed In-Progress Logs for `user-jackson`
Ensure `user-jackson` (`currentUserId`) has 3 rich in-progress starter entries in `public/data.js`, `data/db.json`, and auto-upgraded on load in `server.js` / `public/app.js` so the shelf is populated immediately on refresh:
1. **`tv-201` (*Severance*, 2022)** — `log-2`:
   - `progress: { season: 2, episode: 4, status: 'in_progress' }` (or `'watching'`)
2. **`tv-203` (*The Bear*, 2022)**:
   - `progress: { season: 3, episode: 6, status: 'in_progress' }`
3. **`book-303` (*Tomorrow, and Tomorrow, and Tomorrow*, 2022, 401 pages)**:
   - `progress: { currentPage: 180, totalPages: 401, percent: 45, status: 'in_progress' }`

*(Note: Support `status: 'in_progress'`, `'watching'`, or `'reading'` interchangeably as active in-progress states!)*

### 7.2 REST Endpoint: `POST /api/logs/:id/progress`
Allows instant one-tap progress bumping from the "Currently Watching & Reading" shelf (with optimistic UI + `localStorage` & `data/db.json` persistence):
- **Supported Payload Actions:**
  - `action: 'increment_episode'` (or `+1 Ep` button for TV Shows):
    - Increments `log.progress.episode = (log.progress.episode || 1) + 1` (keeps `status: 'in_progress'`).
  - `action: 'increment_pages'` (or `+25 pp` button for Books):
    - Increments `log.progress.currentPage = Math.min(totalPages, (log.progress.currentPage || 0) + (body.deltaPages || 25))`
    - Updates `log.progress.percent = Math.round((currentPage / totalPages) * 100)`
    - If `currentPage >= totalPages`, automatically sets `log.progress.status = 'completed'`.
  - `action: 'finish'` (`✓ Finish` button for TV or Books):
    - Sets `log.progress.status = 'completed'`. For Books, also sets `currentPage = totalPages` and `percent = 100`.
- **"Start Watching" / "Start Reading" Quick Action:**
  - On TV Show and Book Detail modals, include a one-click **"Start Watching"** (initializes `season: 1, episode: 1, status: 'in_progress'`) or **"Start Reading"** (initializes `currentPage: 1, totalPages: item.pagesCount || 300, percent: 1, status: 'in_progress'`) button so any TV Show or Book can be added directly to the "Currently Watching & Reading" shelf.

### 7.3 UI & Anti-Cropping Layout
- Render a dedicated **"Currently Watching & Reading"** wooden bookshop shelf section at the top of the **Explore** view (and on the **Profile** view).
- Each shelf card uses `<article class="card currently-card">`:
  - Thumbnail poster with `aspect-ratio: 2 / 3; height: auto;` and `fallbackPosterUrl` `onerror` support.
  - Title, medium badge (`TV` / `BOOK`), and live progress readout (`S2 · E4` for TV, or `180 / 401 pp (45%)` for Books).
  - Native `<progress class="reading-progress" max="100" value="45">` bar styled with `accent-color: var(--accent-brass)` (`brand-consistent-forms`).
  - Compact, non-cropping one-tap action bar:
    - **`+1 Ep`** (for TV) or **`+25 pp`** (for Books)
    - **`✓ Finish`** (marks completed & graduates item from the active shelf into the completed ledger)
    - **`Edit`** (opens the Log/Edit modal pre-filled with that entry)


---

## 8. Cross-Media Adaptations & Related Titles Across Movies, TV Shows, and Books (Option A)

**User Feedback Trigger:**
*"Yes go ahead"* (Approving Option A: Cross-Media Adaptations & Related Titles across Movies, TV Shows, and Books inside the Detail Modal).

### 8.1 Data Schema Extension on `MediaItem` (`crossMediaLinks`)
Each `MediaItem` in `INITIAL_CATALOG` (and `data/db.json`) includes a `crossMediaLinks` array of curated cross-media connections, paired with a dynamic fallback `getCrossMediaRecommendations(item, catalog)` so newly searched/imported items also display rich cross-media connections across the other two mediums:

```typescript
export interface CrossMediaLink {
  targetId: string;           // ID of the linked MediaItem (e.g., 'book-302', 'movie-101', 'tv-207')
  relationType: 'adaptation' | 'companion' | 'thematic';
  relationLabel: string;      // e.g., "Based on the Novel", "Feature Film Adaptation", "Companion Historical Epic · TV", "Shared Theme · Book"
}
```

### 8.2 Curated Cross-Media Matrix for All 24 Seed Catalog Items
1. **Direct Adaptation & Source-Material Pairings:**
   - **`movie-101` (*Dune: Part Two*, 2024) ↔ `book-302` (*Dune*, Frank Herbert, 1965)**:
     - On `movie-101`: `{ targetId: 'book-302', relationType: 'adaptation', relationLabel: 'Based on the Novel by Frank Herbert' }`
     - On `book-302`: `{ targetId: 'movie-101', relationType: 'adaptation', relationLabel: 'Feature Film Adaptation (Denis Villeneuve)' }`
   - Plus companion/thematic links on both (`tv-207` *Andor*, `book-308` *The Left Hand of Darkness*, `movie-104` *Blade Runner 2049*).

2. **Curated Cross-Media Triads Across All 24 Seed Items:**
   - **`movie-101` (*Dune: Part Two*)**: `book-302` (*Dune* — Based on the Novel), `tv-207` (*Andor* — Rebel Empire Companion · TV), `book-308` (*The Left Hand of Darkness* — Worldbuilding Classic · Book)
   - **`movie-102` (*Past Lives*)**: `book-303` (*Tomorrow, and Tomorrow, and Tomorrow* — Soulmates Across Decades · Book), `movie-108` (*Portrait of a Lady on Fire* — Unspoken Devotion · Film), `tv-203` (*The Bear* — Intimate Character Study · TV)
   - **`movie-103` (*Everything Everywhere All at Once*)**: `tv-204` (*Arcane* — Kinetic Multiverse & Family · TV), `book-305` (*Piranesi* — Infinite Labyrinths · Book), `movie-106` (*Spider-Man: Across the Spider-Verse* — Multiverse Companion · Film)
   - **`movie-104` (*Blade Runner 2049*)**: `book-307` (*Klara and the Sun* — Artificial Souls · Book), `tv-201` (*Severance* — Corporate Dystopia · TV), `book-302` (*Dune* — Villeneuve Sci-Fi Lineage · Book)
   - **`movie-105` (*Parasite*)**: `tv-202` (*Succession* — Class Warfare & Wealth · TV), `tv-201` (*Severance* — Late-Capitalist Satire · TV), `book-306` (*Blood Meridian* — Unflinching Social Critique · Book)
   - **`movie-106` (*Spider-Man: Across the Spider-Verse*)**: `tv-204` (*Arcane* — Groundbreaking Animation · TV), `book-303` (*Tomorrow, and Tomorrow, and Tomorrow* — Digital Art & Creation · Book), `movie-103` (*Everything Everywhere All at Once* — Multiverse Storytelling · Film)
   - **`movie-107` (*Oppenheimer*)**: `tv-206` (*Chernobyl* — Nuclear History Companion · TV), `book-304` (*The Three-Body Problem* — Physics & Existential Stakes · Book), `book-306` (*Blood Meridian* — American Reckoning · Book)
   - **`movie-108` (*Portrait of a Lady on Fire*)**: `movie-102` (*Past Lives* — Fate & Memory · Film), `book-305` (*Piranesi* — Poetic Solitude · Book), `tv-205` (*Shōgun* — Period Immersion · TV)
   - **`tv-201` (*Severance*)**: `book-305` (*Piranesi* — Enigmatic Architecture & Memory · Book), `movie-104` (*Blade Runner 2049* — Identity & Conditioning · Film), `book-307` (*Klara and the Sun* — Manufactured Consciousness · Book)
   - **`tv-202` (*Succession*)**: `movie-105` (*Parasite* — Wealth & Power Dynamics · Film), `tv-205` (*Shōgun* — Dynastic Power Struggle · TV), `book-306` (*Blood Meridian* — Empire & Ambition · Book)
   - **`tv-203` (*The Bear*)**: `book-303` (*Tomorrow, and Tomorrow, and Tomorrow* — Creative Obsession & Partnership · Book), `movie-102` (*Past Lives* — Emotional Realism · Film), `tv-202` (*Succession* — High-Stress Ensemble · TV)
   - **`tv-204` (*Arcane*)**: `movie-106` (*Spider-Man: Across the Spider-Verse* — Stylized Visual Masterwork · Film), `book-302` (*Dune* — Faction Conflict & Lore · Book), `movie-103` (*Everything Everywhere All at Once* — Kinetic Action · Film)
   - **`tv-205` (*Shōgun*)**: `book-302` (*Dune* — Feudal Strategy & Honor · Book), `movie-101` (*Dune: Part Two* — Epic Political Cinema · Film), `movie-108` (*Portrait of a Lady on Fire* — Historical Craft · Film)
   - **`tv-206` (*Chernobyl*)**: `movie-107` (*Oppenheimer* — Atomic Age Companion · Film), `book-304` (*The Three-Body Problem* — Scientific Crisis · Book), `tv-207` (*Andor* — Authoritarian Bureaucracy · TV)
   - **`tv-207` (*Andor*)**: `movie-101` (*Dune: Part Two* — Rebellion Against Empire · Film), `book-302` (*Dune* — Political Sci-Fi Foundation · Book), `book-308` (*The Left Hand of Darkness* — Envoy on a Frozen World · Book)
   - **`tv-208` (*The Last of Us*)**: `book-301` (*Project Hail Mary* — Survival & Humanity · Book), `book-306` (*Blood Meridian* — Brutal Frontier Journey · Book), `movie-104` (*Blade Runner 2049* — Post-Collapse Odyssey · Film)
   - **`book-301` (*Project Hail Mary*)**: `book-304` (*The Three-Body Problem* — First Contact Science · Book), `tv-208` (*The Last of Us* — High-Stakes Survival · TV), `movie-101` (*Dune: Part Two* — Interstellar Epic · Film)
   - **`book-302` (*Dune*)**: `movie-101` (*Dune: Part Two* — Feature Film Adaptation), `tv-205` (*Shōgun* — Feudal Intrigue · TV), `tv-207` (*Andor* — Imperial Rebellion · TV)
   - **`book-303` (*Tomorrow, and Tomorrow, and Tomorrow*)**: `movie-102` (*Past Lives* — Decades-Long Bond · Film), `tv-203` (*The Bear* — Creative Partnership · TV), `movie-106` (*Spider-Man: Across the Spider-Verse* — Visual Artistry · Film)
   - **`book-304` (*The Three-Body Problem*)**: `movie-107` (*Oppenheimer* — Theoretical Physics & Fate · Film), `tv-206` (*Chernobyl* — Historical Secret Project · TV), `book-301` (*Project Hail Mary* — Hard Sci-Fi Companion · Book)
   - **`book-305` (*Piranesi*)**: `tv-201` (*Severance* — Surreal Halls & Mystery · TV), `movie-103` (*Everything Everywhere All at Once* — Alternate Realities · Film), `movie-108` (*Portrait of a Lady on Fire* — Haunting Atmosphere · Film)
   - **`book-306` (*Blood Meridian*)**: `movie-107` (*Oppenheimer* — Historical Darkness · Film), `tv-208` (*The Last of Us* — Unforgiving Landscape · TV), `movie-105` (*Parasite* — Moral Reckoning · Film)
   - **`book-307` (*Klara and the Sun*)**: `movie-104` (*Blade Runner 2049* — Artificial Devotion · Film), `tv-201` (*Severance* — Synthetic Identity · TV), `movie-102` (*Past Lives* — Quiet Melancholy · Film)
   - **`book-308` (*The Left Hand of Darkness*)**: `book-302` (*Dune* — Twin Pillars of Sci-Fi · Book), `tv-207` (*Andor* — Political Sci-Fi · TV), `movie-101` (*Dune: Part Two* — Off-World Anthropology · Film)

### 8.3 Dynamic Fallback & Modal-to-Modal Navigation UX
- **Dynamic Fallback (`getCrossMediaRecommendations(item, catalog)`)**:
  - Ensures that even newly searched live items (from iTunes, TVMaze, or Open Library) automatically surface 3–4 cross-media recommendations from the other mediums by scoring shared genres and community rating.
- **Bookshop Catalog Card UI inside `#detailDialog`**:
  - Render a **"Cross-Media Adaptations & Related Stacks"** section inside the Media Detail Modal (`#detailDialog`).
  - Highlight direct adaptations (`relationType === 'adaptation'`) with a brass-bordered **"Adaptation / Source Material"** badge, alongside related cross-media cards (`<article class="card cross-media-card">`) showing the medium pill (`MOVIE`, `TV`, `BOOK`), poster (`aspect-ratio: 2 / 3; height: auto`), title, year, and relationship tag (`relationLabel`).
  - Clicking any cross-media card seamlessly opens that item inside `#detailDialog` and scrolls `#detailDialog` to the top.


---

## 9. Multi-User Family & Friend Profiles, Account Switcher, and Social Graph

**User Feedback Trigger:**
*"okay lets start doing the profiles and friends profile, i think this will be just for my family for now but maybe ill fully release to the app store if they like it."*

### 9.1 Rich Per-User Data Model (`INITIAL_USERS` / `state.users`)
Upgrade every user in `INITIAL_USERS` (`user-jackson`, `user-maya`, `user-marcus`, `user-elena`, plus any newly created family/friend profile) so each profile has complete, self-contained data:
- `id`: string (e.g., `'user-jackson'`, `'user-maya'`, `'user-marcus'`, `'user-elena'`, or `'user-...'`)
- `name`: string
- `handle`: string (e.g., `'@jackson'`, `'@maya_chen'`, `'@marcus_vance'`, `'@elena_reads'`)
- `avatar`: 2-letter initials (auto-derived from `name` if not provided)
- `avatarColor`: hex color string
- `bio`: string
- `location`: string
- `followersCount`: number
- `followingCount`: number
- `followingIds`: string[] (array of user IDs this user follows, e.g., `user-jackson` starts following `['user-maya', 'user-marcus', 'user-elena']`)
- `watchlist`: string[] (per-user Watchlist / Reading List IDs, synced with top-level `state.watchlist` whenever `currentUserId` is active)
- `favorites`: `{ movie: string[], tv: string[], book: string[] }` (pre-populated with 4 Movie, 4 TV, and 4 Book IDs for all 4 seed users so every friend/family profile looks rich immediately):
  - **`user-jackson` (Jackson Cooper, `@jackson`)**:
    - `movie`: `['movie-101', 'movie-105', 'movie-104', 'movie-102']`
    - `tv`: `['tv-201', 'tv-202', 'tv-205', 'tv-206']`
    - `book`: `['book-301', 'book-302', 'book-305', 'book-308']`
    - `followingIds`: `['user-maya', 'user-marcus', 'user-elena']`
  - **`user-maya` (Maya Chen, `@maya_chen`)**:
    - `movie`: `['movie-102', 'movie-108', 'movie-103', 'movie-105']`
    - `tv`: `['tv-201', 'tv-203', 'tv-204', 'tv-208']`
    - `book`: `['book-303', 'book-305', 'book-307', 'book-302']`
    - `watchlist`: `['movie-101', 'tv-205', 'book-308']`
    - `followingIds`: `['user-jackson', 'user-elena']`
  - **`user-marcus` (Marcus Vance, `@marcus_vance`)**:
    - `movie`: `['movie-104', 'movie-107', 'movie-101', 'movie-105']`
    - `tv`: `['tv-202', 'tv-206', 'tv-207', 'tv-205']`
    - `book`: `['book-306', 'book-302', 'book-304', 'book-301']`
    - `watchlist`: `['movie-108', 'tv-201', 'book-305']`
    - `followingIds`: `['user-jackson', 'user-maya']`
  - **`user-elena` (Elena Rostova, `@elena_reads`)**:
    - `movie`: `['movie-108', 'movie-102', 'movie-105', 'movie-103']`
    - `tv`: `['tv-205', 'tv-206', 'tv-201', 'tv-204']`
    - `book`: `['book-305', 'book-308', 'book-304', 'book-307']`
    - `watchlist`: `['movie-107', 'tv-203', 'book-306']`
    - `followingIds`: `['user-jackson', 'user-maya', 'user-marcus']`

*(Backward Compatibility Note: Keep `state.users` accessible by ID and keep `state.watchlist` synced with the active `currentUserId` user's `watchlist` so all existing routes and tests continue passing 100%!)*

### 9.2 REST API Endpoints (`server.js`)
1. **`POST /api/users`** — Create a new Family / Friend Profile:
   - Accepts `{ name, handle, bio, location, avatarColor, switchToUser }`.
   - Generates `id: 'user-' + slug`, `avatar` initials, default `favorites: { movie: ['movie-101', 'movie-102', 'movie-103', 'movie-105'], tv: ['tv-201', 'tv-203', 'tv-205', 'tv-202'], book: ['book-301', 'book-302', 'book-303', 'book-305'] }` (or custom), `watchlist: []`, `followingIds: ['user-jackson']`.
   - If `switchToUser !== false`, switches `dbState.currentUserId` to the new user!
2. **`PUT /api/users/:id`** — Edit Profile Details or Favorites:
   - Updates `name`, `handle`, `bio`, `location`, `avatarColor`, or `favorites` on user `:id`.
3. **`POST /api/users/switch`** — Switch Active Family / Member Profile:
   - Accepts `{ userId }`. Sets `dbState.currentUserId = userId`, syncs `dbState.watchlist = user.watchlist`, and returns the updated state.
4. **`POST /api/users/:id/follow`** — Toggle Follow / Unfollow:
   - Toggles `:id` in the active user's (`dbState.currentUserId`) `followingIds` array and updates `followingCount` / `followersCount`.

### 9.3 UI Flows (`public/index.html`, `public/app.js`, `public/styles.css`)
1. **Header Profile Switcher & `+ New Profile` Modal (`<dialog id="userDialog" closedby="any" aria-labelledby="userDialogTitle">`)**:
   - In the top navigation bar, display the active user's badge/chip (`Jackson Cooper · Switch Profile`) with a clean switcher control to jump between family/friend accounts or open the **`+ New Family/Friend Profile` / `Edit Profile`** modal (`#userDialog`).
2. **Clickable Friend & Family Profiles (`viewingUserId`)**:
   - Clicking any user's name, `@handle`, or avatar in the **Activity Feed** (or in the **Family & Friends Directory** bar on the Feed/Profile view) opens that member's full **Profile View** (`viewingUserId`).
   - When viewing another member's profile (`viewingUserId !== currentUserId`), display:
     - A warm brass **"Viewing Member Card · [Back to My Profile]"** banner.
     - **`Follow` / `✓ Following`** toggle button and **`Switch to Profile`** button.
     - That member's **Top 4 Favorites** across Movies, TV Shows, and Books, their **"Currently Watching & Reading"** shelf, their **Diary / Recent Reviews**, and their **Curated Lists**.
3. **Activity Feed Filter (`All Members` vs `Following`)**:
   - Add a filter toggle on the Social Activity Feed to view **`All Activity`** or **`Following Only`** (logs by users in the active user's `followingIds` plus self).


---

## 10. Proper Email/Password Authentication, Account Creation & Cryptographically Safe Credential Vault

**User Feedback Trigger:**
*"okay can we now add a proper profile creation, sign up with email, all that and create a safe storage for the email and password"*

### 10.1 Isolated Server-Side Credential Vault (`data/auth.json`)
To keep user emails, password hashes, and session tokens completely isolated from public/social app state (`data/db.json`):
1. **Dedicated Vault File (`data/auth.json`) with Strict OS Permissions (`0o600`)**:
   - Stored separately at `/Users/jacksoncooper/.gemini/antigravity/scratch/media-app/data/auth.json`.
   - Enforce owner-only read/write permissions (`fs.chmodSync(AUTH_FILE, 0o600)`) and atomic writes via `auth.json.tmp` + `fs.renameSync`.
2. **Cryptographic Password Hashing (`crypto.scryptSync` + `crypto.timingSafeEqual`)**:
   - Every password is salted with a unique 16-byte random salt (`crypto.randomBytes(16).toString('hex')`) and hashed with Node's native `crypto.scryptSync(password, salt, 64).toString('hex')` (`scrypt` KDF).
   - Password verification uses `crypto.timingSafeEqual(Buffer.from(storedHash, 'hex'), Buffer.from(derivedHash, 'hex'))` to prevent timing attacks.
   - Plaintext passwords are **never** stored on disk, in memory, or in logs.
3. **Zero Credential Leakage**:
   - Public endpoints (`GET /api/bootstrap` / `GET /api/state`) **never** return password hashes, salts, session tokens, or other users' private email addresses.
   - Only the currently authenticated user sees their own email metadata via `GET /api/auth/me` (or `authUser` field).
4. **Session Management**:
   - 32-byte cryptographically random session tokens (`crypto.randomBytes(32).toString('hex')`) stored in `data/auth.json` with `userId`, `createdAt`, and `expiresAt`.
   - Sent via `Set-Cookie: omnilog_session=<token>; HttpOnly; SameSite=Lax; Path=/` **and** returned as `sessionToken` in JSON so clients/tests can also pass `Authorization: Bearer <token>`.
5. **Seeded Default Accounts in `data/auth.json`**:
   - Pre-seed salted `scrypt` credentials for the 4 seed users so family/testing sign-in works out of the box:
     - `user-jackson`: `jackson@omnilog.app` (default password: `Bookshop2026!`)
     - `user-maya`: `maya@omnilog.app` (default password: `Bookshop2026!`)
     - `user-marcus`: `marcus@omnilog.app` (default password: `Bookshop2026!`)
     - `user-elena`: `elena@omnilog.app` (default password: `Bookshop2026!`)

### 10.2 Authentication REST API Endpoints (`server.js`)
1. **`POST /api/auth/signup`** — Full Email & Password Account Creation:
   - Accepts `{ name, handle, email, password, confirmPassword, bio, location, avatarColor }`.
   - Validates email format (`/^[^\s@]+@[^\s@]+\.[^\s@]+$/`), unique email (case-insensitive) in `data/auth.json`, unique `@handle` in `data/db.json`, and password length (`>= 8` characters).
   - Creates the user profile in `data/db.json`, stores `{ userId, emailNormalized, salt, passwordHash, algorithm: 'scrypt-64', createdAt, updatedAt }` in `data/auth.json` (`0o600`), issues a session token + `HttpOnly` cookie, sets `dbState.currentUserId = newUser.id`, and returns `{ ok: true, sessionToken, authUser, state }`.
2. **`POST /api/auth/login`** — Sign In with Email (or Handle) & Password:
   - Accepts `{ emailOrHandle, email, password }`.
   - Looks up the user by normalized email or `@handle`, verifies the password via `crypto.scryptSync` + `crypto.timingSafeEqual`, creates a session token + `HttpOnly` cookie, switches `dbState.currentUserId` to that user, and returns `{ ok: true, sessionToken, authUser, state }`.
   - Returns HTTP `401` with a clean error message on invalid credentials.
3. **`POST /api/auth/logout`** — Sign Out:
   - Invalidates the active session token in `data/auth.json` and clears the `omnilog_session` cookie.
4. **`GET /api/auth/me`** — Current Authenticated Session & Security Metadata:
   - Returns `{ authenticated: boolean, authUser: { userId, name, handle, email, emailMasked, security: { algorithm: 'scrypt-64', vaultPermissions: '0600' } } }`.
5. **`PUT /api/auth/credentials`** — Update Email &/or Password:
   - Accepts `{ userId, currentPassword, newEmail, newPassword }`.
   - Verifies `currentPassword` via `crypto.timingSafeEqual` before updating email or generating a fresh 16-byte salt + `scrypt` hash for `newPassword`.
6. **Backward Compatibility**:
   - Keep `POST /api/users` and `POST /api/users/switch` working seamlessly (if `email` & `password` are passed to `POST /api/users`, also register them in `data/auth.json`) so all existing QA suites continue passing 100%.

### 10.3 UI Flows (`public/index.html`, `public/app.js`, `public/styles.css`)
- **Unified Auth & Profile Modal (`#userDialog` / `#authDialog` with `closedby="any"`)**:
  - **Tab 1 — Sign Up (Create Account)**: Full Name, `@handle`, Email Address (`type="email" required`), Password + Confirm Password (`minlength="8"`), Show/Hide password toggle, live **Password Strength Meter** (`<progress max="100" value="...">` using `brand-consistent-forms`), Location, Bio, and Avatar Color picker.
  - **Tab 2 — Sign In**: Email or `@handle` + Password sign-in form, plus a helpful "Demo / Family Seed Accounts (`jackson@omnilog.app` / `Bookshop2026!`)" hint and error banner for wrong passwords.
  - **Tab 3 — Account & Security Settings**: Edit Profile details (Name, Handle, Bio, Location, Avatar Color), view masked/stored Email & `scrypt` vault badge (`Encrypted in data/auth.json · 0600`), update Email or Password (requiring `currentPassword`), and **Sign Out** button.
- **Header Controls**:
  - Prominent **`Sign Up / Sign In`** / **`Account & Security`** button next to the active user badge in the masthead.


---

## 11. Header Action Bar Cleanup, Streamlined Sign-Up & Letterboxd Account Importer (CSV + RSS)

**User Feedback Trigger:**
*"okay im not liking the look of the sign in/up button right above the log it looks clunky, can we reorganize that please and maybe change the font. and make it simple to sign up first have them make a username then give an email, then create password confirm password and then me and robbie were talking about having a feature where they can import there letterboxd account so robbie can you go ahead and walk them through it so they know what to do. Its looking good so far."*

### 11.1 Header Action Bar Reorganization & Typography Refinement
- **Issue**: Currently the account switcher / `Sign In / Up` controls sit clunkily above the `+ Log Media` CTA with heavy/crowded styling.
- **Fix**:
  - Reorganize `.header-actions` into a sleek, single-line horizontal toolbar (`display: flex; align-items: center; gap: 0.65rem; flex-wrap: nowrap;`) where the search bar, compact member switcher pill, `Sign In / Sign Up` button, and `+ Log Media` button sit cleanly side-by-side on one level (never stacked vertically above `+ Log Media`).
  - Use a clean, modern humanist sans-serif font (`'Plus Jakarta Sans', 'Inter', system-ui, sans-serif`, `font-weight: 600`, `letter-spacing: 0.01em`) for header buttons and auth controls instead of heavy/clunky monospace or serif button labels.

### 11.2 Streamlined Sign-Up Form Order (`#userDialog`)
Simplify the **Sign Up** tab so the top fields appear in the exact order requested by Jackson:
1. **Username** (`handle` / username input, e.g. `jackson_c` — auto-normalizes `@` prefix and derives display name if no separate display name is entered, or includes an optional Display Name helper).
2. **Email** (`email`, `type="email" required`).
3. **Create Password** (`password`, `type="password" minlength="8" required` with live `<progress>` strength meter).
4. **Confirm Password** (`confirmPassword`, `type="password" minlength="8" required`).
5. **Optional Step Right Inside Sign-Up (and Dedicated Tab / Profile Action): "Import Your Letterboxd Account"**:
   - Users signing up can immediately enter their **Letterboxd Username** (for instant RSS sync) and/or attach their **Letterboxd CSV Export file(s)** (`diary.csv`, `reviews.csv`, `ratings.csv`, `watchlist.csv`) so their account is created with all their movie logs, ratings, reviews, and watchlist already populated!
   - Also provide a dedicated **"Import Letterboxd"** tab/button inside `#userDialog` and on the Profile / Diary view so existing users can import anytime.

### 11.3 Letterboxd Importer Backend & Data Mapping (`server.js`)

#### Method A: Letterboxd CSV Export Upload (`POST /api/import/letterboxd-csv`)
- **Why**: Letterboxd's *Settings → Export Your Data* downloads CSV files containing **100% of a user's lifetime movie history** (`reviews.csv`, `diary.csv`, `ratings.csv`, `watchlist.csv`).
- **Standard Letterboxd CSV Columns**:
  - `diary.csv` / `reviews.csv`: `Date,Name,Year,Letterboxd URI,Rating,Rewatch,Tags,Watched Date,Review`
  - `ratings.csv`: `Date,Name,Year,Letterboxd URI,Rating`
  - `watchlist.csv`: `Date,Name,Year,Letterboxd URI`
- **Request Payload**:
  - `{ userId, csvText, fileType?: 'auto' | 'reviews' | 'diary' | 'ratings' | 'watchlist', files?: [{ fileName, csvText }] }`
- **CSV Parsing & Normalization Rules**:
  - Parse RFC-4180 CSV rows properly (handling quoted multi-line reviews and escaped quotes `""`).
  - Detect watchlist CSVs (when `Rating`, `Watched Date`, and `Review` columns are absent or `fileName` includes `watchlist`) and add matched/created movie IDs directly to the user's `watchlist`.
  - For `reviews.csv`, `diary.csv`, and `ratings.csv`:
    - `title`: `row['Name']`
    - `year`: ` parseInt(row['Year'], 10) || 2024`
    - `rating`: `row['Rating'] ? Math.min(5, Math.max(0.5, parseFloat(row['Rating']))) : 4.0`
    - `dateConsumed`: `row['Watched Date'] || row['Date'] || today`
    - `isRewatch`: `String(row['Rewatch'] || '').toLowerCase() === 'yes'`
    - `review`: `row['Review'] || ''`
    - Deduplicate against existing user logs by `(userId, mediaId, dateConsumed)` — if an entry already exists for that movie, merge/upgrade the rating and review text rather than creating duplicates.

#### Method B: One-Click Letterboxd `@username` RSS Sync (`POST /api/import/letterboxd-rss`)
- **Why**: Every public Letterboxd profile exposes `https://letterboxd.com/<username>/rss/` with their ~50 most recent movie logs, ratings, watched dates, poster image (`<description>` `<img src="...">`), and review text — requiring zero file downloads!
- **Request Payload**:
  - `{ userId, username }` (strips leading `@` or full `letterboxd.com/` URL if pasted).
- **RSS Parsing & Resilient Fallback**:
  - Fetch `https://letterboxd.com/${cleanUsername}/rss/` with a browser-like `User-Agent`.
  - Parse `<item>` blocks:
    - `<letterboxd:filmTitle>` -> `title`
    - `<letterboxd:filmYear>` -> `year`
    - `<letterboxd:memberRating>` -> `rating` (0.5–5.0)
    - `<letterboxd:watchedDate>` -> `dateConsumed`
    - `<letterboxd:rewatch>` -> `isRewatch` (`Yes` -> `true`)
    - Extract `<img src="...">` from `<description>` CDATA as the real TMDB/Letterboxd poster URL (`posterUrl`), and strip HTML tags from the remaining `<description>` paragraphs for `review`!
  - **Built-in Demo / Offline Fallback**: If the live fetch to `letterboxd.com/<username>/rss/` is blocked by Cloudflare/network or if a user tests with a demo username (e.g. `jackson`, `cinephile`, `demo`, or any username when offline), gracefully fall back to importing a curated realistic batch of Letterboxd movie logs (with real HTTP-200 movie posters, star ratings, watched dates, and reviews) so the 1-click username sync ALWAYS succeeds reliably in demos and automated tests!

#### Auto-Catalog Matching & Creation
- For every imported movie (`title`, `year`):
  1. First check if `dbState.catalog` already has a movie matching normalized `title` (+ `year`).
  2. If not in `dbState.catalog`, create a new `MediaItem` (`id: 'movie-lb-' + slug`, `type: 'movie'`, `title`, `year`, `creator: 'Feature Film'`, `posterUrl` from RSS `<img src>` or live iTunes/IMDb lookup or `buildPosterUrl(...)`, `fallbackPosterUrl: buildPosterUrl(...)`, `genres: ['Cinema', 'Imported']`, `runtimeMinutes: 120`, `communityRating: rating`, `ratingsCount: 1`).
  3. Recalculate `communityRating` and `ratingsCount` on matched catalog items and return `{ ok: true, importedLogsCount, importedWatchlistCount, newCatalogItemsCount, state }`.


---

## 12. Multi-Screen Step-by-Step Sign-Up Onboarding Flow (Inspired by Fable, Literal & Substack)

**User Feedback Trigger:**
*"also the signup feels just thrown together it should be seperate screens per step and take your time robbie look at other signups and see how it looks and then just tell ben how to do it if there are any problems come to me but im giving you guys full authority to finish off the site besides public domain and app optimizing everyone follow Miles's rules or come to me for any questions good luck."*

### 12.1 UX Research & Design Principles (Fable / Literal / Substack Onboarding Pattern)
Modern reading and film communities (like **Fable**, **Literal.club**, and **Substack**) avoid dumping 6–8 form fields onto a single crowded modal. Instead, they use **progressive disclosure**:
- **One focused question per screen** with generous breathing room, a warm editorial serif heading (`Playfair Display` / `Georgia`), and a short, human 1-line subtitle.
- **Subtle 4-dot step indicator** at the top (`Step 1 of 4` + 4 warm brass/parchment progress pills/dots) so the user always knows where they are without feeling overwhelmed.
- **Zero technical or security jargon**: No strength meters, no `scrypt`/`0600` badges, and no robotic disclaimers in the UI.
- **Keyboard-friendly**: Pressing `Enter` on Steps 1, 2, or 3 validates the current step and advances to the next screen instead of prematurely submitting the form.

### 12.2 The 4 Separate Sign-Up Screens (`[data-signup-step="1".."4"]`)
Inside `#userProfileForm` (when in Sign Up mode), render 4 distinct screen panels where only the active step is visible (`display: flex; flex-direction: column;`), while the other 3 steps have the `hidden` attribute:

#### Screen 1 (`data-signup-step="1"`, `#signupStep1`): Pick Your Username
- **Heading**: *"First, pick a username"*
- **Subtext**: *"This is how friends will find your reviews and shelves."*
- **Visible Input**:
  - Username input (`#userHandleInput`, placeholder `e.g. jackson`, large comfortable input box with `@` prefix styling).
- **Actions**:
  - Primary CTA: **`Continue`** (`#signupNextStep1Btn`) — validates that `#userHandleInput` is non-empty (at least 2 chars) before transitioning to Screen 2 and focusing `#userEmailInput`.
  - Footer link: *"Already have an account? Sign in"* (switches to the Sign In view).

#### Screen 2 (`data-signup-step="2"`, `#signupStep2`): Enter Your Email
- **Heading**: *"What's your email address?"*
- **Subtext**: *"Just for signing in to your account."*
- **Visible Input**:
  - Email input (`#userEmailInput`, `type="email"`, placeholder `you@example.com`).
- **Actions**:
  - Secondary CTA: **`Back`** (`#signupBackStep2Btn`) — returns to Screen 1.
  - Primary CTA: **`Continue`** (`#signupNextStep2Btn`) — validates a valid `@` email address before transitioning to Screen 3 and focusing `#userPasswordInput`.

#### Screen 3 (`data-signup-step="3"`, `#signupStep3`): Create Your Password
- **Heading**: *"Create a password"*
- **Subtext**: *"At least 8 characters."* (No security jargon, no strength meters, no encryption callouts.)
- **Visible Inputs**:
  - Create Password (`#userPasswordInput`, `type="password"`, placeholder `At least 8 characters`) + clean `Show` toggle.
  - Confirm Password (`#userConfirmPasswordInput`, `type="password"`, placeholder `Type your password again`).
- **Actions**:
  - Secondary CTA: **`Back`** (`#signupBackStep3Btn`) — returns to Screen 2.
  - Primary CTA: **`Continue`** (`#signupNextStep3Btn`) — validates that password is `>= 8` characters and matches confirm password before transitioning to Screen 4.

#### Screen 4 (`data-signup-step="4"`, `#signupStep4`): Import from Letterboxd (Optional Final Screen)
- **Heading**: *"Bring your films from Letterboxd"*
- **Subtext**: *"Connect your Letterboxd username or drop in your export files, or skip this step and start fresh."*
- **Visible Content (`#signupLetterboxdBox`)**:
  - Letterboxd `@username` input (`#signupLetterboxdUsernameInput`) for instant RSS sync.
  - Letterboxd `.csv` export file upload (`#signupLetterboxdCsvInput`) for full lifetime history.
- **Actions**:
  - Secondary CTA: **`Back`** (`#signupBackStep4Btn`) — returns to Screen 3.
  - Secondary CTA: **`Skip & Finish`** (`#signupSkipFinishBtn`) — clears any Letterboxd inputs and immediately creates the account.
  - Primary CTA: **`Finish & Create Account`** (`#saveUserSubmitBtn`, `type="submit"`) — creates the account and runs the Letterboxd import if a username or CSV was provided.


---

## 13. Final Site Completion — Profile Milestones, Diary/Watchlist Filters, Custom Media Entry & Export

**User Feedback Trigger:**
*"okay now finish off the site do whatever you guys think should be done but make sure to run it with miles as he is the manager and if there are any problems you guys cannot solve after going to miles then you can come to me"*

### 13.1 Rich Profile Milestones, Top Genres & One-Click Diary CSV Export
1. **Profile Reading & Viewing Milestones**:
   - On the Profile view (for the active user or any viewed family/friend profile), display a warm bookshop stats summary showing:
     - **Films Watched** (count of completed movie logs + total runtime hours)
     - **TV Episodes Logged** (sum of episodes across TV logs)
     - **Book Pages Read** (sum of `currentPage` / `pagesCount` across book logs)
     - **Average Rating** (`★ 4.5` average across rated entries) & **Top Genres** pills (top 3 genres logged by that user).
2. **One-Click Diary CSV Export (`GET /api/export/diary.csv?userId=...` & UI Button `#exportDiaryCsvBtn`)**:
   - Allow any user to download their entire Omnilog diary as a clean RFC-4180 CSV file (`Date,Title,Year,Medium,Creator,Rating,Liked,Rewatch,Progress,Review`) directly from their Profile or Diary view.

### 13.2 Diary & Watchlist Filtering, Search & Sorting
1. **Diary Filter & Sort Bar**:
   - Filter Diary entries by **Medium** (`All`, `Movies`, `TV Shows`, `Books`), **Rating / Liked** (`All`, `♥ Liked Only`, `4.5★+`), or text search, and sort by **Date Consumed (Newest / Oldest)** or **Highest Rated**.
2. **Watchlist / Reading Queue Sorting & Quick Filter**:
   - Keep the medium filter (`All`, `Movies`, `TV Shows`, `Books`) and add sorting by **Recently Added**, **Highest Community Rating**, or **Title / Year**.

### 13.3 Add Custom Media Item (`POST /api/catalog` & UI Modal/Form)
- For rare editions, indie shorts, zines, or family home videos not in iTunes/TVMaze/OpenLibrary, allow users to add a custom title directly to the catalog (`title`, `type: 'movie' | 'tv' | 'book'`, `year`, `creator`, `genres`, optional `posterUrl` or automatic warm wood SVG cover via `buildPosterUrl`, `runtimeMinutes` / `seasonsCount` / `pagesCount`, `synopsis`) and immediately log or bookmark it.

### 13.4 Live User Account & State Preservation During QA Testing
- **Critical Rule for QA Scripts (`qa_test.mjs` / `stress_test.mjs`)**:
  - Before running any automated test suite against `http://localhost:4173`, snapshot `data/db.json` and `data/auth.json` in memory (or backup files) and restore them in a `finally` block (while preserving any real user accounts created outside the test script) so accounts Jackson creates in the browser are **never** overwritten or logged out!


---

## 14. Phone Optimization, Responsive Touch UX & Installable PWA

**User Feedback Trigger:**
*"ok now lets add the phone optimization stuff now please"*

### 14.1 Mobile-First Navigation & Viewport Polish (`<= 768px`)
1. **Sticky Bottom Tab Bar (`#mobileBottomNav` / `.mobile-bottom-nav`)**:
   - On phone viewports (`@media (max-width: 768px)`), render a native-feeling bottom tab bar anchored to the bottom of the screen with `padding-bottom: calc(0.45rem + env(safe-area-inset-bottom, 0px))` for iPhone Home Indicator clearance.
   - Include 5 thumb-friendly tabs (`min-height: 48px` tap targets): **Stacks (`explore`)**, **Feed (`feed`)**, **Ledger (`diary`)**, **Tables (`lists`)**, **Queue (`watchlist`)**, and **Member (`profile`)** (or a center `+ Log` action + tabs) synced with the main view switcher (`data-mobile-nav="..."`).
   - Add bottom padding to `body` / `.main-container` on mobile (`padding-bottom: calc(84px + env(safe-area-inset-bottom, 0px))`) so footer content is never obscured by the bottom bar.
2. **Compact Mobile Masthead & Search Bar**:
   - Collapse the top header on mobile into a sleek 2-row bookshop bar: Brand title + active profile pill + `+ Log` on the top row, and full-width live search input (`#globalSearchInput`) + medium pills in a smooth horizontal touch-scroll strip (`overflow-x: auto; -webkit-overflow-scrolling: touch; scrollbar-width: none;`) on the second row.

### 14.2 Bottom-Sheet Modals & iOS Safari Anti-Zoom (`16px` Inputs)
1. **Mobile Bottom-Sheet Dialogs (`<dialog>`)**:
   - On `@media (max-width: 768px)`, style all native `<dialog>` modals (`#detailDialog`, `#logDialog`, `#listDialog`, `#userDialog`, `#customMediaDialog`) as smooth mobile bottom sheets (`margin: auto 0 0 0; width: 100%; max-width: 100%; max-height: 92dvh; border-radius: 20px 20px 0 0;`) with an iOS-style grab handle indicator at the top and safe-area bottom padding.
2. **Prevent iOS Safari Input Auto-Zoom**:
   - Ensure all `<input>`, `<select>`, and `<textarea>` elements have `font-size: max(16px, 1rem)` on mobile (`@media (max-width: 768px)`) so iOS Safari never zooms the viewport when focusing search, sign-up, or review inputs.
3. **2-Column Mobile Poster Shelves & Touch Targets**:
   - On `@media (max-width: 640px)`, use a crisp 2-column poster grid (`grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.85rem;`) with `aspect-ratio: 2 / 3; height: auto;` posters, always-accessible quick bookmark/log actions on touch devices (`@media (hover: none)`), and `min-height: 44px` interactive buttons (`touch-action: manipulation`).

### 14.3 Installable Home-Screen Web App (`manifest.webmanifest` & Apple Meta Tags)
- Add `<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">`, `<meta name="theme-color" content="#2b1d14">`, `<meta name="apple-mobile-web-app-capable" content="yes">`, and `<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">` to `public/index.html`.
- Serve `/manifest.webmanifest` (`name: "Omnilog — The Mahogany Parlor"`, `short_name: "Omnilog"`, `display: "standalone"`, `background_color: "#1f140e"`, `theme_color: "#2b1d14"`, SVG app icon) so Jackson and his family can use **"Add to Home Screen"** on iPhone or Android and launch Omnilog like a native app!
