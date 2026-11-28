begin;

create table public.support_admins (
  user_id uuid primary key references auth.users(id) on delete cascade
);
alter table public.support_admins enable row level security;
revoke all on public.support_admins from public, anon, authenticated;

create function public.support_is_admin() returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.support_admins where user_id = (select auth.uid())
  )
$$;
revoke all on function public.support_is_admin() from public, anon, authenticated;
grant execute on function public.support_is_admin() to authenticated;

create table public.support_tickets (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 1 and 120),
  console_model text not null check (char_length(btrim(console_model)) between 1 and 100),
  os text not null check (char_length(btrim(os)) between 1 and 100),
  hub_version text not null default '' check (char_length(hub_version) <= 50),
  description text not null check (char_length(btrim(description)) between 1 and 4000),
  attachment_name text,
  attachment_data text,
  progress smallint not null default 0 check (progress between 0 and 100),
  status text generated always as (
    case when progress = 100 then 'resolved' when progress > 0 then 'working' else 'open' end
  ) stored,
  resolution text not null default '' check (char_length(resolution) <= 4000),
  created_at timestamptz not null default now(),
  constraint attachment_pair check (
    (attachment_name is null and attachment_data is null)
    or (attachment_name is not null and attachment_data is not null
      and char_length(attachment_name) between 1 and 180
      and attachment_name ~* '[.](png|jpe?g|webp|txt|log)$'
      and char_length(attachment_data) between 4 and 5592408
      and octet_length(decode(attachment_data, 'base64')) between 1 and 4194304)
  )
);
create index support_tickets_owner_created on public.support_tickets (owner_id, created_at desc);
create index support_tickets_created on public.support_tickets (created_at desc, id);
alter table public.support_tickets enable row level security;
revoke all on public.support_tickets from public, anon, authenticated;
grant select on public.support_tickets to authenticated;
grant insert (title, console_model, os, hub_version, description, attachment_name, attachment_data)
  on public.support_tickets to authenticated;
grant update (progress, resolution) on public.support_tickets to authenticated;

create policy "Autor ou administrador lê chamados" on public.support_tickets
  for select to authenticated using (owner_id = (select auth.uid()) or (select public.support_is_admin()));
create policy "Autor envia chamado" on public.support_tickets
  for insert to authenticated with check (owner_id = (select auth.uid()));
create policy "Administrador atualiza chamados" on public.support_tickets
  for update to authenticated using ((select public.support_is_admin()))
  with check ((select public.support_is_admin()));

grant delete on public.support_tickets to authenticated;
create policy "Administrador exclui chamados" on public.support_tickets
  for delete to authenticated using ((select public.support_is_admin()));

alter table public.support_tickets add column author_username text
  check (char_length(author_username) between 2 and 60);

alter table public.support_tickets alter column author_username set default (
  case when jsonb_typeof(auth.jwt() -> 'user_metadata' -> 'support_username') = 'string'
    and char_length(btrim(auth.jwt() -> 'user_metadata' ->> 'support_username')) between 2 and 60
  then btrim(auth.jwt() -> 'user_metadata' ->> 'support_username') end
);

alter table public.support_tickets
  add column correction_feedback text check (correction_feedback in ('confirmed', 'failed')),
  add column correction_revision uuid not null default gen_random_uuid();

alter table public.support_tickets
  add column support_state text generated always as (
    case
      when progress = 100 and correction_feedback = 'confirmed' then 'resolved'
      when progress = 100 then 'pending_confirmation'
      when progress > 0 or correction_feedback = 'failed' then 'working'
      else 'open'
    end
  ) stored;

create function public.support_reset_correction_feedback() returns trigger
language plpgsql set search_path = ''
as $
begin
  if new.correction_feedback is not distinct from old.correction_feedback
     and (new.progress is distinct from old.progress or new.resolution is distinct from old.resolution) then
    new.correction_revision := gen_random_uuid();
    if new.progress = 100 or old.correction_feedback = 'confirmed' then
      new.correction_feedback := null;
    end if;
  end if;
  return new;
end;
$;
revoke all on function public.support_reset_correction_feedback() from public, anon, authenticated;

create trigger support_reset_correction_feedback
before update of progress, resolution on public.support_tickets
for each row execute function public.support_reset_correction_feedback();

create schema if not exists support_private;
grant usage on schema support_private to authenticated;

create function support_private.submit_correction_feedback(ticket_id uuid, revision uuid, resolved boolean)
returns boolean
language sql security definer set search_path = ''
as $
  with updated as (
    update public.support_tickets
    set correction_feedback = case when resolved then 'confirmed' else 'failed' end,
        progress = case when resolved then 100 else 99 end
    where id = ticket_id and owner_id = (select auth.uid())
      and correction_revision = revision and support_state = 'pending_confirmation'
      and resolved is not null
    returning id
  )
  select exists (select 1 from updated);
$;

create function public.support_submit_correction_feedback(ticket_id uuid, revision uuid, resolved boolean)
returns boolean
language sql security invoker set search_path = ''
as $
  select support_private.submit_correction_feedback(ticket_id, revision, resolved);
$;

revoke all on function support_private.submit_correction_feedback(uuid, uuid, boolean) from public, anon, authenticated;
revoke all on function public.support_submit_correction_feedback(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function support_private.submit_correction_feedback(uuid, uuid, boolean) to authenticated;
grant execute on function public.support_submit_correction_feedback(uuid, uuid, boolean) to authenticated;

commit;
