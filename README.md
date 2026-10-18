# 🗄️ Fault-Tolerant Storage Stack Simulator

A simulator that shows what happens to a file after you hit "save". It models the full path from the file system, through a buffer cache, down to a RAID array of virtual disks. You can then **fail a disk**, read your files anyway, **rebuild** the disk, and prove with **fsck** that nothing was lost.

Written in C++ (no dependencies), with an optional animated web visualisation.

```
User:           create / write / read / delete files
   |
File system:    directories, inodes, free-block bitmap, fsck
   |
Buffer cache:   LRU eviction, hit / miss statistics
   |
RAID layer:     RAID 0 / RAID 1 / RAID 5
   |
Virtual disks
```

Each layer only talks to the one below it. The file system asks for "block 12" and has no idea which physical disk holds it. The cache decides whether a disk needs to be read at all. The RAID layer decides where each block physically lives and how to recover it after a failure.

## Features

- **File system:** inodes, a root directory, a free-block bitmap, and an `fsck` consistency checker with per-file checksums.
- **Buffer cache:** LRU replacement in O(1) (linked list + hash map), write-through, hit/miss counters and hit ratio.
- **RAID 0, 1 and 5:** striping, mirroring, and striping with rotating XOR parity.
- **Failure simulation:** fail any disk (its data is destroyed), keep working in degraded mode, then replace and rebuild it row by row.
- **Integrity checking:** `fsck` detects lost blocks, checksum mismatches, blocks claimed twice, used-but-free blocks and leaked blocks.
- **23 automated tests** covering every layer.
- **Interactive shell** and a **web visualisation** with a one-click "Run Full Demo".

## Quick start

You need a C++ compiler (`g++`). No other libraries are required.

```bash
g++ -std=c++14 -O2 -o sim main.cpp

./sim          # run the automated test suite
./sim shell    # interactive shell
```

On Windows PowerShell, use `.\sim.exe` instead of `./sim`.

## Try it: survive a disk failure

```
$ ./sim shell
sim> build 5 4 8            # RAID 5, 4 disks, cache of 8 blocks
sim> sample a.txt           # create a 300-byte file
sim> clearcache
sim> read a.txt             # every block is a cache MISS
sim> read a.txt             # every block is a cache HIT, no disk touched
sim> stats
   cache: hits=7 misses=5 ratio=58.3% | disk I/O: reads=21 writes=16
sim> fail 1                 # disk 1 dies and its data is gone
sim> clearcache
sim> read a.txt
   block 1: disk 1 down -> rebuilt by XOR of 3 disks
   ...the file is still returned correctly
sim> replace 1              # new blank disk, rebuilt row by row
sim> fsck
   OK  a.txt: OK (3 blocks, checksum matches)
   fsck: CLEAN
```

Try the same with `build 0 4 8` (RAID 0). After `fail 1` the data is gone, and because the root directory lives on that disk, `fsck` reports the whole folder structure as lost.

### Shell commands

| Command | What it does |
|---|---|
| `build <0\|1\|5> <disks> <cache>` | Create a new array (RAID 1 always uses 2 disks; use 3 to 5 for RAID 5) |
| `create <name> <text...>` | Create a file with your own text |
| `sample <name>` | Create a 300-byte sample file (3 blocks) |
| `read <name>` | Read a file through the cache |
| `del <name>` | Delete a file and free its blocks |
| `ls` | List files |
| `fail <d>` | Fail disk `d` (all its data is destroyed) |
| `replace <d>` | Replace disk `d` with a blank one and rebuild it |
| `fsck` | Check the whole file system |
| `map` | Draw the block layout across all disks (P = parity, x = unreachable) |
| `stats` | Cache hits, misses, hit ratio and physical disk I/O |
| `clearcache` | Empty the cache |
| `quit` | Exit |

Writes are write-through, so a freshly created file is already in the cache. Use `clearcache` before `read` to see cache misses.

## How it works

### RAID layouts

For `n` disks and logical block `L`:

| Level | Placement | Usable capacity | Survives 1 disk failure |
|---|---|---|---|
| RAID 0 | disk = `L mod n`, row = `L / n` | all | No |
| RAID 1 | same row on both disks | half | Yes, read the mirror |
| RAID 5 | `n-1` data blocks + 1 parity block per row; parity disk = `(n-1) - (row mod n)` rotates every row | `(n-1)/n` | Yes, XOR the survivors |

RAID 5 with 4 disks (`P` = parity):

```
row 0     0     1     2     P
row 1     3     4     P     5
row 2     6     P     7     8
row 3     P     9    10    11
```

Parity is the XOR of the data blocks in a row. If `P = A xor B` and `B` is lost, then `B = A xor P`.

### Failure handling

- **Degraded read (RAID 1):** read the same row from the mirror.
- **Degraded read (RAID 5):** XOR the other `n-1` blocks of the stripe to recreate the missing one.
- **RAID 0:** there is no copy, so the block is reported as lost.
- **Rebuild:** the failed disk is replaced by a blank one and refilled one row at a time. RAID 1 copies from the mirror, RAID 5 XORs the other disks, and RAID 0 has nothing to restore from.

### Buffer cache

An LRU cache built from a doubly linked list (most recent at the front) and a hash map from block number to list position, so hits, inserts and evictions are all O(1). The cache is cleared on disk failure and replacement so that the next reads show the real state of the disks.

### File system layout

| Blocks | Contents |
|---|---|
| 0 | Free-block bitmap |
| 1 | Root directory (`name inode-number`) |
| 2 - 9 | Inode table (one inode per block: size, checksum, data blocks) |
| 10+ | File data |

All metadata is stored in ordinary blocks, so it is spread across the disks like file data. That is why losing one disk in RAID 0 can destroy the directory itself.

### fsck

Reads straight from the RAID layer (bypassing the cache) and checks that: the bitmap and directory are readable, every inode is valid, every block is marked used, no block is owned by two files, no used block is orphaned, and each file's checksum matches its contents.

## Tests

`./sim` runs 23 checks in 7 groups:

| Group | What it verifies |
|---|---|
| T1 | Cache miss then hit, no extra disk reads, capacity never exceeded |
| T2 | RAID 5: fail, degraded read, fsck, rebuild, fsck, then a second failure on another disk |
| T3 | RAID 1: same procedure using the mirror |
| T4 | RAID 0: data loss is detected and fsck keeps reporting it after the disk is replaced |
| T5 | XOR parity recovers a lost block exactly |
| T6 | Duplicate and missing file errors, delete frees blocks |
| T7 | fsck catches a single flipped byte |

## Complexity

`B` = block size, `n` = disks, `R` = rows per disk, `k` = blocks per file, `F` = files, `N` = total blocks.

| Operation | Time |
|---|---|
| Address mapping | O(1) |
| Cache lookup / insert / evict | O(1) |
| RAID 0 / 1 / 5 healthy read | O(B) |
| RAID 5 degraded read | O(n·B) |
| RAID 5 write | O(n²·B) in this simulator (re-reads the stripe) |
| Rebuild one disk | O(R·n·B) |
| Create / read a file | O(k·n·B) |
| fsck | O(F·k·n·B + N) |

Space: O(n·R·B) for the disks, O(C·B) for a cache of `C` blocks, O(N) for the bitmap.

## Web visualisation

Open `index.html` in a browser (or use the VS Code **Live Server** extension). It shows the same stack with:

- a live diagram that lights up each layer as a request passes through,
- the disks as coloured block grids with glowing status LEDs,
- the cache as LRU slots, plus a hit-ratio gauge,
- a **🎬 Run Full Demo** button that plays create, read, fail, degraded read, rebuild and fsck automatically.

## Project structure

```
.
├── main.cpp          # C++ simulator: Disk, Raid, Cache, FileSystem, tests, shell
├── index.html        # web visualisation
├── style.css
├── js/
│   ├── util.js       # XOR, checksum, helpers
│   ├── raid.js       # disks and RAID layer
│   ├── cache.js      # LRU cache
│   ├── fs.js         # file system and fsck
│   └── app.js        # UI logic
```

## Limitations

- Everything is in memory; time is not simulated, so cost is measured by counting disk reads and writes.
- Blocks are 128 bytes. The file system is flat: one directory, up to 8 files, up to 20 blocks each, names up to 8 characters.
- RAID 1 and RAID 5 tolerate one failed disk at a time. A second failure in RAID 5 is reported as data loss.
- The cache is write-through; there is no write-back or journaling.

## Ideas for future work

- Read-modify-write parity updates to make RAID 5 writes O(B).
- RAID 6 (two parity blocks) and RAID 10.
- Write-back cache with dirty bits and a journal, plus crash simulation.
- Sub-directories, indirect blocks and dynamic inode allocation.
- A hot-spare disk that rebuilds automatically.
- Comparing other replacement policies (FIFO, LFU, CLOCK) against LRU.