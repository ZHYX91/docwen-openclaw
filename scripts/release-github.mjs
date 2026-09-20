import { setTimeout as pause } from "node:timers/promises";

export function githubApi(repository, token, fetch = globalThis.fetch, wait = pause) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository) || !token)
    throw new Error("publication_github_context_invalid");
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2026-03-10",
    "User-Agent": "docwen-openclaw-release",
  };
  const request = async (method, endpoint, body, upload = false) => {
    const origin = upload ? "https://uploads.github.com" : "https://api.github.com";
    const response = await fetch(`${origin}/repos/${repository}/${endpoint}`, {
      method,
      headers: { ...headers, "Content-Type": upload ? "application/octet-stream" : "application/json" },
      ...(body === undefined ? {} : { body: upload ? body : JSON.stringify(body) }),
      signal: globalThis.AbortSignal.timeout(60_000),
      redirect: "error",
    });
    if (method === "GET" && response.status === 404) return null;
    if (!response.ok)
      throw Object.assign(new Error(`publication_github_http_${response.status}`), {
        status: response.status,
      });
    return response.json();
  };
  return {
    async read(endpoint) {
      for (let attempt = 0; ; attempt++) {
        try {
          return await request("GET", endpoint);
        } catch (error) {
          if (attempt >= 2 || (error.status !== undefined && error.status !== 429 && error.status < 500))
            throw error;
          await wait(1000 * (attempt + 1));
        }
      }
    },
    write: (method, endpoint, body) => request(method, endpoint, body),
    upload: (id, name, bytes) =>
      request("POST", `releases/${id}/assets?name=${encodeURIComponent(name)}`, bytes, true),
  };
}
