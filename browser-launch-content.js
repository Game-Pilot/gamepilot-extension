(() => {
  let selecting = false;
  const adapter = () => globalThis.GamePilotAdapters?.huntera;
  const visible = element => Boolean(element && element.getClientRects().length);
  const normalize = value => String(value || '').trim().toLowerCase();
  function inspect() {
    const state = adapter()?.readState?.();
    return { characterName: state?.character?.name || null,
      health: state?.resources?.health?.current ?? null,
      entry: ['/login', '/characters'].includes(location.pathname), connected: state?.socket?.connected === true };
  }
  async function connect(job) {
    if (location.origin !== 'https://huntera.com.br' || !job?.id || !job.characterName) return { error: true, code: 'wrong-page' };
    if (!adapter()) return { waiting: true, phase: 'loading-adapter' };
    const state = inspect();
    if (location.pathname === '/game') {
      if (state.characterName && normalize(state.characterName) !== normalize(job.characterName)) return { error: true, code: 'wrong-character' };
      if (!state.connected || normalize(state.characterName) !== normalize(job.characterName)) return { waiting: true, phase: 'connecting' };
      const death = [...document.querySelectorAll('[role="alertdialog"]')].find(element => visible(element) && /você morreu|you died/i.test(element.textContent));
      if (death) {
        const revive = [...death.querySelectorAll('button')].find(button => visible(button) && !button.disabled && /^(reviver|revive)$/i.test(button.textContent.trim()));
        if (!revive || sessionStorage.getItem('gamepilot.reviveSubmitted') === job.id) return { waiting: true, phase: 'reviving' };
        sessionStorage.setItem('gamepilot.reviveSubmitted', job.id);
        revive.click();
        return { waiting: true, phase: 'reviving' };
      }
      if (!(Number(state.health) > 0)) return { waiting: true, phase: 'waiting-health' };
      return { ok: true, phase: 'ready' };
    }
    if (location.pathname === '/characters') {
      if (selecting) return { waiting: true, phase: 'selecting' };
      selecting = true;
      try {
        await adapter().selectCharacter(job.characterName);
        // The SPA changes the route before the account's character list arrives.
        // A missing card at this point is not a failed selection: retry within
        // the worker's bounded deadline, without ever choosing another character.
        // Read the resulting game screen on the next pass, including death and HP.
        return { waiting: true, phase: 'selecting' };
      } finally { selecting = false; }
    }
    if (location.pathname !== '/login') return { error: true, code: 'wrong-page' };
    const form = document.querySelector('form.gate-card');
    const email = form?.querySelector('input[name="email"][type="email"]');
    const password = form?.querySelector('input[name="password"][type="password"][autocomplete="current-password"]');
    const submit = form?.querySelector('button[type="submit"]');
    if (![form, email, password, submit].every(visible)) return { waiting: true, phase: 'login-form' };
    if (visible(form.querySelector('.account-error')) || visible(form.querySelector('[role="alert"]'))) return { error: true, code: 'login-rejected' };
    // Never retry a rejected password or submit registration/reset forms.
    const submittedKey = 'gamepilot.loginSubmitted';
    if (sessionStorage.getItem(submittedKey) === job.id) return { waiting: true, phase: 'logging-in' };
    if (!job.email || !job.password || submit.disabled) return { waiting: true, phase: 'login-form' };
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    for (const [element, value] of [[email, job.email], [password, job.password]]) {
      setter.call(element, value);
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    }
    sessionStorage.setItem(submittedKey, job.id);
    submit.click();
    return { waiting: true, phase: 'logging-in' };
  }
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return;
    if (message.type === 'browser-launch-inspect') { respond(inspect()); return; }
    if (message.type !== 'browser-launch-connect') return;
    connect(message.job).then(respond, () => respond({ error: true }));
    return true;
  });
})();
