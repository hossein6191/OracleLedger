// Turning raw logs into {value, t}. All three oracles put a timestamp in the
// event itself, so no block lookups are needed anywhere.
import { AbiCoder, id, encodeBytes32String, decodeBytes32String, toBigInt } from 'ethers';
import { EVENTS } from './config.mjs';

const coder = AbiCoder.defaultAbiCoder();

export const TOPIC = {
  chainlinkAnswerUpdated: id(EVENTS.chainlinkAnswerUpdated),
  redstoneValueUpdate: id(EVENTS.redstoneValueUpdate),
  chroniclePoked: id(EVENTS.chroniclePoked),
  chronicleOpPoked: id(EVENTS.chronicleOpPoked),
};

export const feedIdBytes32 = (name) => encodeBytes32String(name).toLowerCase();

function int256(hex) {
  let v = toBigInt(hex);
  if (v >= (1n << 255n)) v -= (1n << 256n);
  return v;
}

export function decodeChainlink(log) {
  const [updatedAt] = coder.decode(['uint256'], log.data);
  return { value: Number(int256(log.topics[1])) / 1e8, t: Number(updatedAt) };
}

export function decodeRedstone(log) {
  const [value, feedId, updatedAt] = coder.decode(['uint256', 'bytes32', 'uint256'], log.data);
  let name;
  try { name = decodeBytes32String(feedId); } catch { name = feedId; }
  return { value: Number(value) / 1e8, feedId: name, feedIdRaw: feedId.toLowerCase(), t: Number(updatedAt) };
}

export function decodeChronicle(log) {
  const topic = log.topics[0];
  if (topic === TOPIC.chroniclePoked) {
    const [val, age] = coder.decode(['uint128', 'uint32'], log.data);
    return { value: Number(val) / 1e18, t: Number(age), optimistic: false };
  }
  if (topic === TOPIC.chronicleOpPoked) {
    const [, pokeData] = coder.decode(['tuple(bytes32,address,bytes)', 'tuple(uint128,uint32)'], log.data);
    return { value: Number(pokeData[0]) / 1e18, t: Number(pokeData[1]), optimistic: true };
  }
  return null;
}
