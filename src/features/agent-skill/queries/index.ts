import { queryOptions } from "@tanstack/react-query";
import { orpcClient } from "@/lib/orpc";

export type PairingState =
  | "none"
  | "waiting"
  | "connected"
  | "expired"
  | "cancelled";

export interface PairingStatus {
  state: PairingState;
  code?: string;
  expiresAt?: Date | string;
  agent?: {
    name: string;
    apiKeyId: string;
    connectedAt: Date | string;
  };
}

/**
 * The admin operations of #232, typed here from the spec until the oRPC
 * contract carries them; the router path `pairing.admin` is the assumption.
 */
interface PairingAdminClient {
  generate: () => Promise<{ code: string; expiresAt: Date | string }>;
  status: () => Promise<PairingStatus>;
  cancel: () => Promise<unknown>;
}

const pairingAdmin = () =>
  (orpcClient as unknown as { pairing: { admin: PairingAdminClient } }).pairing
    .admin;

export const PAIRING_POLL_MS = 2000;

export const pairingStatusQuery = queryOptions({
  queryKey: ["agent-skill", "pairing"],
  queryFn: () => pairingAdmin().status(),
  // Background tabs are skipped by TanStack Query itself
  // (`refetchIntervalInBackground` is off).
  refetchInterval: (query) =>
    query.state.data?.state === "waiting" ? PAIRING_POLL_MS : false,
});

export const generatePairingCode = () => pairingAdmin().generate();

export const cancelPairingCode = () => pairingAdmin().cancel();
