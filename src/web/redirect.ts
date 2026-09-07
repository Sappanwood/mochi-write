import { broadcastResponseToMainFrame } from "@azure/msal-browser/redirect-bridge";
void broadcastResponseToMainFrame().catch(() => {
  const status = document.getElementById("status");
  if (status) status.textContent = "登录响应未能送达，请关闭此窗口后重试。";
});
