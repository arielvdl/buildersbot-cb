import type { ServerCreationAdminState } from "@openbot/contracts/server-creation";
import { createRoot } from "solid-js";
import { describe, expect, it } from "vitest";
import {
  createServerCreationAdminStore,
  type ServerCreationAdminCalls,
} from "../../../../../packages/ui/src/features/settings/stores/server-creation-admin-store";

const STATE: ServerCreationAdminState = {
  requests: [
    {
      id: "request-1",
      userId: "person-1",
      email: "person@example.com",
      name: "Person",
      reason: "The sales team needs a server.",
      status: "pending",
      createdAt: 1,
      decidedAt: null,
    },
  ],
  grants: [{ userId: "person-2", email: "other@example.com", name: null, grantedAt: 2, note: null }],
};

function calls(access: () => Promise<{ administrator: boolean }>): ServerCreationAdminCalls {
  const unused = () => Promise.reject(new Error("unused"));
  return {
    creationAccess: async () => ({ canCreate: true, creationAvailable: true, request: null, ...(await access()) }),
    creationAdmin: async () => structuredClone(STATE),
    grantCreation: unused,
    revokeCreation: unused,
    decideCreationRequest: unused,
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function adminStore(api: () => ServerCreationAdminCalls) {
  return createRoot((dispose) => ({ store: createServerCreationAdminStore(api, () => false), dispose }));
}

describe("the administrator section of server creation", () => {
  it("shows the requests and grants to an administrator", async () => {
    const { store, dispose } = adminStore(() => calls(async () => ({ administrator: true })));
    store.reload();
    await settle();
    expect(store.state.administrator).toBe(true);
    expect(store.state.requests.map((request) => request.email)).toEqual(["person@example.com"]);
    expect(store.state.grants).toHaveLength(1);
    dispose();
  });

  it("drops the rows of an earlier account when the next access read fails", async () => {
    let api = calls(async () => ({ administrator: true }));
    const { store, dispose } = adminStore(() => api);
    store.reload();
    await settle();
    expect(store.state.requests).toHaveLength(1);
    api = calls(() => Promise.reject(new Error("offline")));
    store.reload();
    await settle();
    expect(store.state.administrator).toBe(false);
    expect(store.state.loaded).toBe(false);
    expect(store.state.requests).toEqual([]);
    expect(store.state.grants).toEqual([]);
    expect(store.state.error).toBeNull();
    dispose();
  });

  it("drops the rows when the next account is not an administrator", async () => {
    let api = calls(async () => ({ administrator: true }));
    const { store, dispose } = adminStore(() => api);
    store.reload();
    await settle();
    api = calls(async () => ({ administrator: false }));
    store.reload();
    await settle();
    expect(store.state.administrator).toBe(false);
    expect(store.state.requests).toEqual([]);
    expect(store.state.grants).toEqual([]);
    dispose();
  });

  it("keeps the section with an error when only the administrator state fails", async () => {
    const api: ServerCreationAdminCalls = {
      ...calls(async () => ({ administrator: true })),
      creationAdmin: () => Promise.reject(new Error("offline")),
    };
    const { store, dispose } = adminStore(() => api);
    store.reload();
    await settle();
    expect(store.state.administrator).toBe(true);
    expect(store.state.error).not.toBeNull();
    dispose();
  });
});
