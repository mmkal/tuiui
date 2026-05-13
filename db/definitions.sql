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
