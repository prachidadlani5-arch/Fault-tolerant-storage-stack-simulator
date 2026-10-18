const BITMAP = 0, DIR = 1, INODE_START = 2, INODE_END = 10, DATA_START = 10;

class FileSystem {
  constructor(cache) {
    this.c = cache;
    this.bs = cache.raid.bs;
    this.total = cache.raid.capacity;
    this.owner = new Array(this.total).fill(null);   // only used to color the screen
  }

  // how = 'cache' (normal), 'raw' (skip cache), 'quiet' (skip cache, don't count)
  _get(L, how = 'cache') {
    if (how === 'cache') return this.c.read(L);
    return this.c.raid.read(L, how === 'quiet');
  }

  _json(L, label, how = 'cache') {
    const r = this._get(L, how);
    if (!r.data) throw new Error(`${label} (block ${L}) is LOST: its disk died and nothing can restore it`);
    const t = unpackText(r.data);
    if (!t) return null;
    try { return JSON.parse(t); }
    catch (e) { throw new Error(`${label} (block ${L}) is corrupt`); }
  }

  _putJson(L, obj) {
    const block = packText(JSON.stringify(obj), this.bs);
    if (!this.c.write(L, block)) throw new Error(`could not write block ${L} (disk is down)`);
  }

  format() {
    const bm = Array.from({ length: this.total }, (_, i) => (i < DATA_START ? '1' : '0')).join('');
    this._putJson(BITMAP, bm);
    this._putJson(DIR, {});
    this.owner.fill(null);
    for (let i = 0; i < DATA_START; i++) this.owner[i] = 'meta';
    Log.add('File system formatted: bitmap, root directory and inode table created.', 'ok');
  }

  // Quiet listing for the screen (does not touch the stats)
  listFiles() {
    const dir = this._json(DIR, 'Folder structure', 'quiet') || {};
    return Object.entries(dir).map(([name, ino]) => {
      let inode = null;
      try { inode = this._json(ino, 'Inode', 'quiet'); } catch (e) { /* inode lost */ }
      return { name, ino, size: inode ? inode.s : undefined, blocks: inode ? inode.b : null };
    });
  }

  createFile(name, text) {
    if (!/^[\w.-]{1,8}$/.test(name)) throw new Error('Name must be 1-8 letters/numbers/dots');
    const bytes = enc.encode(text);
    if (!bytes.length) throw new Error('Type some text first');
    const need = Math.ceil(bytes.length / this.bs);
    if (need > 20) throw new Error('File too big (max 20 blocks)');

    const dir = this._json(DIR, 'Folder structure') || {};
    if (dir[name] !== undefined) throw new Error(`"${name}" already exists`);

    const used = Object.values(dir);
    let ino = null;
    for (let i = INODE_START; i < INODE_END; i++) if (!used.includes(i)) { ino = i; break; }
    if (ino === null) throw new Error('No free inodes (max 8 files)');

    const bm = this._json(BITMAP, 'Bitmap');
    if (!bm) throw new Error('Bitmap is empty. Press "Build array" to start fresh.');
    const free = [];
    for (let i = DATA_START; i < this.total && free.length < need; i++) if (bm[i] === '0') free.push(i);
    if (free.length < need) throw new Error('Disk is full');

    free.forEach((L, k) => {
      const chunk = new Uint8Array(this.bs);
      chunk.set(bytes.slice(k * this.bs, (k + 1) * this.bs));
      if (!this.c.write(L, chunk)) throw new Error(`write to block ${L} failed (disk is down)`);
    });

    const bits = bm.split('');
    free.forEach(L => (bits[L] = '1'));
    this._putJson(ino, { s: bytes.length, c: checksum(bytes), b: free });
    dir[name] = ino;
    this._putJson(DIR, dir);
    this._putJson(BITMAP, bits.join(''));
    free.forEach(L => (this.owner[L] = name));
    Log.add(`Created "${name}": ${bytes.length} bytes, inode ${ino}, data blocks [${free.join(', ')}]`, 'ok');
  }

  readFile(name) {
    const dir = this._json(DIR, 'Folder structure') || {};
    const ino = dir[name];
    if (ino === undefined) throw new Error(`"${name}" not found`);
    const inode = this._json(ino, `Inode of "${name}"`);
    if (!inode) throw new Error(`Inode of "${name}" is empty`);

    const parts = [], lost = [];
    for (const L of inode.b) {
      const r = this._get(L);
      if (r.data) parts.push(r.data); else lost.push(L);
    }
    if (lost.length) return { ok: false, lost };
    const bytes = concatBytes(parts).slice(0, inode.s);
    return { ok: true, text: dec.decode(bytes) };
  }

  deleteFile(name) {
    const dir = this._json(DIR, 'Folder structure') || {};
    const ino = dir[name];
    if (ino === undefined) throw new Error(`"${name}" not found`);
    const inode = this._json(ino, `Inode of "${name}"`);
    const bits = this._json(BITMAP, 'Bitmap').split('');
    if (inode) inode.b.forEach(L => { bits[L] = '0'; this.owner[L] = null; });
    this.c.write(ino, new Uint8Array(this.bs));
    delete dir[name];
    this._putJson(DIR, dir);
    this._putJson(BITMAP, bits.join(''));
    Log.add(`Deleted "${name}" and freed its blocks.`, 'ok');
  }

  // Consistency checker. Reads straight from the disks (skips cache).
  fsck() {
    const issues = [], info = [];
    const getJ = (L, label) => {
      const r = this.c.raid.read(L);
      if (!r.data) { issues.push(`${label} (block ${L}) is LOST`); return undefined; }
      const t = unpackText(r.data);
      if (!t) return null;
      try { return JSON.parse(t); }
      catch (e) { issues.push(`${label} (block ${L}) is corrupt`); return undefined; }
    };

    const bm = getJ(BITMAP, 'Free-block bitmap');
    const dir = getJ(DIR, 'Root directory');
    if (!bm || !dir) {
      issues.push('Cannot continue: core metadata is unreadable');
      return { issues, info, ok: false };
    }

    const claimed = {};
    for (const [name, ino] of Object.entries(dir)) {
      if (ino < INODE_START || ino >= INODE_END) { issues.push(`${name}: bad inode number ${ino}`); continue; }
      const inode = getJ(ino, `Inode of "${name}"`);
      if (!inode) { if (inode === null) issues.push(`${name}: inode ${ino} is empty`); continue; }

      const chunks = [];
      let missing = false;
      for (const L of inode.b) {
        if (L < DATA_START || L >= this.total) { issues.push(`${name}: points to invalid block ${L}`); missing = true; continue; }
        if (bm[L] !== '1') issues.push(`${name}: block ${L} is used but marked FREE in bitmap`);
        if (claimed[L]) issues.push(`block ${L} is claimed by both "${claimed[L]}" and "${name}"`);
        else claimed[L] = name;
        const r = this.c.raid.read(L);
        if (!r.data) { issues.push(`${name}: data block ${L} is LOST`); missing = true; }
        else chunks.push(r.data);
      }
      if (!missing) {
        const bytes = concatBytes(chunks).slice(0, inode.s);
        if (checksum(bytes) !== inode.c) issues.push(`${name}: checksum MISMATCH (contents damaged)`);
        else info.push(`${name}: OK (${inode.b.length} blocks, checksum matches)`);
      }
    }
    for (let L = DATA_START; L < this.total; L++) {
      if (bm[L] === '1' && !claimed[L]) issues.push(`block ${L} is marked used but no file owns it (leak)`);
    }
    return { issues, info, ok: issues.length === 0 };
  }
}