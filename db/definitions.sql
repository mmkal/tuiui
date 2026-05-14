create table if not exists sessions (
  id text primary key,
  cwd text not null,
  launch_command text not null,
  created_at_ms integer not null,
  archived_at_ms integer
);

create table if not exists session_recovery (
  session_id text primary key references sessions (id) on delete cascade,
  recovery_command text not null,
  created_at_ms integer not null
);

create index if not exists idx_session_recovery_recovery_command
on session_recovery (recovery_command);

create table if not exists session_process_owners (
  session_id text not null references session_recovery (session_id) on delete cascade,
  pid integer not null,
  created_at_ms integer not null,
  updated_at_ms integer not null,
  primary key (session_id, pid)
);
