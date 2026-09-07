import {
  InteractionRequiredAuthError,
  PublicClientApplication,
} from "@azure/msal-browser";

export async function createAuthClient() {
  const response = await fetch("/api/auth-config");
  if (!response.ok) throw new Error("登录配置暂不可用");
  const config = (await response.json()) as {
    tenantId: string;
    spaClientId: string;
    scope: string;
  };
  const client = new PublicClientApplication({
    auth: {
      clientId: config.spaClientId,
      authority: `https://login.microsoftonline.com/${config.tenantId}`,
      redirectUri: `${window.location.origin}/redirect.html`,
    },
    cache: { cacheLocation: "sessionStorage" },
  });
  await client.initialize();
  const request = { scopes: [config.scope] };
  return {
    async login() {
      const result = await client.loginPopup(request);
      client.setActiveAccount(result.account);
    },
    async token() {
      const account = client.getActiveAccount() ?? client.getAllAccounts()[0];
      if (!account) throw new Error("请先登录");
      try {
        return (await client.acquireTokenSilent({ ...request, account }))
          .accessToken;
      } catch (error) {
        if (error instanceof InteractionRequiredAuthError)
          // eslint-disable-next-line preserve-caught-error -- Do not propagate provider error details.
          throw new Error("登录已过期，请重新登录");
        // eslint-disable-next-line preserve-caught-error -- Do not propagate provider error details.
        throw new Error("暂时无法获取访问权限，请重试");
      }
    },
    async logout() {
      await client.logoutPopup({
        account: client.getActiveAccount(),
        postLogoutRedirectUri: window.location.origin,
      });
    },
  };
}

export type AuthClient = Awaited<ReturnType<typeof createAuthClient>>;
