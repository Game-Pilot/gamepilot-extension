globalThis.startGamepilotBrowserLauncher = function (apiUrl) {
  if (!['http://127.0.0.1:4317', 'https://gamepilot-api.iancosta.dev'].includes(apiUrl)) return;
  const alarmName = 'gamepilot-browser-launch';
  let busy = false;
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function request(body) {
    const stored = await chrome.storage.local.get('gamepilot.deviceToken');
    const token = stored['gamepilot.deviceToken'];
    if (!token) return {};
    const response = await fetch(apiUrl + '/api/v1/browser/agent', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-gamepilot-device': token },
      body: JSON.stringify(body), signal: AbortSignal.timeout(7000), cache: 'no-store'
    });
    if (!response.ok) throw Object.assign(new Error('Launcher indisponível'), { status: response.status });
    return response.json();
  }
  async function inspect(tab) {
    try { return await chrome.tabs.sendMessage(tab.id, { type: 'browser-launch-inspect' }); }
    catch { return null; }
  }
  async function connect(job) {
    let lastPhase = '';
    async function progress(phase) {
      if (!phase || phase === lastPhase) return;
      try { await request({ jobId: job.id, phase }); lastPhase = phase; } catch { /* Next step retries progress. */ }
    }
    await progress('opening');
    const tabs = await chrome.tabs.query({ url: 'https://huntera.com.br/*' });
    const states = await Promise.all(tabs.map(inspect));
    let index = job.discover ? -1 : states.findIndex(state => state?.characterName === job.characterName);
    if (index < 0) index = states.findIndex(state => state?.entry);
    let tab;
    if (index >= 0) tab = tabs[index];
    else if (tabs.length) throw Object.assign(new Error('Aba ocupada ou sem resposta'), { code: 'tab-unavailable' });
    else tab = await chrome.tabs.create({ url: 'https://huntera.com.br/login', active: true });
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    const deadline = Date.now() + 100000;
    while (Date.now() < deadline) {
      const current = await chrome.tabs.get(tab.id);
      if (!current.url?.startsWith('https://huntera.com.br/')) throw new Error('A aba saiu do Huntera');
      let result;
      try { result = await chrome.tabs.sendMessage(tab.id, { type: 'browser-launch-connect', job }); }
      catch { await progress('loading-adapter'); await delay(1000); continue; }
      await progress(result?.phase);
      if (result?.ok) return result;
      if (result?.error) throw Object.assign(new Error('A conexão precisa de atenção'), { code: result.code });
      await delay(1500);
    }
    throw Object.assign(new Error('Tempo de conexão esgotado'), { code: 'connection-timeout' });
  }
  async function poll() {
    if (busy) return;
    busy = true;
    try {
      // Acknowledgements survive worker suspension, without storing credentials.
      const stored = await chrome.storage.session.get('gamepilot.browserLaunchResult');
      const previous = stored['gamepilot.browserLaunchResult'];
      if (previous) {
        try { await request(previous); }
        catch (error) { if (error.status !== 404) throw error; }
        await chrome.storage.session.remove('gamepilot.browserLaunchResult');
      }
      const { job } = await request({});
      if (!job) return;
      let ok = false;
      let characters;
      let code = 'connection-failed';
      try { const connected = await connect(job); characters = connected?.characters; ok = true; } catch (error) { code = error.code || code; }
      job.password = '';
      const result = { jobId: job.id, ok, code, ...(characters ? { characters } : {}) };
      await chrome.storage.session.set({ 'gamepilot.browserLaunchResult': result });
      await request(result);
      await chrome.storage.session.remove('gamepilot.browserLaunchResult');
    } catch { /* The local API may be stopped. The next alarm retries. */ }
    finally { busy = false; }
  }
  chrome.alarms.create(alarmName, { periodInMinutes: 1 });
  chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === alarmName) void poll(); });
  void poll();
};
