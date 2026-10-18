// ---------- One physical disk ----------
class Disk {
  constructor(id, rows, blockSize) {
    this.id = id;
    this.blockSize = blockSize;
    this.blocks = Array.from({ length: rows }, () => new Uint8Array(blockSize));
    this.failed = false;
    this.rebuilding = false;
    this.rebuiltRows = 0;
    this.reads = 0;
    this.writes = 0;
  }
  // Can we trust this row right now?
  usable(row) {
    if (this.failed) return false;
    if (this.rebuilding && row >= this.rebuiltRows) return false;
    return true;
  }
  read(row) { this.reads++; return this.blocks[row].slice(); }
  peek(row) { return this.blocks[row].slice(); }          // look without counting
  write(row, data) { this.writes++; this.blocks[row] = data.slice(); }
  fail() {                                                  // disk dies: data is GONE
    this.failed = true;
    this.rebuilding = false;
    this.blocks = this.blocks.map(() => new Uint8Array(this.blockSize));
  }
}

// ---------- The RAID layer ----------
class Raid {
  constructor(level, numDisks, rows, blockSize) {
    this.level = level;
    this.n = level === 1 ? 2 : numDisks;
    this.rows = rows;
    this.bs = blockSize;
    this.disks = Array.from({ length: this.n }, (_, i) => new Disk(i, rows, blockSize));
    this.touched = [];   // which cells were used (for green highlight)
  }

  // How many logical blocks the file system can use
  get capacity() {
    if (this.level === 0) return this.n * this.rows;
    if (this.level === 1) return this.rows;
    return (this.n - 1) * this.rows;
  }

  // RAID 5: parity moves to a different disk every row
  parityDisk(row) { return this.n - 1 - (row % this.n); }

  // Logical block number -> (disk, row)
  locate(L) {
    const n = this.n;
    if (this.level === 0) return { disk: L % n, row: Math.floor(L / n) };
    if (this.level === 1) return { disk: 0, row: L };       // copy also lives on disk 1
    const row = Math.floor(L / (n - 1));
    const idx = L % (n - 1);
    const p = this.parityDisk(row);
    return { disk: idx < p ? idx : idx + 1, row, parity: p };
  }

  // Reverse: what lives in (disk,row)? Used for drawing.
  logicalAt(disk, row) {
    const n = this.n;
    if (this.level === 0) return { L: row * n + disk };
    if (this.level === 1) return { L: row };
    const p = this.parityDisk(row);
    if (disk === p) return { parity: true };
    const idx = disk < p ? disk : disk - 1;
    return { L: row * (n - 1) + idx };
  }

  _rd(d, row, quiet) {
    if (quiet) return this.disks[d].peek(row);
    this.touched.push({ disk: d, row });
    return this.disks[d].read(row);
  }
  _wr(d, row, data) {
    this.touched.push({ disk: d, row });
    this.disks[d].write(row, data);
  }

  // Read one logical block. status: 'ok' | 'degraded' | 'lost'
  read(L, quiet = false) {
    const loc = this.locate(L);
    const lost = { data: null, status: 'lost', loc };

    if (this.disks[loc.disk].usable(loc.row)) {
      return { data: this._rd(loc.disk, loc.row, quiet), status: 'ok', loc };
    }
    // The disk that should hold it is down:
    if (this.level === 0) return lost;                       // no backup at all

    if (this.level === 1) {                                  // use the mirror
      const m = this.disks[1 - loc.disk];
      if (!m.usable(loc.row)) return lost;
      if (!quiet) Log.add(`block ${L}: disk ${loc.disk} is down -> read from MIRROR disk ${m.id}`, 'warn');
      return { data: this._rd(m.id, loc.row, quiet), status: 'degraded', loc };
    }

    // RAID 5: XOR everything else in the stripe
    const others = this.disks.filter(d => d.id !== loc.disk);
    if (!others.every(d => d.usable(loc.row))) return lost;  // 2 disks down: too bad
    const data = xorBlocks(others.map(d => this._rd(d.id, loc.row, quiet)));
    if (!quiet) Log.add(`block ${L}: disk ${loc.disk} is down -> rebuilt by XOR of the other ${others.length} disks`, 'warn');
    return { data, status: 'degraded', loc };
  }

  // Write one logical block. Returns true if it worked.
  write(L, data) {
    const loc = this.locate(L);

    if (this.level === 0) {
      if (!this.disks[loc.disk].usable(loc.row)) return false;
      this._wr(loc.disk, loc.row, data);
      return true;
    }

    if (this.level === 1) {
      let ok = false;
      for (const d of this.disks) {
        if (d.usable(loc.row)) { this._wr(d.id, loc.row, data); ok = true; }
      }
      return ok;
    }

    // RAID 5: new parity = XOR of all data blocks in the stripe
    const row = loc.row, p = loc.parity;
    const parts = [];
    for (let idx = 0; idx < this.n - 1; idx++) {
      const Lj = row * (this.n - 1) + idx;
      parts.push(Lj === L ? data : this.read(Lj).data);      // read() reconstructs if needed
    }
    if (parts.some(x => x === null)) return false;
    const parity = xorBlocks(parts);
    if (this.disks[loc.disk].usable(row)) this._wr(loc.disk, row, data);
    if (this.disks[p].usable(row)) this._wr(p, row, parity);
    return true;
  }

  // ---- Replace a dead disk and rebuild it row by row ----
  startRebuild(id) {
    const d = this.disks[id];
    d.failed = false;
    d.rebuilding = true;
    d.rebuiltRows = 0;
  }

  // Rebuild ONE row. Returns true when the whole disk is finished.
  rebuildRow(id) {
    const d = this.disks[id];
    const row = d.rebuiltRows;
    const others = this.disks.filter(x => x.id !== id);
    let data = new Uint8Array(this.bs);                      // RAID 0: nothing to copy from -> blank

    if (this.level === 1 && others[0].usable(row)) {
      data = this._rd(others[0].id, row, false);
    } else if (this.level === 5 && others.every(x => x.usable(row))) {
      data = xorBlocks(others.map(x => this._rd(x.id, row, false)));
    }
    this._wr(id, row, data);
    d.rebuiltRows++;
    if (d.rebuiltRows >= this.rows) d.rebuilding = false;
    return d.rebuiltRows >= this.rows;
  }
}