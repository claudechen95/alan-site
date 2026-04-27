# Alan's Accountability Tracker

A simple daily/weekly check-in site.

## Local Development

### 1. Get a free Redis database (Upstash)

1. Go to [console.upstash.com](https://console.upstash.com/redis)
2. Create a free Redis database (any region)
3. Click **Connect** → **.env.local** tab
4. Copy the two env vars

### 2. Set up env vars

```bash
cp .env.local.example .env.local
# Edit .env.local and paste your KV_REST_API_URL and KV_REST_API_TOKEN
```

### 3. Run locally

```bash
npm install
npm run dev
# → http://localhost:3000
```

## Deploy to Vercel

```bash
npm i -g vercel
vercel
```

Then in the Vercel dashboard:
1. Go to your project → **Storage** → **Connect Store** → **KV**
2. Create or connect an Upstash Redis instance
3. Vercel will auto-inject the env vars

Or add the env vars manually under **Settings → Environment Variables**.

## Adding / Editing Goals

The two default goals are seeded automatically on first load:
- 🏋️ Gym session (1x weekly)
- 🥤 Protein drink (1x daily)

To add or change goals, `POST /api/goals` with:
```json
{ "id": "my-goal", "name": "My Goal", "emoji": "🎯", "frequency": "daily", "targetCount": 1 }
```

To delete: `DELETE /api/goals` with `{ "id": "my-goal" }`.

> A future admin UI can be added for managing goals without needing to hit the API directly.

