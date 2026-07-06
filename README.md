# Bathroom Renovation Report — Jake of All Trades

Static quiz funnel (`index.html`) with a Vercel serverless function
(`api/submit-lead.js`) that proxies lead submission to Supabase and an
optional webhook, so no credentials are exposed client-side.

## Local development

    vercel dev

Copy `.env.local.example` to `.env.local` and fill in real values first —
`vercel dev` loads `.env.local` automatically.

## Environment variables

Set these in the Vercel dashboard (Project Settings > Environment Variables)
before deploying. Never commit real values to git.

- `SUPABASE_URL`
- `SUPABASE_SERVICE_KEY` — service role key, server-side only
- `WEBHOOK_URL` — optional, leave unset to skip

## Supabase RLS

`api/submit-lead.js` uses the service role key, which bypasses RLS. The
anon key is no longer used anywhere, so the `leads` table can stay fully
locked down — no public access at all:

    alter table leads enable row level security;
    -- no policies — service role bypasses RLS, no anon/public access needed

## Deploy

    vercel
