let raid, cache, fs, timers = [], demoRunning = false;
const $ = id => document.getElementById(id);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- Log ----------
const ICONS = { info: '•', hit: '⚡', miss: '🐢', warn: '⚠️', err: '❌', ok: '✅' };
Log.handler = (msg, type) => {
  const d = document.createElement('div');
  d.className = 'log ' + type;
  d.textContent = `${ICONS[type] || '•'} ${msg}`;
  $('log').appendChild(d);
  $('log').scrollTop = $('log').scrollHeight;
};

// ---------- Toasts ----------
function toast(msg, type = '') {
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  t.textContent = msg;
  $('toasts').appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

// ---------- Stack animation: light up each layer in order ----------
function flow() {
  ['l-user', 'l-fs', 'l-cache', 'l-raid', 'l-disk'].forEach((id, i) => {
    setTimeout(() => {
      $(id).classList.add('on');
      setTimeout(() => $(id).classList.remove('on'), 380);
    }, i * 170);
  });
}

// Run an action, catch errors, then redraw
function act(fn) {
  raid.touched = [];
  flow();
  try { fn(); }
  catch (e) { Log.add(e.message, 'err'); toast(e.message, 'err'); }
  refresh();
}

function ownerColor(name) {
  if (name === 'meta') return '#3a4358';
  if (!name) return '#1b2340';
  let h = 0;
  for (const ch of name) h = (h * 37 + ch.charCodeAt(0)) % 360;
  return `hsl(${h},75%,72%)`;
}

// ---------- Buttons ----------
function build() {
  timers.forEach(clearInterval);
  timers = [];
  const level = +$('level').value;
  let n = +$('ndisks').value || 4;
  if (level === 1) n = 2;
  if (level === 5) n = Math.max(3, n);
  n = Math.min(5, Math.max(2, n));
  $('ndisks').value = n;

  raid = new Raid(level, n, 24, 128);
  cache = new Cache(raid, +$('csize').value || 8);
  fs = new FileSystem(cache);
  $('log').innerHTML = '';
  $('out').textContent = '';
  $('raidLabel').textContent = `RAID ${level} · ${n} disks`;
  Log.add(`Built RAID ${level} with ${n} disks. Usable capacity: ${raid.capacity} blocks. Cache holds ${cache.capacity} blocks.`, 'ok');
  act(() => fs.format());
  toast(`RAID ${level} array ready`, 'ok');
}

function doCreate() { act(() => fs.createFile($('fname').value.trim(), $('ftext').value)); }

function doSample() {
  const name = $('fname').value.trim() || 'file';
  $('ftext').value = (`This is ${name}! `).repeat(40).slice(0, 300);
}

function doRead(name) {
  act(() => {
    Log.add(`--- Reading "${name}" ---`);
    const r = fs.readFile(name);
    if (r.ok) {
      $('out').textContent = r.text;
      Log.add(`Read "${name}" successfully.`, 'ok');
    } else {
      $('out').textContent = '💥 Cannot read this file';
      Log.add(`"${name}" is UNREADABLE: lost blocks [${r.lost.join(', ')}]`, 'err');
      toast(`"${name}" is lost!`, 'err');
    }
  });
}

function doDelete(name) { act(() => fs.deleteFile(name)); }

function doFsck() {
  act(() => {
    Log.add('--- Running fsck ---');
    const r = fs.fsck();
    r.info.forEach(m => Log.add(m, 'ok'));
    r.issues.forEach(m => Log.add(m, 'err'));
    Log.add(r.ok ? 'fsck: file system is CLEAN' : `fsck: ${r.issues.length} problem(s) found`, r.ok ? 'ok' : 'err');
    toast(r.ok ? '✅ fsck: everything is intact' : `⚠️ fsck found ${r.issues.length} problem(s)`, r.ok ? 'ok' : 'err');
  });
}

function doClearCache() { cache.clear(); Log.add('Cache cleared.', 'warn'); refresh(); }

function failDisk(id) {
  raid.disks[id].fail();
  cache.clear();
  Log.add(`Disk ${id} FAILED. All data on it is gone. (Cache cleared so you see the real disk state.)`, 'err');
  toast(`💥 Disk ${id} failed!`, 'err');
  raid.touched = [];
  refresh();
}

// Returns a Promise that resolves when the rebuild is done
function replaceDisk(id) {
  return new Promise(resolve => {
    raid.startRebuild(id);
    cache.clear();
    Log.add(`Disk ${id} replaced with a blank disk. Rebuilding row by row...`, 'warn');
    toast(`🔧 Rebuilding disk ${id}...`);
    if (raid.level === 0) Log.add('RAID 0 has no copies, so the new disk stays blank. Lost data is NOT coming back.', 'err');
    const t = setInterval(() => {
      raid.touched = [];
      const done = raid.rebuildRow(id);
      refresh();
      if (done) {
        clearInterval(t);
        Log.add(`Rebuild of disk ${id} finished. Run fsck to check everything.`, 'ok');
        toast(`Disk ${id} rebuilt`, 'ok');
        resolve();
      }
    }, 120);
    timers.push(t);
    refresh();
  });
}

// ---------- Full demo ----------
async function runDemo() {
  if (demoRunning) return;
  demoRunning = true;
  $('demoBtn').disabled = true;
  const say = m => { Log.add('🎬 ' + m, 'warn'); toast('🎬 ' + m); };
  try {
    $('level').value = 5; $('ndisks').value = 4; $('csize').value = 8;
    build(); await sleep(1500);

    say('Creating two files');
    act(() => fs.createFile('a.txt', 'Hello from file A! '.repeat(25))); await sleep(1500);
    act(() => fs.createFile('b.txt', 'Bananas are berries. '.repeat(20))); await sleep(1800);

    say('Reading a.txt twice: a miss, then a hit');
    doRead('a.txt'); await sleep(2200);
    doRead('a.txt'); await sleep(2500);

    say('Failing disk 1');
    failDisk(1); await sleep(2200);

    say('Reading a.txt in degraded mode (XOR magic)');
    doRead('a.txt'); await sleep(2800);

    say('Replacing disk 1 and rebuilding');
    await replaceDisk(1); await sleep(1000);

    say('Running fsck to verify everything');
    doFsck();
  } finally {
    demoRunning = false;
    $('demoBtn').disabled = false;
  }
}

// ---------- Drawing ----------
function renderDisks() {
  let html = '';
  for (const d of raid.disks) {
    const state = d.failed ? 'FAILED' : d.rebuilding ? 'REBUILDING' : 'ONLINE';
    const cls = d.failed ? 'failed' : d.rebuilding ? 'rebuilding' : '';
    const pct = Math.round((100 * d.rebuiltRows) / raid.rows);
    html += `<div class="disk ${cls}">
      <div class="dhead">
        <div class="dtitle"><span class="led"></span>Disk ${d.id}</div>
        <span class="badge">${state}</span>
        <div class="io">R ${d.reads} · W ${d.writes}</div>
        <div class="dbtns">
          <button onclick="failDisk(${d.id})" ${d.failed || d.rebuilding ? 'disabled' : ''}>💥 Fail</button>
          <button onclick="replaceDisk(${d.id})" ${d.failed ? '' : 'disabled'}>🔧 Fix</button>
        </div>
        ${d.rebuilding ? `<div class="bar"><i style="width:${pct}%"></i></div>` : ''}
      </div>`;
    for (let row = 0; row < raid.rows; row++) {
      const a = raid.logicalAt(d.id, row);
      const touch = raid.touched.some(t => t.disk === d.id && t.row === row) ? ' touch' : '';
      const dead = !d.usable(row) ? ' dead' : '';
      if (a.parity) {
        html += `<div class="cell parity${touch}${dead}" title="Parity block, row ${row}">P</div>`;
      } else {
        const own = fs.owner[a.L];
        const kind = own === 'meta' ? ' meta' : !own ? ' empty' : '';
        const label = own === 'meta' ? 'metadata' : own ? 'file ' + own : 'free';
        html += `<div class="cell${kind}${touch}${dead}" style="${own && own !== 'meta' ? 'background:' + ownerColor(own) : ''}"
                   title="Block ${a.L} · ${label} · disk ${d.id}, row ${row}">${a.L}</div>`;
      }
    }
    html += '</div>';
  }
  $('disks').innerHTML = html;
}

function renderFiles() {
  let html = '';
  try {
    const files = fs.listFiles();
    if (!files.length) html = '<div class="empty-note">no files yet. Create one above!</div>';
    for (const f of files) {
      const col = ownerColor(f.name);
      const chips = f.blocks
        ? f.blocks.map(b => `<span class="chip" style="background:${col}">${b}</span>`).join('')
        : '<span class="err">blocks unknown</span>';
      html += `<div class="file">
        <span class="fname" style="background:${col}">${f.name}</span>
        <div class="fmeta">${f.size ?? '?'} bytes<div class="chips">${chips}</div></div>
        <button class="btn" onclick="doRead('${f.name}')">📖 Read</button>
        <button class="btn" onclick="doDelete('${f.name}')">🗑️</button>
      </div>`;
    }
  } catch (e) {
    html = `<div class="err">📁 ${e.message}</div>`;
  }
  $('files').innerHTML = html;
}

function renderCache() {
  const keys = [...cache.map.keys()];
  let html = '';
  for (let i = 0; i < cache.capacity; i++) {
    if (i < keys.length) {
      const L = keys[i];
      const own = fs.owner[L];
      const tag = i === 0 && keys.length > 1 ? ' lru' : i === keys.length - 1 ? ' mru' : '';
      const note = tag === ' lru' ? 'next out' : tag === ' mru' ? 'newest' : '';
      html += `<div class="slot full${tag}" style="background:${ownerColor(own)}" title="Block ${L}">${L}<small>${note}</small></div>`;
    } else {
      html += '<div class="slot">·</div>';
    }
  }
  $('cache').innerHTML = html;
}

function renderStats() {
  const total = cache.hits + cache.misses;
  const ratio = total ? Math.round((100 * cache.hits) / total) : 0;
  const r = raid.disks.reduce((s, d) => s + d.reads, 0);
  const w = raid.disks.reduce((s, d) => s + d.writes, 0);
  const C = 2 * Math.PI * 36;
  $('stats').innerHTML = `
    <div class="statwrap">
      <div class="ring">
        <svg width="90" height="90">
          <circle cx="45" cy="45" r="36" stroke="#2a3558" stroke-width="9" fill="none"/>
          <circle cx="45" cy="45" r="36" stroke="#3ddc97" stroke-width="9" fill="none" stroke-linecap="round"
                  stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - ratio / 100)}" style="transition:stroke-dashoffset .5s"/>
        </svg>
        <div class="num">${ratio}%<small>hit ratio</small></div>
      </div>
      <div class="nums">
        <div class="h"><b>${cache.hits}</b>hits</div>
        <div class="m"><b>${cache.misses}</b>misses</div>
        <div><b>${r}</b>disk reads</div>
        <div><b>${w}</b>disk writes</div>
      </div>
    </div>`;
}

function refresh() { renderDisks(); renderFiles(); renderCache(); renderStats(); }

build();   // start with a fresh array when the page opens