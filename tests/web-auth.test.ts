import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuthClient } from "../src/web/auth.js";
const state = vi.hoisted(() => ({
  config: undefined as unknown,
  initialized: false,
  account: null as unknown,
  login: vi.fn(),
  silent: vi.fn(),
  logout: vi.fn(),
}));
vi.mock("@azure/msal-browser", () => ({
  InteractionRequiredAuthError: class extends Error {},
  PublicClientApplication: class {
    constructor(config: unknown) {
      state.config = config;
    }
    async initialize() {
      state.initialized = true;
    }
    async loginPopup(request: unknown) {
      expect(state.initialized).toBe(true);
      state.login(request);
      return { account: { id: "owner" } };
    }
    setActiveAccount(account: unknown) {
      state.account = account;
    }
    getActiveAccount() {
      return state.account;
    }
    getAllAccounts() {
      return [];
    }
    acquireTokenSilent(request: unknown) {
      return state.silent(request);
    }
    logoutPopup(request: unknown) {
      return state.logout(request);
    }
  },
}));
afterEach(() => {
  vi.unstubAllGlobals();
  state.account = null;
  state.initialized = false;
  vi.clearAllMocks();
});
describe("MSAL browser adapter", () => {
  it("initializes MSAL with a dedicated same-origin v5 redirect bridge before login", async () => {
    vi.stubGlobal("window", { location: { origin: "https://write.example" } });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          tenantId: "tenant",
          spaClientId: "spa",
          scope: "api://api/Write.Access",
        }),
      }),
    );
    const auth = await createAuthClient();
    await auth.login();
    expect(state.config).toMatchObject({
      auth: { redirectUri: "https://write.example/redirect.html" },
      cache: { cacheLocation: "sessionStorage" },
    });
    expect(state.login).toHaveBeenCalledWith({
      scopes: ["api://api/Write.Access"],
    });
    state.silent.mockResolvedValue({ accessToken: "test" });
    expect(await auth.token()).toBe("test");
    await auth.logout();
    expect(state.logout).toHaveBeenCalled();
  });
});
