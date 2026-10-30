import type {
  ExchangePairingCodeInput,
  PairedApiKeyMetadata,
  PairingStatus,
} from "@/features/agent-pairing/agent-pairing.schema";
import * as PairingCodeRepo from "@/features/agent-pairing/data/pairing-codes.data";
import {
  hashPairingCode,
  newPairingCode,
  normalizePairingCode,
  PAIRING_CODE_TTL_MS,
} from "@/features/agent-pairing/utils/pairing-code";
import { serverEnv } from "@/lib/env/server.env";
import { err, ok } from "@/lib/errors";

type AdminContext = DbContext & { session: Session };

/**
 * A new Pairing Code for the signed-in Admin. It replaces the Admin's
 * previous code, which stops working.
 */
export async function generatePairingCode(context: AdminContext) {
  const code = newPairingCode();
  const now = new Date();
  // The column keeps seconds; the answer says what is stored.
  const expiresAt = new Date(
    Math.floor((now.getTime() + PAIRING_CODE_TTL_MS) / 1000) * 1000,
  );
  // Two Admins drawing the same code out of 31^8 would fail the unique index
  // and answer 500; generating again draws another.
  await PairingCodeRepo.replacePairingCode(context.db, {
    userId: context.session.user.id,
    codeHash: await hashPairingCode(normalizePairingCode(code)!),
    expiresAt,
    now,
  });
  return { code, expiresAt };
}

export async function getPairingStatus(
  context: AdminContext,
): Promise<PairingStatus> {
  const row = await PairingCodeRepo.findPairingCode(
    context.db,
    context.session.user.id,
  );
  if (!row) return { state: "none" };

  const { expiresAt } = row;
  if (row.pairedAt && row.agentName && row.apiKeyId) {
    return {
      state: "connected",
      expiresAt,
      agent: {
        name: row.agentName,
        apiKeyId: row.apiKeyId,
        connectedAt: row.pairedAt,
      },
    };
  }
  if (row.cancelledAt) return { state: "cancelled", expiresAt };
  // Claimed but its key not yet recorded: an exchange is under way.
  if (row.pairedAt) return { state: "waiting", expiresAt };
  if (expiresAt.getTime() <= Date.now()) return { state: "expired", expiresAt };
  return { state: "waiting", expiresAt };
}

/** Cancels the Admin's code; one already exchanged or expired stays so. */
export async function cancelPairingCode(context: AdminContext) {
  await PairingCodeRepo.cancelPairingCode(
    context.db,
    context.session.user.id,
    new Date(),
  );
  return { success: true };
}

/**
 * Exchanges a Pairing Code for a new API Key owned by the Admin who generated
 * it. A wrong, expired, cancelled or used code is the same not found.
 */
export async function exchangePairingCode(
  context: DbContext & { getAuth: () => Promise<Auth> },
  input: ExchangePairingCodeInput,
) {
  const normalized = normalizePairingCode(input.code);
  if (!normalized) return err({ reason: "PAIRING_CODE_NOT_FOUND" });

  const codeHash = await hashPairingCode(normalized);
  const now = new Date();
  const userId = await PairingCodeRepo.claimPairingCode(context.db, {
    codeHash,
    agentName: input.agentName,
    now,
  });
  if (!userId) return err({ reason: "PAIRING_CODE_NOT_FOUND" });

  const metadata: PairedApiKeyMetadata = {
    source: "pairing",
    agentName: input.agentName,
  };
  let created: { id: string; key: string };
  try {
    const auth = await context.getAuth();
    // No headers: a server call that creates the key for `userId`.
    created = await auth.api.createApiKey({
      body: {
        name: `${input.agentName} · ${now.toISOString().slice(0, 10)}`,
        userId,
        metadata,
      },
    });
  } catch (error) {
    await PairingCodeRepo.releasePairingCode(context.db, { userId, codeHash });
    throw error;
  }

  await PairingCodeRepo.recordPairedApiKey(context.db, {
    userId,
    codeHash,
    apiKeyId: created.id,
  });
  return ok({
    apiKey: created.key,
    url: `https://${serverEnv(context.env).DOMAIN}`,
  });
}
