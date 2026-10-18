// Simple logger. app.js plugs in a function that prints to the screen.
const Log = {
  handler: null,
  add(msg, type = 'info') { if (this.handler) this.handler(msg, type); }
};

const enc = new TextEncoder();
const dec = new TextDecoder();

// XOR a list of blocks together (A ^ B ^ C ...). This is parity math.
function xorBlocks(list) {
  const out = new Uint8Array(list[0].length);
  for (const b of list) {
    for (let i = 0; i < out.length; i++) out[i] ^= b[i];
  }
  return out;
}

// Glue many byte arrays into one
function concatBytes(arrs) {
  const total = arrs.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}

// Tiny fingerprint of a file's bytes, used by fsck to detect damage
function checksum(bytes) {
  let h = 7;
  for (const b of bytes) h = (h * 31 + b) >>> 0;
  return h;
}

// Put a string into exactly one block (padded with zeros)
function packText(str, blockSize) {
  const b = enc.encode(str);
  if (b.length > blockSize) throw new Error('Too much metadata for one block (directory or inode is full)');
  const out = new Uint8Array(blockSize);
  out.set(b);
  return out;
}

// Read a string back out of a block (remove the zero padding)
function unpackText(bytes) {
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end--;
  return dec.decode(bytes.slice(0, end));
}