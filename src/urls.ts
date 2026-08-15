/** Frontend URL building — shared by the CLI and the TUIs. */

/**
 * A todo's canonical frontend URL. The short `/t/<todoId>` route resolves the
 * project itself (frontend/src/routes/_main/_shell/t.$todoId.tsx), so a link is
 * copy-pasteable without carrying a projectId the user never sees.
 */
export function getFrontendUrl(apiUrl: string, todoId: string): string {
  const local = apiUrl.includes("localhost:4000") || apiUrl.includes("127.0.0.1:4000");
  return `${local ? "http://localhost:3000" : "https://todofor.ai"}/t/${todoId}`;
}
