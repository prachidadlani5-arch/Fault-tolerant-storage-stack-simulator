#include <algorithm>
#include <cstdint>
#include <exception>
#include <iomanip>
#include <iostream>
#include <list>
#include <map>
#include <memory>
#include <sstream>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <vector>
using namespace std;

typedef vector<uint8_t> Block;
const int BS = 128;                       // block size in bytes
const int BITMAP = 0, DIRB = 1, INODE_START = 2, INODE_END = 10, DATA_START = 10;
bool VERBOSE = true;
void logm(const string& s) { if (VERBOSE) cout << "   " << s << "\n"; }

// ---------------- helpers ----------------
Block xorBlocks(const vector<Block>& v) {            // O(k*BS)
    Block o(BS, 0);
    for (size_t k = 0; k < v.size(); k++)
        for (int i = 0; i < BS; i++) o[i] ^= v[k][i];
    return o;
}
uint32_t checksum(const string& s) {
    uint32_t h = 7;
    for (size_t i = 0; i < s.size(); i++) h = h * 31 + (unsigned char)s[i];
    return h;
}
Block pack(const string& s) {
    if ((int)s.size() > BS) throw runtime_error("metadata too big for one block");
    Block b(BS, 0); copy(s.begin(), s.end(), b.begin()); return b;
}
string unpack(const Block& b) {
    int e = BS; while (e > 0 && b[e - 1] == 0) e--;
    return string(b.begin(), b.begin() + e);
}

// ---------------- one physical disk ----------------
struct Disk {
    vector<Block> b; bool failed; bool rebuilding; int rebuilt; long reads; long writes;
    Disk(int rows) : b(rows, Block(BS, 0)), failed(false), rebuilding(false), rebuilt(0), reads(0), writes(0) {}
    bool usable(int row) const { return !failed && !(rebuilding && row >= rebuilt); }
    void fail() {
        failed = true; rebuilding = false;
        for (size_t i = 0; i < b.size(); i++) fill(b[i].begin(), b[i].end(), 0);
    }
};

// ---------------- RAID layer ----------------
struct Loc { int disk, row, parity; };
struct RRes { bool ok; Block data; bool degraded; Loc loc; };

class Raid {
public:
    int level, n, rows; vector<Disk> d;
    Raid(int lv, int nd, int r) : level(lv), n(lv == 1 ? 2 : nd), rows(r) { for (int i = 0; i < n; i++) d.push_back(Disk(r)); }
    int capacity() const { return level == 0 ? n * rows : level == 1 ? rows : (n - 1) * rows; }
    int parityDisk(int row) const { return n - 1 - (row % n); }
    Loc locate(int L) const {                                  // O(1)
        Loc x;
        if (level == 0) { x.disk = L % n; x.row = L / n; x.parity = -1; return x; }
        if (level == 1) { x.disk = 0; x.row = L; x.parity = -1; return x; }
        int row = L / (n - 1), idx = L % (n - 1), p = parityDisk(row);
        x.disk = idx < p ? idx : idx + 1; x.row = row; x.parity = p;
        return x;
    }
    int logicalAt(int disk, int row) const {                   // -1 = parity
        if (level == 0) return row * n + disk;
        if (level == 1) return row;
        int p = parityDisk(row); if (disk == p) return -1;
        return row * (n - 1) + (disk < p ? disk : disk - 1);
    }
    Block rd(int di, int row) { d[di].reads++; return d[di].b[row]; }
    void wr(int di, int row, const Block& x) { d[di].writes++; d[di].b[row] = x; }

    RRes mk(bool ok, const Block& data, bool deg, const Loc& loc) { RRes r; r.ok = ok; r.data = data; r.degraded = deg; r.loc = loc; return r; }

    RRes read(int L) {
        Loc loc = locate(L);
        if (d[loc.disk].usable(loc.row)) return mk(true, rd(loc.disk, loc.row), false, loc);
        if (level == 0) return mk(false, Block(), false, loc);
        if (level == 1) {
            Disk& m = d[1 - loc.disk];
            if (!m.usable(loc.row)) return mk(false, Block(), false, loc);
            logm("block " + to_string(L) + ": disk " + to_string(loc.disk) + " down -> read from MIRROR");
            return mk(true, rd(1 - loc.disk, loc.row), true, loc);
        }
        vector<Block> parts;                                   // RAID 5: XOR of the other n-1 blocks
        for (int i = 0; i < n; i++) if (i != loc.disk) {
            if (!d[i].usable(loc.row)) return mk(false, Block(), false, loc);
            parts.push_back(rd(i, loc.row));
        }
        logm("block " + to_string(L) + ": disk " + to_string(loc.disk) + " down -> rebuilt by XOR of " + to_string(n - 1) + " disks");
        return mk(true, xorBlocks(parts), true, loc);
    }
    bool write(int L, const Block& data) {
        Loc loc = locate(L);
        if (level == 0) { if (!d[loc.disk].usable(loc.row)) return false; wr(loc.disk, loc.row, data); return true; }
        if (level == 1) { bool ok = false; for (int i = 0; i < 2; i++) if (d[i].usable(loc.row)) { wr(i, loc.row, data); ok = true; } return ok; }
        vector<Block> parts;
        for (int idx = 0; idx < n - 1; idx++) {
            int Lj = loc.row * (n - 1) + idx;
            if (Lj == L) parts.push_back(data);
            else { RRes r = read(Lj); if (!r.ok) return false; parts.push_back(r.data); }
        }
        Block par = xorBlocks(parts);
        if (d[loc.disk].usable(loc.row)) wr(loc.disk, loc.row, data);
        if (d[loc.parity].usable(loc.row)) wr(loc.parity, loc.row, par);
        return true;
    }
    void startRebuild(int id) { d[id].failed = false; d[id].rebuilding = true; d[id].rebuilt = 0; }
    bool rebuildRow(int id) {                                  // one row, O(n*BS)
        Disk& dk = d[id]; int row = dk.rebuilt; Block data(BS, 0);
        vector<int> others; for (int i = 0; i < n; i++) if (i != id) others.push_back(i);
        bool allOk = true;
        for (size_t k = 0; k < others.size(); k++) if (!d[others[k]].usable(row)) allOk = false;
        if (level == 1 && allOk) data = rd(others[0], row);
        else if (level == 5 && allOk) {
            vector<Block> p;
            for (size_t k = 0; k < others.size(); k++) p.push_back(rd(others[k], row));
            data = xorBlocks(p);
        }
        wr(id, row, data); dk.rebuilt++;
        if (dk.rebuilt >= rows) dk.rebuilding = false;
        return dk.rebuilt >= rows;
    }
    void rebuildAll(int id) { startRebuild(id); while (!rebuildRow(id)) {} }
};

// ---------------- Buffer cache (LRU: list + hash map, O(1)) ----------------
class Cache {
public:
    Raid& raid; size_t cap; long hits, misses;
    list<pair<int, Block> > lru;                               // front = most recent
    unordered_map<int, list<pair<int, Block> >::iterator> idx;
    Cache(Raid& r, int c) : raid(r), cap(c), hits(0), misses(0) {}
    RRes read(int L) {
        unordered_map<int, list<pair<int, Block> >::iterator>::iterator it = idx.find(L);
        if (it != idx.end()) {
            lru.splice(lru.begin(), lru, it->second); hits++;
            logm("block " + to_string(L) + ": cache HIT");
            return raid.mk(true, it->second->second, false, raid.locate(L));
        }
        misses++; RRes r = raid.read(L);
        if (r.ok) { put(L, r.data); logm("block " + to_string(L) + ": cache MISS -> disk " + to_string(r.loc.disk) + ", row " + to_string(r.loc.row)); }
        else logm("block " + to_string(L) + ": cache MISS -> LOST (no backup)");
        return r;
    }
    bool write(int L, const Block& b) { bool ok = raid.write(L, b); if (ok) put(L, b); return ok; }   // write-through
    void put(int L, const Block& b) {
        unordered_map<int, list<pair<int, Block> >::iterator>::iterator it = idx.find(L);
        if (it != idx.end()) { lru.erase(it->second); idx.erase(it); }
        lru.push_front(make_pair(L, b)); idx[L] = lru.begin();
        if (lru.size() > cap) { int old = lru.back().first; idx.erase(old); lru.pop_back(); logm("cache full: evicted block " + to_string(old) + " (LRU)"); }
    }
    void clear() { lru.clear(); idx.clear(); }
    double ratio() const { long t = hits + misses; return t ? 100.0 * hits / t : 0; }
};

// ---------------- File system ----------------
struct Inode { int size; uint32_t sum; vector<int> blocks; Inode() : size(0), sum(0) {} };
struct ReadResult { bool ok; string text; vector<int> lost; };
struct FsckResult { bool ok; vector<string> issues, info; };

class FileSystem {
public:
    Cache& c; int total; vector<string> owner;
    FileSystem(Cache& ca) : c(ca), total(ca.raid.capacity()), owner(ca.raid.capacity()) {}

    string getText(int L, bool useCache, const string& label) {
        RRes r = useCache ? c.read(L) : c.raid.read(L);
        if (!r.ok) throw runtime_error(label + " (block " + to_string(L) + ") is LOST");
        return unpack(r.data);
    }
    void putText(int L, const string& s) { if (!c.write(L, pack(s))) throw runtime_error("write to block " + to_string(L) + " failed"); }
    map<string, int> parseDir(const string& t) { map<string, int> m; istringstream is(t); string n; int i; while (is >> n >> i) m[n] = i; return m; }
    string dumpDir(const map<string, int>& m) {
        string s;
        for (map<string, int>::const_iterator it = m.begin(); it != m.end(); ++it) s += it->first + " " + to_string(it->second) + "\n";
        return s;
    }
    Inode parseInode(const string& t) { Inode in; istringstream is(t); is >> in.size >> in.sum; int b; while (is >> b) in.blocks.push_back(b); return in; }
    string dumpInode(const Inode& in) { string s = to_string(in.size) + " " + to_string(in.sum); for (size_t k = 0; k < in.blocks.size(); k++) s += " " + to_string(in.blocks[k]); return s; }

    void format() {
        string bm(total, '0'); for (int i = 0; i < DATA_START; i++) bm[i] = '1';
        putText(BITMAP, bm); putText(DIRB, "");
        for (size_t i = 0; i < owner.size(); i++) owner[i].clear();
        for (int i = 0; i < DATA_START; i++) owner[i] = "meta";
    }
    void create(const string& name, const string& text) {
        if (name.empty() || name.size() > 8) throw runtime_error("name must be 1-8 chars");
        if (text.empty()) throw runtime_error("empty file");
        int need = (text.size() + BS - 1) / BS; if (need > 20) throw runtime_error("file too big (max 20 blocks)");
        map<string, int> dir = parseDir(getText(DIRB, true, "Directory"));
        if (dir.count(name)) throw runtime_error("\"" + name + "\" already exists");
        int ino = -1;
        for (int i = INODE_START; i < INODE_END && ino < 0; i++) {
            bool used = false;
            for (map<string, int>::iterator it = dir.begin(); it != dir.end(); ++it) if (it->second == i) used = true;
            if (!used) ino = i;
        }
        if (ino < 0) throw runtime_error("no free inodes (max 8 files)");
        string bm = getText(BITMAP, true, "Bitmap"); vector<int> fr;
        for (int i = DATA_START; i < total && (int)fr.size() < need; i++) if (bm[i] == '0') fr.push_back(i);
        if ((int)fr.size() < need) throw runtime_error("disk full");
        for (int k = 0; k < need; k++) {
            Block b(BS, 0); string part = text.substr(k * BS, BS); copy(part.begin(), part.end(), b.begin());
            if (!c.write(fr[k], b)) throw runtime_error("data write failed (disk down)");
            owner[fr[k]] = name; bm[fr[k]] = '1';
        }
        Inode in; in.size = (int)text.size(); in.sum = checksum(text); in.blocks = fr;
        putText(ino, dumpInode(in));
        dir[name] = ino; putText(DIRB, dumpDir(dir)); putText(BITMAP, bm);
        string bl; for (size_t k = 0; k < fr.size(); k++) bl += to_string(fr[k]) + " ";
        logm("created \"" + name + "\": inode " + to_string(ino) + ", blocks [ " + bl + "]");
    }
    ReadResult read(const string& name) {
        map<string, int> dir = parseDir(getText(DIRB, true, "Directory"));
        if (!dir.count(name)) throw runtime_error("\"" + name + "\" not found");
        Inode in = parseInode(getText(dir[name], true, "Inode"));
        string all; vector<int> lost;
        for (size_t k = 0; k < in.blocks.size(); k++) {
            int L = in.blocks[k]; RRes r = c.read(L);
            if (!r.ok) lost.push_back(L); else all.append(r.data.begin(), r.data.end());
        }
        ReadResult rr; rr.ok = lost.empty(); rr.lost = lost;
        if (rr.ok) rr.text = all.substr(0, in.size);
        return rr;
    }
    void del(const string& name) {
        map<string, int> dir = parseDir(getText(DIRB, true, "Directory"));
        if (!dir.count(name)) throw runtime_error("\"" + name + "\" not found");
        int ino = dir[name]; Inode in = parseInode(getText(ino, true, "Inode"));
        string bm = getText(BITMAP, true, "Bitmap");
        for (size_t k = 0; k < in.blocks.size(); k++) { bm[in.blocks[k]] = '0'; owner[in.blocks[k]].clear(); }
        c.write(ino, Block(BS, 0)); dir.erase(name); putText(DIRB, dumpDir(dir)); putText(BITMAP, bm);
    }
    vector<string> list() {
        vector<string> v;
        try {
            map<string, int> m = parseDir(getText(DIRB, false, "Directory"));
            for (map<string, int>::iterator it = m.begin(); it != m.end(); ++it) v.push_back(it->first);
        } catch (...) {}
        return v;
    }
    FsckResult fsck() {                                        // bypasses the cache, reads straight from RAID
        FsckResult R; R.ok = true;
        string bm, dtext;
        try { bm = getText(BITMAP, false, "Bitmap"); dtext = getText(DIRB, false, "Root directory"); }
        catch (exception& e) { R.issues.push_back(string(e.what()) + " -> cannot continue"); R.ok = false; return R; }
        map<string, int> dir = parseDir(dtext); map<int, string> claimed;
        for (map<string, int>::iterator di = dir.begin(); di != dir.end(); ++di) {
            string name = di->first; int ino = di->second;
            string it;
            try { it = getText(ino, false, "Inode of " + name); }
            catch (exception& e) { R.issues.push_back(e.what()); R.ok = false; continue; }
            if (it.empty()) { R.issues.push_back(name + ": inode is empty"); R.ok = false; continue; }
            Inode in = parseInode(it); string all; bool miss = false;
            for (size_t k = 0; k < in.blocks.size(); k++) {
                int L = in.blocks[k];
                if (L < DATA_START || L >= total) { R.issues.push_back(name + ": invalid block " + to_string(L)); R.ok = false; miss = true; continue; }
                if (bm[L] != '1') { R.issues.push_back(name + ": block " + to_string(L) + " used but marked FREE"); R.ok = false; }
                if (claimed.count(L)) { R.issues.push_back("block " + to_string(L) + " claimed by both " + claimed[L] + " and " + name); R.ok = false; }
                else claimed[L] = name;
                RRes r = c.raid.read(L);
                if (!r.ok) { R.issues.push_back(name + ": data block " + to_string(L) + " is LOST"); R.ok = false; miss = true; }
                else all.append(r.data.begin(), r.data.end());
            }
            if (!miss) {
                if (checksum(all.substr(0, in.size)) != in.sum) { R.issues.push_back(name + ": checksum MISMATCH"); R.ok = false; }
                else R.info.push_back(name + ": OK (" + to_string(in.blocks.size()) + " blocks, checksum matches)");
            }
        }
        for (int L = DATA_START; L < total; L++)
            if (bm[L] == '1' && !claimed.count(L)) { R.issues.push_back("block " + to_string(L) + " marked used but owned by no file (leak)"); R.ok = false; }
        return R;
    }
};

// ---------------- Pretty output ----------------
void printMap(Raid& r) {
    cout << "      ";
    for (int i = 0; i < r.n; i++) {
        string h = "D" + to_string(i) + (r.d[i].failed ? "(X)" : r.d[i].rebuilding ? "(R)" : "");
        cout << setw(8) << h;
    }
    cout << "\n";
    for (int row = 0; row < r.rows; row++) {
        cout << "row" << setw(2) << row << " ";
        for (int di = 0; di < r.n; di++) {
            int L = r.logicalAt(di, row);
            string s = L < 0 ? "P" : to_string(L);
            if (!r.d[di].usable(row)) s = "x" + s;
            cout << setw(8) << s;
        }
        cout << "\n";
    }
}
void printStats(Cache& c) {
    long R = 0, W = 0; for (size_t i = 0; i < c.raid.d.size(); i++) { R += c.raid.d[i].reads; W += c.raid.d[i].writes; }
    cout << "   cache: hits=" << c.hits << " misses=" << c.misses << " ratio=" << fixed << setprecision(1) << c.ratio()
         << "%  | disk I/O: reads=" << R << " writes=" << W << "\n";
}

// ---------------- Stack object ----------------
struct Stack {
    Raid raid; Cache cache; FileSystem fs;
    Stack(int lv, int n, int cs) : raid(lv, n, 24), cache(raid, cs), fs(cache) { fs.format(); }
};

// ---------------- Test suite ----------------
int passed = 0, failedT = 0;
void check(bool cond, const string& msg) { cout << (cond ? "  [PASS] " : "  [FAIL] ") << msg << "\n"; if (cond) passed++; else failedT++; }
string sample(const string& s, int len) { string o; while ((int)o.size() < len) o += s; return o.substr(0, len); }
long totalReads(Raid& r) { long x = 0; for (size_t i = 0; i < r.d.size(); i++) x += r.d[i].reads; return x; }

void testCacheLRU() {
    cout << "\nT1: Cache hit/miss and LRU eviction\n";
    Stack s(5, 4, 3);
    s.fs.create("a", sample("AAAA", 400));                      // 4 blocks
    s.cache.clear(); s.cache.hits = s.cache.misses = 0;
    s.fs.read("a"); long m1 = s.cache.misses, h1 = s.cache.hits;
    check(m1 > 0 && h1 == 0, "first read = all misses");
    Stack s2(5, 4, 16); s2.fs.create("a", sample("AAAA", 400)); s2.cache.clear(); s2.cache.hits = s2.cache.misses = 0;
    s2.fs.read("a"); long reads1 = totalReads(s2.raid);
    s2.fs.read("a"); long reads2 = totalReads(s2.raid);
    check(s2.cache.hits > 0 && reads1 == reads2, "second read = hits, zero extra disk reads (big cache)");
    check(s.cache.lru.size() <= 3, "cache never exceeds its capacity (LRU eviction works)");
}
void testRaidLevel(int lv, int n, const string& label, bool survives) {
    cout << "\n" << label << "\n";
    Stack s(lv, n, 8);
    s.fs.create("a.txt", sample("Hello A! ", 300)); s.fs.create("b.txt", sample("Banana ", 500));
    check(s.fs.fsck().ok, "fsck clean before failure");
    s.raid.d[1].fail(); s.cache.clear();
    if (survives) {
        ReadResult r = s.fs.read("a.txt"); ReadResult r2 = s.fs.read("b.txt");
        check(r.ok && r.text == sample("Hello A! ", 300) && r2.ok, "files still readable in degraded mode, bytes identical");
        check(s.fs.fsck().ok, "fsck clean in degraded mode");
        s.raid.rebuildAll(1); s.cache.clear();
        check(!s.raid.d[1].failed && !s.raid.d[1].rebuilding, "rebuild finished");
        check(s.fs.fsck().ok, "fsck clean after rebuild");
        s.raid.d[0].fail(); s.cache.clear();
        check(s.fs.read("b.txt").ok, "after rebuild, a different disk can fail and data still survives");
    } else {
        bool lost = false;
        try { lost = !s.fs.read("b.txt").ok; } catch (exception&) { lost = true; }   // directory itself may be gone
        check(lost && !s.fs.fsck().ok, "data/metadata loss detected after disk failure");
        s.raid.rebuildAll(1); s.cache.clear();
        check(!s.fs.fsck().ok, "fsck still reports problems after replacing disk (no redundancy)");
    }
}
void testParity() {
    cout << "\nT5: XOR parity math\n";
    Block A(BS), B(BS); for (int i = 0; i < BS; i++) { A[i] = i * 7; B[i] = i * 13 + 5; }
    vector<Block> v1; v1.push_back(A); v1.push_back(B);
    Block P = xorBlocks(v1);
    vector<Block> v2; v2.push_back(A); v2.push_back(P);
    Block Brec = xorBlocks(v2);
    check(Brec == B, "B = A xor P recovers the lost block");
}
void testErrors() {
    cout << "\nT6: File-system error handling\n";
    Stack s(5, 4, 8); s.fs.create("x", "hi");
    bool dup = false; try { s.fs.create("x", "hi"); } catch (...) { dup = true; }
    bool miss = false; try { s.fs.read("nope"); } catch (...) { miss = true; }
    check(dup, "duplicate name rejected"); check(miss, "missing file rejected");
    s.fs.del("x"); check(s.fs.list().empty() && s.fs.fsck().ok, "delete frees blocks, fsck clean");
}
void testFsckDetects() {
    cout << "\nT7: fsck detects corruption\n";
    Stack s(5, 4, 8); s.fs.create("a", sample("Z", 300));
    int L = 10; Loc lc = s.raid.locate(L); s.raid.d[lc.disk].b[lc.row][3] ^= 0xFF;
    check(!s.fs.fsck().ok, "flipped byte -> checksum mismatch found");
}
int runTests() {
    VERBOSE = false;
    testCacheLRU();
    testRaidLevel(5, 4, "T2: RAID 5 (4 disks) fail -> degraded read -> rebuild -> fsck", true);
    testRaidLevel(1, 2, "T3: RAID 1 (mirror) fail -> degraded read -> rebuild -> fsck", true);
    testRaidLevel(0, 4, "T4: RAID 0 (striping) fail -> data lost", false);
    testParity(); testErrors(); testFsckDetects();
    cout << "\n=== " << passed << " passed, " << failedT << " failed ===\n";
    return failedT ? 1 : 0;
}

// ---------------- Interactive shell ----------------
void shell() {
    unique_ptr<Stack> s(new Stack(5, 4, 8));
    cout << "Commands: build <0|1|5> <disks> <cache> | create <name> <text...> | sample <name> | read <name> | del <name>\n"
            "          ls | fail <d> | replace <d> | fsck | map | stats | clearcache | quit\n";
    string line;
    while (cout << "sim> " << flush, getline(cin, line)) {
        istringstream is(line); string cmd; is >> cmd;
        try {
            if (cmd == "quit" || cmd == "exit") break;
            else if (cmd == "build") { int lv, n, cs; is >> lv >> n >> cs; s.reset(new Stack(lv, n, cs)); cout << "   RAID " << lv << ", " << s->raid.n << " disks, capacity " << s->raid.capacity() << " blocks\n"; }
            else if (cmd == "create") { string n, t; is >> n; getline(is, t); if (!t.empty()) t = t.substr(1); s->fs.create(n, t); }
            else if (cmd == "sample") { string n; is >> n; s->fs.create(n, sample("This is " + n + "! ", 300)); }
            else if (cmd == "read") {
                string n; is >> n; ReadResult r = s->fs.read(n);
                if (r.ok) cout << "   " << r.text.substr(0, 80) << (r.text.size() > 80 ? "..." : "") << "\n";
                else { cout << "   UNREADABLE, lost blocks:"; for (size_t k = 0; k < r.lost.size(); k++) cout << " " << r.lost[k]; cout << "\n"; }
            }
            else if (cmd == "del") { string n; is >> n; s->fs.del(n); }
            else if (cmd == "ls") { vector<string> v = s->fs.list(); for (size_t k = 0; k < v.size(); k++) cout << "   " << v[k] << "\n"; }
            else if (cmd == "fail") { int d; is >> d; s->raid.d.at(d).fail(); s->cache.clear(); cout << "   disk " << d << " FAILED\n"; }
            else if (cmd == "replace") { int d; is >> d; s->raid.rebuildAll(d); s->cache.clear(); cout << "   disk " << d << " replaced and rebuilt\n"; }
            else if (cmd == "fsck") {
                FsckResult r = s->fs.fsck();
                for (size_t k = 0; k < r.info.size(); k++) cout << "   OK  " << r.info[k] << "\n";
                for (size_t k = 0; k < r.issues.size(); k++) cout << "   BAD " << r.issues[k] << "\n";
                cout << "   fsck: " << (r.ok ? "CLEAN" : "PROBLEMS FOUND") << "\n";
            }
            else if (cmd == "map") printMap(s->raid);
            else if (cmd == "stats") printStats(s->cache);
            else if (cmd == "clearcache") { s->cache.clear(); cout << "   cache cleared\n"; }
            else if (cmd.empty()) {}
            else cout << "   unknown command\n";
        } catch (exception& e) { cout << "   ERROR: " << e.what() << "\n"; }
    }
}

int main(int argc, char** argv) {
    if (argc > 1 && string(argv[1]) == "shell") { shell(); return 0; }
    return runTests();
}