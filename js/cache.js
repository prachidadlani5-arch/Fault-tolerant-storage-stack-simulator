class Cache {
  constructor(raid, capacity) {
    this.raid = raid;
    this.capacity = capacity;
    this.map = new Map();    // block number -> data. Oldest-used is first.
    this.hits = 0;
    this.misses = 0;
  }

  read(L) {
    if (this.map.has(L)) {                       // HIT
      const data = this.map.get(L);
      this.map.delete(L);                        // move to the "most recent" end
      this.map.set(L, data);
      this.hits++;
      Log.add(`block ${L}: cache HIT (no disk touched)`, 'hit');
      return { data: data.slice(), status: 'ok', hit: true };
    }
    this.misses++;                               // MISS
    const r = this.raid.read(L);
    if (r.data) {
      this._put(L, r.data);
      Log.add(`block ${L}: cache MISS -> read from disk ${r.loc.disk}, row ${r.loc.row}`, 'miss');
    } else {
      Log.add(`block ${L}: cache MISS -> LOST (disk ${r.loc.disk} is dead, no backup)`, 'err');
    }
    return { ...r, hit: false };
  }

  // Write-through: write to the disks AND keep a copy in the cache
  write(L, data) {
    const ok = this.raid.write(L, data);
    if (ok) this._put(L, data);
    return ok;
  }

  _put(L, data) {
    this.map.delete(L);
    this.map.set(L, data.slice());
    if (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
      Log.add(`cache full: evicted block ${oldest} (least recently used)`);
    }
  }

  clear() { this.map.clear(); }
}