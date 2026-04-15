# Lunch Voter

Weekly lunch voting app for choosing a Thuisbezorgd restaurant. Colleagues vote Mon-Thu, winner is picked Thursday before 11:00.

## Quick Start

```bash
npm install
node seed.js          # Fetch restaurants from Thuisbezorgd
npm start             # http://localhost:3000
```

## Tech Stack

- **Runtime**: Node.js (CommonJS modules)
- **Framework**: Express 5
- **Database**: SQLite via better-sqlite3 (WAL mode, foreign keys enabled)
- **Frontend**: Vanilla HTML, CSS, JavaScript (no build step, no framework)
- **Data source**: Thuisbezorgd.nl HTML scraping (embedded Next.js server-side props)

## Project Structure

```
lunch-voter/
├── server.js          # Express backend - all API routes and DB logic
├── seed.js            # Standalone script to fetch/refresh restaurants
├── package.json
├── lunch-voter.db     # SQLite database (auto-created on first run)
└── public/            # Frontend (served as static files)
    ├── index.html     # Single page with 4 tabs
    ├── style.css      # All styles, responsive, CSS custom properties
    └── app.js         # Client-side logic, state management, API calls
```

## Database Schema

4 tables in SQLite:

- **restaurants** - restaurant listings (id TEXT PK, name, slug, cuisine, logo_url, rating, rating_count, delivery_fee, min_order, is_open, last_fetched)
- **voting_sessions** - weekly sessions keyed by `YYYY-Www` (id INTEGER PK, week_key UNIQUE, created_at, closed)
- **votes** - one vote per person per session (id INTEGER PK, session_id FK, voter_name, restaurant_id FK, voted_at; UNIQUE on session_id+voter_name)
- **past_winners** - historical winners (id INTEGER PK, week_key, restaurant_id FK, restaurant_name, vote_count, decided_at)

Tables are auto-created on server startup via `db.exec()`.

## API Routes

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/restaurants` | List all restaurants (sorted by rating) |
| POST | `/api/restaurants/refresh` | Fetch fresh data from Thuisbezorgd (uses curl) |
| POST | `/api/restaurants` | Add restaurant manually `{name, cuisine}` |
| DELETE | `/api/restaurants/:id` | Remove a restaurant |
| GET | `/api/voting/status` | Current session, votes, tallies, past winners |
| POST | `/api/voting/vote` | Cast/update vote `{voterName, restaurantId}` |
| POST | `/api/voting/finalize` | Pick winner (random tiebreak), save to history |
| GET | `/api/history` | Last 52 winners |

## Key Business Logic

- **Voting window**: Monday through Thursday before 11:00
- **Results**: Available Thursday 11:00+
- **One vote per person per week** - voting again updates the existing vote
- **Voter names** are normalized to lowercase trimmed strings
- **Restaurant filter**: Only restaurants delivering by 13:30 are included (delivery start time <= 810 minutes)
- **Tiebreaker**: Random selection among tied leaders
- **Fairness**: Past 12 winners are tracked and shown as "Won Nx recently" on cards

## Thuisbezorgd Data Fetching

Restaurants are scraped from `https://www.thuisbezorgd.nl/bestellen/eten/1812`. The page embeds JSON in a script tag as Next.js server-side props. Data path: `props.appProps.preloadedState.discovery.restaurantList.restaurantData`.

- **node-fetch gets 403'd** by Thuisbezorgd — both `seed.js` and the refresh endpoint use `curl` via `child_process.execSync`
- Restaurant IDs are numeric strings from Thuisbezorgd (e.g. `"9453913"`)

## Frontend Architecture

- Single-page app with 4 tab sections toggled via CSS class `.active`
- State held in module-level variables: `restaurants`, `votingStatus`, `voterName`
- Voter name persisted in `localStorage` key `lunchVoterName`
- Auto-refreshes voting status every 30 seconds
- All API calls use `fetch()` with JSON content type

## CSS Design System

CSS custom properties defined in `:root`:
- `--primary`: `#ff8000` (Thuisbezorgd orange)
- `--primary-dark`: `#e67300`
- `--success`: `#4caf50`
- `--danger`: `#e53935`
- `--voted` / `--voted-border`: highlight for selected restaurant
- Responsive breakpoint at 600px

## Development Workflow

### Verification Protocol

After every change, verify your work:

1. **Code changes**: Restart the server (`taskkill //F //IM node.exe; cd C:/Users/ralfa/lunch-voter && node server.js &`) and test the affected API endpoint with `curl`
2. **Frontend/design changes**: After restarting the server, take a screenshot of `http://localhost:3000` in the browser to visually verify the result. Iterate on design until it matches the intent.
3. **Database changes**: Check the schema is applied correctly by querying the DB. If schema changed, delete `lunch-voter.db` and re-run `node seed.js` before starting.
4. **Keep testing until the result is correct** — do not report a task as done until you've verified the output. For API routes, test the happy path AND at least one error case.

### Server Restart Pattern

```bash
taskkill //F //IM node.exe 2>/dev/null
sleep 1
cd C:/Users/ralfa/lunch-voter && node server.js &
sleep 2
# then test
```

### Seeding After DB Reset

```bash
rm -f lunch-voter.db
node seed.js    # fetches fresh from Thuisbezorgd via curl
node server.js &
```

## Conventions

- CommonJS (`require` / `module.exports`), not ESM
- Synchronous SQLite operations (better-sqlite3 is sync by design)
- All database writes use prepared statements
- Bulk operations wrapped in `db.transaction()`
- Express 5 (not 4) — route handlers can return promises that auto-catch errors
- No TypeScript, no linter, no test framework currently configured
- Port defaults to 3000, overridable via `PORT` env var

## Hosting Considerations

- SQLite is file-based — host must support persistent filesystem (not suitable for serverless/ephemeral containers without external DB)
- `curl` must be available on the host for restaurant fetching
- `better-sqlite3` is a native addon — must be compiled for the target platform (`npm rebuild better-sqlite3`)
- No authentication currently — anyone with the URL can vote and manage restaurants
