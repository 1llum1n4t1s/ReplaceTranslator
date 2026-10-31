"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// 実際のSW・共有ライブラリを読み、ブラウザー保存と外部APIだけを置換する。
module.exports = function workerHarness({ initial = {}, disk = { settings: initial }, session = {}, catalog = {}, models = {}, fetchResponse, localGet } = {}) {
  const root = path.join(__dirname, "..");
  const requests = [], fetches = [], partials = [];
  let listener;
  const onSuspend = [];
  const storage = data => ({
    get: async keys => structuredClone(Object.fromEntries((Array.isArray(keys) ? keys : [keys])
      .filter(key => Object.hasOwn(data, key)).map(key => [key, data[key]]))),
    set: async values => { Object.assign(data, structuredClone(values)); },
    remove: async keys => { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; },
  });
  const event = { addListener: () => {} };
  const chrome = {
    runtime: { id: "translation-test", getManifest: () => ({ version: "test" }),
      getURL: p => `chrome-extension://translation-test/${p}`, onInstalled: event,
      onSuspend: { addListener: fn => { onSuspend.push(fn); } },
      onMessage: { addListener: fn => { listener = fn; } }, sendMessage: async () => {} },
    storage: { local: storage(disk), session: storage(session), sync: storage({}), onChanged: event },
    tabs: { onActivated: event, onUpdated: event,
      sendMessage: async (_tabId, message) => { partials.push(structuredClone(message)); } },
    alarms: { onAlarm: event, create: async () => {}, clear: async () => true },
  };
  if (localGet) {
    const get = chrome.storage.local.get;
    chrome.storage.local.get = keys => localGet(keys, get);
  }
  const context = vm.createContext({ chrome, URL, URLSearchParams, AbortController, AbortSignal, TextDecoder,
    TextEncoder, crypto, console, structuredClone, btoa, setTimeout: () => 1, clearTimeout: () => {},
    fetch: async (url, options = {}) => {
      fetches.push(url);
      if (fetchResponse) {
        const response = await fetchResponse(url, options);
        if (response) return response;
      }
      if (url === "https://models.dev/api.json") return Response.json(catalog);
      const provider = context.Providers.ids.find(id => {
        const endpoint = context.Providers.get(id).endpoint;
        return endpoint && new URL(endpoint.replace("{model}", "model")).origin === new URL(url).origin;
      });
      if (new URL(url).pathname.endsWith("/models")) return Response.json(models[provider] || { data: [] });
      requests.push({ provider, body: options.body && JSON.parse(options.body) });
      const text = JSON.stringify({ translations: ["test translation"] });
      return Response.json({ choices: [{ message: { content: text } }], content: [{ type: "text", text }],
        candidates: [{ content: { parts: [{ text }] } }] });
    },
  });
  for (const file of ["actions", "lang", "model-pricing", "providers", "stream", "settings-sync"]) {
    vm.runInContext(fs.readFileSync(path.join(root, "src/lib", `${file}.js`), "utf8"), context);
  }
  vm.runInContext(fs.readFileSync(path.join(root, "src/service_worker.js"), "utf8"), context);
  const extension = { id: chrome.runtime.id, url: chrome.runtime.getURL("src/popup/popup.html") };
  return { disk, session, requests, fetches, partials, context, suspend: () => Promise.all(onSuspend.map(fn => fn())), send: (message, sender = extension) =>
    new Promise(resolve => listener(message, sender, value => resolve(structuredClone(value)))) };
};
