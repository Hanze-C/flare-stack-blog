import { useSuspenseQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import ConfirmationModal from "@/components/ui/confirmation-modal";
import { Spinner } from "@/components/ui/spinner";
import { usePairing } from "@/features/agent-skill/hooks/use-pairing";
import { useApiKeys } from "@/features/api-keys/hooks/use-api-keys";
import { siteDomainQuery } from "@/features/config/queries";
import { formatDate } from "@/lib/utils";
import { m } from "@/paraglide/messages";
import { CopyLine } from "./copy-line";

/** `abcdefgh` or `ABCD-EFGH` is shown as `ABCD-EFGH`. */
function formatPairingCode(code: string) {
  const compact = code.replace(/[^a-z0-9]/gi, "").toUpperCase();
  return compact.length === 8
    ? `${compact.slice(0, 4)}-${compact.slice(4)}`
    : code;
}

export function PairingStep() {
  const {
    status,
    isLoading,
    isError,
    reload,
    generate,
    isGenerating,
    cancel,
    isCancelling,
  } = usePairing();
  const { data: domain } = useSuspenseQuery(siteDomainQuery);
  const { deleteKey, isDeleting } = useApiKeys();
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [revokedKeyId, setRevokedKeyId] = useState<string | null>(null);
  const revokeRef = useRef<HTMLButtonElement>(null);
  const generateRef = useRef<HTMLButtonElement>(null);

  const run = async (action: () => Promise<unknown>) => {
    try {
      await action();
    } catch {
      /* Mutation displays the failure. */
    }
  };
  const generateButton = (label: string, primary = false) => (
    <Button
      ref={generateRef}
      variant={primary ? "primary" : undefined}
      loading={isGenerating}
      disabled={isCancelling}
      onClick={() => void run(generate)}
    >
      {label}
    </Button>
  );

  const state = status?.state ?? "none";
  const agent = status?.agent;
  let body;
  if (isError) {
    body = (
      <Callout
        tone="warning"
        action={
          <Button size="sm" onClick={() => void reload()}>
            {m.settings_design_retry()}
          </Button>
        }
      >
        {m.agent_skill_pair_load_failed()}
      </Callout>
    );
  } else if (isLoading) {
    body = (
      <p className="agent-skill-waiting" role="status">
        <Spinner />
        {m.agent_skill_pair_loading()}
      </p>
    );
  } else if (state === "waiting" && status?.code) {
    const prompt = m.agent_skill_pair_prompt({
      site: `https://${domain}`,
      code: formatPairingCode(status.code),
    });
    body = (
      <>
        <CopyLine
          text={prompt}
          copyLabel={m.agent_skill_pair_copy()}
          copiedLabel={m.agent_skill_pair_copied()}
        />
        <p className="agent-skill-waiting" role="status">
          <Spinner />
          {m.agent_skill_pair_waiting()}
        </p>
        <div className="agent-skill-actions">
          {generateButton(m.agent_skill_pair_regenerate())}
          <Button
            variant="plain"
            loading={isCancelling}
            disabled={isGenerating}
            onClick={() => void run(cancel)}
          >
            {m.agent_skill_pair_cancel()}
          </Button>
        </div>
      </>
    );
  } else if (state === "connected" && agent) {
    const revoked = revokedKeyId === agent.apiKeyId;
    body = (
      <>
        <Callout role="status" tone={revoked ? "info" : "success"}>
          {revoked
            ? m.agent_skill_pair_revoked({ name: agent.name })
            : m.agent_skill_pair_connected({
                name: agent.name,
                time: formatDate(agent.connectedAt, { includeTime: true }),
              })}
        </Callout>
        <div className="agent-skill-actions">
          {!revoked && (
            <Button
              ref={revokeRef}
              variant="plain"
              tone="danger"
              onClick={() => setRevokeOpen(true)}
            >
              {m.agent_skill_pair_not_this()}
            </Button>
          )}
          {generateButton(m.agent_skill_pair_another())}
        </div>
      </>
    );
  } else if (state === "expired") {
    body = (
      <>
        <Callout role="status" tone="warning">
          {m.agent_skill_pair_expired()}
        </Callout>
        <div className="agent-skill-actions">
          {generateButton(m.agent_skill_pair_regenerate(), true)}
        </div>
      </>
    );
  } else {
    body = (
      <div className="agent-skill-actions">
        {generateButton(m.agent_skill_pair_generate(), true)}
      </div>
    );
  }

  return (
    <>
      <p className="agent-skill-hint">{m.agent_skill_pair_hint()}</p>
      {body}
      <ConfirmationModal
        isOpen={revokeOpen}
        onClose={() => setRevokeOpen(false)}
        onConfirm={async () => {
          if (!agent || isDeleting) return;
          try {
            await deleteKey(agent.apiKeyId);
            setRevokedKeyId(agent.apiKeyId);
            setRevokeOpen(false);
          } catch {
            /* Keep the dialog for retry. */
          }
        }}
        title={m.agent_skill_pair_revoke_title()}
        message={m.agent_skill_pair_revoke_desc({ name: agent?.name ?? "" })}
        confirmLabel={m.agent_skill_pair_revoke_confirm()}
        isDanger
        isLoading={isDeleting}
        returnFocus={() => revokeRef.current}
        fallbackFocus={() => generateRef.current}
      />
    </>
  );
}
