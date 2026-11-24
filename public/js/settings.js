// Settings: the drives on the page and the SSH key used for drives on other machines.
(() => {
  const $ = (id) => document.getElementById(id);
  const { el, bytes } = window.dsot;
  let current = { drives: [], key: null, df: 'df -P -k' };

  async function call(method, url, body) {
    const res = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    if (res.status === 401) { window.location.href = '/login'; throw new Error('Not signed in'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `The server answered ${res.status}`);
    return data;
  }
  function say(target, text, good) {
    target.textContent = text;
    target.className = `small ${good === true ? 'good' : good === false ? 'bad' : 'muted'}`;
  }
  function copyButton(text) {
    const b = el('button', { class: 'btn', type: 'button', text: 'Copy' });
    b.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(text); b.textContent = 'Copied'; } catch { b.textContent = 'Select it and copy'; }
      setTimeout(() => { b.textContent = 'Copy'; }, 2000);
    });
    return b;
  }
  const sizeLine = (f) => (f.error ? f.error : `${bytes(f.free)} free of ${bytes(f.size)}`);

  async function load() {
    current = await call('GET', '/api/settings');
    $('drivesRoot').textContent = current.root;
    drawDrives();
    drawKey();
  }

  // --- The drives ---
  function drawDrives() {
    $('fromStart').hidden = !(current.fromStart && current.drives.length);
    const list = $('driveList');
    if (!current.drives.length) { list.replaceChildren(el('p', { class: 'muted', text: 'No drives yet: add one below.' })); return; }
    list.replaceChildren(el('table', { class: 'settings-table' }, el('tbody', {}, current.drives.map((d, i) => el('tr', {},
      el('td', { class: 'name', text: d.name }),
      el('td', {}, el('code', { text: d.url })),
      el('td', { class: 'actions' },
        el('button', { class: 'btn', type: 'button', text: 'Rename', onclick: () => rename(i) }),
        el('button', { class: 'btn', type: 'button', text: 'Remove', onclick: () => remove(i) })))))));
  }

  async function saveList(drives) {
    await call('PUT', '/api/settings/drives', { drives: drives.map((d) => ({ name: d.name, url: d.url })) });
    await load();
    window.dsot.refresh();
    // A drive that was just added is read straight away: show its first reading when it's in.
    setTimeout(window.dsot.refresh, 4000);
  }
  async function rename(i) {
    const d = current.drives[i];
    const name = window.prompt(`New name for ${d.name}:`, d.name);
    if (!name || name.trim() === d.name) return;
    try { await saveList(current.drives.map((x, j) => (j === i ? { ...x, name: name.trim() } : x))); } catch (e) { window.alert(e.message); }
  }
  async function remove(i) {
    const d = current.drives[i];
    if (!window.confirm(`Take ${d.name} off the page? Its readings are kept, and come back if you add it again.`)) return;
    try { await saveList(current.drives.filter((_, j) => j !== i)); } catch (e) { window.alert(e.message); }
  }
  async function add(name, url, result) {
    name = name.trim();
    if (!name) { say(result, 'Give it a name first.', false); return; }
    try {
      await saveList([...current.drives, { name, url }]);
      say(result, `${name} added.`, true);
    } catch (e) { say(result, e.message, false); }
  }
  const added = (url) => current.drives.some((d) => d.url === url);

  // A row in a picker: the drive, a name box and Add.
  function pickRow(defaultName, url, detail, redraw) {
    const name = el('input', { value: defaultName, maxlength: '60', 'aria-label': `Name for ${url}` });
    const result = el('span', { class: 'small', role: 'status' });
    const already = added(url);
    return el('tr', {},
      el('td', {}, el('code', { text: url }), el('br'), el('span', { class: 'small muted', text: detail })),
      el('td', {}, already ? el('span', { class: 'small muted', text: 'On the list' }) : name),
      el('td', { class: 'actions' }, already ? null : el('button', { class: 'btn primary', type: 'button', text: 'Add', onclick: async () => { await add(name.value, url, result); redraw(); } }), result));
  }

  // Drives on this machine: the folders mounted under DRIVES_ROOT.
  function toggle(button, form, open) {
    const show = open ?? form.hidden;
    form.hidden = !show;
    button.setAttribute('aria-expanded', String(show));
    return show;
  }
  $('addFolderBtn').addEventListener('click', async () => {
    toggle($('addSshBtn'), $('sshForm'), false);
    if (toggle($('addFolderBtn'), $('folderForm'))) await drawFolders();
  });
  async function drawFolders() {
    const box = $('folderPick');
    box.replaceChildren(el('p', { class: 'muted small', text: 'Looking...' }));
    try {
      const r = await call('GET', '/api/settings/folders');
      if (!r.folders.length) {
        box.replaceChildren(el('p', { class: 'small' }, 'No drives of this machine are mounted into the app. To check one, add a line such as ', el('code', { text: `- C:/:${r.root}/C:ro` }), ' to volumes in docker-compose.yml, then run docker compose up -d. A NAS does not need this: use Add a drive over SSH.'));
        return;
      }
      box.replaceChildren(el('table', { class: 'settings-table' }, el('tbody', {}, r.folders.map((f) => pickRow(f.name, f.path, sizeLine(f), drawFolders)))));
    } catch (e) { box.replaceChildren(el('p', { class: 'small bad', text: e.message })); }
  }

  // Drives on another machine, over SSH.
  $('addSshBtn').addEventListener('click', () => {
    toggle($('addFolderBtn'), $('folderForm'), false);
    if (toggle($('addSshBtn'), $('sshForm'))) $('sAddress').focus();
  });
  function machineUrl() {
    const address = $('sAddress').value.trim();
    const user = $('sUser').value.trim();
    if (!address || !user) return '';
    return `ssh://${encodeURIComponent(user)}@${address}:${$('sPort').value.trim() || 22}`;
  }
  let lastList = null;
  async function lookAtMachine() {
    const url = machineUrl();
    if (!url) { say($('sResult'), 'Fill in the address and the user first.', false); return; }
    say($('sResult'), 'Asking it...');
    $('sshPick').replaceChildren();
    try {
      const r = await call('POST', '/api/settings/machine', { url });
      if (!r.ok) { say($('sResult'), r.error, false); return; }
      lastList = r.drives;
      say($('sResult'), `${r.drives.length} drive${r.drives.length === 1 ? '' : 's'} found.`, true);
      drawMachine();
    } catch (e) { say($('sResult'), e.message, false); }
  }
  function drawMachine() {
    if (!lastList) return;
    const host = $('sAddress').value.trim();
    $('sshPick').replaceChildren(lastList.length
      ? el('table', { class: 'settings-table' }, el('tbody', {}, lastList.map((f) => pickRow(`${host} ${f.mount === '/' ? 'system' : f.mount.split('/').pop()}`, f.url, `${f.device} · ${sizeLine(f)}`, drawMachine))))
      : el('p', { class: 'small muted', text: 'No drives over 1 GB were found there.' }));
  }
  $('sLook').addEventListener('click', lookAtMachine);
  ['sAddress', 'sPort', 'sUser'].forEach((id) => $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') lookAtMachine(); }));

  // --- SSH key ---
  function drawKey() {
    const k = current.key;
    const box = $('keyBox');
    if (!k) {
      box.replaceChildren(
        el('p', {}, 'Drives on other machines are read over SSH with a key. Make one here (the private half never leaves the app), or use a key you already have.'),
        el('div', { class: 'row' }, el('button', { class: 'btn primary', type: 'button', text: 'Make a key', onclick: makeKey })));
      return;
    }
    if (k.error) {
      box.replaceChildren(el('p', { class: 'bad', text: `The key file ${k.file} can't be used: ${k.error}` }),
        el('div', { class: 'row' }, el('button', { class: 'btn primary', type: 'button', text: 'Make a key', onclick: makeKey })));
      return;
    }
    const where = k.source === 'made' ? `Made by this app ${new Date(k.created).toLocaleDateString()}` : k.source === 'file' ? `From the file ${k.file} (SSH_KEY)` : `Your own key, saved ${new Date(k.created).toLocaleDateString()}`;
    const line = `command="${current.df}",no-pty,no-port-forwarding,no-agent-forwarding,no-X11-forwarding ${k.publicKey}`;
    box.replaceChildren(
      el('p', { class: 'muted small', text: `${where} · ${k.type} · ${k.fingerprint}` }),
      el('p', {}, 'Add this line to ', el('code', { text: '~/.ssh/authorized_keys' }), ' for the SSH user on each other machine. It lets the key list the drive sizes and nothing else.'),
      el('div', { class: 'keyline' }, el('textarea', { readonly: 'readonly', rows: '4', spellcheck: 'false', text: line }), copyButton(line)),
      el('details', {}, el('summary', { class: 'small', text: 'Just the public key' }),
        el('div', { class: 'keyline' }, el('textarea', { readonly: 'readonly', rows: '2', spellcheck: 'false', text: k.publicKey }), copyButton(k.publicKey))),
      el('div', { class: 'row' },
        el('button', { class: 'btn', type: 'button', text: 'Make a new key', onclick: makeKey }),
        k.source !== 'file' ? el('button', { class: 'btn', type: 'button', text: 'Remove key', onclick: removeKey } ) : null));
  }

  async function makeKey() {
    if (current.key && !current.key.error && !window.confirm('Make a new key? The old one stops working here, so each machine will need the new line in authorized_keys.')) return;
    try { const r = await call('POST', '/api/settings/key/make', {}); current.key = r.key; drawKey(); } catch (e) { window.alert(e.message); }
  }
  async function removeKey() {
    if (!window.confirm('Remove the SSH key from the app? Drives over SSH won\'t be read until a key is added again.')) return;
    try { const r = await call('DELETE', '/api/settings/key'); current.key = r.key; drawKey(); } catch (e) { window.alert(e.message); }
  }
  $('kSave').addEventListener('click', async () => {
    if (current.key && !current.key.error && current.key.source !== 'file' && !window.confirm('Replace the key the app has now with this one?')) return;
    say($('kResult'), 'Checking the key...');
    try {
      const r = await call('POST', '/api/settings/key', { privateKey: $('kPrivate').value, passphrase: $('kPass').value });
      $('kPrivate').value = ''; $('kPass').value = '';
      $('pasteKey').open = false;
      say($('kResult'), '');
      current.key = r.key; drawKey();
    } catch (e) { say($('kResult'), e.message, false); }
  });

  $('settingsBtn').addEventListener('click', async () => {
    $('settings').showModal();
    try { await load(); } catch (e) { $('driveList').replaceChildren(el('p', { class: 'bad', text: e.message })); }
  });
  // Clear a pasted key if the dialog is closed without saving it.
  $('settings').addEventListener('close', () => { $('kPrivate').value = ''; $('kPass').value = ''; });
})();
// http://<server>:3060/#settings opens Settings straight away.
if (window.location.hash === '#settings') document.getElementById('settingsBtn').click();
