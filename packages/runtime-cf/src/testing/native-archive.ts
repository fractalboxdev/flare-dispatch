import { Buffer } from "node:buffer";
import { crc32 } from "node:zlib";

/** Stored ZIP bytes exercise the actual range, CRC and immutable publication owners. */
export const nativeTestArchive = (members: { path: string; bytes: Buffer }[]) => {
  const bodies: Buffer[] = [], directory: Buffer[] = []; let offset = 0;
  for (const member of members) {
    const name = Buffer.from(member.path), size = member.bytes.length, checksum = crc32(member.bytes);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4);
    local.writeUInt32LE(checksum, 14); local.writeUInt32LE(size, 18); local.writeUInt32LE(size, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt32LE(checksum, 16); central.writeUInt32LE(size, 20); central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    bodies.push(local, name, member.bytes); directory.push(central, name); offset += local.length + name.length + size;
  }
  const records = Buffer.concat(directory), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(members.length, 8); end.writeUInt16LE(members.length, 10);
  end.writeUInt32LE(records.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...bodies, records, end]);
};
