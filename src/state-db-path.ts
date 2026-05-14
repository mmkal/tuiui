import * as os from "node:os";
import * as path from "node:path";

export function sessionStorePathForEnv(env: NodeJS.ProcessEnv) {
  if (env.TUIUI_STATE_DB) {
    return path.resolve(env.TUIUI_STATE_DB);
  }
  const stateHome = env.XDG_STATE_HOME || path.join(String(env.HOME || os.homedir()), ".local", "state");
  return path.join(stateHome, "tuiui", "tuiui.sqlite");
}
