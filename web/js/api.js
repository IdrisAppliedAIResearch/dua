import { state } from "./state.js?v=20261112c";

const base = "/api";

async function req(path, opts = {}) {
  let res;
  try {
    res = await fetch(base + path, {
      ...opts,
      headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    });
  } catch (err) {
    state.offline = true;
    throw err;
  }
  if (res.status === 204) {
    state.offline = false;
    return null;
  }
  if (!res.ok) {
    const err = new Error(String(res.status));
    err.status = res.status;
    try {
      err.detail = (await res.json()).detail;
    } catch (_) {}
    throw err;
  }
  state.offline = false;
  return res.json();
}

const json = (p) => ({ method: "POST", body: JSON.stringify(p) });

export const api = {
  list: () => req("/entries"),
  create: (p) => req("/entries", json(p)),
  update: (id, p) => req(`/entries/${id}`, { method: "PUT", body: JSON.stringify(p) }),
  remove: (id) => req(`/entries/${id}`, { method: "DELETE" }),
};
