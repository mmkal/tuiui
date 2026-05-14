import type {SyncClient} from 'sqlfu';

const getSessionSql = `
select
  sessions.id,
  sessions.cwd,
  sessions.launch_command,
  sessions.created_at_ms,
  sessions.archived_at_ms
from sessions
where sessions.id = ?
limit 1;
`.trim();
const getSessionQuery = (params: getSession.Params) => ({
	name: "getSession",
	sql: getSessionSql,
	args: [params.id],
});

export const getSession = Object.assign(
	function getSession(client: SyncClient, params: getSession.Params): getSession.Result | null {
		const rows = client.all<getSession.Result>(getSessionQuery(params));
		return rows.length > 0 ? rows[0] : null;
	},
	{ sql: getSessionSql, query: getSessionQuery },
);

export namespace getSession {
	export type Params = {
		id: string;
	};
	export type Result = {
		id: string;
		cwd: string;
		launch_command: string;
		created_at_ms: number;
		archived_at_ms?: number;
	};
}

const getSessionRecoverySql = `
select
  session_recovery.session_id,
  session_recovery.recovery_command,
  session_recovery.created_at_ms
from session_recovery
where session_recovery.session_id = ?
limit 1;
`.trim();
const getSessionRecoveryQuery = (params: getSessionRecovery.Params) => ({
	name: "getSessionRecovery",
	sql: getSessionRecoverySql,
	args: [params.sessionId],
});

export const getSessionRecovery = Object.assign(
	function getSessionRecovery(client: SyncClient, params: getSessionRecovery.Params): getSessionRecovery.Result | null {
		const rows = client.all<getSessionRecovery.Result>(getSessionRecoveryQuery(params));
		return rows.length > 0 ? rows[0] : null;
	},
	{ sql: getSessionRecoverySql, query: getSessionRecoveryQuery },
);

export namespace getSessionRecovery {
	export type Params = {
		sessionId: string;
	};
	export type Result = {
		session_id: string;
		recovery_command: string;
		created_at_ms: number;
	};
}

const recordSessionSql = `
insert into sessions (
  id,
  cwd,
  launch_command,
  created_at_ms
)
values (
  ?,
  ?,
  ?,
  ?
)
on conflict (id) do nothing;
`.trim();
const recordSessionQuery = (params: recordSession.Params) => ({
	name: "recordSession",
	sql: recordSessionSql,
	args: [params.id, params.cwd, params.launchCommand, params.createdAtMs],
});

export const recordSession = Object.assign(
	function recordSession(client: SyncClient, params: recordSession.Params) {
		return client.run(recordSessionQuery(params));
	},
	{ sql: recordSessionSql, query: recordSessionQuery },
);

export namespace recordSession {
	export type Params = {
		id: string;
		cwd: string;
		launchCommand: string;
		createdAtMs: number;
	};
}

const setSessionRecoverySql = `
insert into session_recovery (
  session_id,
  recovery_command,
  created_at_ms
)
values (
  ?,
  ?,
  ?
)
on conflict (session_id) do update set
  recovery_command = excluded.recovery_command;
`.trim();
const setSessionRecoveryQuery = (params: setSessionRecovery.Params) => ({
	name: "setSessionRecovery",
	sql: setSessionRecoverySql,
	args: [params.sessionId, params.recoveryCommand, params.createdAtMs],
});

export const setSessionRecovery = Object.assign(
	function setSessionRecovery(client: SyncClient, params: setSessionRecovery.Params) {
		return client.run(setSessionRecoveryQuery(params));
	},
	{ sql: setSessionRecoverySql, query: setSessionRecoveryQuery },
);

export namespace setSessionRecovery {
	export type Params = {
		sessionId: string;
		recoveryCommand: string;
		createdAtMs: number;
	};
}

const archiveSessionSql = `
update sessions
set archived_at_ms = ?
where id = ?;
`.trim();
const archiveSessionQuery = (data: archiveSession.Data, params: archiveSession.Params) => ({
	name: "archiveSession",
	sql: archiveSessionSql,
	args: [data.archivedAtMs, params.sessionId],
});

export const archiveSession = Object.assign(
	function archiveSession(client: SyncClient, data: archiveSession.Data, params: archiveSession.Params) {
		return client.run(archiveSessionQuery(data, params));
	},
	{ sql: archiveSessionSql, query: archiveSessionQuery },
);

export namespace archiveSession {
	export type Data = {
		archivedAtMs: number | null;
	};
	export type Params = {
		sessionId: string;
	};
}

const recordSessionProcessOwnerSql = `
insert into session_process_owners (
  session_id,
  pid,
  created_at_ms,
  updated_at_ms
)
values (
  ?,
  ?,
  ?,
  ?
)
on conflict (session_id, pid) do update set
  updated_at_ms = excluded.updated_at_ms;
`.trim();
const recordSessionProcessOwnerQuery = (params: recordSessionProcessOwner.Params) => ({
	name: "recordSessionProcessOwner",
	sql: recordSessionProcessOwnerSql,
	args: [params.sessionId, params.pid, params.createdAtMs, params.updatedAtMs],
});

export const recordSessionProcessOwner = Object.assign(
	function recordSessionProcessOwner(client: SyncClient, params: recordSessionProcessOwner.Params) {
		return client.run(recordSessionProcessOwnerQuery(params));
	},
	{ sql: recordSessionProcessOwnerSql, query: recordSessionProcessOwnerQuery },
);

export namespace recordSessionProcessOwner {
	export type Params = {
		sessionId: string;
		pid: number;
		createdAtMs: number;
		updatedAtMs: number;
	};
}

const removeSessionProcessOwnerSql = `
delete from session_process_owners
where session_id = ?
  and pid = ?;
`.trim();
const removeSessionProcessOwnerQuery = (params: removeSessionProcessOwner.Params) => ({
	name: "removeSessionProcessOwner",
	sql: removeSessionProcessOwnerSql,
	args: [params.sessionId, params.pid],
});

export const removeSessionProcessOwner = Object.assign(
	function removeSessionProcessOwner(client: SyncClient, params: removeSessionProcessOwner.Params) {
		return client.run(removeSessionProcessOwnerQuery(params));
	},
	{ sql: removeSessionProcessOwnerSql, query: removeSessionProcessOwnerQuery },
);

export namespace removeSessionProcessOwner {
	export type Params = {
		sessionId: string;
		pid: number;
	};
}
