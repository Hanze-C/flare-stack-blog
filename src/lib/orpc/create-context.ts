import { getRequestAuth } from "@/lib/auth/auth.server";
import { getDb } from "@/lib/db";
import type { ApiContext } from "./context";

export function createApiContext(
  headers: Headers,
  env: Env,
  executionCtx: ExecutionContext<unknown>,
): ApiContext {
  const db = getDb(env);
  return {
    headers,
    env,
    executionCtx,
    db,
    getAuth: () => getRequestAuth({ db, env, executionCtx }),
  };
}
