-- --- Persist the temporal diff on the version that produced it --------------
--
-- Phase 2 computes a diff between the previous snapshot and the current one on
-- every run, but the result was only returned in memory and never stored. That
-- meant "what changed since last time" disappeared the moment the request ended,
-- so the contact page could not show it and a user had no way to see that a plan
-- had been completed or a topic had gone quiet.
--
-- Storing it on the version keeps the diff tied to exactly the analysis that
-- produced it, and preserves history: an older version keeps its own diff.

alter table public.analysis_versions
  add column if not exists temporal_diff jsonb;

comment on column public.analysis_versions.temporal_diff is
  'Changes detected between the previous conversation snapshot and this run. Null for the first run, which has nothing to compare against.';

-- Queried per contact, newest first, to show recent changes without scanning.
create index if not exists analysis_versions_temporal_idx
  on public.analysis_versions (contact_id, version desc)
  where temporal_diff is not null;
