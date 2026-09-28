const list = document.getElementById('app-list');
const template = document.getElementById('card-template');
const summary = document.getElementById('summary');
const pending = new Set();

function hue(str) {
  let h = 0;
  for (const c of str) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

function initials(name) {
  return name.split(/[\s:—-]+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('');
}

async function act(app, action) {
  pending.add(app.id);
  await refresh();
  try {
    await fetch(`/api/apps/${app.id}/${action}`, { method: 'POST' });
  } finally {
    pending.delete(app.id);
    await refresh();
  }
}

function render(apps) {
  const running = apps.filter(a => a.running).length;
  summary.innerHTML = `<strong>${running}</strong> of ${apps.length} running`;

  list.innerHTML = '';
  for (const app of apps) {
    const node = template.content.cloneNode(true);
    const card = node.querySelector('.card');
    const busy = pending.has(app.id);
    card.classList.toggle('is-running', app.running);
    card.style.setProperty('--h', hue(app.id));

    node.querySelector('.monogram').textContent = initials(app.name);
    node.querySelector('.app-name').textContent = app.name;
    const port = node.querySelector('.app-port');
    port.textContent = `localhost:${app.port}`;
    port.href = app.url;

    node.querySelector('.status-text').textContent =
      busy ? 'Working…' : app.running ? 'Running' : 'Stopped';
    node.querySelector('.status').classList.toggle('busy', busy);

    const toggle = node.querySelector('.toggle-btn');
    toggle.textContent = app.running ? 'Stop' : 'Start';
    toggle.classList.add(app.running ? 'stop' : 'start');
    toggle.disabled = busy;
    toggle.addEventListener('click', () => act(app, app.running ? 'stop' : 'start'));

    const open = node.querySelector('.open-btn');
    open.href = app.url;
    if (!app.running) {
      open.classList.add('disabled');
      open.setAttribute('aria-disabled', 'true');
      open.tabIndex = -1;
    }

    list.appendChild(node);
  }
}

async function refresh() {
  const res = await fetch('/api/apps');
  render(await res.json());
}

refresh();
setInterval(refresh, 3000);
