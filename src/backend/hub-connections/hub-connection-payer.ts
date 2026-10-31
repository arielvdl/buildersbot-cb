// Which organization pays for a connection call. The agent never chooses: the tool has no field for
// it. The rule runs in the main process at each call, on the access rows of the Hub catalog.
//
// The organization that the person chose, or the one that paid the last call, is the anchor. When the
// anchor is no longer available, the call gets `choose_org`: the app does not move the cost to the
// only organization left, nor to the personal plan, by itself.

import type { HubConnectionAccess, HubConnectionEntry, HubOrgView } from "@openbot/contracts/hub-connections";

export type PayerDecision =
  | { readonly kind: "pay"; readonly access: HubConnectionAccess; readonly name: string }
  | {
      readonly kind: "choose_org";
      /** Why: no anchor and more than one organization, or the anchor is gone. */
      readonly reason: "several" | "anchor_gone";
      readonly candidates: ReadonlyArray<{ readonly access: HubConnectionAccess; readonly name: string }>;
    }
  | { readonly kind: "none" };

/** The personal plan's row on the catalog. */
export const PERSONAL_ORG = "personal";

/** A row that can pay: the organization enabled it, the person may use it, and this app may spend it. */
export function canPay(access: HubConnectionAccess): boolean {
  return access.org === "enabled" && access.user === "allowed" && access.consented;
}

function orgName(orgs: readonly HubOrgView[], orgId: string): string {
  return orgs.find((org) => org.id === orgId)?.name ?? orgId;
}

/**
 * The payer of the next call. `anchor` is the organization that the person chose for this
 * connection, or else the one that paid its last call; null when there is none yet.
 */
export function choosePayer(
  connection: HubConnectionEntry,
  orgs: readonly HubOrgView[],
  anchor: string | null,
): PayerDecision {
  const paying = connection.access.filter(canPay).map((access) => ({ access, name: orgName(orgs, access.orgId) }));
  if (anchor !== null) {
    const kept = paying.find((row) => row.access.orgId === anchor);
    if (kept) return { kind: "pay", ...kept };
    return paying.length > 0 ? { kind: "choose_org", reason: "anchor_gone", candidates: paying } : { kind: "none" };
  }
  const organizations = paying.filter((row) => row.access.orgId !== PERSONAL_ORG);
  if (organizations.length === 1 && organizations[0]) return { kind: "pay", ...organizations[0] };
  if (organizations.length > 1) {
    // The Hub's default organization goes first on the cards; it is not chosen without the person.
    const ordered = [...organizations].sort(
      (a, b) =>
        Number(orgs.find((org) => org.id === b.access.orgId)?.default === true) -
        Number(orgs.find((org) => org.id === a.access.orgId)?.default === true),
    );
    return { kind: "choose_org", reason: "several", candidates: ordered };
  }
  const personal = paying.find((row) => row.access.orgId === PERSONAL_ORG);
  return personal ? { kind: "pay", ...personal } : { kind: "none" };
}
