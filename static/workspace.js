// Temporary, tab-scoped recovery. The token lives in sessionStorage; IndexedDB
// holds larger datasets without the small synchronous Web Storage quota.
class WorkspaceStore {
  async database() {
    if (!this.opening) this.opening = new Promise((resolve, reject) => {
      const request = indexedDB.open('annotation-workspaces', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('workspaces');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return this.opening;
  }
  async get(key) {
    const db = await this.database();
    return new Promise((resolve, reject) => {
      const request = db.transaction('workspaces').objectStore('workspaces').get(key);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }
  async put(key, value) {
    const db = await this.database();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('workspaces', 'readwrite');
      transaction.objectStore('workspaces').put(value, key);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }
  async remove(key) {
    const db = await this.database();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('workspaces', 'readwrite');
      transaction.objectStore('workspaces').delete(key);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }
}

class BrowserWorkspace {
  constructor(store = new WorkspaceStore()) {
    this.store = store;
    this.token = null;
    this.snapshot = null;
    this.capture = null;
    this.onStatus = () => {};
    this.writeQueue = Promise.resolve();
  }
  newToken() { return crypto.randomUUID().replaceAll('-', ''); }
  async initialize() {
    const key = 'annotation_tab_workspace_v1';
    try { this.token = sessionStorage.getItem(key); } catch {}
    this.token ||= this.newToken();
    // Duplicating a tab copies sessionStorage. Fork its snapshot, so even that
    // case cannot make one annotator's requests overwrite another tab's task.
    let occupied = false;
    if (typeof BroadcastChannel !== 'undefined') {
      this.channel = new BroadcastChannel('annotation-workspace-tabs');
      const nonce = this.newToken();
      this.channel.onmessage = ({ data }) => {
        if (data.token !== this.token) return;
        if (data.type === 'probe') this.channel.postMessage({ type: 'occupied', token: this.token, nonce: data.nonce });
        if (data.type === 'occupied' && data.nonce === nonce) occupied = true;
      };
      this.channel.postMessage({ type: 'probe', token: this.token, nonce });
      await new Promise(resolve => setTimeout(resolve, 80));
    }
    try { this.snapshot = await this.store.get(this.token); }
    catch { this.onStatus('浏览器草稿存储不可用；当前页面仍保留工作副本', true); }
    if (occupied) this.token = this.newToken();
    try { sessionStorage.setItem(key, this.token); } catch {}
    if (occupied && this.snapshot) await this.flush();
    return this.snapshot;
  }
  async request(url, options = {}, recover = true) {
    const headers = new Headers(options.headers || {});
    if (this.token) headers.set('X-Workspace-ID', this.token);
    let response = await fetch(url, { ...options, headers });
    if (recover && response.status === 409 && this.snapshot) {
      const error = await response.clone().json().catch(() => ({}));
      if (error.needs_upload) {
        await this.restore();
        response = await fetch(url, { ...options, headers });
      }
    }
    return response;
  }
  async restore() {
    if (!this.snapshot) return;
    if (!this.restoring) this.restoring = (async () => {
      this.onStatus('正在恢复临时工作区…');
      const response = await this.request('/api/workspace/restore', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: this.snapshot.filename, rows: this.snapshot.rows,
          source_rows: this.snapshot.source_rows, template: this.snapshot.template,
          templates: this.snapshot.templates,
        }),
      }, false);
      if (!response.ok) throw new Error(await response.text());
      this.onStatus('工作区已恢复');
    })().finally(() => { this.restoring = null; });
    return this.restoring;
  }
  checkpoint() {
    if (!this.snapshot) return;
    if (this.capture) this.snapshot.ui = this.capture();
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 500);
  }
  async flush() {
    clearTimeout(this.timer);
    if (!this.token || !this.snapshot) return;
    // Clone now; later keystrokes must not mutate an enqueued checkpoint.
    const value = structuredClone(this.snapshot);
    const token = this.token;
    this.writeQueue = this.writeQueue.catch(() => {}).then(() => this.store.put(token, value));
    try {
      await this.writeQueue;
      this.onStatus('浏览器草稿已保存');
    } catch {
      this.onStatus('浏览器草稿写入失败；请保留页面并及时下载', true);
    }
  }
  async loadSnapshot(preserveUI = true) {
    const response = await this.request('/api/workspace');
    if (!response.ok) throw new Error(await response.text());
    const ui = preserveUI ? this.snapshot?.ui : null;
    this.snapshot = await response.json();
    if (ui) this.snapshot.ui = ui;
    if (preserveUI) this.checkpoint();
    await this.flush();
  }
  async upload(file) {
    const previousToken = this.token;
    const token = this.newToken();
    const form = new FormData();
    form.append('file', file);
    const response = await fetch('/api/upload', { method: 'POST', body: form, headers: { 'X-Workspace-ID': token } });
    if (!response.ok) throw new Error(await response.text());
    const saved = await fetch('/api/workspace', { headers: { 'X-Workspace-ID': token } });
    if (!saved.ok) throw new Error(await saved.text());
    const snapshot = await saved.json();
    // Switch tasks only once the new working copy is available.
    this.token = token;
    try { sessionStorage.setItem('annotation_tab_workspace_v1', token); }
    catch { this.onStatus('标签页存储不可用；请保留当前页面并及时下载', true); }
    this.snapshot = snapshot;
    await this.flush();
    if (previousToken && previousToken !== token) {
      // Release only the task explicitly replaced in this tab. The shared
      // browser cookie may refer to another tab, so it is never used here.
      try { await fetch('/api/workspace', { method: 'DELETE', headers: { 'X-Workspace-ID': previousToken } }); } catch {}
      try { await this.store.remove?.(previousToken); } catch {}
    }
  }
}

const localWorkspace = new BrowserWorkspace();
