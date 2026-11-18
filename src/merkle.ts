// Merkle root over receipt leaves (sorted pairs, keccak256), so anyone can prove a receipt is part of
// a sealed root.
import { concat, keccak256, type Hex } from "viem";

const hashPair = (a: Hex, b: Hex): Hex => (BigInt(a) < BigInt(b) ? keccak256(concat([a, b])) : keccak256(concat([b, a])));

export function merkleRoot(leaves: Hex[]): Hex {
  if (leaves.length === 0) return `0x${"00".repeat(32)}`;
  let level = [...leaves].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
  while (level.length > 1) {
    const next: Hex[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(i + 1 < level.length ? hashPair(level[i], level[i + 1]) : level[i]);
    level = next;
  }
  return level[0];
}

/** Proof for `leaf` (sibling hashes from the bottom up), for MerkleProof.verify. */
export function merkleProof(leaves: Hex[], leaf: Hex): Hex[] {
  let level = [...leaves].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
  let idx = level.indexOf(leaf);
  if (idx < 0) throw new Error("leaf not in tree");
  const proof: Hex[] = [];
  while (level.length > 1) {
    const sib = idx ^ 1;
    if (sib < level.length) proof.push(level[sib]);
    const next: Hex[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(i + 1 < level.length ? hashPair(level[i], level[i + 1]) : level[i]);
    level = next;
    idx = Math.floor(idx / 2);
  }
  return proof;
}

export function verifyProof(proof: Hex[], root: Hex, leaf: Hex) {
  return proof.reduce((h, p) => hashPair(h, p), leaf).toLowerCase() === root.toLowerCase();
}
