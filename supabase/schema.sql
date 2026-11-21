-- Run once in the Supabase dashboard: SQL Editor → New query → paste → Run.

create table public.user_state (
  user_id uuid primary key default auth.uid() references auth.users on delete cascade,
  progress jsonb not null default '{}',   -- {bookId: {"chapter/page": {wpm, acc}}}
  recent jsonb not null default '[]',
  updated_at timestamptz not null default now()
);

create table public.user_books (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  id text not null,
  title text not null,
  author text not null,
  chapters jsonb not null,                -- [{title, pages: [[paragraph, ...], ...]}]
  cover text,                             -- small JPEG data URL from the EPUB, optional
  created_at timestamptz not null default now(),
  primary key (user_id, id)
);

alter table public.user_state enable row level security;
alter table public.user_books enable row level security;

-- Signed-in users only, and only their own rows. No anon access.
revoke all on public.user_state, public.user_books from anon;
grant select, insert, update, delete on public.user_state, public.user_books to authenticated;

create policy "own state" on public.user_state for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "own books" on public.user_books for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

-- Already ran this file before covers existed? Run just this line once:
-- alter table public.user_books add column if not exists cover text;
