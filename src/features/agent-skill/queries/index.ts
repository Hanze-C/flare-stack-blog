import { queryOptions } from "@tanstack/react-query";
import { orpcClient } from "@/lib/orpc";

const pairingAdmin = orpcClient.pairing.admin;

export type PairingStatus = Awaited<ReturnType<typeof pairingAdmin.status>>;
export type PairingState = PairingStatus["state"];
export type GeneratedPairingCode = Awaited<
  ReturnType<typeof pairingAdmin.generate>
>;

export const PAIRING_POLL_MS = 2000;

export const pairingStatusQuery = queryOptions({
  queryKey: ["agent-skill", "pairing"],
  queryFn: () => pairingAdmin.status(),
  // Background tabs are skipped by TanStack Query itself
  // (`refetchIntervalInBackground` is off).
  refetchInterval: (query) =>
    query.state.data?.state === "waiting" ? PAIRING_POLL_MS : false,
});

export const generatePairingCode = () => pairingAdmin.generate();

export const cancelPairingCode = () => pairingAdmin.cancel();
