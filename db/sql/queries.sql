/** @name getSession */
select
  sessions.id,
  sessions.cwd,
  sessions.launch_command,
  sessions.created_at_ms,
  sessions.archived_at_ms
from sessions
where sessions.id = :id
limit 1;

/** @name getSessionRecovery */
select
  session_recovery.session_id,
  session_recovery.recovery_command,
  session_recovery.created_at_ms
from session_recovery
where session_recovery.session_id = :sessionId
limit 1;

/** @name recordSession */
insert into sessions (
  id,
  cwd,
  launch_command,
  created_at_ms
)
values (
  :id,
  :cwd,
  :launchCommand,
  :createdAtMs
)
on conflict (id) do nothing;

/** @name setSessionRecovery */
insert into session_recovery (
  session_id,
  recovery_command,
  created_at_ms
)
values (
  :sessionId,
  :recoveryCommand,
  :createdAtMs
)
on conflict (session_id) do update set
  recovery_command = excluded.recovery_command;

/** @name archiveSession */
update sessions
set archived_at_ms = :archivedAtMs
where id = :sessionId;
