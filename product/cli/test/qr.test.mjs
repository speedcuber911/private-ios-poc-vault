import test from "node:test";
import assert from "node:assert/strict";

const { qrModules, renderQrAnsi, qrAnsiWidth } = await import("../src/qr.mjs");

// ECC level ordinals match Nayuki / ISO format-info packing: M=0, L=1, H=2, Q=3.
const ECC_MEDIUM = 0;

function versionOf(size) {
  return (size - 17) / 4;
}

function finderOk(modules, ox, oy) {
  for (let y = 0; y < 7; y++) {
    for (let x = 0; x < 7; x++) {
      const ring = x === 0 || x === 6 || y === 0 || y === 6;
      const center = x >= 2 && x <= 4 && y >= 2 && y <= 4;
      if (modules[oy + y][ox + x] !== (ring || center)) return false;
    }
  }
  return true;
}

// BCH(15,5) format information used by QR Model 2, XOR mask 0x5412.
function formatBitsFor(ecl, mask) {
  const data = (ecl << 3) | mask;
  let rem = data << 10;
  for (let i = 0; i < 5; i++) {
    if (((rem >>> (14 - i)) & 1) !== 0) rem ^= 0x537 << (4 - i);
  }
  return ((data << 10) | rem) ^ 0x5412;
}

function readFormatBits(modules) {
  // Primary copy along the top-left finder (ISO Figure 25).
  const bits = [];
  // horizontal: (0,8)..(5,8), skip (6,8) timing, then (7,8),(8,8)
  for (const x of [0, 1, 2, 3, 4, 5, 7, 8]) bits.push(modules[8][x] ? 1 : 0);
  // vertical: (8,7), skip (8,6) timing, then (8,5)..(8,0)
  for (const y of [7, 5, 4, 3, 2, 1, 0]) bits.push(modules[y][8] ? 1 : 0);
  let value = 0;
  for (const bit of bits) value = (value << 1) | bit;
  return value;
}

function matrixToStrings(modules) {
  return modules.map((row) => row.map((cell) => (cell ? "1" : "0")).join(""));
}

test("finder patterns sit at the three corners", () => {
  const modules = qrModules("https://relay.example/cli-login#code=ABCD-EFGH");
  const n = modules.length;
  assert.ok(finderOk(modules, 0, 0), "top-left finder");
  assert.ok(finderOk(modules, n - 7, 0), "top-right finder");
  assert.ok(finderOk(modules, 0, n - 7), "bottom-left finder");
});

test("timing patterns alternate along row 6 and column 6", () => {
  const modules = qrModules("relay-login");
  const n = modules.length;
  for (let i = 8; i < n - 8; i++) {
    assert.equal(modules[6][i], i % 2 === 0, `horizontal timing at x=${i}`);
    assert.equal(modules[i][6], i % 2 === 0, `vertical timing at y=${i}`);
  }
});

test("format information matches a valid ECC-M BCH codeword", () => {
  const modules = qrModules("https://relay.example/cli-login#code=ABCD-EFGH");
  const observed = readFormatBits(modules);
  const valid = new Set();
  for (let mask = 0; mask < 8; mask++) valid.add(formatBitsFor(ECC_MEDIUM, mask));
  assert.ok(valid.has(observed), `format bits 0x${observed.toString(16)} not a valid ECC-M codeword`);
});

test("module count matches the auto-selected version (1–10)", () => {
  const modules = qrModules("https://relay.example/cli-login#code=ABCD-EFGH");
  const version = versionOf(modules.length);
  assert.equal(version, Math.floor(version), "size must be 21+4·(v-1)");
  assert.ok(version >= 1 && version <= 10, `version ${version} outside 1–10`);
  assert.equal(modules.length, 17 + 4 * version);
});

test("golden matrices stay stable for fixed payloads", () => {
  const fixtures = {
    hi: [
      "111111100111101111111",
      "100000100110101000001",
      "101110101101101011101",
      "101110101100101011101",
      "101110101001101011101",
      "100000101100101000001",
      "111111101010101111111",
      "000000001011100000000",
      "101111100000101111100",
      "011101010010100100001",
      "001100110101010011110",
      "111010000100000110100",
      "111010100001010010101",
      "000000001001111001001",
      "111111100010101100010",
      "100000101111111001001",
      "101110101000100100100",
      "101110101110100100100",
      "101110101001010011100",
      "100000100110000110100",
      "111111101011010011110",
    ],
    loginUri: ["111111101100110011110101101111111","100000101000110010100111101000001","101110100101100101011000001011101","101110101100101110001111101011101","101110100010111000001101101011101","100000100001010001111100001000001","111111101010101010101010101111111","000000001001100001101000100000000","101101110111001011110100101001011","010100011110100010111001001101101","001110101100001011001001101111011","000111001101111100111010011101001","100101101110000000110100110101000","111010001010100011100001101100110","110101101011110111000000101111100","011001000100100010011110011101100","010101111110011100111111011011100","111111010000100101001101101011011","110101101100010101000010100110110","111110011001010010001101110010010","010110101010111100111001000011110","111000010010110101100000000001101","000101111101011011100001101101011","011010010000111010010010111101011","100001110101100101001011111110011","000000001011101111010001100011000","111111101010000000011011101010010","100000101001100110001111100011101","101110100001010101011001111110110","101110101000101001111001000101011","101110101001010000110101101101100","100000100001010111110011111111001","111111101110010111000100010011100"],
    mid: ["1111111000011100101111111","1000001001001111101000001","1011101011001001001011101","1011101011101111001011101","1011101010111000101011101","1000001010101011001000001","1111111010101010101111111","0000000010001001000000000","1011111000101110001111100","1001010110101100100100100","0010001100111111000111011","1010000010000011011100011","0011011101000111011011111","1101100111101000000101000","1011001001100111010110011","1010100011101000000110000","1010011001001111111110101","0000000010000000100011110","1111111001011111101010011","1000001010010000100011000","1011101011110001111111111","1011101010101100001011011","1011101010100111000101001","1000001001101100001000001","1111111011001010001111111"],
  };

  assert.deepEqual(matrixToStrings(qrModules("hi")), fixtures.hi);
  assert.deepEqual(
    matrixToStrings(qrModules("https://relay.example/cli-login#code=ABCD-EFGH")),
    fixtures.loginUri,
  );
  assert.deepEqual(matrixToStrings(qrModules("relay login QR handoff")), fixtures.mid);
});

test("renderQrAnsi uses half-blocks, a quiet zone, and explicit ANSI colors", () => {
  const text = "https://relay.example/cli-login#code=ABCD-EFGH";
  const ansi = renderQrAnsi(text);
  assert.match(ansi, /\x1b\[38;5;16;48;5;231m/);
  assert.match(ansi, /\x1b\[0m/);
  assert.match(ansi, /[█▀▄]/);
  assert.equal(qrAnsiWidth(text), qrModules(text).length + 4);
});
